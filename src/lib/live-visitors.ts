// Live visitors, without storing anything personal. A visit is remembered only in memory, under a salted
// hash of (IP + user agent) whose salt is random and changes every day, so it cannot be traced back to a
// person or followed across days. What reaches the database is only counts: one row per minute with how
// many visitors were active in the last 5 minutes, and one row per day with unique visitors and the peak.
import { createHash, randomBytes } from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';

export const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
const KEEP_MS = 30 * 60 * 1000;

export interface LiveSnapshot { active: number; loggedIn: number; uniquesToday: number; peakToday: number; day: string }

export class LiveVisitors {
  private seen = new Map<string, number>();        // visitor hash -> last seen (ms)
  private users = new Map<number, number>();       // logged-in user id -> last seen (ms)
  private today = new Set<string>();
  private day = '';
  private salt = '';
  private peak = 0;

  constructor(private readonly now: () => number = Date.now, private readonly makeSalt: () => string = () => randomBytes(16).toString('hex')) {}

  private rollDay(t: number): void {
    const d = new Date(t).toISOString().slice(0, 10);
    if (d !== this.day) { this.day = d; this.salt = this.makeSalt(); this.today = new Set(); this.peak = 0; this.seen.clear(); }
  }

  /** Register a page view of a person (never call it for bots). */
  touch(ip: string, userAgent: string, userId?: number | null): void {
    const t = this.now();
    this.rollDay(t);
    const h = createHash('sha256').update(this.salt + '|' + ip + '|' + userAgent).digest('hex').slice(0, 24);
    this.seen.set(h, t);
    this.today.add(h);
    if (userId) this.users.set(userId, t);
    this.prune(t);
    const a = this.countActive(t);
    if (a > this.peak) this.peak = a;
  }

  private prune(t: number): void {
    if (this.seen.size < 2000 && this.users.size < 500) return;
    for (const [k, v] of this.seen) if (t - v > KEEP_MS) this.seen.delete(k);
    for (const [k, v] of this.users) if (t - v > KEEP_MS) this.users.delete(k);
  }
  private countActive(t: number): number { let n = 0; for (const v of this.seen.values()) if (t - v <= ACTIVE_WINDOW_MS) n++; return n; }

  snapshot(): LiveSnapshot {
    const t = this.now();
    this.rollDay(t);
    let loggedIn = 0; for (const v of this.users.values()) if (t - v <= ACTIVE_WINDOW_MS) loggedIn++;
    const active = this.countActive(t);
    return { active, loggedIn, uniquesToday: this.today.size, peakToday: Math.max(this.peak, active), day: this.day };
  }
}

export const liveVisitors = new LiveVisitors();

async function record(): Promise<void> {
  const s = liveVisitors.snapshot();
  try {
    await db.execute(sql`INSERT INTO visitor_samples (active, logged_in) VALUES (${s.active}, ${s.loggedIn})`);
    // A restart empties today's set, so never let the stored figures go down.
    await db.execute(sql`
      INSERT INTO visitor_daily (day, uniques, peak) VALUES (${s.day}, ${s.uniquesToday}, ${s.peakToday})
      ON CONFLICT (day) DO UPDATE SET uniques = GREATEST(visitor_daily.uniques, EXCLUDED.uniques), peak = GREATEST(visitor_daily.peak, EXCLUDED.peak)`);
  } catch (err) { console.error('[visitors] no se pudo guardar la muestra:', err instanceof Error ? err.message : err); }
}

export function startVisitorRecorder(): void {
  setInterval(() => { void record(); }, 60_000).unref();
}

export async function pruneVisitorSamples(): Promise<void> {
  await db.execute(sql`DELETE FROM visitor_samples WHERE ts < NOW() - INTERVAL '14 days'`);
  await db.execute(sql`DELETE FROM visitor_daily WHERE day < TO_CHAR(CURRENT_DATE - 400, 'YYYY-MM-DD')`);
}
