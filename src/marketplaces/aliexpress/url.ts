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

/**
 * True if the input looks like one of AliExpress's short / affiliate URL
 * shapes that resolve via HTTP redirect:
 *   - s.click.aliexpress.com/e/_XXXXXXX   (affiliate share link)
 *   - a.aliexpress.com/_XXXXXXX           (generic short link)
 * These never contain the productId in the URL itself — you have to follow
 * the 301/302 to the full /item/<id>.html target.
 */
const SHORT_URL_HOSTS = new Set(['s.click.aliexpress.com', 'a.aliexpress.com']);
export function isShortUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return SHORT_URL_HOSTS.has(u.hostname.toLowerCase());
  } catch { return false; }
}

/**
 * Async productId resolver that handles short / affiliate URLs by following
 * the HTTP redirect chain (up to `maxRedirects` hops) to the canonical
 * `/item/<id>.html`. For inputs `parseProductId` can already handle
 * synchronously (bare ids, long URLs), no network is touched.
 *
 * Use this on user-supplied input in the POST /products handler. The
 * server-side redirect costs ~200-400ms typically; acceptable for a
 * one-time "add product" action.
 *
 * Throws on network failure or if the redirect chain doesn't end at a
 * URL that parseProductId can decode.
 */
export async function resolveAndParseProductId(input: string, maxRedirects = 5): Promise<string | null> {
  const direct = parseProductId(input);
  if (direct) return direct;

  if (!isShortUrl(input)) return null;  // not a shape we can resolve

  let current = input;
  for (let hop = 0; hop < maxRedirects; hop++) {
    // Use HEAD + manual redirect so we read the Location header without
    // downloading the (often heavy) target page body.
    const res = await fetch(current, { method: 'HEAD', redirect: 'manual' });
    const next = res.headers.get('location');
    if (!next) {
      // Some short-link services return 200 with no Location and use
      // client-side JS to redirect. Fall back to a GET to follow
      // automatically and read the final URL from res.url.
      const got = await fetch(current, { method: 'GET', redirect: 'follow' });
      return parseProductId(got.url);
    }
    // Resolve relative URLs against current (rare for AE but defensive)
    current = new URL(next, current).toString();
    const found = parseProductId(current);
    if (found) return found;
  }
  return null;
}
