import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import {
  parseMeminfo, parseCgroupCpuUsec, parseCgroupMemory, MetricsSampler, evaluateSystem, PI_THRESHOLDS,
  type SampleReaders, type SystemSample,
} from '../src/scraper/metrics';
import { nextPause } from '../src/scheduler/executor-monitor';
import { createService } from '../src/scraper/service';

const MEMINFO = `MemTotal:        8257536 kB
MemFree:          883000 kB
MemAvailable:    3348000 kB
SwapTotal:       8331264 kB
SwapFree:        3801088 kB
`;

describe('parsers', () => {
  it('reads /proc/meminfo, cgroup cpu.stat and memory files', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({ totalKb: 8257536, availKb: 3348000, swapTotalKb: 8331264, swapFreeKb: 3801088 });
    expect(parseCgroupCpuUsec('usage_usec 123456\nuser_usec 100\n')).toBe(123456);
    expect(parseCgroupCpuUsec('nonsense')).toBeNull();
    expect(parseCgroupMemory('536870912\n', '1073741824\n')).toEqual({ usedMb: 512, limitMb: 1024 });
    expect(parseCgroupMemory('536870912', 'max')).toEqual({ usedMb: 512, limitMb: null });
    expect(parseCgroupMemory('x', 'y')).toEqual({ usedMb: null, limitMb: null });
  });
});

describe('MetricsSampler', () => {
  function fake() {
    let t = 1_000_000, usec = 0, swapFreeKb = 3801088, availKb = 3348000;
    const readers: SampleReaders = {
      now: () => t,
      meminfo: () => `MemTotal: 8257536 kB\nMemAvailable: ${availKb} kB\nSwapTotal: 8331264 kB\nSwapFree: ${swapFreeKb} kB\n`,
      cgroupCpuStat: () => `usage_usec ${usec}\n`,
      cgroupMemCurrent: () => String(700 * 1048576),
      cgroupMemMax: () => String(1024 * 1048576),
      tempMilli: () => '61250',
      load1: () => 1.234,
    };
    return { readers, step: (ms: number, cpuUsec: number, swapGrowthKb = 0, avail = availKb) => { t += ms; usec += cpuUsec; swapFreeKb -= swapGrowthKb; availKb = avail; } };
  }

  it('computes container CPU % of one core from cgroup usage deltas', () => {
    const f = fake(); const s = new MetricsSampler(f.readers);
    expect(s.sample().containerCpuPct).toBeNull();                 // first sample has no delta yet
    f.step(10_000, 5_000_000);                                      // 5 s of CPU in 10 s → 50 %
    expect(s.sample().containerCpuPct).toBe(50);
  });

  it('reports swap GROWTH relative to the start (the Pi already lives with a lot of swap)', () => {
    const f = fake(); const s = new MetricsSampler(f.readers);
    const first = s.sample();
    expect(first.swapUsedMb).toBe(Math.round((8331264 - 3801088) / 1024));
    expect(first.swapGrowthMb).toBe(0);
    f.step(10_000, 0, 512 * 1024);
    expect(s.sample().swapGrowthMb).toBe(512);
  });

  it('exposes memory, temperature and load, keeps a bounded history and downsamples it', () => {
    const f = fake(); const s = new MetricsSampler(f.readers, 100);
    for (let i = 0; i < 250; i++) { f.step(10_000, 1_000_000); s.sample(); }
    const last = s.latest()!;
    expect([last.containerMemMb, last.containerMemLimitMb, last.tempC, last.load1, last.hostMemAvailMb]).toEqual([700, 1024, 61.3, 1.23, 3270]);
    expect(s.history(1000).length).toBe(100);
    expect(s.history(10).length).toBe(10);
  });

  it('survives missing files (not on Linux / no cgroup v2)', () => {
    const f = fake();
    const s = new MetricsSampler({ ...f.readers, cgroupCpuStat: () => null, cgroupMemCurrent: () => null, cgroupMemMax: () => null, tempMilli: () => null });
    const r = s.sample();
    expect([r.containerCpuPct, r.containerMemMb, r.tempC]).toEqual([null, null, null]);
  });
});

