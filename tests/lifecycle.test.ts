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
