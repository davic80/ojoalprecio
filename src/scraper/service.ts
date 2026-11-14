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

export interface ServiceDeps {
  token: string;
  scrape: (url: string, timeoutSeconds: number) => Promise<ScrapeResult>;
  /** Parallel scrapes allowed. */
  concurrency: number;
  /** Extra requests allowed to wait; beyond this the service answers 503 "busy". */
  maxQueue?: number;
  version?: string;
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
      return send(res, 200, { ok: true, inFlight, queued, served, failed, uptimeSec: Math.round((Date.now() - startedAt) / 1000), version: deps.version ?? 'dev' });
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
    }
  };
}
