import cron from 'node-cron';
import { db } from '../db/client';
import { products, priceHistory, alerts, alertEvents, users } from '../db/schema';
import { eq, and, desc, min, isNull, sql } from 'drizzle-orm';
import { scrapeProduct, affiliateUrl, ProductUnavailableError, CaptchaDetectedError, isCaptchaBlocked, captchaRemainingMs } from '../scraper/amazon';
import { sendPriceAlert, sendBackInStockAlert } from '../mailer';
import { sendTelegramAlert, sendTelegramBackInStock } from '../mailer/telegram';
import { getSetting } from '../db/settings';

const CHECK_INTERVAL = process.env.CHECK_INTERVAL_CRON ?? '0 * * * *';

export interface ScraperLogEntry { id: number; name: string; asin: string; ok: boolean; ts: number; }

export interface ScraperStatus {
  isRunning: boolean;
  current: { id: number; name: string; asin: string } | null;
  done: number;
  total: number;       // products due this cycle
  activeCount: number; // total active non-failed products
  log: ScraperLogEntry[];
}

const state: ScraperStatus = { isRunning: false, current: null, done: 0, total: 0, activeCount: 0, log: [] };

export function getScraperStatus(): ScraperStatus { return { ...state, log: [...state.log] }; }

let isRunning = false;

async function checkAllProducts(): Promise<void> {
  if (isRunning) {
    console.log('[scheduler] Previous run still active, skipping.');
    return;
  }
  isRunning = true;
  state.isRunning = true;
  state.done = 0;
  state.log = [];

  // Abort cycle early if IP is still in captcha cooldown
  if (isCaptchaBlocked()) {
    const secs = Math.round(captchaRemainingMs() / 1000);
    console.log(`[scheduler] IP bloqueada, saltando ciclo. Cooldown restante: ${secs}s`);
    isRunning = false;
    state.isRunning = false;
    return;
  }

  // Read live settings from DB each cycle — DB is source of truth, no env fallbacks
  const CONCURRENCY            = Math.max(1, Math.min(8,   Number(await getSetting('scraper_concurrency',    2))));
  const RETRY_FAILED_PER_CYCLE = Math.max(0, Math.min(100, Number(await getSetting('retry_failed_per_cycle', 30))));
  const MIN_AGE_MINUTES        = Math.max(1, Math.min(1440,Number(await getSetting('min_age_minutes',        59))));
  const SCRAPER_TIMEOUT        = Math.max(15,Math.min(120, Number(await getSetting('scraper_timeout_seconds',30))));
  const MIN_AGE_MS = MIN_AGE_MINUTES * 60 * 1000;

  try {
    // Release up to RETRY_FAILED_PER_CYCLE failed products back into the normal cycle.
    // Ordered by id ASC so the backlog drains predictably (30/cycle ≈ 17 cycles for 512 products).
    if (RETRY_FAILED_PER_CYCLE > 0) {
      const retried = await db.execute(sql`
        UPDATE products
        SET is_failed = FALSE, consecutive_failures = 0
        WHERE id IN (
          SELECT id FROM products
          WHERE is_active = TRUE AND is_failed = TRUE
          ORDER BY id ASC
          LIMIT ${RETRY_FAILED_PER_CYCLE}
        )
        RETURNING id
      `);
      if (retried.rows.length > 0) {
        console.log(`[scheduler] Retry: ${retried.rows.length} failed products re-queued for this cycle`);
      }
    }

    const activeProducts = await db.execute(sql`
      SELECT p.id, p.url, p.name, p.asin,
        (SELECT ph.scraped_at FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "lastScrapedAt"
      FROM products p
      WHERE p.is_active = TRUE AND p.is_failed = FALSE
    `);
    const toCheck = (activeProducts.rows as any[]).filter(p => {
      if (!p.lastScrapedAt) return true;
      return Date.now() - new Date(p.lastScrapedAt).getTime() >= MIN_AGE_MS;
    });
    state.total = toCheck.length;
    state.activeCount = activeProducts.rows.length;
    console.log(`[scheduler] ${toCheck.length}/${activeProducts.rows.length} products due for check (${CONCURRENCY} workers)…`);

    // Worker pool: CONCURRENCY workers pick products until exhausted
    let idx = 0;
    async function worker(): Promise<void> {
      while (idx < toCheck.length) {
        const product = toCheck[idx++];
        state.current = { id: product.id, name: product.name ?? product.asin, asin: product.asin };
        let ok = true;
        try {
          await checkProduct(product.id, product.url, product.name ?? product.asin, SCRAPER_TIMEOUT);
        } catch (e) {
          ok = false;
          if (e instanceof CaptchaDetectedError) break; // stop this worker — whole IP is blocked
        }
        state.log.unshift({ id: product.id, name: product.name ?? product.asin, asin: product.asin, ok, ts: Date.now() });
        if (state.log.length > 50) state.log.pop();
        state.done++;
        // Delay skewed toward lower bound: x² pushes ~75% of values into the bottom half of the range
        await new Promise(r => setTimeout(r, 1000 + Math.floor(Math.random() ** 2 * 4000)));
      }
    }

    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, toCheck.length) }, worker));

    console.log('[scheduler] Cycle complete.');
  } catch (err) {
    console.error('[scheduler] Unexpected error in cycle:', err);
  } finally {
    isRunning = false;
    state.isRunning = false;
    state.current = null;
  }
}

