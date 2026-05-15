import { describe, it, expect } from 'vitest';
import { calcSaleTier, evaluateAutoFeature } from '../src/scheduler/sale-logic';

describe('calcSaleTier', () => {
  it('returns no sale when below 7% off', () => {
    const r = calcSaleTier(95, 100);
    expect(r.isOnSale).toBe(false);
    expect(r.saleTier).toBeNull();
    expect(r.dealScore).toBeNull();
  });

  it('returns oferta tier between 7% and 15% off', () => {
    const r = calcSaleTier(90, 100);
    expect(r.isOnSale).toBe(true);
    expect(r.saleTier).toBe('oferta');
    expect(r.dealScore).toBe(10);
  });

  it('returns super-oferta tier between 15% and 30%', () => {
    const r = calcSaleTier(80, 100);
    expect(r.saleTier).toBe('super-oferta');
    expect(r.dealScore).toBe(20);
  });

  it('returns mega-oferta tier between 30% and 50%', () => {
    const r = calcSaleTier(60, 100);
    expect(r.saleTier).toBe('mega-oferta');
    expect(r.dealScore).toBe(40);
  });

  it('returns broooooferton tier between 50% and 67%', () => {
    const r = calcSaleTier(40, 100);
    expect(r.saleTier).toBe('broooooferton');
    expect(r.dealScore).toBe(60);
  });

  it('returns 67oferta tier at 67%+', () => {
    const r = calcSaleTier(25, 100);
    expect(r.saleTier).toBe('67oferta');
    expect(r.dealScore).toBe(75);
  });

  it('handles exact threshold at 7%', () => {
    expect(calcSaleTier(93, 100).saleTier).toBe('oferta');
  });
  it('handles just-below 7%', () => {
    expect(calcSaleTier(93.5, 100).isOnSale).toBe(false);
  });
});

describe('evaluateAutoFeature', () => {
  const now = new Date('2026-05-15T10:00:00Z');
  const onSale20 = { isOnSale: true, saleTier: 'super-oferta', dealScore: 20 };
  const onSale10 = { isOnSale: true, saleTier: 'oferta', dealScore: 10 };
  const noSale = { isOnSale: false, saleTier: null, dealScore: null };

  // ── Entry ──
  it('enters when not featured + meets entry criteria', () => {
    const r = evaluateAutoFeature({ isPublic: false, isAvailable: true, featuredAt: null }, onSale20, 10, 5, 20, now);
    expect(r.isPublic).toBe(true);
    expect(r.featuredAt).toEqual(now);
  });

  it('does not enter with insufficient scrape history', () => {
    const r = evaluateAutoFeature({ isPublic: false, isAvailable: true, featuredAt: null }, onSale20, 3, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  it('does not enter with insufficient days_span', () => {
    const r = evaluateAutoFeature({ isPublic: false, isAvailable: true, featuredAt: null }, onSale20, 10, 1, 20, now);
    expect(r.isPublic).toBe(false);
  });

  it('does not enter when unavailable', () => {
    const r = evaluateAutoFeature({ isPublic: false, isAvailable: false, featuredAt: null }, onSale20, 10, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  it('does not enter when not on sale even with enough history', () => {
    const r = evaluateAutoFeature({ isPublic: false, isAvailable: true, featuredAt: null }, noSale, 10, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  it('does not enter at deal_score below minScore', () => {
    const r = evaluateAutoFeature({ isPublic: false, isAvailable: true, featuredAt: null }, onSale10, 10, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  // ── Hysteresis on exit ──
  it('keeps featured at deal_score 17% (above exit=15, below entry=20)', () => {
    const featuredAt = new Date('2026-05-14T10:00:00Z'); // 1 day ago
    const r = evaluateAutoFeature(
      { isPublic: true, isAvailable: true, featuredAt },
      { isOnSale: true, saleTier: 'super-oferta', dealScore: 17 },
      10, 5, 20, now,
    );
    expect(r.isPublic).toBe(true);
    expect(r.featuredAt).toEqual(featuredAt); // preserved
  });

  it('exits when deal_score drops below exit threshold', () => {
    const featuredAt = new Date('2026-05-14T10:00:00Z');
    const r = evaluateAutoFeature(
      { isPublic: true, isAvailable: true, featuredAt },
      { isOnSale: true, saleTier: 'oferta', dealScore: 14 },
      10, 5, 20, now,
    );
    expect(r.isPublic).toBe(false);
    expect(r.featuredAt).toBeNull();
  });

  it('exits when no longer on sale', () => {
    const featuredAt = new Date('2026-05-14T10:00:00Z');
    const r = evaluateAutoFeature({ isPublic: true, isAvailable: true, featuredAt }, noSale, 10, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  it('exits when unavailable', () => {
    const featuredAt = new Date('2026-05-14T10:00:00Z');
    const r = evaluateAutoFeature({ isPublic: true, isAvailable: false, featuredAt }, onSale20, 10, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  // ── 14-day fatigue ──
  it('exits after 14 days of fatigue even if still on sale', () => {
    const featuredAt = new Date('2026-04-30T10:00:00Z'); // 15 days ago
    const r = evaluateAutoFeature({ isPublic: true, isAvailable: true, featuredAt }, onSale20, 10, 5, 20, now);
    expect(r.isPublic).toBe(false);
  });

  it('stays featured before fatigue at 13 days', () => {
    const featuredAt = new Date('2026-05-02T10:00:00Z'); // 13 days ago
    const r = evaluateAutoFeature({ isPublic: true, isAvailable: true, featuredAt }, onSale20, 10, 5, 20, now);
    expect(r.isPublic).toBe(true);
  });
});
