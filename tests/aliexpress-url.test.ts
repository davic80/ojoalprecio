import { describe, it, expect } from 'vitest';
import { parseProductId, isAliExpressUrl, canonicalUrl } from '../src/marketplaces/aliexpress/url';

describe('aliexpress URL parsing', () => {
  it('accepts a bare productId', () => {
    expect(parseProductId('1005006789012345')).toBe('1005006789012345');
    expect(parseProductId('  1005006789012345  ')).toBe('1005006789012345');
  });

  it('rejects non-numeric strings that look like ids', () => {
    expect(parseProductId('B000ABCDEF')).toBeNull();   // ASIN-shaped
    expect(parseProductId('abc12345')).toBeNull();
    expect(parseProductId('')).toBeNull();
    expect(parseProductId(null)).toBeNull();
    expect(parseProductId(undefined)).toBeNull();
  });

  it('parses long-form aliexpress.com URLs', () => {
    expect(parseProductId('https://www.aliexpress.com/item/1005006789012345.html'))
      .toBe('1005006789012345');
  });

  it('parses locale subdomains (es, m, us)', () => {
    expect(parseProductId('https://es.aliexpress.com/item/1005006789012345.html')).toBe('1005006789012345');
    expect(parseProductId('https://m.aliexpress.com/item/1005006789012345.html')).toBe('1005006789012345');
    expect(parseProductId('https://www.aliexpress.us/item/1005006789012345.html')).toBe('1005006789012345');
  });

  it('strips query string + spm trackers', () => {
    const u = 'https://es.aliexpress.com/item/1005006789012345.html?spm=a2g0o.detail.0.0.123abc&pdp_npi=4%40dis';
    expect(parseProductId(u)).toBe('1005006789012345');
  });

  it('rejects non-AliExpress hosts even when the path matches', () => {
    expect(parseProductId('https://example.com/item/1005006789012345.html')).toBeNull();
    expect(parseProductId('https://aliexpress.fake.com/item/1005006789012345.html')).toBeNull();
  });

  it('rejects malformed URLs gracefully', () => {
    expect(parseProductId('not a url')).toBeNull();
    expect(parseProductId('htp://broken')).toBeNull();
  });

  it('isAliExpressUrl mirrors parseProductId', () => {
    expect(isAliExpressUrl('1005006789012345')).toBe(true);
    expect(isAliExpressUrl('https://es.aliexpress.com/item/1005006789012345.html')).toBe(true);
    expect(isAliExpressUrl('https://amazon.es/dp/B000XXX')).toBe(false);
    expect(isAliExpressUrl(null)).toBe(false);
  });

  it('builds the canonical es-locale URL', () => {
    expect(canonicalUrl('1005006789012345'))
      .toBe('https://es.aliexpress.com/item/1005006789012345.html');
  });

  // Defensive: 10-digit IDs (older listings) and 16-digit (newer) both ok
  it('handles edge-length productIds 10-16 digits', () => {
    expect(parseProductId('1234567890')).toBe('1234567890');             // 10
    expect(parseProductId('1234567890123456')).toBe('1234567890123456'); // 16
    expect(parseProductId('123456789')).toBeNull();                       // 9 too short
    expect(parseProductId('12345678901234567')).toBeNull();               // 17 too long
  });
});
