import { describe, it, expect } from 'vitest';
import { isTransientBrowserError, friendlyScrapeError } from '../src/lib/transient';

describe('isTransientBrowserError', () => {
  it('recognises a Chromium restart seen from a running page', () => {
    expect(isTransientBrowserError(new Error('page.evaluate: Target page, context or browser has been closed'))).toBe(true);
    expect(isTransientBrowserError(new Error('browserType.launch: Target closed'))).toBe(true);
    expect(isTransientBrowserError(new Error('Protocol error (Target.createTarget): Browser closed'))).toBe(true);
  });
  it('does not treat product problems as transient', () => {
    expect(isTransientBrowserError(new Error('Sin oferta de Amazon — solo terceros vendedores'))).toBe(false);
    expect(isTransientBrowserError(new Error('ASIN inválido: x'))).toBe(false);
    expect(isTransientBrowserError(null)).toBe(false);
  });
});

describe('friendlyScrapeError', () => {
  it('hides raw scraper errors from the people who add products', () => {
    expect(friendlyScrapeError('page.evaluate: Target page, context or browser has been closed')).toBe('Reintentando automáticamente…');
    expect(friendlyScrapeError('[hard_timeout] 24s')).toBe('Reintentando automáticamente…');
    expect(friendlyScrapeError('algo raro')).toContain('se reintentará');
  });
});
