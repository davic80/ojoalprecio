import { describe, it, expect } from 'vitest';
import { parseBareProductId } from '../src/lib/product-input';

describe('parseBareProductId', () => {
  it('recognises an Amazon ASIN, in any case and with a label or quotes', () => {
    expect(parseBareProductId('B0DJC3WYTP')).toEqual({ kind: 'amazon', asin: 'B0DJC3WYTP' });
    expect(parseBareProductId('  b0djc3wytp ')).toEqual({ kind: 'amazon', asin: 'B0DJC3WYTP' });
    expect(parseBareProductId('ASIN: B0DJC3WYTP')).toEqual({ kind: 'amazon', asin: 'B0DJC3WYTP' });
    expect(parseBareProductId('"B0DJC3WYTP"')).toEqual({ kind: 'amazon', asin: 'B0DJC3WYTP' });
  });
  it('recognises a book ISBN-10 as an Amazon ASIN', () => {
    expect(parseBareProductId('8408163450')).toEqual({ kind: 'amazon', asin: '8408163450' });
    expect(parseBareProductId('043942089X')).toEqual({ kind: 'amazon', asin: '043942089X' });
  });
  it('recognises an AliExpress product id (long number) and never confuses it with an ASIN', () => {
    expect(parseBareProductId('1005006123456789')).toEqual({ kind: 'aliexpress', id: '1005006123456789' });
    expect(parseBareProductId('32891234567')).toEqual({ kind: 'aliexpress', id: '32891234567' });
  });
  it('leaves URLs, words and malformed tokens alone', () => {
    expect(parseBareProductId('https://www.amazon.es/dp/B0DJC3WYTP')).toBeNull();
    expect(parseBareProductId('zapatillas')).toBeNull();
    expect(parseBareProductId('ofertasama')).toBeNull();      // 10 letters but not B + 9
    expect(parseBareProductId('B0DJC3WYT')).toBeNull();       // 9 characters
    expect(parseBareProductId('')).toBeNull();
    expect(parseBareProductId(null)).toBeNull();
  });
});