const base = (o: Partial<SystemSample> = {}): SystemSample => ({
  ts: 0, load1: 0.5, hostMemTotalMb: 8064, hostMemAvailMb: 3300, swapUsedMb: 4400, swapGrowthMb: 0,
  containerMemMb: 600, containerMemLimitMb: 1024, containerCpuPct: 40, tempC: 60, ...o,
});

describe('evaluateSystem', () => {
  it('a healthy Pi (the real baseline we measured) is ok', () => {
    expect(evaluateSystem(base())).toEqual({ level: 'ok', reasons: [] });
  });
  it('flags warn and critical per signal', () => {
    expect(evaluateSystem(base({ hostMemAvailMb: 900 })).level).toBe('warn');
    expect(evaluateSystem(base({ hostMemAvailMb: 500 })).level).toBe('critical');
    expect(evaluateSystem(base({ tempC: 76 })).level).toBe('warn');
    expect(evaluateSystem(base({ tempC: 83 })).level).toBe('critical');
    expect(evaluateSystem(base({ swapGrowthMb: 700 })).level).toBe('warn');
    expect(evaluateSystem(base({ swapGrowthMb: 1600 })).level).toBe('critical');
    expect(evaluateSystem(base({ load1: 3.2 })).level).toBe('warn');
    expect(evaluateSystem(base({ load1: 4.0 })).level).toBe('critical');
    expect(evaluateSystem(base({ containerMemMb: 950 })).level).toBe('warn');
  });
  it('critical wins and lists every reason; missing temperature is not an error', () => {
    const r = evaluateSystem(base({ hostMemAvailMb: 400, load1: 4.5, tempC: null }));
    expect(r.level).toBe('critical');
    expect(r.reasons.length).toBe(2);
    expect(PI_THRESHOLDS.memAvailCritMb).toBeLessThan(PI_THRESHOLDS.memAvailWarnMb);
  });
});

describe('nextPause (pause the remote worker while the Pi is under pressure)', () => {
  const T = 1_000_000;
  it('critical pauses for 10 min and reports the first pause only', () => {
    const a = nextPause({ pausedUntil: 0, okStreak: 0 }, 'critical', T);
    expect(a.pausedUntil).toBe(T + 600_000); expect(a.justPaused).toBe(true);
    const b = nextPause({ pausedUntil: a.pausedUntil, okStreak: 0 }, 'critical', T + 30_000);
    expect(b.justPaused).toBe(false);                               // no repeated alert while still paused
    expect(b.pausedUntil).toBe(T + 30_000 + 600_000);               // pause is extended
  });
  it('resumes only after 2 healthy polls in a row; warn does not resume', () => {
    const paused = { pausedUntil: T + 600_000, okStreak: 0 };
    const w = nextPause(paused, 'warn', T + 60_000);
    expect(w.pausedUntil).toBe(T + 600_000);
    const o1 = nextPause(paused, 'ok', T + 60_000);
    expect(o1.pausedUntil).toBe(T + 600_000);                       // 1 ok is not enough
    const o2 = nextPause({ pausedUntil: o1.pausedUntil, okStreak: o1.okStreak }, 'ok', T + 90_000);
    expect(o2.pausedUntil).toBe(0);
  });
  it('healthy and never paused stays that way', () => {
    expect(nextPause({ pausedUntil: 0, okStreak: 0 }, 'ok', T)).toEqual({ pausedUntil: 0, okStreak: 1, justPaused: false });
  });
});

describe('service exposes the system state', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>(r => { server ? server.close(() => r()) : r(); server = null; }));
  it('/health carries the latest sample and /metrics the history (token required)', async () => {
    const sample = base({ hostMemAvailMb: 3100 });
    server = http.createServer(createService({ token: 't'.repeat(30), scrape: async () => { throw new Error('unused'); }, concurrency: 1, getSystem: () => sample, getHistory: () => [sample, sample] }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const h = await (await fetch(`${url}/health`, { headers: { authorization: 'Bearer ' + 't'.repeat(30) } })).json() as any;
    expect(h.system.hostMemAvailMb).toBe(3100);
    const m = await (await fetch(`${url}/metrics`, { headers: { authorization: 'Bearer ' + 't'.repeat(30) } })).json() as any;
    expect(m.samples.length).toBe(2);
    expect((await fetch(`${url}/metrics`)).status).toBe(401);
  });
});
