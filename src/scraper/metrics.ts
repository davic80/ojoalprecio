// Resource metrics of the machine running the scrape service (the Raspberry Pi).
// Sampled from the moment the service starts; exposed through /health and /metrics and
// polled by the main server, which stores them and pauses the remote worker when the
// Pi is under pressure. Parsers are pure so they are unit-testable.
import fs from 'fs';
import os from 'os';

export interface SystemSample {
  ts: number;
  /** 1-minute load average of the HOST (a Pi 5 has 4 cores). */
  load1: number;
  hostMemTotalMb: number;
  /** MemAvailable: what the host can still hand out without swapping. */
  hostMemAvailMb: number;
  swapUsedMb: number;
  /** Growth of swap use since the service started (the Pi already lives with a lot of swap). */
  swapGrowthMb: number;
  /** cgroup memory of this container vs its limit. */
  containerMemMb: number | null;
  containerMemLimitMb: number | null;
  /** CPU use of this container, in % of ONE core. */
  containerCpuPct: number | null;
  tempC: number | null;
  inFlight?: number;
}

export function parseMeminfo(text: string): { totalKb: number; availKb: number; swapTotalKb: number; swapFreeKb: number } {
  const get = (k: string) => { const m = new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(text); return m ? parseInt(m[1], 10) : 0; };
  return { totalKb: get('MemTotal'), availKb: get('MemAvailable'), swapTotalKb: get('SwapTotal'), swapFreeKb: get('SwapFree') };
}

/** `usage_usec` from a cgroup v2 cpu.stat. */
export function parseCgroupCpuUsec(text: string): number | null {
  const m = /^usage_usec\s+(\d+)/m.exec(text);
  return m ? parseInt(m[1], 10) : null;
}

/** memory.current / memory.max ("max" = unlimited) → MB. */
export function parseCgroupMemory(current: string, max: string): { usedMb: number | null; limitMb: number | null } {
  const cur = parseInt(current.trim(), 10);
  const lim = max.trim() === 'max' ? NaN : parseInt(max.trim(), 10);
  return {
    usedMb: Number.isFinite(cur) ? Math.round(cur / 1048576) : null,
    limitMb: Number.isFinite(lim) ? Math.round(lim / 1048576) : null,
  };
}

export interface SampleReaders {
  meminfo: () => string;
  cgroupCpuStat: () => string | null;
  cgroupMemCurrent: () => string | null;
  cgroupMemMax: () => string | null;
  tempMilli: () => string | null;
  load1: () => number;
  now: () => number;
}

const tryRead = (p: string) => () => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

export const defaultReaders: SampleReaders = {
  meminfo: () => fs.readFileSync('/proc/meminfo', 'utf8'),
  cgroupCpuStat: tryRead('/sys/fs/cgroup/cpu.stat'),
  cgroupMemCurrent: tryRead('/sys/fs/cgroup/memory.current'),
  cgroupMemMax: tryRead('/sys/fs/cgroup/memory.max'),
  tempMilli: tryRead('/sys/class/thermal/thermal_zone0/temp'),
  load1: () => os.loadavg()[0],
  now: () => Date.now(),
};

export class MetricsSampler {
  private timer: NodeJS.Timeout | null = null;
  private lastCpuUsec: number | null = null;
  private lastCpuAt = 0;
  private baselineSwapMb: number | null = null;
  private readonly samples: SystemSample[] = [];
  inFlight: () => number = () => 0;

  constructor(private readonly readers: SampleReaders = defaultReaders, private readonly keep = 360) {}

