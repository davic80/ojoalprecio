import cron from 'node-cron';
import { db } from '../db/client';
import { products, priceHistory, alerts, alertEvents, users, scrapeAnomalies, userProducts, purgedAsins } from '../db/schema';
import { eq, and, desc, min, isNull, sql, inArray } from 'drizzle-orm';
import { scrapeProduct, affiliateUrl, ProductUnavailableError, CaptchaDetectedError, isCaptchaBlocked, captchaRemainingMs, type ScrapeResult } from '../scraper/amazon';
import { autoCategorizeId } from '../scraper/categorize';
import { emitScrapeUpdate } from '../lib/product-events';
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

// Pure sale logic lives in ./sale-logic for unit testability without pulling
// in db/playwright at module load. Re-exported here for backwards compat.
export { calcSaleTier, evaluateAutoFeature, type SaleInfo } from './sale-logic';
import { calcSaleTier, evaluateAutoFeature, type SaleInfo } from './sale-logic';

/**
 * Compute sale info and persist a scrape result atomically.
 *
 * Used by both the scheduler's `checkProduct` and the admin manual-refresh
 * endpoint so they share the exact same behaviour: was_price, sale tier,
 * deal score, name/image, error flags — everything is consistent regardless
 * of who triggered the scrape.
 *
 * `stats` is optional. The scheduler already pre-fetches all-time stats for
 * other reasons and passes them in to avoid a duplicate query; the manual
 * refresh path passes nothing and we fetch them here.
 *
 * Returns the computed SaleInfo so the caller can react (e.g. process alerts).
 */
