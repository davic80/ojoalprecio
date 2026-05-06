import cron from 'node-cron';
import { db } from '../db/client';
import { products, users, amazonCategorySources } from '../db/schema';
import { eq, sql } from 'drizzle-orm';
import { scrapeAmazonCategory, normaliseAmazonUrl, extractAsin } from '../scraper/amazon';
import { getSetting } from '../db/settings';

const SYSTEM_EMAIL = 'system@ojoalprecio.local';
const PRODUCTS_PER_HOUR = 40;
const MS_BETWEEN_ADDS = 60_000; // 1 minute

async function getSystemUserId(): Promise<number | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SYSTEM_EMAIL))
    .limit(1);
  return user?.id ?? null;
}

async function importNextCategory(): Promise<void> {
  const enabled = Boolean(await getSetting('category_import_enabled', true));
  if (!enabled) {
    console.log('[category-import] Desactivado via ajustes admin, saltando.');
    return;
  }

  const systemUserId = await getSystemUserId();
  if (!systemUserId) {
    console.log('[category-import] System user not found, skipping.');
    return;
  }

  const [source] = await db
    .select()
    .from(amazonCategorySources)
    .where(eq(amazonCategorySources.isActive, true))
    .orderBy(sql`${amazonCategorySources.lastImportedAt} ASC NULLS FIRST`)
    .limit(1);

  if (!source) {
    console.log('[category-import] No active category sources configured.');
    return;
  }

  console.log(`[category-import] Scraping: ${source.name} — ${source.amazonUrl}`);

  let urls: string[];
  try {
    urls = await scrapeAmazonCategory(source.amazonUrl, PRODUCTS_PER_HOUR);
  } catch (err) {
    console.error('[category-import] Failed to scrape category:', err);
    return;
  }

  await db
    .update(amazonCategorySources)
    .set({ lastImportedAt: new Date() })
    .where(eq(amazonCategorySources.id, source.id));

  console.log(`[category-import] ${urls.length} products found in ${source.name}`);

  // Filter out ASINs already tracked by anyone
  const newProducts: Array<{ asin: string; url: string }> = [];
  for (const productUrl of urls) {
    const asin = extractAsin(productUrl);
    if (!asin) continue;
    const [existing] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.asin, asin))
      .limit(1);
    if (!existing) newProducts.push({ asin, url: normaliseAmazonUrl(asin) });
  }

  console.log(`[category-import] ${newProducts.length} new products to add, one/minute…`);

  newProducts.forEach(({ asin, url }, idx) => {
    setTimeout(async () => {
      try {
        await db.insert(products).values({
          userId: systemUserId,
          asin,
          url,
          categoryId: source.categoryId ?? null,
          isPublic: false,
        });
        console.log(`[category-import] + ${asin} (${source.name})`);
      } catch (err) {
        // Ignore unique constraint violations (race condition with another user adding the same ASIN)
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('unique') && !msg.includes('duplicate')) {
          console.error(`[category-import] Error inserting ${asin}:`, err);
        }
      }
    }, idx * MS_BETWEEN_ADDS);
  });
}

export function startCategoryImportScheduler(): void {
  cron.schedule('10 * * * *', importNextCategory);
  console.log('[category-import] Scheduled: every hour at :10.');
}