interface SaleInfo { isOnSale: boolean; saleTier: string | null; dealScore: number | null; }

function calcSaleTier(currentPrice: number, reference: number): SaleInfo {
  const pctOff = (reference - currentPrice) / reference * 100;
  if (pctOff >= 67) return { isOnSale: true, saleTier: '67oferta',      dealScore: pctOff };
  if (pctOff >= 50) return { isOnSale: true, saleTier: 'broooooferton', dealScore: pctOff };
  if (pctOff >= 30) return { isOnSale: true, saleTier: 'mega-oferta',   dealScore: pctOff };
  if (pctOff >= 15) return { isOnSale: true, saleTier: 'super-oferta',  dealScore: pctOff };
  if (pctOff >= 7)  return { isOnSale: true, saleTier: 'oferta',        dealScore: pctOff };
  return { isOnSale: false, saleTier: null, dealScore: null };
}

async function checkProduct(productId: number, url: string, label: string, timeoutSeconds = 30): Promise<void> {
  // Load current state to detect availability transitions and track failures
  const [current] = await db.select({
    isAvailable: products.isAvailable,
    consecutiveFailures: products.consecutiveFailures,
    consecutiveAnomalies: products.consecutiveAnomalies,
  }).from(products).where(eq(products.id, productId)).limit(1);
  const wasUnavailable = current ? !current.isAvailable : false;

  // Fetch all-time stats before this scrape (for sale tier detection)
  const statsResult = await db.execute(sql`
    SELECT
      MAX(price)::float                                      AS all_time_max,
      COUNT(*)::int                                          AS scrape_count,
      EXTRACT(DAY FROM (NOW() - MIN(scraped_at)))::int       AS days_span
    FROM price_history
    WHERE product_id = ${productId}
  `);
  const statsRow    = statsResult.rows[0] as any;
  const allTimeMax  = (statsRow?.all_time_max  ?? null)  as number | null;
  const scrapeCount = (statsRow?.scrape_count  ?? 0)     as number;
  const daysSpan    = (statsRow?.days_span     ?? 0)     as number;

  try {
    console.log(`[scheduler] Scraping: ${label}`);
    const result = await scrapeProduct(url, timeoutSeconds);

    // ── Anomaly guard ────────────────────────────────────────────────────────
    // Reject prices that drop >60% below the recent median when we have enough
    // history to be confident. Catches selectors picking up "Nuevo y de segunda
    // mano desde X €", accessory prices, or sponsored cards.
    // Bypass the guard if wasPrice corroborates the deal (real RRP / 4 ≥ price).
    // After 3 consecutive anomalies we accept anyway: the price may have genuinely
    // shifted (e.g. Amazon clearance), and we don't want to wedge the product.
    const recentRows = await db.execute(sql`
      SELECT price::float AS p FROM price_history
      WHERE product_id = ${productId}
      ORDER BY scraped_at DESC LIMIT 5
    `);
    const recent = (recentRows.rows as any[]).map(r => r.p as number);
    const anomalyCount = current?.consecutiveAnomalies ?? 0;
    if (recent.length >= 3 && anomalyCount < 3) {
      const sorted = recent.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const wasPriceCorroborates = result.wasPrice != null && result.wasPrice >= result.price * 4;
      if (result.price < median * 0.4 && !wasPriceCorroborates) {
        const newCount = anomalyCount + 1;
        console.warn(`[scheduler] ${label} → ANOMALÍA (${newCount}/3): ${result.price.toFixed(2)} € << mediana ${median.toFixed(2)} € — descartado`);
        await db.update(products).set({
          consecutiveAnomalies: newCount,
          lastError: `Precio anómalo descartado (${newCount}/3): ${result.price.toFixed(2)} € << mediana ${median.toFixed(2)} € — probable accesorio o "Nuevo y de segunda mano"`,
        }).where(eq(products.id, productId));
        return;
      }
    }

    await db.insert(priceHistory).values({ productId, price: String(result.price), currency: result.currency });

    // Sale detection: use was_price (Amazon RRP) as reference when available;
    // fall back to all-time historical max with minimum data gate.
    const wasPriceRef = (result.wasPrice && result.wasPrice > result.price) ? result.wasPrice : null;
    const historicalRef = (scrapeCount >= 5 && daysSpan >= 2 && allTimeMax !== null && result.price < allTimeMax) ? allTimeMax : null;
    const saleReference = Math.max(wasPriceRef ?? 0, historicalRef ?? 0) || null;
    const saleInfo: SaleInfo = saleReference
      ? calcSaleTier(result.price, saleReference)
      : { isOnSale: false, saleTier: null, dealScore: null };
    if (saleInfo.isOnSale) {
      const refSrc = (wasPriceRef && wasPriceRef >= (historicalRef ?? 0)) ? 'was_price' : 'all_time_max';
      console.log(`[scheduler] ${label} → ${saleInfo.saleTier} (${saleInfo.dealScore!.toFixed(1)}% off, ref ${saleReference?.toFixed(2)} [${refSrc}])`);
    }

    await db.update(products).set({
      name: result.name,
      imageUrl: result.imageUrl,
      extraImages: result.extraImages.length ? JSON.stringify(result.extraImages) : null,
      lastError: null,
      isAvailable: true,
      consecutiveFailures: 0,
      consecutiveAnomalies: 0,
      isFailed: false,
      isOnSale: saleInfo.isOnSale,
      saleTier: saleInfo.saleTier,
      dealScore: saleInfo.dealScore != null ? String(saleInfo.dealScore.toFixed(1)) : null,
      ...(result.wasPrice != null ? { wasPrice: String(result.wasPrice.toFixed(2)) } : {}),
    }).where(eq(products.id, productId));

    console.log(`[scheduler] ${label} → ${result.price} ${result.currency}`);

    // Product just came back in stock — notify owner
    if (wasUnavailable) {
      console.log(`[scheduler] ${label} → back in stock, sending notification`);
      await notifyBackInStock(productId, result.price, result.currency, result.name, result.imageUrl, url);
    }

    await processAlerts(productId, result.price, result.currency, label, result.imageUrl, url);
  } catch (err) {
    if (err instanceof ProductUnavailableError) {
      console.log(`[scheduler] ${label} → No disponible`);
      await db.update(products).set({
        isAvailable: false, lastError: null,
        isOnSale: false, saleTier: null, dealScore: null,
      }).where(eq(products.id, productId));
      // Reset stock alerts so they fire again when the product comes back
      await db.update(alerts).set({ notifiedAt: null })
        .where(and(eq(alerts.productId, productId), eq(alerts.alertType, 'stock')));
    } else if (err instanceof CaptchaDetectedError) {
      // Pausa global por bloqueo Amazon — no penalizar el producto, abortar ciclo
      console.log(`[scheduler] ${label} → ${err.message}`);
      throw err; // propagate so the worker stops immediately
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed for ${label}: ${msg}`);
      const newFailCount = (current?.consecutiveFailures ?? 0) + 1;
      const isFailed = newFailCount >= 3;
      if (isFailed) console.log(`[scheduler] ${label} → marked as failed after ${newFailCount} consecutive errors`);
      await db.update(products).set({ lastError: msg, consecutiveFailures: newFailCount, isFailed, totalFailures: sql`total_failures + 1` }).where(eq(products.id, productId));
    }
  }
}

async function notifyBackInStock(
  productId: number,
  currentPrice: number,
  currency: string,
  productName: string,
  imageUrl: string | null | undefined,
  productUrl: string,
): Promise<void> {
  const productAffilUrl = affiliateUrl(productUrl);

  const [product] = await db.select({ userId: products.userId }).from(products).where(eq(products.id, productId)).limit(1);
  if (!product) return;
  const [owner] = await db.select({ email: users.email, telegramChatId: users.telegramChatId }).from(users).where(eq(users.id, product.userId)).limit(1);
  if (!owner) return;

  try {
    await sendBackInStockAlert({ to: owner.email, productName, productUrl: productAffilUrl, currentPrice, imageUrl, currency });
  } catch (err) {
    console.error(`[scheduler] Back-in-stock email failed:`, err);
  }

  const chatId = owner.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
  if (chatId) {
    try {
      await sendTelegramBackInStock({ chatId, productName, productUrl: productAffilUrl, currentPrice, currency });
    } catch (err) {
      console.error(`[scheduler] Back-in-stock Telegram failed:`, err);
    }
  }

  // Fire explicit stock-type alerts (may include users other than the owner)
  const stockAlerts = await db.select().from(alerts).where(
    and(
      eq(alerts.productId, productId),
      eq(alerts.alertType, 'stock'),
      eq(alerts.isActive, true),
      isNull(alerts.notifiedAt),
    ),
  );

  for (const alert of stockAlerts) {
    try {
      const channel = alert.notificationChannel ?? 'email';
      if (channel === 'email' || channel === 'both') {
        await sendBackInStockAlert({ to: alert.notificationEmail, productName, productUrl: productAffilUrl, currentPrice, imageUrl, currency });
      }
      if (channel === 'telegram' || channel === 'both') {
        const alertChatId = alert.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
        if (alertChatId) {
          await sendTelegramBackInStock({ chatId: alertChatId, productName, productUrl: productAffilUrl, currentPrice, currency });
        }
      }
      await db.update(alerts).set({ notifiedAt: new Date() }).where(eq(alerts.id, alert.id));
    } catch (err) {
      console.error(`[scheduler] Stock alert ${alert.id} failed:`, err);
    }
  }
}

async function processAlerts(
  productId: number,
  currentPrice: number,
  currency: string,
  productName: string,
  imageUrl: string | null | undefined,
  productUrl: string,
): Promise<void> {
  const productAffilUrl = affiliateUrl(productUrl);

  // Load all active alerts for this product
  const activeAlerts = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.productId, productId), eq(alerts.isActive, true)));

  // All-time low for alltime_low alert type
  const [lowestRow] = await db
    .select({ val: min(priceHistory.price) })
    .from(priceHistory)
    .where(eq(priceHistory.productId, productId));
  const alltimeLow = lowestRow?.val ? parseFloat(String(lowestRow.val)) : null;

  // Previous price (second most recent record) for drop display in email
  const prevPriceResult = await db.execute(sql`
    SELECT price FROM price_history WHERE product_id = ${productId} ORDER BY scraped_at DESC LIMIT 1 OFFSET 1
  `);
  const previousPrice = prevPriceResult.rows[0] ? parseFloat(String((prevPriceResult.rows[0] as any).price)) : null;

  for (const alert of activeAlerts) {
    const type = alert.alertType ?? 'price';

    // Determine if this alert should fire
    let shouldFire = false;
    let thresholdLabel = '';

    if (type === 'price') {
      const threshold = parseFloat(String(alert.thresholdPrice ?? 0));
      shouldFire = !!alert.thresholdPrice && currentPrice <= threshold;
      thresholdLabel = `${threshold.toFixed(2)} €`;
      // Auto-reactivate: if price went back above threshold after notifying, reset
      if (alert.notifiedAt && currentPrice > threshold + 0.01) {
        await db.update(alerts).set({ notifiedAt: null }).where(eq(alerts.id, alert.id));
      }
    } else if (type === 'percent') {
      const ref = parseFloat(String(alert.referencePrice ?? 0));
      const drop = parseFloat(String(alert.percentageDrop ?? 0));
      // No referencePrice yet (immediate scrape failed when product was added) — initialize now, fire next cycle
      if (ref === 0) {
        await db.update(alerts).set({ referencePrice: String(currentPrice.toFixed(2)) }).where(eq(alerts.id, alert.id));
        continue;
      }
      const targetPrice = ref * (1 - drop / 100);
      shouldFire = drop > 0 && currentPrice <= targetPrice;
      thresholdLabel = `−${drop.toFixed(0)}% desde ${ref.toFixed(2)} €`;
      if (alert.notifiedAt && currentPrice > targetPrice + 0.01) {
        await db.update(alerts).set({ notifiedAt: null }).where(eq(alerts.id, alert.id));
      }
    } else if (type === 'alltime_low') {
      // Fires whenever a new all-time low is set (we compare with pre-insert min)
      // Here: alltimeLow already includes the current price (just inserted). Fire if current = alltimeLow
      shouldFire = alltimeLow !== null && currentPrice <= alltimeLow + 0.01;
      thresholdLabel = 'nuevo mínimo histórico';
      // Always allow re-firing for alltime_low (reset after each cycle)
      if (alert.notifiedAt) {
        await db.update(alerts).set({ notifiedAt: null }).where(eq(alerts.id, alert.id));
        continue; // will fire next cycle if still at low
      }
    }

    if (!shouldFire || alert.notifiedAt) continue;

    try {
      const channel = alert.notificationChannel ?? 'email';

      if (channel === 'email' || channel === 'both') {
        await sendPriceAlert({
          to: alert.notificationEmail,
          productName,
          productUrl: productAffilUrl,
          productId,
          currentPrice,
          previousPrice,
          thresholdPrice: parseFloat(String(alert.thresholdPrice ?? currentPrice)),
          imageUrl,
          currency,
        });
      }

      if (channel === 'telegram' || channel === 'both') {
        const chatId = alert.telegramChatId ?? process.env.TELEGRAM_CHAT_ID;
        if (chatId) {
          await sendTelegramAlert({
            chatId,
            productName,
            productUrl: productAffilUrl,
            currentPrice,
            thresholdLabel,
            currency,
          });
        }
      }

      await db.update(alerts).set({ notifiedAt: new Date() }).where(eq(alerts.id, alert.id));
      await db.insert(alertEvents).values({
        alertId: alert.id,
        productId,
        userId: alert.userId,
        alertType: type,
        priceAtTime: String(currentPrice),
        thresholdLabel,
      });
    } catch (err) {
      console.error(`[scheduler] Failed to send alert ${alert.id}:`, err);
    }
  }
}

export function triggerScrape(): boolean {
  if (isRunning) return false;
  checkAllProducts().catch(err => console.error('[scheduler] Manual trigger error:', err));
  return true;
}

export function startScheduler(): void {
  console.log(`[scheduler] Starting with schedule: "${CHECK_INTERVAL}"`);
  checkAllProducts();
  cron.schedule(CHECK_INTERVAL, () => { checkAllProducts(); });

  const { startCategoryImportScheduler } = require('./category-import');
  startCategoryImportScheduler();
}

export { checkProduct };
