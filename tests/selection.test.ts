import { describe, it, expect } from 'vitest';
import { selectDue } from '../src/scheduler/selection';
import { shouldSendAlert, _resetAlertThrottle } from '../src/lib/ops-alert';

const H = 3600_000;
const now = Date.parse('2026-11-10T12:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * H);
const row = (id: number, o: Partial<{ isAvailable: boolean; lastCheckedAt: Date | null; lastScrapedAt: Date | null }> = {}) =>
  ({ id, isAvailable: true, lastCheckedAt: null, lastScrapedAt: null, ...o });

describe('selectDue — fair scrape ordering', () => {
  it('puts never-scraped products first, then oldest attempt first', () => {
    const out = selectDue([
      row(1, { lastCheckedAt: at(2) }),
      row(2, { lastCheckedAt: at(30) }),
      row(3),                                  // never scraped
      row(4, { lastCheckedAt: at(10) }),
    ], now, 59 * 60_000, 12 * H);
    expect(out.map(r => r.id)).toEqual([3, 2, 4, 1]);
  });

  it('skips products checked more recently than the minimum age', () => {
    const out = selectDue([row(1, { lastCheckedAt: at(0.5) }), row(2, { lastCheckedAt: at(2) })], now, 59 * 60_000, 12 * H);
    expect(out.map(r => r.id)).toEqual([2]);
  });

  it('uses the last successful scrape while last_checked_at is still empty', () => {
    const out = selectDue([row(1, { lastScrapedAt: at(100) }), row(2, { lastScrapedAt: at(5) })], now, 59 * 60_000, 12 * H);
    expect(out.map(r => r.id)).toEqual([1, 2]);
  });

  it('rechecks unavailable products only every 12 h', () => {
    const out = selectDue([
      row(1, { isAvailable: false, lastCheckedAt: at(3) }),   // too soon
      row(2, { isAvailable: false, lastCheckedAt: at(13) }),  // due
      row(3, { isAvailable: true,  lastCheckedAt: at(3) }),   // due
    ], now, 59 * 60_000, 12 * H);
    expect(out.map(r => r.id).sort()).toEqual([2, 3]);
  });

  it('is stable for equal timestamps (by id) and tolerates invalid dates', () => {
    const t = at(5);
    const out = selectDue([row(9, { lastCheckedAt: t }), row(2, { lastCheckedAt: t }), row(5, { lastCheckedAt: 'basura' as any })], now, 59 * 60_000, 12 * H);
    expect(out.map(r => r.id)).toEqual([5, 2, 9]);
  });
});

describe('shouldSendAlert — throttling', () => {
  it('sends once per key inside the interval, again after it, and keys are independent', () => {
    _resetAlertThrottle();
    expect(shouldSendAlert('stuck', 1_000, 3 * H)).toBe(true);
    expect(shouldSendAlert('stuck', 1_000 + H, 3 * H)).toBe(false);
    expect(shouldSendAlert('blocks', 1_000 + H, 3 * H)).toBe(true);
    expect(shouldSendAlert('stuck', 1_000 + 3 * H, 3 * H)).toBe(true);
  });
});