export async function persistScrapeResult(
  productId: number,
  result: ScrapeResult,
  opts: { allTimeMax?: number | null; scrapeCount?: number; daysSpan?: number; label?: string; skipVariantIngest?: boolean } = {},
): Promise<SaleInfo> {
  let { allTimeMax, scrapeCount, daysSpan } = opts;
  // recent_high is always fetched: it's the MAX price observed between 2 and
  // 14 days ago and serves as the baseline for "real" sale detection. The
  // scheduler doesn't preflight it, so we read it here regardless of opts.
  const stats2Res = await db.execute(sql`
    SELECT
      ${allTimeMax === undefined  ? sql`MAX(price)::float`                                              : sql`NULL::float`} AS all_time_max,
      ${scrapeCount === undefined ? sql`COUNT(*)::int`                                                  : sql`NULL::int`}   AS scrape_count,
      ${daysSpan === undefined    ? sql`EXTRACT(DAY FROM (NOW() - MIN(scraped_at)))::int`               : sql`NULL::int`}   AS days_span,
      (SELECT MAX(price)::float FROM price_history
        WHERE product_id = ${productId}
          AND scraped_at >= NOW() - INTERVAL '14 days'
          AND scraped_at <  NOW() - INTERVAL '2 days')                                                  AS recent_high
    FROM price_history WHERE product_id = ${productId}
  `);
  const r = stats2Res.rows[0] as any;
  if (allTimeMax  === undefined) allTimeMax  = (r?.all_time_max  ?? null) as number | null;
  if (scrapeCount === undefined) scrapeCount = (r?.scrape_count  ?? 0)    as number;
  if (daysSpan    === undefined) daysSpan    = (r?.days_span     ?? 0)    as number;
  const recentHigh = (r?.recent_high ?? null) as number | null;

  // Read current feature + category state so we can decide whether to toggle
  // is_public AND set category_id in the same transaction as the scrape.
  const [stateRow] = await db.select({
    featureLock: products.featureLock,
    isPublic:    products.isPublic,
    isAvailable: products.isAvailable,
    featuredAt:  products.featuredAt,
    categoryId:  products.categoryId,
  }).from(products).where(eq(products.id, productId)).limit(1);

  // Auto-categorise: only when the product has no category yet (admin-set or
  // category-import-set values are never overwritten). Best-effort — a name
  // that doesn't match any rule keeps category_id NULL and shows up on the
  // admin uncategorized list.
  let nextCategoryId = stateRow?.categoryId ?? null;
  if (nextCategoryId === null && result.name) {
    try {
      const guess = await autoCategorizeId(result.name);
      if (guess !== null) {
        nextCategoryId = guess;
        if (opts.label) console.log(`[scheduler] ${opts.label} → auto-categorize → category #${guess}`);
      }
    } catch (err) { console.error('[scheduler] auto-categorize failed:', err); }
  }

  // is_on_sale and deal_score are derived from REAL price movement, not from
  // Amazon's "PVP recomendado" (wasPrice) — that field is routinely inflated
  // and was flagging stable-price products as permanently on sale. The
  // baseline is the max price observed 2-14 days ago; current must be below
  // that for the product to count as on sale. wasPrice still gets stored and
  // shown in the UI as a crossed-out RRP, just not used to drive on_sale.
  const hasEnoughHistory = scrapeCount! >= 5 && daysSpan! >= 2;
  const baselineRef = (hasEnoughHistory && recentHigh !== null && result.price < recentHigh)
    ? recentHigh
    : null;
  const saleInfo: SaleInfo = baselineRef
    ? calcSaleTier(result.price, baselineRef)
    : { isOnSale: false, saleTier: null, dealScore: null };

  if (saleInfo.isOnSale && opts.label) {
    console.log(`[scheduler] ${opts.label} → ${saleInfo.saleTier} (${saleInfo.dealScore!.toFixed(1)}% off, ref ${baselineRef?.toFixed(2)} [recent_high 2-14d])`);
  }

  // Auto-curation of /ofertas. Only when feature_lock = 'auto'. 'pin' and 'mute'
  // are admin overrides preserved as-is. Alerts are NOT affected by this — the
  // alerts table joins on product_id only, never on is_public.
  let nextIsPublic   = stateRow?.isPublic   ?? false;
  let nextFeaturedAt = stateRow?.featuredAt ?? null;
  if (stateRow && stateRow.featureLock === 'auto') {
    const minScoreRaw = await getSetting('featured_min_deal_score', 20);
    const minScore    = Math.max(5, Math.min(95, Number(minScoreRaw)));
    const decision = evaluateAutoFeature(
      { isPublic: stateRow.isPublic, isAvailable: true, featuredAt: stateRow.featuredAt as Date | null },
      saleInfo, scrapeCount!, daysSpan!, minScore,
    );
    if (decision.isPublic !== stateRow.isPublic && opts.label) {
      console.log(`[scheduler] ${opts.label} → auto-feature ${decision.isPublic ? 'IN' : 'OUT'} (score=${(saleInfo.dealScore ?? 0).toFixed(1)}, threshold=${minScore})`);
    }
    nextIsPublic   = decision.isPublic;
    nextFeaturedAt = decision.featuredAt;
  }

  // Atomic insert + update so a SIGTERM/SIGKILL between the writes can't leave
  // a price_history row without its matching wasPrice / sale-flag update.
  await db.transaction(async (tx) => {
    await tx.insert(priceHistory).values({ productId, price: String(result.price), currency: result.currency });
    await tx.update(products).set({
      name: result.name,
      imageUrl: result.imageUrl,
      extraImages: result.extraImages.length ? JSON.stringify(result.extraImages) : null,
      variantsJson: result.variants && result.variants.length ? JSON.stringify(result.variants) : null,
      consecutiveUnavailable: 0,
      lastError: null,
      isAvailable: true,
      consecutiveFailures: 0,
      consecutiveAnomalies: 0,
      isFailed: false,
      isOnSale: saleInfo.isOnSale,
      saleTier: saleInfo.saleTier,
      dealScore: saleInfo.dealScore != null ? String(saleInfo.dealScore.toFixed(1)) : null,
      ...(result.wasPrice != null ? { wasPrice: String(result.wasPrice.toFixed(2)) } : {}),
      isPublic:   nextIsPublic,
      featuredAt: nextFeaturedAt,
      categoryId: nextCategoryId,
    }).where(eq(products.id, productId));
  });

  if (opts.label) console.log(`[scheduler] ${opts.label} → ${result.price} ${result.currency}`);

  // Live push to any open /p/:asin viewer via SSE. Fire-and-forget — listeners
  // re-render server-side fragments on their own.
  emitScrapeUpdate(result.asin);

  // (featured cap, anomaly TTL, blacklist TTL all run together in the
  // hourly maintenance task — not here. Doing them per-scrape thrashed the
  // window function across thousands of rows; once an hour is plenty.)

  // Variant auto-ingest + immediate scrape. For each twister sibling we don't
  // already have, insert it owned by the system user with the parent's
  // category, then queue an immediate background scrape so users see prices
  // right away instead of waiting for the next scheduler cycle. skipVariantIngest
  // breaks the recursion: variants scraped from the queue don't re-ingest their
  // own siblings (they'd be the same set we just discovered).
  if (!opts.skipVariantIngest && result.variants && result.variants.length) {
    try {
      const newOnes = await ingestNewVariants(productId, result.variants.map(v => v.asin));
      for (const { productId: vId, asin: vAsin } of newOnes) {
        queueImmediateVariantScrape(vId, `https://www.amazon.es/dp/${vAsin}`, vAsin);
      }
    } catch (err) {
      console.error(`[scheduler] variant ingest failed for ${result.asin}:`, err);
    }
  }

  return saleInfo;
}

