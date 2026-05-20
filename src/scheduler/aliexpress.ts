import cron from 'node-cron';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  AliExpressClient,
  AliExpressError,
  AliExpressPermissionError,
  getAliExpressClient,
  extractBrandModel,
  textSimilarity,
} from '../marketplaces/aliexpress';
import type { AliExpressProduct, SimilarSource } from '../marketplaces/aliexpress/types';

/**
 * 8-hour refresh job for tracked AliExpress products.
 *
 * Mirrors the Amazon scheduler in spirit but simpler: AE doesn't have a
 * sale-tier ladder, no buybox semantics, no auto-curation of /ofertas.
 * Each tick re-fetches the catalog row + the similars pool and appends a
 * fresh price_history entry. Price-drop alerts (Phase D2) bolt on top of
 * the refresh by reading notified_at + threshold_price.
 *
 * Pacing: AliExpress rate-limits at ~1 req/sec per app. We sleep 250ms
 * between calls and skip a product on transient errors (rate limit or
 * network) so one bad product can't stall the whole batch.
 *
 * Cadence: every 8 hours at :05 (Madrid TZ) so we offset from the
 * Amazon scheduler's :00 firing.
 */

const SIMILARITY_THRESHOLD = 0.30;
const MIN_KEPT_BEFORE_FALLBACK = 3;
const MAX_SIMILARS = 12;
const QUERY_PAGE_SIZE = 30;
const SIMILARS_TTL_DAYS = 7;       // prune edges not refreshed within this window
const PER_REQUEST_SLEEP_MS = 250;  // ~4 req/s budget, well under the per-app limit

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * Re-fetch a single AE product and write the latest snapshot + price tick.
 * Returns the new salePrice, or null when the API didn't return the product
 * (deleted listing, transient error, etc.).
 */
export async function refreshAEProduct(client: AliExpressClient, productId: string): Promise<AliExpressProduct | null> {
  const fresh = await client.productDetail(productId).catch((err: unknown) => {
    if (err instanceof AliExpressError) {
      console.warn(`[ae-refresh] productDetail(${productId}) failed: ${err.message}`);
      return null;
    }
    throw err;
  });
  if (!fresh) return null;

  await db.transaction(async (tx) => {
    await tx.execute(upsertProductSql(fresh));
    await tx.execute(sql`
      INSERT INTO aliexpress_price_history (product_id, price, currency)
      VALUES (${fresh.productId}, ${fresh.salePrice}, ${fresh.currency})
    `);
  });
  return fresh;
}

/** Re-run productQuery for a master, upsert seen candidates, prune stale edges. */
export async function refreshSimilars(client: AliExpressClient, master: AliExpressProduct): Promise<number> {
  const keywords = extractBrandModel(master.title);
  if (!keywords) return 0;

  let queryRes;
  try {
    queryRes = await client.productQuery({
      keywords,
      maxSalePrice: master.salePrice > 0 ? Math.ceil(master.salePrice * 1.5) : undefined,
      pageSize:     QUERY_PAGE_SIZE,
    });
  } catch (err) {
    if (err instanceof AliExpressPermissionError) throw err;
    console.warn(`[ae-refresh] productQuery for similars of ${master.productId} failed: ${(err as Error).message}`);
    return 0;
  }

  const scored = queryRes.products
    .filter(p => p.productId !== master.productId)
    .map(p => ({ product: p, source: 'query' as SimilarSource, textScore: textSimilarity(master.title, p.title) }));

  const strict = scored.filter(c => c.textScore >= SIMILARITY_THRESHOLD).sort((a, b) => b.textScore - a.textScore).slice(0, MAX_SIMILARS);
  const kept = strict.length >= MIN_KEPT_BEFORE_FALLBACK
    ? strict
    : scored.sort((a, b) => b.textScore - a.textScore).slice(0, MAX_SIMILARS);

  if (kept.length === 0) return 0;

  await db.transaction(async (tx) => {
    for (const cand of kept) {
      await tx.execute(upsertProductSql(cand.product));
      await tx.execute(sql`
        INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source, text_score, last_seen_at)
        VALUES (${master.productId}, ${cand.product.productId}, ${cand.source}, ${cand.textScore.toFixed(2)}, NOW())
        ON CONFLICT (master_product_id, similar_product_id) DO UPDATE
          SET text_score   = EXCLUDED.text_score,
              last_seen_at = NOW()
      `);
    }
    // TTL pruning — drop edges that haven't been re-seen in a week.
    // The orphaned aliexpress_products rows stay (a similar removed from
    // ONE master may still be a similar of ANOTHER); we'd need a separate
    // garbage-collection pass to remove unreferenced catalog entries.
    await tx.execute(sql`
      DELETE FROM aliexpress_similars
      WHERE master_product_id = ${master.productId}
        AND last_seen_at < NOW() - INTERVAL '${sql.raw(String(SIMILARS_TTL_DAYS))} days'
    `);
  });
  return kept.length;
}

