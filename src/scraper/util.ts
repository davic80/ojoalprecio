/**
 * Pure scraper helpers — no Playwright, no DB. Lives apart so unit tests can
 * import without paying the Playwright load cost or initializing a browser.
 *
 * Re-exported from `./amazon` for backwards compatibility with existing
 * callers; new code should import here.
 */

const AFFILIATE_TAG = 'canidrone-21';

/** "33,70€" → 33.70 ; "1.234,56 €" → 1234.56 */
export function parseSpanishPrice(raw: string): number {
  const cleaned = raw.replace(/[€$\s]/g, '').trim();
  const normalised = cleaned.replace(/\./g, '').replace(',', '.');
  return parseFloat(normalised);
}

/** Extract the 10-char ASIN from any Amazon URL shape, or null if absent. */
export function extractAsin(url: string): string | null {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

/** Canonical amazon.es product URL given an ASIN. */
export function normaliseAmazonUrl(asin: string): string {
  return `https://www.amazon.es/dp/${asin}`;
}

/**
 * Build an outbound click-through URL with our affiliate tag and forced
 * Spanish language. Strips any pre-existing tag so we always own the lead.
 */
export function affiliateUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('tag');
    u.searchParams.set('tag', AFFILIATE_TAG);
    u.searchParams.set('language', 'es_ES');
    return u.toString();
  } catch {
    return url;
  }
}
