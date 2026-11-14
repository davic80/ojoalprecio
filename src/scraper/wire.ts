// How scrape results and errors travel between the scraper service (on the Pi) and the
// scheduler (on the Hetzner box). The scheduler's whole decision logic depends on the
// CLASS of the error (unavailable / captcha / wrong location / generic) and on a few
// fields, so they are serialised explicitly and rebuilt on the other side.
import {
  ProductUnavailableError,
  CaptchaDetectedError,
  WrongLocationError,
  type ScrapeResult,
} from './amazon';

export interface WireError {
  name: 'ProductUnavailableError' | 'CaptchaDetectedError' | 'WrongLocationError' | 'Error';
  message: string;
  reason?: string;
  snippet?: string;
  productName?: string;
}

export type WireResponse =
  | { ok: true; result: ScrapeResult }
  | { ok: false; error: WireError };

export function serializeError(e: unknown): WireError {
  if (e instanceof ProductUnavailableError) {
    return { name: 'ProductUnavailableError', message: e.message, reason: e.reason, snippet: e.snippet, productName: e.productName };
  }
  if (e instanceof CaptchaDetectedError) return { name: 'CaptchaDetectedError', message: e.message };
  if (e instanceof WrongLocationError)   return { name: 'WrongLocationError', message: e.message };
  return { name: 'Error', message: e instanceof Error ? e.message : String(e) };
}

const REASONS = new Set(['used', 'unqualified', 'gone', 'redirect']);

export function rebuildError(w: WireError): Error {
  switch (w.name) {
    case 'ProductUnavailableError':
      return new ProductUnavailableError(
        w.message,
        (w.reason && REASONS.has(w.reason) ? w.reason : undefined) as ProductUnavailableError['reason'],
        w.snippet,
        w.productName,
      );
    case 'CaptchaDetectedError': return new CaptchaDetectedError(w.message);
    case 'WrongLocationError':   return new WrongLocationError(w.message);
    default:                     return new Error(w.message);
  }
}

/** Minimal shape check so a garbled/foreign response can't be mistaken for a scrape result. */
export function isScrapeResult(x: any): x is ScrapeResult {
  return !!x && typeof x === 'object' && typeof x.asin === 'string' && typeof x.name === 'string'
    && typeof x.price === 'number' && Number.isFinite(x.price) && typeof x.url === 'string';
}