/**
 * Refresh every distinct tracked AE product. Sequential to respect the
 * per-app rate limit. Returns a summary for logging.
 */
export async function refreshAllAETracks(client: AliExpressClient): Promise<{
  totalProducts: number; refreshed: number; failed: number; skippedSimilars: number;
}> {
  const productIds = await db.execute(sql`
    SELECT DISTINCT product_id FROM aliexpress_user_tracks
  `);
  const ids = (productIds.rows as Array<{ product_id: string }>).map(r => r.product_id);

  let refreshed = 0, failed = 0, skippedSimilars = 0;
  for (const productId of ids) {
    try {
      const master = await refreshAEProduct(client, productId);
      if (!master) { failed++; continue; }
      refreshed++;
      await sleep(PER_REQUEST_SLEEP_MS);
      const n = await refreshSimilars(client, master);
      if (n === 0) skippedSimilars++;
      await sleep(PER_REQUEST_SLEEP_MS);
    } catch (err) {
      failed++;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[ae-refresh] product ${productId} failed: ${msg}`);
      // Permission errors mean smartmatch/hotproduct perms not granted yet.
      // Stop the loop only on a permission error so we don't spam the same
      // failure for every tracked product.
      if (err instanceof AliExpressPermissionError) {
        console.warn('[ae-refresh] permission error — aborting batch');
        break;
      }
    }
  }

  return { totalProducts: ids.length, refreshed, failed, skippedSimilars };
}

/** Wire the 8h cron. Skips entirely when no AE client is configured. */
export function startAliExpressScheduler(): void {
  const client = getAliExpressClient();
  if (!client) {
    console.log('[ae-scheduler] ALIEXPRESS_* env vars not set — AE refresh disabled.');
    return;
  }
  const tz = 'Europe/Madrid';
  // Every 8h at :05, offset from the Amazon scheduler's :00.
  cron.schedule('5 */8 * * *', async () => {
    const started = Date.now();
    console.log('[ae-scheduler] starting 8h refresh…');
    try {
      const r = await refreshAllAETracks(client);
      const ms = Date.now() - started;
      console.log(`[ae-scheduler] done in ${(ms / 1000).toFixed(1)}s — ${r.refreshed}/${r.totalProducts} refreshed, ${r.failed} failed, similars skipped on ${r.skippedSimilars}.`);
    } catch (err) {
      console.error('[ae-scheduler] uncaught:', err);
    }
  }, { timezone: tz });
  console.log('[ae-scheduler] AliExpress 8h refresh activated (every 8h at :05 Europe/Madrid).');
}

/** Reused upsert — same shape the ingest module uses. */
function upsertProductSql(p: AliExpressProduct) {
  return sql`
    INSERT INTO aliexpress_products (
      product_id, title, image_url, product_url, promotion_url,
      sale_price, original_price, discount_pct, currency,
      rating, orders_count, category_id, category_name, shop_id, shop_name,
      is_available, last_fetched_at
    ) VALUES (
      ${p.productId}, ${p.title}, ${p.imageUrl}, ${p.productUrl}, ${p.promotionUrl},
      ${p.salePrice}, ${p.originalPrice}, ${p.discountPct}, ${p.currency},
      ${p.rating}, ${p.ordersCount}, ${p.categoryId}, ${p.categoryName}, ${p.shopId}, ${p.shopName},
      TRUE, NOW()
    )
    ON CONFLICT (product_id) DO UPDATE SET
      title           = EXCLUDED.title,
      image_url       = EXCLUDED.image_url,
      product_url     = EXCLUDED.product_url,
      promotion_url   = EXCLUDED.promotion_url,
      sale_price      = EXCLUDED.sale_price,
      original_price  = EXCLUDED.original_price,
      discount_pct    = EXCLUDED.discount_pct,
      currency        = EXCLUDED.currency,
      rating          = EXCLUDED.rating,
      orders_count    = EXCLUDED.orders_count,
      category_id     = EXCLUDED.category_id,
      category_name   = EXCLUDED.category_name,
      shop_id         = EXCLUDED.shop_id,
      shop_name       = EXCLUDED.shop_name,
      is_available    = TRUE,
      last_fetched_at = NOW()
  `;
}
