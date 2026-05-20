import { sql } from 'drizzle-orm';
import { db } from '../../db/client';
import type { AliExpressClient } from './client';
import type { AliExpressProduct, SimilarCandidate, SimilarSource } from './types';
import { extractBrandModel, textSimilarity } from './text';
import { upsertAEProductSql } from './persist';

/**
 * One-shot synchronous ingest for a single AliExpress product. Hard SLA
 * <60s — typically completes in 1-3s (1 productDetail + 1 productQuery).
 *
 * Steps:
 *   1. productDetail(productId) → upsert into aliexpress_products
 *   2. Insert into aliexpress_user_tracks (idempotent)
 *   3. Insert the first aliexpress_price_history entry
 *   4. Discover similars:
 *      - Strategy A (default-perm): productQuery with brand+model keywords,
 *        score each result via Jaccard against the master title,
 *        keep score ≥ SIMILARITY_THRESHOLD.
 *      - Fallback (when <MIN_KEPT survive A): keep the top-N raw query
 *        results without the score filter. Real `smartmatch` swaps in
 *        here once the extra permission is granted (see
 *        project_aliexpress.md).
 *   5. Upsert each similar into aliexpress_products and write the
 *      master ↔ similar edges into aliexpress_similars.
 *
 * Returns the master product + the similars actually persisted.
 */

const SIMILARITY_THRESHOLD = 0.30;   // Jaccard cut-off for strategy A
const MIN_KEPT_BEFORE_FALLBACK = 3;
const MAX_SIMILARS = 12;             // hard cap stored per master
const QUERY_PAGE_SIZE = 30;          // results requested from productQuery

export interface IngestResult {
  master:   AliExpressProduct;
  similars: SimilarCandidate[];
  /** Source actually used for the kept similars. */
  similarsSource: SimilarSource;
}

export async function ingestProduct(opts: {
  client:      AliExpressClient;
  productId:   string;
  userId:      number;
  thresholdPrice?: number | null;
}): Promise<IngestResult> {
  const { client, productId, userId } = opts;

  // 1) Fetch master ──────────────────────────────────────────────────────
  const master = await client.productDetail(productId);
  if (!master) throw new Error(`AliExpress productId ${productId} not found via productDetail`);

  // 2) Persist master + 3) follow + 4) first price tick — atomic.
  await db.transaction(async (tx) => {
    await tx.execute(upsertAEProductSql(master));
    await tx.execute(sql`
      INSERT INTO aliexpress_user_tracks (user_id, product_id, threshold_price, alert_enabled)
      VALUES (${userId}, ${master.productId}, ${opts.thresholdPrice ?? null}, TRUE)
      ON CONFLICT (user_id, product_id) DO NOTHING
    `);
    await tx.execute(sql`
      INSERT INTO aliexpress_price_history (product_id, price, currency)
      VALUES (${master.productId}, ${master.salePrice}, ${master.currency})
    `);
  });

  // 5) Similars discovery — outside the master transaction so a flaky
  //    query call doesn't roll back the user's primary track.
  const similars = await discoverSimilars(client, master);

  if (similars.length > 0) {
    await db.transaction(async (tx) => {
      for (const cand of similars) {
        await tx.execute(upsertAEProductSql(cand.product));
        await tx.execute(sql`
          INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source, text_score, last_seen_at)
          VALUES (${master.productId}, ${cand.product.productId}, ${cand.source}, ${cand.textScore.toFixed(2)}, NOW())
          ON CONFLICT (master_product_id, similar_product_id) DO UPDATE
            SET text_score = EXCLUDED.text_score,
                last_seen_at = NOW()
        `);
      }
    });
  }

  return {
    master,
    similars,
    similarsSource: similars[0]?.source ?? 'query',
  };
}

/** Strategy A with fallback. Returns up to MAX_SIMILARS scored candidates. */
async function discoverSimilars(client: AliExpressClient, master: AliExpressProduct): Promise<SimilarCandidate[]> {
  const keywords = extractBrandModel(master.title);
  if (!keywords) return [];

  let queryRes;
  try {
    queryRes = await client.productQuery({
      keywords,
      // Cap at 1.5x master price so we surface equivalent-or-cheaper
      // listings rather than every accessory in the category.
      maxSalePrice: master.salePrice > 0 ? Math.ceil(master.salePrice * 1.5) : undefined,
      pageSize:     QUERY_PAGE_SIZE,
    });
  } catch (err) {
    // Network/permission/rate-limit issues here are non-fatal for the
    // master ingest — the user can still see their tracked product, and
    // the 8h cron will retry similars on the next pass.
    console.warn(`[aliexpress] productQuery failed for similars of ${master.productId}: ${(err as Error).message}`);
    return [];
  }

  // Score each candidate (excluding the master itself).
  const scored = queryRes.products
    .filter(p => p.productId !== master.productId)
    .map(p => ({ product: p, source: 'query' as SimilarSource, textScore: textSimilarity(master.title, p.title) }));

  const strict = scored
    .filter(c => c.textScore >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.textScore - a.textScore)
    .slice(0, MAX_SIMILARS);

  if (strict.length >= MIN_KEPT_BEFORE_FALLBACK) return strict;

  // Fallback: keep top-N by score regardless of threshold (still useful
  // because productQuery already restricted by keywords + price cap).
  // Mark as 'query' since we used the same endpoint. When smartmatch
  // perm lands, this is where the smartmatch call slots in.
  const loose = scored
    .sort((a, b) => b.textScore - a.textScore)
    .slice(0, MAX_SIMILARS);
  return loose;
}

