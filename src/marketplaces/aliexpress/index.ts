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
export * from './equivalents';
export * from './oauth';
export { AliExpressClient, AliExpressError, AliExpressPermissionError } from './client';

/** OAuth redirect URI — must match what's whitelisted in the AE app console. */
export function getOAuthConfig(): { appKey: string; appSecret: string; redirectUri: string } | null {
  const appKey    = process.env.ALIEXPRESS_APP_KEY;
  const appSecret = process.env.ALIEXPRESS_APP_SECRET;
  if (!appKey || !appSecret) return null;
  // SITE_URL is the public origin (e.g. https://ojoalprecio.com) — the
  // AE app console must whitelist `${SITE_URL}/admin/aliexpress/oauth/callback`
  // EXACTLY, including scheme and any trailing slash. Falls back to PUBLIC_URL
  // / the hard-coded prod origin so dev environments without env vars still work.
  const base = (process.env.SITE_URL ?? process.env.PUBLIC_URL ?? 'https://ojoalprecio.com').replace(/\/$/, '');
  return { appKey, appSecret, redirectUri: `${base}/admin/aliexpress/oauth/callback` };
}

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
