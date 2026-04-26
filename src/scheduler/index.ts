import cron from 'node-cron';
import { db } from '../db/client';
import { products, priceHistory, alerts, users } from '../db/schema';
import { eq, and, desc, min } from 'drizzle-orm';
import { scrapeProduct, affiliateUrl, ProductUnavailableError } from '../scraper/amazon';
import { sendPriceAlert, sendBackInStockAlert } from '../mailer';
import { sendTelegramAlert, sendTelegramBackInStock } from '../mailer/telegram';

const CHECK_INTERVAL = process.env.CHECK_INTERVAL_CRON ?? '0 * * * *';

let isRunning = false;

async function checkAllProducts(): Promise<void> {
  if (isRunning) {
    console.log('[scheduler] Previous run still active, skipping.');
    return;
  }
  isRunning = true;

  try {
    const activeProducts = await db.select().from(products).where(eq(products.isActive, true));
    console.log(`[scheduler] Checking ${activeProducts.length} products…`);

    for (const product of activeProducts) {
      await checkProduct(product.id, product.url, product.name ?? product.asin);
      const delay = 5000 + Math.random() * 10000;
      await new Promise((r) => setTimeout(r, delay));
    }

    console.log('[scheduler] Cycle complete.');
  } catch (err) {
    console.error('[scheduler] Unexpected error in cycle:', err);
  } finally {
    isRunning = false;
  }
}

async function checkProduct(productId: number, url: string, label: string): Promise<void> {
  // Load current state to detect availability transitions
  const [current] = await db.select({ isAvailable: products.isAvailable }).from(products).where(eq(products.id, productId)).limit(1);
  const wasUnavailable = current ? !current.isAvailable : false;

  try {
    console.log(`[scheduler] Scraping: ${label}`);
    const result = await scrapeProduct(url);

    await db.insert(priceHistory).values({ productId, price: String(result.price), currency: result.currency });
    await db.update(products).set({
      name: result.name,
      imageUrl: result.imageUrl,
      lastError: null,
      isAvailable: true,
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
      await db.update(products).set({ isAvailable: false, lastError: null }).where(eq(products.id, productId));
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed for ${label}: ${msg}`);
      await db.update(products).set({ lastError: msg }).where(eq(products.id, productId));
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
      const targetPrice = ref * (1 - drop / 100);
      shouldFire = ref > 0 && drop > 0 && currentPrice <= targetPrice;
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
          currentPrice,
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
    } catch (err) {
      console.error(`[scheduler] Failed to send alert ${alert.id}:`, err);
    }
  }
}

export function startScheduler(): void {
  console.log(`[scheduler] Starting with schedule: "${CHECK_INTERVAL}"`);
  checkAllProducts();
  cron.schedule(CHECK_INTERVAL, () => { checkAllProducts(); });
}

export { checkProduct };
