// Sign in with Google (OpenID Connect, authorization-code flow with PKCE).
// Pure-ish helpers: no Express, no DB. The id_token signature is verified against Google's published keys.
import crypto from 'crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface GoogleConfig { clientId: string; clientSecret: string; redirectUri: string }

/** null when Google sign-in is not configured (the buttons are hidden and the routes redirect to the login). */
export function googleConfig(env: NodeJS.ProcessEnv = process.env): GoogleConfig | null {
  const clientId = (env.GOOGLE_CLIENT_ID ?? '').trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) return null;
  const site = (env.SITE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  return { clientId, clientSecret, redirectUri: `${site}/auth/google/callback` };
}

const b64url = (b: Buffer) => b.toString('base64url');
export const randomToken = (bytes = 32): string => b64url(crypto.randomBytes(bytes));

/** PKCE (RFC 7636, S256). */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(48);
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
}

export function buildAuthUrl(cfg: GoogleConfig, p: { state: string; nonce: string; challenge: string }): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: 'code',
    scope: 'openid email profile', state: p.state, nonce: p.nonce,
    code_challenge: p.challenge, code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${q.toString()}`;
}

/** Trade the one-time code for the id_token. */
export async function exchangeCode(
  cfg: GoogleConfig, code: string, verifier: string, fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const r = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code, client_id: cfg.clientId, client_secret: cfg.clientSecret,
      redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`Google token endpoint answered ${r.status}`);
  const j = (await r.json()) as { id_token?: string };
  if (!j.id_token) throw new Error('Google did not return an id_token');
  return j.id_token;
}

export interface GoogleIdentity { sub: string; email: string; emailVerified: boolean; name: string | null }

let _remote: JWTVerifyGetKey | null = null;
const remoteJwks = (): JWTVerifyGetKey => (_remote ??= createRemoteJWKSet(new URL(GOOGLE_JWKS_URL)));

/** Verifies signature, issuer, audience, expiry and nonce; returns who Google says the person is. */
export async function verifyIdToken(
  idToken: string, cfg: Pick<GoogleConfig, 'clientId'>, nonce: string, jwks: JWTVerifyGetKey = remoteJwks(),
): Promise<GoogleIdentity> {
  const { payload } = await jwtVerify(idToken, jwks, { issuer: ISSUERS, audience: cfg.clientId, algorithms: ['RS256'] });
  if (payload.nonce !== nonce) throw new Error('nonce mismatch');
  const sub = String(payload.sub ?? '');
  const email = String(payload.email ?? '').trim().toLowerCase();
  if (!sub || !email) throw new Error('id_token without sub or email');
  // Google sends a boolean; be strict about it ("false" must not pass).
  const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
  return { sub, email, emailVerified, name: typeof payload.name === 'string' ? payload.name : null };
}

/** Open email+password sign-up. Set PASSWORD_SIGNUP=off to allow new accounts only through Google (stops sign-up bots). */
export const passwordSignupEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  (env.PASSWORD_SIGNUP ?? 'on').trim().toLowerCase() !== 'off';
