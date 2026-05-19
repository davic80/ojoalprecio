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