  /** Take one sample (also used directly by tests). */
  sample(): SystemSample {
    const r = this.readers;
    const now = r.now();
    const mi = parseMeminfo(r.meminfo());
    const swapUsedMb = Math.round((mi.swapTotalKb - mi.swapFreeKb) / 1024);
    if (this.baselineSwapMb === null) this.baselineSwapMb = swapUsedMb;

    let cpuPct: number | null = null;
    const cpuText = r.cgroupCpuStat();
    const usec = cpuText ? parseCgroupCpuUsec(cpuText) : null;
    if (usec !== null) {
      if (this.lastCpuUsec !== null && now > this.lastCpuAt) {
        cpuPct = Math.round(((usec - this.lastCpuUsec) / ((now - this.lastCpuAt) * 1000)) * 1000) / 10;
      }
      this.lastCpuUsec = usec; this.lastCpuAt = now;
    }

    const cur = r.cgroupMemCurrent(), max = r.cgroupMemMax();
    const mem = cur !== null && max !== null ? parseCgroupMemory(cur, max) : { usedMb: null, limitMb: null };
    const temp = r.tempMilli();
    const tempC = temp !== null && Number.isFinite(parseInt(temp, 10)) ? Math.round(parseInt(temp, 10) / 100) / 10 : null;

    const s: SystemSample = {
      ts: now,
      load1: Math.round(r.load1() * 100) / 100,
      hostMemTotalMb: Math.round(mi.totalKb / 1024),
      hostMemAvailMb: Math.round(mi.availKb / 1024),
      swapUsedMb,
      swapGrowthMb: swapUsedMb - this.baselineSwapMb,
      containerMemMb: mem.usedMb,
      containerMemLimitMb: mem.limitMb,
      containerCpuPct: cpuPct,
      tempC,
      inFlight: this.inFlight(),
    };
    this.samples.push(s);
    if (this.samples.length > this.keep) this.samples.shift();
    return s;
  }

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.sample();
    this.timer = setInterval(() => { try { this.sample(); } catch { /* keep sampling */ } }, intervalMs);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  latest(): SystemSample | null { return this.samples[this.samples.length - 1] ?? null; }
  history(maxPoints = 60): SystemSample[] {
    const n = this.samples.length;
    if (n <= maxPoints) return [...this.samples];
    const step = n / maxPoints;
    return Array.from({ length: maxPoints }, (_, i) => this.samples[Math.min(n - 1, Math.floor(i * step))]);
  }
}

export function formatSample(s: SystemSample): string {
  return `cpu=${s.containerCpuPct ?? '?'}% mem=${s.containerMemMb ?? '?'}/${s.containerMemLimitMb ?? '?'}MB ` +
    `hostLibre=${s.hostMemAvailMb}MB swap+${s.swapGrowthMb}MB temp=${s.tempC ?? '?'}°C load1=${s.load1}`;
}

// ── Health evaluation (used by the main server) ──────────────────────────────────────────────
export type HealthLevel = 'ok' | 'warn' | 'critical';

export interface Thresholds {
  memAvailWarnMb: number; memAvailCritMb: number;
  tempWarnC: number;      tempCritC: number;
  swapGrowthWarnMb: number; swapGrowthCritMb: number;
  loadWarn: number;       loadCrit: number;
  containerMemWarnPct: number;
}

/** Defaults for a Raspberry Pi 5 (4 cores, 8 GB) that already runs many services. */
export const PI_THRESHOLDS: Thresholds = {
  memAvailWarnMb: 1000, memAvailCritMb: 600,
  tempWarnC: 75, tempCritC: 82,
  swapGrowthWarnMb: 600, swapGrowthCritMb: 1500,
  loadWarn: 3.0, loadCrit: 3.8,
  containerMemWarnPct: 90,
};

export function evaluateSystem(s: SystemSample, t: Thresholds = PI_THRESHOLDS): { level: HealthLevel; reasons: string[] } {
  const warn: string[] = [], crit: string[] = [];
  if (s.hostMemAvailMb < t.memAvailCritMb) crit.push(`memoria libre del host ${s.hostMemAvailMb} MB (< ${t.memAvailCritMb})`);
  else if (s.hostMemAvailMb < t.memAvailWarnMb) warn.push(`memoria libre del host ${s.hostMemAvailMb} MB`);
  if (s.tempC !== null) {
    if (s.tempC >= t.tempCritC) crit.push(`temperatura ${s.tempC} °C`);
    else if (s.tempC >= t.tempWarnC) warn.push(`temperatura ${s.tempC} °C`);
  }
  if (s.swapGrowthMb > t.swapGrowthCritMb) crit.push(`el swap ha crecido ${s.swapGrowthMb} MB desde el arranque`);
  else if (s.swapGrowthMb > t.swapGrowthWarnMb) warn.push(`el swap ha crecido ${s.swapGrowthMb} MB`);
  if (s.load1 > t.loadCrit) crit.push(`carga del host ${s.load1} (4 núcleos)`);
  else if (s.load1 > t.loadWarn) warn.push(`carga del host ${s.load1}`);
  if (s.containerMemMb !== null && s.containerMemLimitMb) {
    const pct = (s.containerMemMb / s.containerMemLimitMb) * 100;
    if (pct >= t.containerMemWarnPct) warn.push(`el contenedor usa el ${Math.round(pct)} % de su límite de memoria`);
  }
  if (crit.length) return { level: 'critical', reasons: [...crit, ...warn] };
  if (warn.length) return { level: 'warn', reasons: warn };
  return { level: 'ok', reasons: [] };
}
