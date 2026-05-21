import type { AliExpressClient } from './client';
import { AliExpressError, AliExpressPermissionError } from './client';
import type { AliExpressProduct, SimilarCandidate, SimilarSource } from './types';
import { extractBrandModel, textSimilarity } from './text';

/**
 * Shared "find similar products" discovery for an AliExpress master.
 *
 * Used by:
 *   - ingest.ts             (initial add — must complete <1 min)
 *   - scheduler/aliexpress.ts:refreshSimilars (8 h cron pass)
 *
 * Three-layer strategy (locked in with the user 2026-05-19, smartmatch
 * wired up 2026-05-22 once Advanced API perms landed):
 *
 *   A. **Strict query+score**. productQuery with brand+model keywords +
 *      price cap (master × 1.5). Jaccard over titles, keep score ≥
 *      SIMILARITY_THRESHOLD. If we land MIN_KEPT_BEFORE_FALLBACK or more,
 *      we ship those (most precise — same product, different listings).
 *
 *   C. **smartmatch** (the proper fallback, Advanced API perm required).
 *      "You may also like" engine inside AE keyed on productId. Wider
 *      net than keyword query, good for the "equivalent products"
 *      use-case when the master has unusual / generic title text.
 *
 *   Fallback-of-fallback. If smartmatch errors out (perm revoked,
 *   network, transient), keep the top-N from the original strict query
 *   without the score threshold — better than empty.
 *
 * Returned candidates are already sorted by score DESC and capped at
 * MAX_SIMILARS. The `source` discriminator on each candidate tells the
 * UI / DB how it was picked.
 */

export const SIMILARITY_THRESHOLD     = 0.30;
export const MIN_KEPT_BEFORE_FALLBACK = 3;
export const MAX_SIMILARS             = 12;
export const QUERY_PAGE_SIZE          = 30;

export async function discoverSimilars(
  client: AliExpressClient,
  master: AliExpressProduct,
): Promise<SimilarCandidate[]> {
  const keywords = extractBrandModel(master.title);
  if (!keywords) return [];

  // ── Layer A: strict keyword query + Jaccard ────────────────────────────
  let queryRes;
  try {
    queryRes = await client.productQuery({
      keywords,
      maxSalePrice: master.salePrice > 0 ? Math.ceil(master.salePrice * 1.5) : undefined,
      pageSize:     QUERY_PAGE_SIZE,
    });
  } catch (err) {
    if (err instanceof AliExpressPermissionError) throw err;
    console.warn(`[ae-similars] productQuery for ${master.productId} failed: ${(err as Error).message}`);
    queryRes = { products: [], totalCount: 0, pageNo: 1, pageSize: 0 };
  }

  const scored = queryRes.products
    .filter(p => p.productId !== master.productId)
    .map(p => ({
      product:   p,
      source:    'query' as SimilarSource,
      textScore: textSimilarity(master.title, p.title),
    }));

  const strict = scored
    .filter(c => c.textScore >= SIMILARITY_THRESHOLD)
    .sort((a, b) => b.textScore - a.textScore)
    .slice(0, MAX_SIMILARS);

  if (strict.length >= MIN_KEPT_BEFORE_FALLBACK) return strict;

  // ── Layer C: smartmatch (Advanced API permission) ──────────────────────
  let smartProducts: AliExpressProduct[] = [];
  try {
    // `?? []` defends against mocks (or buggy wrappers) that resolve with
    // undefined instead of an empty array.
    smartProducts = (await client.smartMatch(master.productId, MAX_SIMILARS)) ?? [];
  } catch (err) {
    if (err instanceof AliExpressError) {
      // Permission revoked / not granted / transient — fall through to
      // the loose-query last-resort so the user still sees something.
      console.warn(`[ae-similars] smartMatch for ${master.productId} unavailable: ${err.message}`);
    } else {
      throw err;
    }
  }

  if (smartProducts.length > 0) {
    const smart = smartProducts
      .filter(p => p.productId !== master.productId)
      .map(p => ({
        product:   p,
        source:    'smartmatch' as SimilarSource,
        textScore: textSimilarity(master.title, p.title),
      }))
      .sort((a, b) => b.textScore - a.textScore)
      .slice(0, MAX_SIMILARS);
    if (smart.length > 0) return smart;
  }

  // ── Layer fallback: loose query (no score threshold) ──────────────────
  return scored
    .sort((a, b) => b.textScore - a.textScore)
    .slice(0, MAX_SIMILARS);
}
