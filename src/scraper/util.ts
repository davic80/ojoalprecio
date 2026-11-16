/**
 * Pure scraper helpers — no Playwright, no DB. Lives apart so unit tests can
 * import without paying the Playwright load cost or initializing a browser.
 *
 * Re-exported from `./amazon` for backwards compatibility with existing
 * callers; new code should import here.
 */

/** Amazon Associates tracking ID used when AMAZON_AFFILIATE_TAG is not set. */
export const DEFAULT_AFFILIATE_TAG = 'ojoalprecio0d-21';

/**
 * Tracking ID appended to every outbound Amazon link. Configurable through the AMAZON_AFFILIATE_TAG
 * environment variable (read on every call, so tests and a restart pick up a change); an empty or
 * malformed value falls back to the default instead of producing broken links.
 */
export function getAffiliateTag(): string {
  const t = (process.env.AMAZON_AFFILIATE_TAG ?? '').trim();
  return /^[A-Za-z0-9_-]{3,40}$/.test(t) ? t : DEFAULT_AFFILIATE_TAG;
}

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
 * URL the scraper actually navigates to. For listings with a size/colour selector Amazon
 * only renders the buy-box price when the child ASIN's own variation is pinned:
 * `th=1&psc=1` does that. Without it (e.g. unycos dumbbells, Palbea padel balls) the page
 * shows the add-to-cart button but no price block and we reported "Sin precio disponible".
 * Kept separate from normaliseAmazonUrl so stored/affiliate URLs stay clean.
 */
export function scrapeUrl(asin: string): string {
  return `https://www.amazon.es/dp/${asin}?th=1&psc=1`;
}

/**
 * Build an outbound click-through URL with our affiliate tag and forced
 * Spanish language. Strips any pre-existing tag so we always own the lead.
 */
export function affiliateUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('tag');
    u.searchParams.set('tag', getAffiliateTag());
    u.searchParams.set('language', 'es_ES');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Multiplier for the waits of Amazon's delivery-location UI flow. 1 on the server; the Raspberry Pi 4 sets
 * SCRAPER_UI_TIMEOUT_SCALE=2.5 because on a cold, busy Pi the popover takes longer than 5 s. Never below 1,
 * and garbage (empty, text, 0, negative) falls back to 1.
 */
export function uiTimeoutScale(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 10) : 1;
}

/**
 * How many times the same Chromium is reused before it is replaced (SCRAPER_BROWSER_RECYCLE_AFTER, default 500).
 * Closing the browser frees what Playwright keeps in memory for it (network objects, about 2-3 MB per scrape),
 * so a lower value keeps the Node process small without restarting the whole service.
 */
export function browserRecycleAfter(raw: string | undefined): number {
  const n = parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 10 ? Math.min(n, 5000) : 500;
}

/** Counts what is using the shared browser right now, so it is never closed under a running scrape. */
export class IdleGate {
  private n = 0;
  private waiters: Array<() => void> = [];
  enter(): void { this.n++; }
  leave(): void {
    if (this.n > 0) this.n--;
    if (this.n === 0) { const w = this.waiters.splice(0); w.forEach(f => f()); }
  }
  get active(): number { return this.n; }
  /** Resolves true when nothing is active, or false after `ms` if something still is. */
  waitIdle(ms: number): Promise<boolean> {
    if (this.n === 0) return Promise.resolve(true);
    return new Promise<boolean>(resolve => {
      const done = () => { clearTimeout(t); resolve(true); };
      const t = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== done); resolve(false); }, ms);
      this.waiters.push(done);
    });
  }
}
