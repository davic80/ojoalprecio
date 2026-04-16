import cron from 'node-cron';
import { db } from '../db/client';
import { products, priceHistory, alerts } from '../db/schema';
import { eq, and, isNull, lte, desc } from 'drizzle-orm';
import { scrapeProduct } from '../scraper/amazon';
import { sendPriceAlert } from '../mailer';

const CHECK_INTERVAL = process.env.CHECK_INTERVAL_CRON ?? '0 * * * *'; // every hour

// Semaphore to avoid concurrent scraping overloading the RPi
let isRunning = false;

async function checkAllProducts(): Promise<void> {
  if (isRunning) {
    console.log('[scheduler] Previous run still active, skipping.');
    return;
  }
  isRunning = true;

  try {
    const activeProducts = await db
      .select()
      .from(products)
      .where(eq(products.isActive, true));

    console.log(`[scheduler] Checking ${activeProducts.length} products…`);

    for (const product of activeProducts) {
      await checkProduct(product.id, product.url, product.name ?? product.asin);

      // Stagger requests: wait 5-15s between products to avoid rate limiting
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
  try {
    console.log(`[scheduler] Scraping: ${label}`);
    const result = await scrapeProduct(url);

    // Save to price_history
    await db.insert(priceHistory).values({
      productId,
      price: String(result.price),
      currency: result.currency,
    });

    // Update product metadata if needed (name, imageUrl)
    await db
      .update(products)
      .set({
        name: result.name,
        imageUrl: result.imageUrl,
        lastError: null,
      })
      .where(eq(products.id, productId));

    console.log(`[scheduler] ${label} → ${result.price} ${result.currency}`);

    // Check alerts
    await processAlerts(productId, result.price, result.currency, label, result.imageUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scheduler] Failed for ${label}: ${msg}`);

    await db
      .update(products)
      .set({ lastError: msg })
      .where(eq(products.id, productId));
  }
}

async function processAlerts(
  productId: number,
  currentPrice: number,
  currency: string,
  productName: string,
  imageUrl: string | null | undefined,
): Promise<void> {
  // Find active alerts for this product where price <= threshold and not yet notified
  const activeAlerts = await db
    .select()
    .from(alerts)
    .where(
      and(
        eq(alerts.productId, productId),
        eq(alerts.isActive, true),
        isNull(alerts.notifiedAt),
      ),
    );

  for (const alert of activeAlerts) {
    const threshold = parseFloat(String(alert.thresholdPrice));
    if (currentPrice <= threshold) {
      try {
        // Get canonical URL
        const [product] = await db
          .select({ url: products.url })
          .from(products)
          .where(eq(products.id, productId))
          .limit(1);

        await sendPriceAlert({
          to: alert.notificationEmail,
          productName,
          productUrl: product?.url ?? `https://www.amazon.es/dp/${productId}`,
          currentPrice,
          thresholdPrice: threshold,
          imageUrl,
          currency,
        });

        // Mark alert as notified
        await db
          .update(alerts)
          .set({ notifiedAt: new Date() })
          .where(eq(alerts.id, alert.id));
      } catch (err) {
        console.error(`[scheduler] Failed to send alert ${alert.id}:`, err);
      }
    }
  }
}

export function startScheduler(): void {
  console.log(`[scheduler] Starting with schedule: "${CHECK_INTERVAL}"`);

  // Run immediately on startup
  checkAllProducts();

  cron.schedule(CHECK_INTERVAL, () => {
    checkAllProducts();
  });
}

// Export for manual triggers from the UI
export { checkProduct };
