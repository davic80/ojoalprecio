import { describe, it, expect } from 'vitest';
import { decideAfterConfirmedUnavailable as decide, describeReason } from '../src/scheduler/lifecycle';
import { scrapeUrl, normaliseAmazonUrl } from '../src/scraper/util';

describe('decideAfterConfirmedUnavailable', () => {
  it('unprotected (nobody follows it): delete at the first confirmation', () => {
    expect(decide({ reason: undefined, confirmations: 1, isProtected: false })).toBe('delete');
    expect(decide({ reason: 'used', confirmations: 1, isProtected: false })).toBe('delete');
    expect(decide({ reason: 'gone', confirmations: 1, isProtected: false })).toBe('delete');
  });

  it('protected + unavailable: initial confirmation plus 2 extra checks, then delete', () => {
    expect(decide({ reason: undefined, confirmations: 1, isProtected: true })).toBe('keep');
    expect(decide({ reason: undefined, confirmations: 2, isProtected: true })).toBe('keep');
    expect(decide({ reason: undefined, confirmations: 3, isProtected: true })).toBe('delete');
    expect(decide({ reason: 'used', confirmations: 2, isProtected: true })).toBe('keep');
    expect(decide({ reason: 'unqualified', confirmations: 3, isProtected: true })).toBe('delete');
  });

  it('protected + gone (ASIN does not exist): delete on the second confirmation', () => {
    expect(decide({ reason: 'gone', confirmations: 1, isProtected: true })).toBe('keep');
    expect(decide({ reason: 'gone', confirmations: 2, isProtected: true })).toBe('delete');
  });

  it('redirect to another ASIN never deletes on a single sighting, protected or not', () => {
    expect(decide({ reason: 'redirect', confirmations: 1, isProtected: false })).toBe('keep');
    expect(decide({ reason: 'redirect', confirmations: 1, isProtected: true })).toBe('keep');
    expect(decide({ reason: 'redirect', confirmations: 2, isProtected: false })).toBe('delete');
    expect(decide({ reason: 'redirect', confirmations: 2, isProtected: true })).toBe('delete');
  });

  it('honours custom thresholds and clamps nonsense counts', () => {
    const settings = { extraChecks: 4, goneConfirmations: 3 };
    expect(decide({ reason: undefined, confirmations: 4, isProtected: true, settings })).toBe('keep');
    expect(decide({ reason: undefined, confirmations: 5, isProtected: true, settings })).toBe('delete');
    expect(decide({ reason: 'gone', confirmations: 2, isProtected: true, settings })).toBe('keep');
    expect(decide({ reason: undefined, confirmations: 0, isProtected: true })).toBe('keep');
  });

  it('has a Spanish explanation for each reason', () => {
    for (const r of ['gone', 'redirect', 'used', 'unqualified', undefined] as const) {
      expect(describeReason(r).length).toBeGreaterThan(10);
    }
  });
});

describe('scrapeUrl', () => {
  it('pins the child ASIN variation (th=1&psc=1) but normaliseAmazonUrl stays clean', () => {
    expect(scrapeUrl('B0F7TM92ZM')).toBe('https://www.amazon.es/dp/B0F7TM92ZM?th=1&psc=1');
    expect(normaliseAmazonUrl('B0F7TM92ZM')).toBe('https://www.amazon.es/dp/B0F7TM92ZM');
  });
});

import { sameArticle, titleSimilarity, normalizeTitle, ASIN_RE } from '../src/scheduler/redirect';
import { serializeError, rebuildError } from '../src/scraper/wire';
import { ProductUnavailableError } from '../src/scraper/amazon';

describe('sameArticle — follow Amazon\'s ASIN move only when it is the same article', () => {
  it('identical or cosmetically different titles are the same article', () => {
    expect(sameArticle('HOBIBEAR Zapatillas Barefoot Unisex, Puntera Ancha, Ligeras y Casual', 'HOBIBEAR Zapatillas Barefoot Unisex, Puntera Ancha, Ligeras y Casual')).toBe(true);
    expect(sameArticle('Funda para Samsung Galaxy A26, Carcasa Antigolpes', 'funda para samsung galaxy a26 - carcasa antigolpes')).toBe(true);
    expect(sameArticle('Café Molido  Natural 500g', 'Cafe molido natural 500g')).toBe(true);   // accents/spacing
  });
  it('another size or colour is NOT the same article (the Apple Watch case)', () => {
    expect(sameArticle('Apple Watch Series 11 GPS con Caja de Aluminio en Plata de 42 mm y Correa Deportiva',
                       'Apple Watch Series 11 GPS con Caja de Aluminio en Gris Espacial de 46 mm y Correa Deportiva')).toBe(false);
    expect(sameArticle('Funda Samsung Galaxy A26 Azul', 'Funda Samsung Galaxy A25 Negro')).toBe(false);
  });
  it('missing titles never match (be conservative)', () => {
    expect(sameArticle(null, 'Algo')).toBe(false);
    expect(sameArticle('Algo', '')).toBe(false);
    expect(titleSimilarity('', '')).toBe(0);
    expect(normalizeTitle('  Áé  Í!! ')).toBe('ae i');
  });
  it('validates ASIN shape', () => {
    expect(ASIN_RE.test('B0GJSSK3NL')).toBe(true);
    expect(ASIN_RE.test('b0gjssk3nl')).toBe(false);
    expect(ASIN_RE.test('B0GJSSK3N')).toBe(false);
    expect(ASIN_RE.test("B0GJSSK3N'; DROP")).toBe(false);
  });
  it('the new ASIN travels with the error from the Pi (wire)', () => {
    const back = rebuildError(serializeError(new ProductUnavailableError('redirige', 'redirect', undefined, 'Título servido', 'B0GJSSK3NL'))) as ProductUnavailableError;
    expect([back.reason, back.newAsin, back.productName]).toEqual(['redirect', 'B0GJSSK3NL', 'Título servido']);
  });
});
