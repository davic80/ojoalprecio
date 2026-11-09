// Fair work selection for the scrape cycle. Pure so it is unit-testable.
//
// Old behaviour: no ORDER BY + a single worker that aborted the whole cycle on
// the first Amazon block meant the same ~300 products were re-scraped every
// hour while ~3,500 starved for weeks. Now: oldest-checked first, and the
// reference time is the last *attempt* (not the last successful price), so
// dead or unavailable products can't hog the front of the queue either.

export interface DueCandidate {
  id: number;
  isAvailable: boolean;
  /** Last time we tried to scrape it (success or not). */
  lastCheckedAt: Date | string | null;
  /** Last successful price row; fallback while last_checked_at is still empty. */
  lastScrapedAt: Date | string | null;
}

function ts(v: Date | string | null): number | null {
  if (v === null || v === undefined) return null;
  const n = new Date(v).getTime();
  return Number.isNaN(n) ? null : n;
}

export function selectDue<T extends DueCandidate>(
  rows: T[],
  now: number,
  minAgeMs: number,
  unavailableRecheckMs: number,
): T[] {
  const due: Array<{ row: T; ref: number | null }> = [];
  for (const row of rows) {
    const ref = ts(row.lastCheckedAt) ?? ts(row.lastScrapedAt);
    if (ref === null) { due.push({ row, ref }); continue; } // never scraped → first in line
    const minAge = row.isAvailable ? minAgeMs : Math.max(minAgeMs, unavailableRecheckMs);
    if (now - ref >= minAge) due.push({ row, ref });
  }
  due.sort((a, b) => {
    if (a.ref === null && b.ref === null) return a.row.id - b.row.id;
    if (a.ref === null) return -1;
    if (b.ref === null) return 1;
    return a.ref - b.ref || a.row.id - b.row.id;
  });
  return due.map(d => d.row);
}
