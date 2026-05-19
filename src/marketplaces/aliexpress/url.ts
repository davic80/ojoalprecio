/**
 * AliExpress product-URL utilities.
 *
 * AliExpress has no stable per-product identifier equivalent to Amazon's
 * ASIN: every listing has a numeric `productId` (13-16 digits) that is
 * stable per *listing*, not per *product*. The same physical item is
 * often sold by multiple vendors under different productIds — that's the
 * whole reason the "similar products" feature has any value.
 *
 * Supported input shapes:
 *   1. `1005006789012345`                        → bare productId
 *   2. `https://www.aliexpress.com/item/1005006789012345.html`
 *   3. `https://es.aliexpress.com/item/1005006789012345.html?spm=…`
 *   4. `https://m.aliexpress.com/item/1005006789012345.html`     (mobile)
 *   5. `https://www.aliexpress.us/item/1005006789012345.html`    (US)
 *
 * Short / affiliate links (`a.aliexpress.com/_XXX`,
 * `s.click.aliexpress.com/e/_XXX`) are NOT resolved here — they require a
 * live HTTP HEAD to follow the redirect. Resolve them in the caller and
 * pass the resulting long URL to `parseProductId`.
 */

const PRODUCT_ID_RE = /\b(\d{10,16})\b/;
const ITEM_PATH_RE  = /\/item\/(\d{10,16})(?:\.html|\b)/i;

/** Hostname ends with `aliexpress.<tld>` (any single TLD label, e.g. com, us, ru). */
function isAliexpressHost(hostname: string): boolean {
  const parts = hostname.toLowerCase().split('.');
  // Need at least `aliexpress.<tld>`; the second-to-last label must equal "aliexpress"
  // so `aliexpress.fake.com` (where "aliexpress" is the subdomain) is rejected.
  return parts.length >= 2 && parts[parts.length - 2] === 'aliexpress';
}

/** Returns the canonical productId for an AliExpress URL or bare id, or null. */
export function parseProductId(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Bare numeric id
  if (/^\d{10,16}$/.test(trimmed)) return trimmed;

  // Try as URL — must be on an aliexpress.* host
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (!isAliexpressHost(url.hostname)) return null;

  // /item/<id>.html  is the canonical product path
  const m = url.pathname.match(ITEM_PATH_RE);
  if (m) return m[1];

  // Fallback: pluck any 10-16 digit number from the path. Loose, but
  // catches odd /i/<id>/ shapes that turn up occasionally.
  const f = url.pathname.match(PRODUCT_ID_RE);
  return f ? f[1] : null;
}

/** True if the input is parseable as an AliExpress product link. */
export function isAliExpressUrl(input: string | null | undefined): boolean {
  return parseProductId(input) !== null;
}

/** Canonical es-locale product URL given a productId (for stored display). */
export function canonicalUrl(productId: string): string {
  return `https://es.aliexpress.com/item/${productId}.html`;
}