// ── Immediate variant scrape queue ────────────────────────────────────────────
// Sequential drain so we don't spawn N concurrent Chromium contexts when a
// parent reveals many new variants. Fire-and-forget from the caller.
interface VariantScrapeJob { productId: number; url: string; asin: string }
const _variantQueue: VariantScrapeJob[] = [];
let _variantDraining = false;

function queueImmediateVariantScrape(productId: number, url: string, asin: string): void {
  _variantQueue.push({ productId, url, asin });
  if (!_variantDraining) void drainVariantQueue();
}

async function drainVariantQueue(): Promise<void> {
  if (_variantDraining) return;
  _variantDraining = true;
  try {
    while (_variantQueue.length > 0) {
      const job = _variantQueue.shift()!;
      try {
        // Use a generous timeout — the parent's already cached the storage state
        // so subsequent contexts navigate fast.
        const r = await scrapeProduct(job.url, 30);
        await persistScrapeResult(job.productId, r, { skipVariantIngest: true, label: `variant ${job.asin}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof ProductUnavailableError) {
          // Variant exists but Amazon shows no Amazon offer for it — mark
          // unavailable so the auto-purge can clean it up later.
          await db.update(products).set({ isAvailable: false }).where(eq(products.id, job.productId));
        } else {
          await db.update(products).set({ lastError: msg }).where(eq(products.id, job.productId));
          console.warn(`[scheduler] immediate variant scrape failed for ${job.asin}: ${msg}`);
        }
      }
    }
  } finally {
    _variantDraining = false;
  }
}

let _systemUserIdCache: number | null = null;
async function getSystemUserId(): Promise<number | null> {
  if (_systemUserIdCache !== null) return _systemUserIdCache;
  const r = await db.select({ id: users.id }).from(users).where(eq(users.email, 'system@ojoalprecio.local')).limit(1);
  _systemUserIdCache = r[0]?.id ?? null;
  return _systemUserIdCache;
}

async function ingestNewVariants(parentProductId: number, variantAsins: string[]): Promise<Array<{ productId: number; asin: string }>> {
  if (!variantAsins.length) return [];
  const systemUserId = await getSystemUserId();
  if (systemUserId === null) return [];

  // Filter out ASINs that already exist anywhere in the catalog. Use the
  // drizzle `inArray` helper instead of `ANY(${...})` because the raw sql
  // template serializes a JS array as a string literal, which Postgres then
  // refuses with "malformed array literal".
  const existingRows = await db
    .selectDistinct({ asin: products.asin })
    .from(products)
    .where(inArray(products.asin, variantAsins));
  const existing = new Set(existingRows.map(r => r.asin));

  // Also skip ASINs that were recently auto-purged (within 30 days). Without
  // this, the next parent scrape re-discovers them and we churn forever.
  const purgedRows = await db
    .select({ asin: purgedAsins.asin })
    .from(purgedAsins)
    .where(and(inArray(purgedAsins.asin, variantAsins), sql`purged_at > NOW() - INTERVAL '30 days'`));
  const purged = new Set(purgedRows.map(r => r.asin));

  const newAsins = variantAsins.filter(a => !existing.has(a) && !purged.has(a));
  if (!newAsins.length) return [];

  // Inherit category from parent for nicer grouping
  const [parent] = await db.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, parentProductId)).limit(1);
  const categoryId = parent?.categoryId ?? null;

  const inserted: Array<{ productId: number; asin: string }> = [];
  for (const asin of newAsins) {
    try {
      const [row] = await db.insert(products).values({
        createdByUserId: systemUserId,
        asin,
        url: `https://www.amazon.es/dp/${asin}`,
        categoryId,
        isPublic: false,
      }).returning({ id: products.id });
      // System owns the discovery; this is what protects the variant from being
      // visible in any real user's dashboard while still letting auto-purge run
      // (the purge check excludes system-only follows).
      await db.insert(userProducts).values({ userId: systemUserId, productId: row.id }).onConflictDoNothing();
      inserted.push({ productId: row.id, asin });
      console.log(`[scheduler] variant ingest: + ${asin}`);
    } catch (err) {
      console.error(`[scheduler] variant ingest failed for ${asin}:`, err);
    }
  }
  return inserted;
}

/**
 * Auto-purge logic for products stuck unavailable. Caller must have just
 * incremented `consecutive_unavailable`. Returns true if the product was
 * deleted.
 *
 * System-discovered variants (only system follows them, no alerts) get a
 * 1-strike fast purge — they're catalog noise that the parent twister will
 * re-discover whenever Amazon brings them back. Products with real followers
 * or active alerts are never auto-purged: user data is sacred.
 *
 * Purged ASINs are written to `purged_asins` so the variant ingester won't
 * reanimate them on the next parent scrape (would otherwise be an infinite
 * churn loop). Blacklist TTLs at 30 days.
 */
async function maybePurgeOrphan(productId: number, label: string, reason: string): Promise<boolean> {
  const systemUserId = await getSystemUserId();
  const checkRows = await db.execute(sql`
    SELECT
      p.asin,
      (SELECT COUNT(*) FROM alerts WHERE product_id = p.id) AS alerts_n,
      (SELECT COUNT(*) FROM user_products WHERE product_id = p.id
        AND ${systemUserId !== null ? sql`user_id != ${systemUserId}` : sql`TRUE`}) AS real_followers_n
    FROM products p WHERE p.id = ${productId}
  `);
  const r = checkRows.rows[0] as any;
  if (!r) return false;
  const asin    = String(r.asin);
  const alertsN = parseInt(r.alerts_n ?? '0', 10);
  const realN   = parseInt(r.real_followers_n ?? '0', 10);

  // Only orphans (no alerts, no real-user follow) are eligible.
  if (alertsN !== 0 || realN !== 0) return false;

  await db.transaction(async (tx) => {
    await tx.insert(purgedAsins).values({ asin, reason })
      .onConflictDoUpdate({ target: purgedAsins.asin, set: { purgedAt: new Date(), reason } });
    await tx.delete(products).where(eq(products.id, productId));
  });
  console.log(`[scheduler] ${label} → AUTO-PURGE (${reason})`);
  return true;
}

/**
 * Append an anomaly to the review queue. Best-effort — failures are logged
 * but don't block the scrape flow. The queue lets admin recover legit
 * captures the guard misclassified, plus toggle bypass_anomaly_guard for
 * products with naturally wide swings.
 */
async function enqueueAnomaly(input: {
  productId: number;
  type: 'low' | 'high' | 'used' | 'unqualified';
  suspectPrice: number | null;
  medianPrice: number | null;
  message: string;
  snippet?: string;
}): Promise<void> {
  try {
    await db.insert(scrapeAnomalies).values({
      productId:      input.productId,
      anomalyType:    input.type,
      suspectPrice:   input.suspectPrice != null ? String(input.suspectPrice.toFixed(2)) : null,
      medianPrice:    input.medianPrice  != null ? String(input.medianPrice.toFixed(2))  : null,
      scraperMessage: input.message,
      pageSnippet:    input.snippet ?? null,
      status:         'pending',
    });
  } catch (err) {
    console.error('[scheduler] enqueueAnomaly failed:', err);
  }
}

async function checkProduct(productId: number, url: string, label: string, timeoutSeconds = 30): Promise<void> {
  // Load current state to detect availability transitions and track failures
  const [current] = await db.select({
    isAvailable: products.isAvailable,
    consecutiveFailures: products.consecutiveFailures,
    consecutiveAnomalies: products.consecutiveAnomalies,
    bypassAnomalyGuard: products.bypassAnomalyGuard,
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

    // ── Anomaly guard (symmetric: rejects extreme highs and extreme lows) ────
    // LOW  (price < median × 0.4): selector caught a "desde X €" / accessory price.
    // HIGH (price > median × 2.5): third-party seller temporarily holding the buybox
    //      at an inflated price (caso B01N7RLGIJ Mario Kart 285/335 €).
    // Bypass for legit movements: was_price corroborates a real flash deal (RRP ≥
    // 4× price) or a pre-existing high range (max ≥ 0.8 × new price). Auto-accept
    // after 3 consecutive anomalies so a genuine price shift can recover.
    const recentRows = await db.execute(sql`
      SELECT price::float AS p FROM price_history
      WHERE product_id = ${productId}
      ORDER BY scraped_at DESC LIMIT 5
    `);
    const recent = (recentRows.rows as any[]).map(r => r.p as number);
    const anomalyCount = current?.consecutiveAnomalies ?? 0;
    const bypassed = current?.bypassAnomalyGuard ?? false;
    if (recent.length >= 3 && anomalyCount < 3 && !bypassed) {
      const sorted = recent.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const lowSuspect  = result.price < median * 0.4 && !(result.wasPrice != null && result.wasPrice >= result.price * 4);
      const highSuspect = result.price > median * 2.5 && (allTimeMax === null || result.price > allTimeMax * 1.5);
      if (lowSuspect || highSuspect) {
        const newCount = anomalyCount + 1;
        const dir = lowSuspect ? '<<' : '>>';
        const cause = lowSuspect ? 'probable accesorio o "Nuevo y de segunda mano"' : 'probable tercero/importación con precio inflado';
        const msg = `Precio anómalo descartado (${newCount}/3): ${result.price.toFixed(2)} € ${dir} mediana ${median.toFixed(2)} € — ${cause}`;
        console.warn(`[scheduler] ${label} → ANOMALÍA (${newCount}/3): ${result.price.toFixed(2)} € ${dir} mediana ${median.toFixed(2)} € — descartado`);
        await db.update(products).set({
          consecutiveAnomalies: newCount,
          lastError: msg,
        }).where(eq(products.id, productId));
        await enqueueAnomaly({
          productId,
          type: lowSuspect ? 'low' : 'high',
          suspectPrice: result.price,
          medianPrice: median,
          message: msg,
        });
        return;
      }
    }

    const saleInfo = await persistScrapeResult(productId, result, { allTimeMax, scrapeCount, daysSpan, label });

    // Product just came back in stock — notify owner
    if (wasUnavailable) {
      console.log(`[scheduler] ${label} → back in stock, sending notification`);
      await notifyBackInStock(productId, result.price, result.currency, result.name, result.imageUrl, url);
    }

    await processAlerts(productId, result.price, result.currency, label, result.imageUrl, url);
  } catch (err) {
    if (err instanceof ProductUnavailableError) {
      console.log(`[scheduler] ${label} → No disponible${err.reason ? ` (${err.reason})` : ''}`);
      // Same transaction: mark unavailable + bump consecutive_unavailable counter
      // + auto-unfeature if it was in /ofertas via auto-curation. Pin/mute admin
      // overrides are preserved as-is.
      await db.execute(sql`
        UPDATE products SET
          is_available = FALSE,
          last_error   = NULL,
          is_on_sale   = FALSE,
          sale_tier    = NULL,
          deal_score   = NULL,
          consecutive_unavailable = consecutive_unavailable + 1,
          is_public    = CASE WHEN feature_lock = 'auto' THEN FALSE ELSE is_public END,
          featured_at  = CASE WHEN feature_lock = 'auto' THEN NULL  ELSE featured_at END
        WHERE id = ${productId}
      `);
      // Reset stock alerts so they fire again when the product comes back
      await db.update(alerts).set({ notifiedAt: null })
        .where(and(eq(alerts.productId, productId), eq(alerts.alertType, 'stock')));
      // Queue for admin review when the unavailability has a structured reason
      // (used buybox, unqualified buybox). Admin can confirm or recover the
      // capture if our detection misclassified.
      if (err.reason) {
        await enqueueAnomaly({
          productId,
          type: err.reason,
          suspectPrice: null,
          medianPrice: null,
          message: err.message,
          snippet: err.snippet,
        });
      }
      // Orphan variants that go unavailable get an immediate purge (1 strike)
      // because the parent twister will re-discover them when Amazon restocks.
      await maybePurgeOrphan(productId, label, 'orphan variant unavailable');
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
      // Orphan variants whose generic scrape errors hit 3-strike `is_failed`
      // get the same fast purge — nothing useful in keeping them.
      if (isFailed) {
        await maybePurgeOrphan(productId, label, `orphan variant 3x scrape errors (${msg.slice(0, 60)})`);
      }
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

  // Only notify users who have explicitly opted in via a `stock` alert.
  // The legacy "products.userId == owner gets notified by default" block
  // was removed because it spammed the system user (mail to
  // system@ojoalprecio.local + Telegram to the public channel as fallback)
  // whenever a variant came back into stock. Followers who want stock
  // notifications must add a stock-type alert explicitly.
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
      // Telegram: only if the alert specifies a personal chat_id. Never fall
      // back to the public channel — that would broadcast a personal stock
      // notification to every subscriber.
      if ((channel === 'telegram' || channel === 'both') && alert.telegramChatId) {
        await sendTelegramBackInStock({ chatId: alert.telegramChatId, productName, productUrl: productAffilUrl, currentPrice, currency });
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

      // Telegram: only with a personal chat_id on the alert. No public-channel
      // fallback — a price alert is per-user and must not be broadcast.
      if ((channel === 'telegram' || channel === 'both') && alert.telegramChatId) {
        await sendTelegramAlert({
          chatId: alert.telegramChatId,
          productName,
          productUrl: productAffilUrl,
          currentPrice,
          thresholdLabel,
          currency,
        });
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

/**
 * Hourly housekeeping. Three light maintenance tasks bundled so they share a
 * single cron slot — runs at :15 every hour, deliberately offset from the
 * main scrape cycle (:00) and the category-import (:10).
 *
 * 1. Featured cap — demote auto-featured products that fell out of the
 *    top-N by deal_score. Used to run after every successful scrape, which
 *    invoked a window function across the whole catalog hundreds of times
 *    per cycle; once an hour is plenty.
 * 2. Anomaly queue TTL — pending anomalies older than 60 days get deleted.
 *    Reviewed (approved/denied) ones are already pruned at 30 days in the
 *    /admin/anomalies route (lazy on each list load).
 * 3. Purged-ASIN blacklist TTL — entries older than 30 days are removed.
 *    The ingest filter already ignores them past 30 days; this just keeps
 *    the table size in check.
 */
async function runHourlyMaintenance(): Promise<void> {
  // 1. Featured cap
  try {
    const capRaw = await getSetting('featured_max_count', 100);
    const cap    = Math.max(1, Math.min(500, Number(capRaw)));
    const demoted = await db.execute(sql`
      WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY deal_score DESC NULLS LAST, featured_at DESC NULLS LAST) AS rnk
        FROM products
        WHERE is_active = TRUE AND is_public = TRUE AND feature_lock = 'auto'
      )
      UPDATE products SET is_public = FALSE, featured_at = NULL
      WHERE id IN (SELECT id FROM ranked WHERE rnk > ${cap})
      RETURNING id
    `);
    if (demoted.rows.length > 0) {
      console.log(`[maintenance] cap: demoted ${demoted.rows.length} auto-featured (cap=${cap})`);
    }
  } catch (err) { console.error('[maintenance] featured cap failed:', err); }

  // 2. Anomaly queue TTL — 60d for pending
  try {
    const dropped = await db.execute(sql`
      DELETE FROM scrape_anomalies
      WHERE status = 'pending' AND detected_at < NOW() - INTERVAL '60 days'
      RETURNING id
    `);
    if (dropped.rows.length > 0) {
      console.log(`[maintenance] anomalies: dropped ${dropped.rows.length} stale pending`);
    }
  } catch (err) { console.error('[maintenance] anomaly TTL failed:', err); }

  // 3. Purged-ASIN blacklist TTL — 30d
  try {
    const dropped = await db.execute(sql`
      DELETE FROM purged_asins WHERE purged_at < NOW() - INTERVAL '30 days' RETURNING asin
    `);
    if (dropped.rows.length > 0) {
      console.log(`[maintenance] blacklist: pruned ${dropped.rows.length} entries`);
    }
  } catch (err) { console.error('[maintenance] blacklist TTL failed:', err); }
}

export function startScheduler(): void {
  console.log(`[scheduler] Starting with schedule: "${CHECK_INTERVAL}"`);
  checkAllProducts();
  cron.schedule(CHECK_INTERVAL, () => { checkAllProducts(); });

  // Hourly housekeeping at :15 — between the main scrape (:00) and the
  // category-import (:10).
  cron.schedule('15 * * * *', () => {
    runHourlyMaintenance().catch(err => console.error('[maintenance] failed:', err));
  });
  console.log('[maintenance] Housekeeping scheduled at :15 each hour (featured cap, anomaly TTL, blacklist TTL).');

  const { startCategoryImportScheduler } = require('./category-import');
  startCategoryImportScheduler();
}

export { checkProduct };
