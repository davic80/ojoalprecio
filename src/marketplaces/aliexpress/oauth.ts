import { sql } from 'drizzle-orm';
import { db } from '../../db/client';
import { signRestRequest, formatRestTimestamp } from './sign';

/**
 * AliExpress OAuth 2.0 — authorize-code flow for the Dropshipping (`ds.*`)
 * namespace. The Affiliate namespace works with just app-key + sign, but
 * any `aliexpress.ds.*` call rejects unauthenticated requests with
 * "MissingParameter: access_token".
 *
 * Flow (run once by the app owner via /admin/aliexpress/oauth/start):
 *   1. Redirect browser to AE's authorize page.
 *   2. AE redirects back to our callback with `?code=XXX&state=YYY`.
 *   3. We POST that code to /auth/token/create — signed with the same
 *      HMAC-SHA256 algo as the rest of the AE API, BUT with the path
 *      ("/auth/token/create") prepended to the signed string, AND a UTC
 *      timestamp (not Beijing). See sign.ts:signRestRequest.
 *   4. AE returns { access_token (24 h TTL), refresh_token (60 d TTL,
 *      rotates on every refresh), expires_in, … }. We persist row id=1
 *      in aliexpress_oauth_tokens (single-row table — app-level token).
 *
 * On every DS call:
 *   - Read the cached token via getCurrentAccessToken().
 *   - If access_token is within 5 minutes of expiring, refresh first.
 *   - If the refresh_token itself is expired, throw — admin needs to
 *     re-authorize.
 *
 * AE auth host: api-sg.aliexpress.com (Singapore). DS endpoints are
 * SG-region only; mixing hosts trips silent server-side rejections.
 */

const AUTH_HOST          = 'https://api-sg.aliexpress.com';
const TOKEN_CREATE_PATH  = '/auth/token/create';
const TOKEN_REFRESH_PATH = '/auth/token/refresh';
// Reauthorize when access_token has < 5 min left — avoids racing the
// refresh with an in-flight DS call landing inside its expiry window.
const REFRESH_SKEW_MS    = 5 * 60 * 1000;

export interface AliExpressOAuthConfig {
  appKey:      string;
  appSecret:   string;
  redirectUri: string;       // must match the one whitelisted in the AE app console
}

export class AliExpressOAuthError extends Error {
  code?:       string;
  raw?:        unknown;
  constructor(message: string, code?: string, raw?: unknown) {
    super(message);
    this.name = 'AliExpressOAuthError';
    this.code = code;
    this.raw  = raw;
  }
}

/** "Run admin needs to re-authorize" sentinel — refresh_token gone or rejected. */
export class AliExpressOAuthRequiredError extends AliExpressOAuthError {
  constructor(message: string, raw?: unknown) {
    super(message, 'reauth_required', raw);
    this.name = 'AliExpressOAuthRequiredError';
  }
}

/** Build the URL we redirect the admin's browser to. */
export function buildAuthorizeUrl(cfg: AliExpressOAuthConfig, state: string): string {
  const u = new URL(AUTH_HOST + '/oauth/authorize');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id',     cfg.appKey);
  u.searchParams.set('redirect_uri',  cfg.redirectUri);
  u.searchParams.set('state',         state);
  u.searchParams.set('sp',            'ae');   // identifies the platform (required)
  u.searchParams.set('view',          'web');
  return u.toString();
}

interface TokenResponseRaw {
  access_token?:        string;
  refresh_token?:       string;
  expires_in?:          number;   // seconds
  refresh_expires_in?:  number;   // seconds
  user_id?:             string;
  account?:             string;
  code?:                string;   // present on error
  message?:             string;
}

