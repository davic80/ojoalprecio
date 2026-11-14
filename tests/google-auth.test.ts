import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';
import { googleConfig, pkcePair, buildAuthUrl, verifyIdToken, passwordSignupEnabled, randomToken } from '../src/lib/google-auth';

const CLIENT = 'cliente-123.apps.googleusercontent.com';
let privateKey: CryptoKey, otherKey: CryptoKey, jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
});

const sign = (claims: Record<string, unknown>, o: { key?: CryptoKey; iss?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(o.iss ?? 'https://accounts.google.com').setAudience(o.aud ?? CLIENT)
    .setIssuedAt().setExpirationTime(o.exp ?? '5m').sign(o.key ?? privateKey);
const good = { sub: '1234567890', email: 'Ana@Gmail.com', email_verified: true, name: 'Ana', nonce: 'N1' };

describe('verifyIdToken', () => {
  it('accepts a valid token and lower-cases the email', async () => {
    const id = await verifyIdToken(await sign(good), { clientId: CLIENT }, 'N1', jwks);
    expect(id).toEqual({ sub: '1234567890', email: 'ana@gmail.com', emailVerified: true, name: 'Ana' });
  });
  it('accepts the legacy issuer without scheme', async () => {
    await expect(verifyIdToken(await sign(good, { iss: 'accounts.google.com' }), { clientId: CLIENT }, 'N1', jwks)).resolves.toBeTruthy();
  });
  it('rejects a token for another application (audience)', async () => {
    await expect(verifyIdToken(await sign(good, { aud: 'otro-cliente' }), { clientId: CLIENT }, 'N1', jwks)).rejects.toThrow();
  });
  it('rejects a replayed token (nonce mismatch)', async () => {
    await expect(verifyIdToken(await sign(good), { clientId: CLIENT }, 'OTRO', jwks)).rejects.toThrow(/nonce/);
  });
  it('rejects a wrong issuer, an expired token and a token signed with another key', async () => {
    await expect(verifyIdToken(await sign(good, { iss: 'https://evil.example' }), { clientId: CLIENT }, 'N1', jwks)).rejects.toThrow();
    await expect(verifyIdToken(await sign(good, { exp: '-1m' }), { clientId: CLIENT }, 'N1', jwks)).rejects.toThrow();
    await expect(verifyIdToken(await sign(good, { key: otherKey }), { clientId: CLIENT }, 'N1', jwks)).rejects.toThrow();
  });
  it('rejects an unsigned token', async () => {
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ ...good, iss: 'https://accounts.google.com', aud: CLIENT })).toString('base64url')}.`;
    await expect(verifyIdToken(none, { clientId: CLIENT }, 'N1', jwks)).rejects.toThrow();
  });
  it('reports email_verified strictly: only true / "true" count', async () => {
    const v = async (x: unknown) => (await verifyIdToken(await sign({ ...good, email_verified: x }), { clientId: CLIENT }, 'N1', jwks)).emailVerified;
    expect(await v(true)).toBe(true);
    expect(await v('true')).toBe(true);
    expect(await v(false)).toBe(false);
    expect(await v('false')).toBe(false);
    expect(await v(undefined)).toBe(false);
  });
  it('rejects a token without email or sub', async () => {
    await expect(verifyIdToken(await sign({ sub: '1', nonce: 'N1' }), { clientId: CLIENT }, 'N1', jwks)).rejects.toThrow();
  });
});

describe('PKCE, auth URL and config', () => {
  it('challenge is the base64url SHA-256 of the verifier', () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  });
  it('tokens are random and URL safe', () => {
    const a = randomToken(), b = randomToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
  it('the auth URL carries state, nonce, PKCE and the exact redirect URI', () => {
    const cfg = googleConfig({ GOOGLE_CLIENT_ID: CLIENT, GOOGLE_CLIENT_SECRET: 's', SITE_URL: 'https://ojoalprecio.com/' } as any)!;
    const u = new URL(buildAuthUrl(cfg, { state: 'S', nonce: 'N', challenge: 'C' }));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: CLIENT, response_type: 'code', state: 'S', nonce: 'N', code_challenge: 'C', code_challenge_method: 'S256',
      redirect_uri: 'https://ojoalprecio.com/auth/google/callback', scope: 'openid email profile',
    });
  });
  it('is off unless both id and secret are set', () => {
    expect(googleConfig({} as any)).toBeNull();
    expect(googleConfig({ GOOGLE_CLIENT_ID: 'x' } as any)).toBeNull();
    expect(googleConfig({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: '  ' } as any)).toBeNull();
  });
  it('password sign-up is open by default and closes with PASSWORD_SIGNUP=off', () => {
    expect(passwordSignupEnabled({} as any)).toBe(true);
    expect(passwordSignupEnabled({ PASSWORD_SIGNUP: 'on' } as any)).toBe(true);
    expect(passwordSignupEnabled({ PASSWORD_SIGNUP: ' OFF ' } as any)).toBe(false);
  });
});
