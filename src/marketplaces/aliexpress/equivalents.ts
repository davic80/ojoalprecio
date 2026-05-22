import { sql } from 'drizzle-orm';
import { db } from '../../db/client';
import type { AliExpressClient } from './client';
import type { AliExpressProduct } from './types';
import { extractBrandModel, textSimilarity } from './text';
import { AliExpressError } from './client';
import { upsertAEProductSql } from './persist';

/**
 * Cross-marketplace discovery: given an Amazon product (title + current
 * price), find the best AliExpress equivalent. Returns the candidate
 * plus eligibility — "eligible" means a banner is worth showing on the
 * /p/:asin page.
 *
 * Strategy mirrors the same-marketplace similars: extract brand+model
 * tokens from the Amazon title, query AE, score each candidate with
 * Jaccard, pick the top result. The thresholds are stricter than the
 * intra-AE similars because here the candidate has to be *the same
 * product* (or close to it), not just "you may also like".
 *
 * Eligibility (both must hold):
 *   - text_score   >= 0.25   ← was 0.40; relaxed because verbose AE
 *                              titles in Spanish + English mix were
 *                              suppressing legit matches around 0.30.
 *                              False-positive rate trade-off accepted
 *                              for higher coverage.
 *   - pct_cheaper  >= 10.00  ← below 10% the user has no real reason to
 *                              jump marketplace
 */

const TEXT_SCORE_MIN  = 0.25;
const PCT_CHEAPER_MIN = 10.00;
// Upper bound on saving %. Legit cross-marketplace cases (same product on
// Amazon vs AE) land in the 10-60% range, occasionally up to ~75%. A 90%+
// "discount" almost always means we matched the Amazon product to an
// accessory or a much smaller SKU of the same brand — e.g. €500 MacBook
// → €5 tempered glass for MacBook, €200 dron → €5 screen protector for
// dron, €150 router → €15 different-model router. Dry-run on the prod
// catalog (2026-05-22) showed ~50% of >80%-cheaper "matches" were
// accessories. Reject them so we don't erode user trust with bogus banners.
const PCT_CHEAPER_MAX = 80.00;
const QUERY_PAGE_SIZE = 20;
const TTL_HOURS       = 24;

export interface EquivalentResult {
  /** The AE product picked as best match, or null when no candidate cleared
      the keyword-search bar (we still store the negative for the cache). */
  candidate:   AliExpressProduct | null;
  textScore:   number;
  pctCheaper:  number;
  isEligible:  boolean;
}

/**
 * One-shot discovery. Pure: makes API calls + scores, persists nothing.
 * Use `discoverAndPersist` for the cached-with-TTL flow.
 */
export async function findAEEquivalent(
  client: AliExpressClient,
  amazonProduct: { title: string; price: number },
): Promise<EquivalentResult> {
  const keywords = extractBrandModel(amazonProduct.title);
  const emptyNegative: EquivalentResult = { candidate: null, textScore: 0, pctCheaper: 0, isEligible: false };
  if (!keywords) return emptyNegative;

  let queryRes;
  try {
    queryRes = await client.productQuery({
      keywords,
      // Cap candidates at the same Amazon price — anything more expensive
      // on AE is never a useful equivalent to surface. Round UP to the next
      // integer because AE rejects float values for this param with the
      // (cryptic) error "null#max_sale_price" — they expect whole-euro
      // integers, not decimals. The intra-AE similars code (ingest.ts,
      // scheduler) already uses Math.ceil(...); mirror that pattern here.
      maxSalePrice: amazonProduct.price > 0 ? Math.ceil(amazonProduct.price) : undefined,
      pageSize:     QUERY_PAGE_SIZE,
    });
  } catch (err) {
    if (err instanceof AliExpressError) {
      console.warn(`[ae-equivalent] productQuery failed: ${err.message}`);
      return emptyNegative;
    }
    throw err;
  }

  // Score every candidate, pick the highest. Ties broken by lowest price.
  let best: { p: AliExpressProduct; score: number } | null = null;
  for (const p of queryRes.products) {
    const score = textSimilarity(amazonProduct.title, p.title);
    if (!best || score > best.score || (score === best.score && p.salePrice < best.p.salePrice)) {
      best = { p, score };
    }
  }
  if (!best || best.score === 0) return emptyNegative;

  const pctCheaper = amazonProduct.price > 0
    ? ((amazonProduct.price - best.p.salePrice) / amazonProduct.price) * 100
    : 0;
  const isEligible = best.score >= TEXT_SCORE_MIN
                  && pctCheaper >= PCT_CHEAPER_MIN
                  && pctCheaper <= PCT_CHEAPER_MAX;

  return {
    candidate:  best.p,
    textScore:  best.score,
    pctCheaper,
    isEligible,
  };
}

