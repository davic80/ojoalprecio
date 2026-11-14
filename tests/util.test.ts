import { describe, it, expect, afterEach } from 'vitest';
import { parseSpanishPrice, extractAsin, normaliseAmazonUrl, affiliateUrl } from '../src/scraper/util';

describe('parseSpanishPrice', () => {
  it('parses plain euros with comma decimal', () => {
    expect(parseSpanishPrice('33,70€')).toBe(33.70);
  });
  it('parses with leading/trailing spaces and currency separator', () => {
    expect(parseSpanishPrice(' 33,70 €')).toBe(33.70);
  });
  it('parses thousands separator as dot', () => {
    expect(parseSpanishPrice('1.234,56€')).toBe(1234.56);
  });
  it('parses integer prices', () => {
    expect(parseSpanishPrice('299€')).toBe(299);
  });
  it('returns NaN for unparseable input', () => {
    expect(parseSpanishPrice('abc')).toBeNaN();
  });
});

describe('extractAsin', () => {
  it('extracts from /dp/ URLs', () => {
    expect(extractAsin('https://www.amazon.es/dp/B07VP5X239')).toBe('B07VP5X239');
  });
  it('extracts from /gp/product/ URLs', () => {
    expect(extractAsin('https://www.amazon.es/gp/product/B0DKVT38D7')).toBe('B0DKVT38D7');
  });
  it('extracts from /exec/obidos/ASIN/ URLs', () => {
    expect(extractAsin('https://amazon.es/exec/obidos/ASIN/B07VP5X239/ref=test')).toBe('B07VP5X239');
  });
  it('uppercases lowercase ASINs', () => {
    expect(extractAsin('https://www.amazon.es/dp/b07vp5x239')).toBe('B07VP5X239');
  });
  it('ignores query params and trailing path', () => {
    expect(extractAsin('https://www.amazon.es/dp/B07VP5X239?tag=foo&th=1')).toBe('B07VP5X239');
  });
  it('returns null for non-product URLs', () => {
    expect(extractAsin('https://www.amazon.es/gp/bestsellers/electronics')).toBeNull();
  });
  it('returns null for empty string', () => {
    expect(extractAsin('')).toBeNull();
  });
});

describe('normaliseAmazonUrl', () => {
  it('builds canonical /dp/ URL', () => {
    expect(normaliseAmazonUrl('B07VP5X239')).toBe('https://www.amazon.es/dp/B07VP5X239');
  });
});

describe('affiliateUrl tag configuration', () => {
  const saved = process.env.AMAZON_AFFILIATE_TAG;
  afterEach(() => { if (saved === undefined) delete process.env.AMAZON_AFFILIATE_TAG; else process.env.AMAZON_AFFILIATE_TAG = saved; });
  it('defaults to ojoalprecio0d-21 and never to the old ID', () => {
    delete process.env.AMAZON_AFFILIATE_TAG;
    const out = affiliateUrl('https://www.amazon.es/dp/B07VP5X239');
    expect(out).toContain('tag=ojoalprecio0d-21');
    expect(out).not.toContain('canidrone');
  });
  it('can be overridden with AMAZON_AFFILIATE_TAG', () => {
    process.env.AMAZON_AFFILIATE_TAG = 'otro-21';
    expect(affiliateUrl('https://www.amazon.es/dp/B07VP5X239')).toContain('tag=otro-21');
  });
  it('ignores an empty or malformed value', () => {
    process.env.AMAZON_AFFILIATE_TAG = 'x y&z';
    expect(affiliateUrl('https://www.amazon.es/dp/B07VP5X239')).toContain('tag=ojoalprecio0d-21');
    process.env.AMAZON_AFFILIATE_TAG = '  ';
    expect(affiliateUrl('https://www.amazon.es/dp/B07VP5X239')).toContain('tag=ojoalprecio0d-21');
  });
});

describe('affiliateUrl', () => {
  it('appends our affiliate tag and language=es_ES', () => {
    const out = affiliateUrl('https://www.amazon.es/dp/B07VP5X239');
    expect(out).toContain('tag=ojoalprecio0d-21');
    expect(out).toContain('language=es_ES');
  });
  it('overrides a pre-existing tag with ours', () => {
    const out = affiliateUrl('https://www.amazon.es/dp/B07VP5X239?tag=foo-21');
    expect(out).toContain('tag=ojoalprecio0d-21');
    expect(out).not.toContain('tag=foo-21');
  });
  it('preserves unrelated query params (e.g. th=1)', () => {
    const out = affiliateUrl('https://www.amazon.es/dp/B07VP5X239?th=1');
    expect(out).toContain('th=1');
    expect(out).toContain('tag=ojoalprecio0d-21');
  });
  it('returns the input unchanged on malformed URLs', () => {
    expect(affiliateUrl('not-a-url')).toBe('not-a-url');
  });
});
