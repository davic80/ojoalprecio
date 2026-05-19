/**
 * Single entry point for the AliExpress integration. Imports go through
 * this barrel so the rest of the app doesn't have to know about the
 * internal file layout.
 */
import { AliExpressClient } from './client';

export * from './types';
export * from './url';
export * from './text';
export * from './ingest';
export { AliExpressClient, AliExpressError, AliExpressPermissionError } from './client';

/**
 * Lazy singleton for the configured AliExpressClient. Reads
 * ALIEXPRESS_APP_KEY / _APP_SECRET / _TRACKING_ID from `process.env` on
 * first call. Returns null when not configured so callers can disable
 * AE features gracefully (rather than throwing on module import in
 * environments without the keys, e.g. CI).
 */
let _client: AliExpressClient | null | undefined;

export function getAliExpressClient(): AliExpressClient | null {
  if (_client !== undefined) return _client;
  const appKey     = process.env.ALIEXPRESS_APP_KEY;
  const appSecret  = process.env.ALIEXPRESS_APP_SECRET;
  const trackingId = process.env.ALIEXPRESS_TRACKING_ID;
  if (!appKey || !appSecret || !trackingId) {
    _client = null;
    return null;
  }
  _client = new AliExpressClient({ appKey, appSecret, trackingId });
  return _client;
}

/** Test helper — drop the cached client so the next getAliExpressClient() picks up new env vars. */
export function _resetAliExpressClientForTests(): void {
  _client = undefined;
}
