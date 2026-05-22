/**
 * Text utilities for AliExpress similar-product discovery.
 *
 * Heuristic-based — no ML, no embeddings. The AE title format is verbose
 * and noisy ("Baofeng BF-88E Pro Walkie Talkie frecuencia de copia
 * inalámbrica de largo alcance UHF 400-470MHz Radio bidireccional…").
 * The first ~4 words of an AE title are almost always brand + model;
 * the rest is marketing copy + specs in mixed languages.
 *
 * Strategy A (the user-locked-in similarity definition):
 *   Take brand+model tokens from the master title → query AE → score
 *   each candidate by Jaccard overlap of normalised title tokens. Keep
 *   those above a threshold.
 */

const STOPWORDS_ES = new Set([
  'de','la','el','los','las','un','una','y','o','para','con','sin','en','del','al','por',
  'a','que','no','ni','su','sus','este','esta','estos','estas','se','lo','le','les','mi',
]);
const STOPWORDS_EN = new Set([
  'the','a','an','and','or','for','with','of','in','on','to','from','by','at','as','is','it','this','that',
]);
// AE catalog noise — words that show up in 80% of titles regardless of product
const STOPWORDS_AE = new Set([
  'pro','plus','max','mini','new','original','wireless','portable','professional',
  'envío','gratis','envio','free','shipping','venta','oferta','promoción','promocion',
  'nuevo','nueva','calidad','alta','baja',
]);

const ALL_STOPWORDS = new Set([...STOPWORDS_ES, ...STOPWORDS_EN, ...STOPWORDS_AE]);

/**
 * Tokenise a product title for similarity scoring: strip diacritics,
 * lowercase, split on non-alphanum, drop pure-numeric tokens shorter than
 * 2 chars, drop stopwords. Keeps alphanumeric tokens like "BF-88E" intact
 * by including hyphens in the split allowlist post-NFKD normalisation.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const norm = text.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  // Split on whitespace + punctuation EXCEPT hyphens, so "BF-88E" survives.
  const raw = norm.split(/[^a-z0-9-]+/).filter(Boolean);
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 2) continue;
    if (ALL_STOPWORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Pluck candidate brand+model keywords from a title. Returns a single
 * space-separated string ready to feed into `productQuery({ keywords })`.
 *
 * Heuristic: take the first 4 non-stopword tokens, preserving original
 * (un-normalised) case so the search engine treats brand/model as
 * meaningful capitalised terms.
 */
export function extractBrandModel(title: string, maxWords = 4): string {
  if (!title) return '';
  // Split on whitespace, keep original word forms, but use normalised
  // version for stopword filtering.
  const words = title.split(/\s+/).filter(Boolean);
  const picked: string[] = [];
  for (const w of words) {
    const norm = w.normalize('NFKD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!norm) continue;
    if (norm.length < 2) continue;
    if (ALL_STOPWORDS.has(norm)) continue;
    picked.push(w);
    if (picked.length >= maxWords) break;
  }
  return picked.join(' ');
}

/**
 * Discount → sale-tier label, mirroring the Amazon-side calcSaleTier()
 * ladder (src/scheduler/sale-logic.ts). Same string values feed the same
 * `badge-tier-*` CSS classes, so AE products render the same overlays
 * Amazon products already use across the site.
 *
 *   <7   → null (not a real sale)
 *    7-14 → 'oferta'
 *   15-29 → 'super-oferta'
 *   30-49 → 'mega-oferta'
 *   50-66 → 'broooooferton'
 *    67+ → '67oferta'
 */
export function saleTierFromDiscountPct(pct: number | null | undefined): string | null {
  if (pct == null || !Number.isFinite(pct)) return null;
  if (pct >= 67) return '67oferta';
  if (pct >= 50) return 'broooooferton';
  if (pct >= 30) return 'mega-oferta';
  if (pct >= 15) return 'super-oferta';
  if (pct >=  7) return 'oferta';
  return null;
}

/**
 * Title similarity in [0, 1], symmetric. Returns max(jaccard, 0.7×min-coverage).
 *
 * Why not pure Jaccard: AE titles are typically 3-4× longer than Amazon's
 * because vendors stuff marketing tail tokens ("Brand New 2025 Wireless
 * High Quality …"). Jaccard's union-in-the-denominator systematically
 * underweights real product matches as "noisy" — a perfect Amazon match
 * inside a verbose AE listing scores 0.25-0.30 even when every Amazon
 * token is present in AE.
 *
 * Production data (2026-05-22, 1420 Amazon products against AE):
 *   bucket 3 (score 0.10-0.25, 188 products) → avg pct_cheaper 12.8%
 *   These were real cross-listings discarded purely by Jaccard's bias.
 *
 * The fix: also compute `coverage = intersection / min(|a|, |b|)`. For
 * Amazon (short) × AE (long), min is Amazon, so this answers "what
 * fraction of the Amazon title was found in the AE listing?" — much
 * closer to the question we care about. We keep jaccard as a floor so
 * highly-balanced matches don't lose ground.
 *
 * Anti-noise guard: only boost when intersection >= 3. Below that we
 * could lift weak matches like "Cable USB" vs "Cable HDMI" or
 * "Sonos altavoz" vs "Sonos Era 100 altavoz wifi bluetooth pack" above
 * threshold — they share brand + category but not the specific model
 * that makes them a real same-product equivalent. 3+ shared tokens is
 * the empirical minimum where the match holds up.
 */
export function textSimilarity(a: string, b: string): number {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (ta.size === 0 || tb.size === 0) return 0;

  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  const union = ta.size + tb.size - intersection;
  const jaccard = union === 0 ? 0 : intersection / union;

  if (intersection < 3) return jaccard;

  const minCoverage = intersection / Math.min(ta.size, tb.size);
  return Math.max(jaccard, 0.7 * minCoverage);
}
