// Stateless scrape service. Runs on a remote machine (the Raspberry Pi) from the same image;
// it opens Chromium with ITS OWN egress IP and returns the result. It has no database access:
// the scheduler on the main server decides what to scrape and persists everything.
//
//   POST /scrape   {url, timeoutSeconds}   Authorization: Bearer <token>
//   GET  /health   (also needs the token)
import http from 'http';
import crypto from 'crypto';
import type { ScrapeResult } from './amazon';
import { serializeError, type WireResponse } from './wire';
import type { SystemSample } from './metrics';

export interface ServiceDeps {
  token: string;
  scrape: (url: string, timeoutSeconds: number) => Promise<ScrapeResult>;
  /** Parallel scrapes allowed. */
  concurrency: number;
  /** Extra requests allowed to wait; beyond this the service answers 503 "busy". */
  maxQueue?: number;
  version?: string;
  /** Latest resource sample of the machine (CPU, memory, swap, temperature). */
  getSystem?: () => SystemSample | null;
  /** Recent samples for /metrics. */
  getHistory?: (maxPoints: number) => SystemSample[];
  /** Refuse NEW scrapes (503) while the host's free memory is below this. Protects whatever else runs there (Pi-hole). */
  minFreeMemMb?: number;
  /**
   * Self-recycling. The Node process of the service slowly grows (about 300 MB/hour on the Pi 4)
   * and ends up killed by the kernel in the middle of scrapes. Instead of waiting for that, when it
   * crosses a limit the service stops taking new work (503 "recycling"), lets the running scrapes
   * finish and calls onRecycle (the entry point exits; Docker starts it again with fresh memory).
   */
  recycle?: {
    /** Node resident memory (MB) above which the service recycles. 0 = off. */
    maxRssMb?: number;
    /** Scrapes served since start above which the service recycles. 0 = off. */
    maxServed?: number;
    /** Current resident memory of this Node process in MB. */
    getRssMb?: () => number;
    /** Called once, when it is safe to exit (nothing in flight, or the drain took too long). */
    onRecycle: (why: string) => void;
    /** Max time to wait for running scrapes before exiting anyway. Default 90 s. */
    drainMs?: number;
  };
}

const AMAZON_DP = /^https:\/\/www\.amazon\.es\/dp\/[A-Z0-9]{10}(\?[A-Za-z0-9=&_%.-]*)?$/;

export function tokensMatch(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function createService(deps: ServiceDeps): http.RequestListener {
  let inFlight = 0;
  let queued = 0;
  const waiters: Array<() => void> = [];
  const maxQueue = deps.maxQueue ?? deps.concurrency * 2;
  let served = 0, failed = 0;
  const startedAt = Date.now();
  let recycling: string | null = null;
  let recycled = false;
  const fire = (why: string) => { if (recycled) return; recycled = true; deps.recycle!.onRecycle(why); };

  /** Decide, after each finished scrape, whether this process should be replaced by a fresh one. */
  function maybeRecycle() {
    const r = deps.recycle;
    if (!r) return;
    if (!recycling) {
      const rss = r.getRssMb?.() ?? 0;
      if (r.maxRssMb && rss >= r.maxRssMb) recycling = `memoria ${Math.round(rss)} MB (límite ${r.maxRssMb})`;
      else if (r.maxServed && served + failed >= r.maxServed) recycling = `${served + failed} consultas atendidas (límite ${r.maxServed})`;
      if (recycling) {
        const t = setTimeout(() => fire(`${recycling} — drenaje agotado`), r.drainMs ?? 90_000);
        t.unref();
      }
    }
    if (recycling && inFlight === 0 && queued === 0) fire(recycling);
  }

  async function acquire(): Promise<boolean> {
    if (inFlight < deps.concurrency) { inFlight++; return true; }
    if (queued >= maxQueue) return false;
    queued++;
    await new Promise<void>(r => waiters.push(r));
    queued--; inFlight++;
    return true;
  }
  function release() { inFlight--; waiters.shift()?.(); }

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  };

  return async (req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!given || !tokensMatch(given, deps.token)) return send(res, 401, { error: 'unauthorized' });

    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, {
        ok: true, inFlight, queued, served, failed, recycling: recycling !== null,
        rssMb: deps.recycle?.getRssMb ? Math.round(deps.recycle.getRssMb()) : undefined,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: deps.version ?? 'dev',
        system: deps.getSystem?.() ?? null,
      });
    }
    if (req.method === 'GET' && req.url === '/metrics') {
      return send(res, 200, { samples: deps.getHistory?.(60) ?? [] });
    }
    if (req.method !== 'POST' || req.url !== '/scrape') return send(res, 404, { error: 'not found' });

    // body (tiny)
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) return send(res, 413, { error: 'too large' }); }
    let payload: { url?: unknown; timeoutSeconds?: unknown };
    try { payload = JSON.parse(raw); } catch { return send(res, 400, { error: 'bad json' }); }
    const url = String(payload.url ?? '');
    // Only product pages of amazon.es: this service must not become an open fetch proxy.
    if (!AMAZON_DP.test(url)) return send(res, 400, { error: 'url not allowed' });
    const timeout = Math.max(15, Math.min(120, Number(payload.timeoutSeconds) || 30));

    // Self-protection, independent of the main server's polling: no new Chromium work when memory is nearly gone.
    const sys = deps.getSystem?.();
    if (deps.minFreeMemMb && sys && sys.hostMemAvailMb < deps.minFreeMemMb) return send(res, 503, { error: 'memory pressure' });

    if (recycling) return send(res, 503, { error: 'recycling' });
    if (!(await acquire())) return send(res, 503, { error: 'busy' });
    try {
      const result = await deps.scrape(url, timeout);
      served++;
      send(res, 200, { ok: true, result } satisfies WireResponse);
    } catch (e) {
      failed++;
      send(res, 200, { ok: false, error: serializeError(e) } satisfies WireResponse);
    } finally {
      release();
      maybeRecycle();
    }
  };
}