async function postRest(path: string, params: Record<string, string>, secret: string): Promise<TokenResponseRaw> {
  const withSign = { ...params, sign: signRestRequest(path, params, secret) };
  const url = AUTH_HOST + '/rest' + path;
  console.log(`[ae-oauth] POST ${url} params=${Object.keys(withSign).filter(k => k !== 'sign').join(',')}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams(withSign).toString(),
    });
  } catch (err) {
    console.error(`[ae-oauth] fetch failed for ${path}: ${(err as Error).message}`);
    throw new AliExpressOAuthError(`Network error talking to AE: ${(err as Error).message}`, 'network');
  }
  const text = await res.text();
  console.log(`[ae-oauth] ${path} → HTTP ${res.status} body=${text.slice(0, 400)}`);
  let json: TokenResponseRaw;
  try {
    json = JSON.parse(text) as TokenResponseRaw;
  } catch {
    throw new AliExpressOAuthError(`AE returned non-JSON: ${text.slice(0, 200)}`, String(res.status));
  }
  if (json.code && json.code !== '0' && json.code !== 'success') {
    throw new AliExpressOAuthError(json.message ?? 'AE OAuth error', String(json.code), json);
  }
  return json;
}

/**
 * Exchange the one-time `code` from the callback for {access,refresh}_token.
 * Persists the resulting tokens (overwriting any prior row). The code is
 * single-use and AE expires it ~60 s after issuing.
 */
export async function exchangeCodeForToken(cfg: AliExpressOAuthConfig, code: string): Promise<void> {
  const params = {
    app_key:      cfg.appKey,
    code,
    sign_method:  'sha256',
    timestamp:    formatRestTimestamp(),
  };
  const json = await postRest(TOKEN_CREATE_PATH, params, cfg.appSecret);
  if (!json.access_token || !json.refresh_token) {
    throw new AliExpressOAuthError('AE returned no tokens', 'missing_tokens', json);
  }
  await persistTokens(json);
}

/**
 * Refresh the access_token using the stored refresh_token. AE rotates the
 * refresh_token on every successful refresh, so we persist the new pair
 * atomically. If the refresh_token is rejected (60-day TTL expired, or
 * admin revoked the grant), throws AliExpressOAuthRequiredError — caller
 * should surface a "re-authorize" prompt in the admin UI.
 */
export async function refreshAccessToken(cfg: AliExpressOAuthConfig, refreshToken: string): Promise<void> {
  const params = {
    app_key:        cfg.appKey,
    refresh_token:  refreshToken,
    sign_method:    'sha256',
    timestamp:      formatRestTimestamp(),
  };
  let json: TokenResponseRaw;
  try {
    json = await postRest(TOKEN_REFRESH_PATH, params, cfg.appSecret);
  } catch (err) {
    if (err instanceof AliExpressOAuthError && /token|grant/i.test(err.message)) {
      throw new AliExpressOAuthRequiredError(`Refresh rejected — admin must reauthorize: ${err.message}`, err.raw);
    }
    throw err;
  }
  if (!json.access_token || !json.refresh_token) {
    throw new AliExpressOAuthError('AE returned no tokens on refresh', 'missing_tokens', json);
  }
  await persistTokens(json);
}

async function persistTokens(t: TokenResponseRaw): Promise<void> {
  // expires_in is seconds — convert to absolute timestamps so we can sort
  // refresh decisions by clock instead of by relative-seconds-at-fetch.
  const accessExpAt  = new Date(Date.now() + (Number(t.expires_in)         ?? 0) * 1000);
  const refreshExpAt = new Date(Date.now() + (Number(t.refresh_expires_in) ?? 0) * 1000);
  await db.execute(sql`
    INSERT INTO aliexpress_oauth_tokens (
      id, access_token, refresh_token, expires_at, refresh_expires_at,
      ae_user_id, ae_account, updated_at
    ) VALUES (
      1, ${t.access_token!}, ${t.refresh_token!}, ${accessExpAt}, ${refreshExpAt},
      ${t.user_id ?? null}, ${t.account ?? null}, NOW()
    )
    ON CONFLICT (id) DO UPDATE SET
      access_token       = EXCLUDED.access_token,
      refresh_token      = EXCLUDED.refresh_token,
      expires_at         = EXCLUDED.expires_at,
      refresh_expires_at = EXCLUDED.refresh_expires_at,
      ae_user_id         = EXCLUDED.ae_user_id,
      ae_account         = EXCLUDED.ae_account,
      updated_at         = NOW()
  `);
}

export interface OAuthStatus {
  connected:        boolean;
  account:          string | null;
  expiresAt:        Date | null;
  refreshExpiresAt: Date | null;
  /** Seconds until access_token expires; negative if already expired. */
  accessSecondsLeft:  number | null;
  refreshSecondsLeft: number | null;
}

export async function getOAuthStatus(): Promise<OAuthStatus> {
  const r = await db.execute(sql`
    SELECT access_token, refresh_token, expires_at, refresh_expires_at, ae_account
    FROM aliexpress_oauth_tokens WHERE id = 1
  `);
  const row = r.rows[0] as undefined | {
    access_token: string; refresh_token: string;
    expires_at: Date; refresh_expires_at: Date; ae_account: string | null;
  };
  if (!row) {
    return { connected: false, account: null, expiresAt: null, refreshExpiresAt: null, accessSecondsLeft: null, refreshSecondsLeft: null };
  }
  const now = Date.now();
  return {
    connected: true,
    account:   row.ae_account,
    expiresAt: row.expires_at,
    refreshExpiresAt: row.refresh_expires_at,
    accessSecondsLeft:  Math.floor((row.expires_at.getTime()         - now) / 1000),
    refreshSecondsLeft: Math.floor((row.refresh_expires_at.getTime() - now) / 1000),
  };
}

/**
 * Returns a valid access_token, refreshing first if it's within
 * REFRESH_SKEW_MS of expiring. Throws AliExpressOAuthRequiredError when
 * no token row exists OR the refresh_token itself is past its TTL.
 *
 * This is the function client code calls; it hides the refresh dance
 * from every DS call site.
 */
export async function getCurrentAccessToken(cfg: AliExpressOAuthConfig): Promise<string> {
  const r = await db.execute(sql`
    SELECT access_token, refresh_token, expires_at, refresh_expires_at
    FROM aliexpress_oauth_tokens WHERE id = 1
  `);
  const row = r.rows[0] as undefined | {
    access_token: string; refresh_token: string;
    expires_at: Date; refresh_expires_at: Date;
  };
  if (!row) throw new AliExpressOAuthRequiredError('No AE OAuth token — admin must connect');
  const now = Date.now();
  if (row.refresh_expires_at.getTime() <= now) {
    throw new AliExpressOAuthRequiredError('AE refresh_token expired — admin must reauthorize');
  }
  if (row.expires_at.getTime() - now > REFRESH_SKEW_MS) {
    return row.access_token;
  }
  // About to expire (or already) — refresh before returning.
  await refreshAccessToken(cfg, row.refresh_token);
  const after = await db.execute(sql`SELECT access_token FROM aliexpress_oauth_tokens WHERE id = 1`);
  return (after.rows[0] as { access_token: string }).access_token;
}
