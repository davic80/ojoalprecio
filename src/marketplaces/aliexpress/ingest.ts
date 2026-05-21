import { sql } from 'drizzle-orm';
import { db } from '../../db/client';
import type { AliExpressClient } from './client';
import type { AliExpressProduct, SimilarCandidate, SimilarSource } from './types';
import { upsertAEProductSql } from './persist';
import { discoverSimilars } from './similars';

/**
 * One-shot synchronous ingest for a single AliExpress product. Hard SLA
 * <60s — typically completes in 1-3s (1 productDetail + 1 productQuery,
 * optionally + 1 smartmatch when strict matches are scarce).
 *
 * Steps:
 *   1. productDetail(productId) → upsert into aliexpress_products
 *   2. Insert into aliexpress_user_tracks (idempotent)
 *   3. Insert the first aliexpress_price_history entry
 *   4. Discover similars via the shared 3-layer pipeline in
 *      ./similars.ts (strict query → smartmatch → loose query)
 *   5. Upsert each similar into aliexpress_products and write the
 *      master ↔ similar edges into aliexpress_similars.
 *
 * Returns the master product + the similars actually persisted.
 */

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


