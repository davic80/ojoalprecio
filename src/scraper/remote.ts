// Client for a remote scraper service (e.g. the Raspberry Pi over Tailscale).
import type { ScrapeResult } from './amazon';
import { rebuildError, isScrapeResult, type WireResponse } from './wire';

/** The remote executor itself failed (unreachable, 401, busy, garbled reply) — says nothing about the product. */
export class ExecutorUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorUnavailableError';
  }
}

export interface RemoteExecutorConfig {
  name: string;
  baseUrl: string;
  token: string;
}

/** Parse SCRAPER_REMOTES="pi|http://100.99.209.115:8890,other|http://host:8890". */
export function parseRemotes(spec: string | undefined, token: string | undefined): RemoteExecutorConfig[] {
  if (!spec || !token) return [];
  return spec.split(',').map(s => s.trim()).filter(Boolean).flatMap(entry => {
    const [name, url] = entry.includes('|') ? entry.split('|') : [entry.replace(/^https?:\/\//, ''), entry];
    if (!/^https?:\/\//.test(url ?? '')) return [];
    return [{ name: name.trim(), baseUrl: url.trim().replace(/\/+$/, ''), token }];
  });
}

export async function remoteScrape(
  cfg: RemoteExecutorConfig,
  url: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ScrapeResult> {
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/scrape`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
      body: JSON.stringify({ url, timeoutSeconds }),
      // scrape hard-timeout + browser start-up + queueing + network margin
      signal: AbortSignal.timeout((timeoutSeconds + 45) * 1000),
    });
  } catch (e) {
    throw new ExecutorUnavailableError(`${cfg.name}: sin conexión (${e instanceof Error ? e.message : e})`);
  }
  if (res.status === 401 || res.status === 403) throw new ExecutorUnavailableError(`${cfg.name}: token rechazado (${res.status})`);
  if (res.status === 503 || res.status === 429)  throw new ExecutorUnavailableError(`${cfg.name}: ocupado (${res.status})`);
  if (res.status >= 500)                         throw new ExecutorUnavailableError(`${cfg.name}: error del servicio (${res.status})`);

  let body: WireResponse;
  try { body = await res.json() as WireResponse; }
  catch { throw new ExecutorUnavailableError(`${cfg.name}: respuesta no válida`); }

  if (body && body.ok === true) {
    if (!isScrapeResult(body.result)) throw new ExecutorUnavailableError(`${cfg.name}: resultado mal formado`);
    return body.result;
  }
  if (body && body.ok === false && body.error) throw rebuildError(body.error);
  throw new ExecutorUnavailableError(`${cfg.name}: respuesta inesperada`);
}
