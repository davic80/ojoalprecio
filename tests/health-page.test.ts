import { describe, it, expect } from 'vitest';
import ejs from 'ejs';
import path from 'path';
import { LiveVisitors } from '../src/lib/live-visitors';
import { alignBuckets, summarize, sparkline } from '../src/lib/spark';

describe('spark helpers', () => {
  it('aligns rows onto fixed buckets and leaves gaps as null', () => {
    const rows = [{ b: 1000, v: 5 }, { b: 1600, v: 7 }, { b: 99999, v: 1 }];
    expect(alignBuckets(rows, r => r.v, 1000, 600, 4)).toEqual([5, 7, null, null]);
  });
  it('summarizes last/min/max and ignores gaps', () => {
    expect(summarize([null, 3, 9, null, 5])).toEqual({ last: 5, min: 3, max: 9 });
    expect(summarize([null, null])).toEqual({ last: null, min: null, max: null });
  });
  it('draws a polyline, breaks it at gaps, and says "sin datos" when there is nothing to draw', () => {
    expect(sparkline([1, 2, 3], { label: 'x' })).toContain('<polyline');
    expect((sparkline([1, 2, null, 3, 4]).match(/<polyline/g) ?? []).length).toBe(2);
    expect(sparkline([null, 4, null])).toContain('sin datos');
  });
});

describe('admin-salud view', () => {
  it('renders with representative data (executors, charts, app block) without template errors', async () => {
    const chart = (key: string) => ({ key, label: key, unit: 'u', svg: sparkline([1, 2, 3]), last: 3, min: 1, max: 3 });
    const html = await ejs.renderFile(path.resolve(__dirname, '..', 'src', 'views', 'admin-salud.ejs'), {
      user: { email: 'a@b.c' }, isAdmin: true, generatedAt: Date.now(), siteUrl: 'https://x.test',
      scraping: { ok: true, stuck: false, noAnswers: false, lastProgressAgeSec: 3, lastAnswerAgeSec: 3, queueDone: 5, queueTotal: 50, avgAgeH: 4.6, read24h: 4100, total: 4130, failed: 2, lastHour: 478, totalRange: 11000 },
      range: '24h',
      bars: Array.from({ length: 24 }, (_, i) => ({ label: i + ':00', tip: i + ':00', n: i * 20, partial: i === 23 })), maxBar: 460,
      visitors: { live: { active: 7, loggedIn: 2, uniquesToday: 120, peakToday: 15, day: '2026-11-18' }, activeSvg: sparkline([1, 4, 2]), loggedSvg: sparkline([0, 1, 1]), activeSummary: { last: 2, min: 1, max: 4 }, daily: [{ day: '2026-11-17', uniques: 90, peak: 9 }, { day: '2026-11-18', uniques: 120, peak: 15 }], maxDaily: 120, usersTotal: 5, new24h: 0, new7d: 1, viewsToday: 300 },
      machines: [
        { name: 'local', kind: 'local', level: 'ok', reachable: true, paused: false, breakerOpen: false, done: 10, failed: 0, lastError: null, charts: ['load', 'cpu', 'mem', 'swap'].map(chart) },
        { name: 'pi4', kind: 'remote', level: 'warn', reachable: true, paused: false, breakerOpen: false, done: 3, failed: 1, lastError: 'boom', charts: ['load', 'temp', 'dns'].map(chart) },
      ],
      app: { version: '3.66.0', commit: 'abc1234', uptimeMs: 7_200_000, rssMb: 550, heapMb: 120, dbPingMs: 2, dbMb: 900, priceRows: 490000, activeProducts: 4154, diskPct: 61, diskFreeGb: 40.5, hostMemAvailMb: 1700, hostMemTotalMb: 3800, load1: 3.2 },
    } as any, { async: true } as any);
    for (const t of ['Últimos 7 días', 'Visitantes', 'visitantes ahora', 'usuarios registrados', 'Salud y rendimiento', 'Lecturas por hora', 'Ejecutores', 'pi4', 'aviso', 'latencia de la BD', '61 %']) expect(html).toContain(t);
  });
});

describe('LiveVisitors (counts only, in memory)', () => {
  const mk = () => { let t = Date.UTC(2026, 10, 18, 12, 0, 0); let n = 0; const lv = new LiveVisitors(() => t, () => 'salt' + (++n)); return { lv, adv: (ms: number) => { t += ms; } }; };
  it('counts distinct visitors active in the last 5 minutes and drops them afterwards', () => {
    const { lv, adv } = mk();
    lv.touch('1.1.1.1', 'ua'); lv.touch('1.1.1.1', 'ua'); lv.touch('2.2.2.2', 'ua', 42);
    expect(lv.snapshot()).toMatchObject({ active: 2, loggedIn: 1, uniquesToday: 2, peakToday: 2 });
    adv(6 * 60_000);
    expect(lv.snapshot()).toMatchObject({ active: 0, loggedIn: 0, uniquesToday: 2, peakToday: 2 });
  });
  it('starts a new day with a new salt: nothing carries over', () => {
    const { lv, adv } = mk();
    lv.touch('1.1.1.1', 'ua');
    adv(24 * 3600_000);
    expect(lv.snapshot()).toMatchObject({ active: 0, uniquesToday: 0, peakToday: 0 });
    lv.touch('1.1.1.1', 'ua');
    expect(lv.snapshot().uniquesToday).toBe(1);
  });
  it('never keeps the IP or the user agent', () => {
    const { lv } = mk();
    lv.touch('9.9.9.9', 'SecretAgent/1.0', 7);
    expect(JSON.stringify([...(lv as any).seen.keys()])).not.toContain('9.9.9.9');
    expect(JSON.stringify([...(lv as any).seen.keys()])).not.toContain('SecretAgent');
  });
});