/**
 * Cached variant: serves the stored equivalent when fresh (< TTL_HOURS),
 * otherwise runs `findAEEquivalent`, persists the result (positive OR
 * negative), and returns it.
 *
 * Persists the AE candidate's catalog row into `aliexpress_products`
 * (upsert) so the FK on `amazon_ae_equivalents.ae_product_id` resolves.
 *
 * Returns null when persisted-and-fresh-but-not-eligible (caller treats
 * as "no banner this view") to keep the call-site branch simple.
 */
export async function discoverAndPersistEquivalent(
  client: AliExpressClient,
  amazonProductId: number,
  amazonProduct: { title: string; price: number },
): Promise<EquivalentResult | null> {
  // Read cache
  const cached = await db.execute(sql`
    SELECT amazon_product_id, ae_product_id, text_score::float AS "textScore",
           ae_price_snapshot::float AS "aePrice", pct_cheaper::float AS "pctCheaper",
           is_eligible, checked_at
    FROM amazon_ae_equivalents
    WHERE amazon_product_id = ${amazonProductId}
  `);
  const row = cached.rows[0] as any;
  if (row) {
    const ageMs = Date.now() - new Date(row.checked_at).getTime();
    if (ageMs < TTL_HOURS * 60 * 60 * 1000) {
      // Hot cache — serve as-is. No DB writes, no API call.
      if (!row.ae_product_id) return { candidate: null, textScore: 0, pctCheaper: 0, isEligible: false };
      const ae = await fetchCachedAEProduct(row.ae_product_id);
      return {
        candidate:  ae,
        textScore:  Number(row.textScore ?? 0),
        pctCheaper: Number(row.pctCheaper ?? 0),
        isEligible: !!row.is_eligible,
      };
    }
  }

  // Cold / stale → query the API, persist, return.
  const fresh = await findAEEquivalent(client, amazonProduct);

  if (fresh.candidate) {
    // Mirror the catalog row so the FK holds + the banner has display data.
    await db.execute(upsertAEProductSql(fresh.candidate));
  }

  await db.execute(sql`
    INSERT INTO amazon_ae_equivalents (
      amazon_product_id, ae_product_id, text_score,
      ae_price_snapshot, amazon_price_snapshot, pct_cheaper, is_eligible, checked_at
    ) VALUES (
      ${amazonProductId},
      ${fresh.candidate?.productId ?? null},
      ${fresh.textScore.toFixed(2)},
      ${fresh.candidate?.salePrice ?? null},
      ${amazonProduct.price},
      ${fresh.pctCheaper.toFixed(2)},
      ${fresh.isEligible},
      NOW()
    )
    ON CONFLICT (amazon_product_id) DO UPDATE SET
      ae_product_id         = EXCLUDED.ae_product_id,
      text_score            = EXCLUDED.text_score,
      ae_price_snapshot     = EXCLUDED.ae_price_snapshot,
      amazon_price_snapshot = EXCLUDED.amazon_price_snapshot,
      pct_cheaper           = EXCLUDED.pct_cheaper,
      is_eligible           = EXCLUDED.is_eligible,
      checked_at            = NOW()
  `);

  return fresh;
}

async function fetchCachedAEProduct(productId: string): Promise<AliExpressProduct | null> {
  const r = await db.execute(sql`
    SELECT product_id AS "productId", title, image_url AS "imageUrl", product_url AS "productUrl",
           promotion_url AS "promotionUrl", sale_price::float AS "salePrice",
           original_price::float AS "originalPrice", discount_pct AS "discountPct", currency,
           rating::float AS rating, orders_count AS "ordersCount",
           category_id AS "categoryId", category_name AS "categoryName",
           shop_id AS "shopId", shop_name AS "shopName"
           /* sale_tier not selected — banner derives it from discount_pct on render */
    FROM aliexpress_products WHERE product_id = ${productId}
  `);
  const p = r.rows[0] as any;
  return p ?? null;
}

