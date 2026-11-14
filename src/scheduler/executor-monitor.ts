// Watches the resource state of remote scrape executors (the Pi): polls /health every 30 s,
// stores samples (for charts), emails the admin on trouble and pauses the remote worker while
// the machine is under pressure, so Home Assistant / Plex / Immich on the Pi never suffer.
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { getSetting } from '../db/settings';
import { sendOpsAlert } from '../lib/ops-alert';
import { parseRemotes } from '../scraper/remote';
import { evaluateSystem, formatSample, type HealthLevel, type SystemSample } from '../scraper/metrics';

export interface ExecutorSystemState {
  reachable: boolean;
  level: HealthLevel | 'unknown';
  reasons: string[];
  sample: SystemSample | null;
  at: number;
}

const PAUSE_MS = 10 * 60 * 1000;
const POLL_MS = 30 * 1000;

const state = new Map<string, ExecutorSystemState>();
const pausedUntil = new Map<string, number>();
const okStreak = new Map<string, number>();
let pollCount = 0;

export function getExecutorSystem(name: string): ExecutorSystemState | undefined { return state.get(name); }
export function isExecutorPaused(name: string, now = Date.now()): boolean { return (pausedUntil.get(name) ?? 0) > now; }

/** Pure transition used by the poller (and by tests): decide pause / resume from a new evaluation. */
export function nextPause(
  prev: { pausedUntil: number; okStreak: number },
  level: HealthLevel,
  now: number,
): { pausedUntil: number; okStreak: number; justPaused: boolean } {
  if (level === 'critical') {
    return { pausedUntil: now + PAUSE_MS, okStreak: 0, justPaused: prev.pausedUntil <= now };
  }
  const streak = level === 'ok' ? prev.okStreak + 1 : 0;
  // After a critical period resume only once the machine has been healthy for 2 polls in a row.
  if (prev.pausedUntil > now && streak >= 2) return { pausedUntil: 0, okStreak: streak, justPaused: false };
  return { pausedUntil: prev.pausedUntil, okStreak: streak, justPaused: false };
}

async function pollOne(name: string, baseUrl: string, token: string): Promise<void> {
  const now = Date.now();
  let sample: SystemSample | null = null;
  try {
    const res = await fetch(`${baseUrl}/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000) });
    if (res.ok) sample = ((await res.json()) as { system?: SystemSample | null }).system ?? null;
  } catch { /* unreachable: handled below */ }

  if (!sample) {
    state.set(name, { reachable: false, level: 'unknown', reasons: ['sin respuesta del servicio'], sample: null, at: now });
    return;
  }
  const ev = evaluateSystem(sample);
  state.set(name, { reachable: true, level: ev.level, reasons: ev.reasons, sample, at: now });

  const t = nextPause({ pausedUntil: pausedUntil.get(name) ?? 0, okStreak: okStreak.get(name) ?? 0 }, ev.level, now);
  okStreak.set(name, t.okStreak);
  if (t.pausedUntil) pausedUntil.set(name, t.pausedUntil); else pausedUntil.delete(name);

  if (t.justPaused) {
    console.log(`[executor-monitor] ${name} en estado crítico: ${ev.reasons.join('; ')} — worker remoto en pausa ${PAUSE_MS / 60000} min`);
    await sendOpsAlert(`executor-pressure-${name}`, `La Pi ("${name}") está al límite: scraper remoto en pausa`, [
      ...ev.reasons.map(r => `• ${r}`),
      '',
      `Estado: ${formatSample(sample)}`,
      `El worker remoto se detiene ${PAUSE_MS / 60000} minutos y se reanuda cuando la Pi se recupere (2 comprobaciones sanas seguidas).`,
      'Si se repite, baja scraper_remote_concurrency a 0 para apagarlo, o revisa qué otro servicio consume la Pi.',
    ], 60 * 60 * 1000);
  } else if (ev.level === 'warn') {
    console.log(`[executor-monitor] ${name} aviso: ${ev.reasons.join('; ')}`);
  }

  // One stored sample per minute (every 2nd poll).
  if (++pollCount % 2 === 0) {
    try {
      await db.execute(sql`
        INSERT INTO executor_metrics (executor, level, load1, host_mem_avail_mb, swap_growth_mb, container_mem_mb, container_cpu_pct, temp_c)
        VALUES (${name}, ${ev.level}, ${sample.load1}, ${sample.hostMemAvailMb}, ${sample.swapGrowthMb},
                ${sample.containerMemMb}, ${sample.containerCpuPct}, ${sample.tempC})
      `);
    } catch (err) { console.error('[executor-monitor] no se pudo guardar la muestra:', err instanceof Error ? err.message : err); }
  }
}

async function tick(): Promise<void> {
  const remotes = Math.max(0, Number(await getSetting('scraper_remote_concurrency', 0)));
  if (remotes <= 0) { pausedUntil.clear(); return; }
  for (const cfg of parseRemotes(process.env.SCRAPER_REMOTES, process.env.SCRAPER_REMOTE_TOKEN)) {
    await pollOne(cfg.name, cfg.baseUrl, cfg.token);
  }
}

export function startExecutorMonitor(): void {
  setInterval(() => { tick().catch(err => console.error('[executor-monitor] failed:', err instanceof Error ? err.message : err)); }, POLL_MS).unref();
  console.log('[executor-monitor] Vigilancia de CPU/memoria de ejecutores remotos cada 30 s (solo si scraper_remote_concurrency > 0).');
}

/** Hourly housekeeping: keep two weeks of samples. */
export async function pruneExecutorMetrics(): Promise<void> {
  await db.execute(sql`DELETE FROM executor_metrics WHERE ts < NOW() - INTERVAL '14 days'`);
}
