import { createHmac } from 'crypto';

/**
 * AliExpress Open Platform (TOP / Aliexpress.affiliate.*) request signing.
 *
 * Algorithm (HMAC-SHA256 variant, what every modern endpoint expects):
 *   1. Collect ALL request parameters (system + business), EXCLUDING `sign`
 *      and any param whose value is a byte stream.
 *   2. Sort keys ASCII-ascending.
 *   3. Concatenate as `k1v1k2v2…kNvN`. NO separators between pairs.
 *   4. HMAC-SHA256 over that string keyed with the App Secret.
 *   5. Hex-encode the digest UPPERCASE.
 *
 * Returns the 64-char uppercase hex signature ready to drop into the
 * `sign` parameter.
 *
 * Reference: openservice.aliexpress.com/doc/doc.htm (Chinese docs); the
 * algorithm itself is shared with TOP/Taobao open platform and is well
 * documented across community wrappers (e.g. sergioteula/python-aliexpress-api).
 */
export function signRequest(params: Record<string, string | number | boolean>, secret: string): string {
  if (!secret) throw new Error('signRequest: missing App Secret');

  const sortedKeys = Object.keys(params).filter(k => k !== 'sign').sort();
  const concat = sortedKeys.map(k => `${k}${params[k]}`).join('');

  return createHmac('sha256', secret).update(concat, 'utf8').digest('hex').toUpperCase();
}

/**
 * Build the system-parameter block every TOP call expects on top of the
 * business params. `method` and the App Key change per call site.
 *
 *   timestamp : GMT+8 / Beijing time in "yyyy-MM-dd HH:mm:ss".
 *   format    : 'json' (XML also supported, we never want it).
 *   v         : '2.0' (current TOP version).
 *   sign_method : 'hmac-sha256' (matches signRequest above).
 */
export function systemParams(appKey: string, method: string, timestamp: Date = new Date()): Record<string, string> {
  return {
    app_key:     appKey,
    method,
    timestamp:   formatBeijingTimestamp(timestamp),
    format:      'json',
    v:           '2.0',
    sign_method: 'hmac-sha256',
  };
}

/**
 * Sign a request to the `/rest/*` gateway (used by the OAuth + DS-namespace
 * endpoints). The shape differs from the legacy `/sync` gateway in two ways:
 *
 *   1. The API path itself is PREPENDED to the param-concat string. This is
 *      where every AE OAuth SDK gets it wrong; without the path prefix the
 *      gateway silently returns InvalidSignature or even just empty bodies.
 *      Example path: "/auth/token/create".
 *   2. The timestamp is UTC, not Beijing — see `formatRestTimestamp`.
 *
 * The `sign` field itself is excluded from the signed string (same as
 * `signRequest`). HMAC-SHA256, hex, uppercase.
 */
export function signRestRequest(
  apiPath: string,
  params: Record<string, string | number | boolean>,
  secret: string,
): string {
  if (!secret)  throw new Error('signRestRequest: missing App Secret');
  if (!apiPath) throw new Error('signRestRequest: missing API path');
  // AE normalises the path to start with a single leading slash before signing.
  const path = apiPath.startsWith('/') ? apiPath : '/' + apiPath;
  const sortedKeys = Object.keys(params).filter(k => k !== 'sign').sort();
  const concat = path + sortedKeys.map(k => `${k}${params[k]}`).join('');
  return createHmac('sha256', secret).update(concat, 'utf8').digest('hex').toUpperCase();
}

/** "yyyy-MM-dd HH:mm:ss" in UTC — required timestamp shape for the /rest gateway. */
export function formatRestTimestamp(d: Date = new Date()): string {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'UTC',
    year:   'numeric', month:  '2-digit', day:    '2-digit',
    hour:   '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  return fmt.format(d);
}

/** "yyyy-MM-dd HH:mm:ss" in Asia/Shanghai (Beijing) time. */
export function formatBeijingTimestamp(d: Date): string {
  // Intl with timeZone is the cleanest cross-platform way; AliExpress
  // wants a fixed GMT+8 stamp regardless of where the server runs.
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone:     'Asia/Shanghai',
    year:         'numeric',
    month:        '2-digit',
    day:          '2-digit',
    hour:         '2-digit',
    minute:       '2-digit',
    second:       '2-digit',
    hour12:       false,
  });
  // 'sv-SE' returns "YYYY-MM-DD HH:mm:ss" with the right separators already.
  return fmt.format(d);
}
