// When Amazon serves the page of another ASIN for a requested one, is it the SAME article that
// Amazon moved (merged listing / new ASIN), or just a sibling variant (other size or colour)?
// Following the article (updating the ASIN) is right in the first case and wrong in the second:
// a follower of "Apple Watch Plata 42 mm" must not silently become a follower of "Gris 46 mm".
// The titles of the old product (what we stored) and the page that was served decide it.
// Pure so it is unit-testable.

export function normalizeTitle(s: string | null | undefined): string {
  return (s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')      // accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Token-set similarity in [0,1] (Jaccard on words). */
export function titleSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ta = new Set(normalizeTitle(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeTitle(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Same article when the normalized titles are (almost) identical. Conservative on purpose. */
export function sameArticle(storedName: string | null | undefined, servedName: string | null | undefined, threshold = 0.9): boolean {
  if (!normalizeTitle(storedName) || !normalizeTitle(servedName)) return false;
  return titleSimilarity(storedName, servedName) >= threshold;
}

export const ASIN_RE = /^[A-Z0-9]{10}$/;
