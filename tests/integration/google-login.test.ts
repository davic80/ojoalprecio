import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet, type JWTVerifyGetKey } from 'jose';

process.env.GOOGLE_CLIENT_ID = 'cliente-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'secreto';
process.env.SITE_URL = 'https://ojoalprecio.test';
delete process.env.PASSWORD_SIGNUP;

let privateKey: CryptoKey;
let jwks: JWTVerifyGetKey;
let nextIdToken = '';
// Google is simulated: the token "endpoint" returns whatever the test signed, verified against a local key set.
vi.mock('../../src/lib/google-auth', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/google-auth')>();
  return {
    ...actual,
    exchangeCode: vi.fn(async () => nextIdToken),
    verifyIdToken: (t: string, c: { clientId: string }, n: string) => actual.verifyIdToken(t, c, n, jwks),
  };
});

import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import authRouter from '../../src/routes/auth';
import accountRouter from '../../src/routes/account';
import { resolveGoogleUser, GoogleEmailNotVerified, GoogleAccountConflict } from '../../src/lib/google-user';
import { googleConfig, passwordSignupEnabled } from '../../src/lib/google-auth';

beforeAll(async () => {
  const kp = await generateKeyPair('RS256');
  privateKey = kp.privateKey as CryptoKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }] });
});

const idToken = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer('https://accounts.google.com').setAudience(process.env.GOOGLE_CLIENT_ID!).setIssuedAt().setExpirationTime('5m').sign(privateKey);

async function addUser(email: string, password: string, verified: boolean) {
  const r = await pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ($1,$2,$3) RETURNING id`, [email, await bcrypt.hash(password, 4), verified]);
  return r.rows[0].id as number;
}
const row = async (email: string) => (await pool.query(`SELECT * FROM users WHERE email=$1`, [email])).rows[0];

describe('resolveGoogleUser', () => {
  beforeEach(resetDb);
  const id = (o: Partial<{ sub: string; email: string; emailVerified: boolean }> = {}) => ({ sub: 'g-1', email: 'ana@gmail.com', emailVerified: true, name: null, ...o });

  it('creates a new, already verified account without a usable password (and sends nothing)', async () => {
    const { user, outcome } = await resolveGoogleUser(id());
    expect(outcome).toBe('created');
    const u = await row('ana@gmail.com');
    expect(u).toMatchObject({ id: user.id, email_verified: true, google_sub: 'g-1', password_set: false });
    expect((await pool.query(`SELECT COUNT(*)::int n FROM email_verifications`)).rows[0].n).toBe(0);
  });

  it('links an existing VERIFIED account by email and keeps its password', async () => {
    await addUser('ana@gmail.com', 'miclave123', true);
    const { outcome } = await resolveGoogleUser(id());
    expect(outcome).toBe('linked');
    const u = await row('ana@gmail.com');
    expect(u.google_sub).toBe('g-1');
    expect(u.password_set).toBe(true);
    expect(await bcrypt.compare('miclave123', u.password_hash)).toBe(true);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email='ana@gmail.com'`)).rows[0].n).toBe(1);   // one person, one account
  });

  it('links an UNVERIFIED account (what a sign-up bot leaves) but throws away its password and pending links', async () => {
    const uid = await addUser('ana@gmail.com', 'laClaveDelBot', false);
    await pool.query(`INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1,'t1', NOW() + interval '1 day')`, [uid]);
    await pool.query(`INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1,'t2', NOW() + interval '1 day')`, [uid]);
    const { outcome } = await resolveGoogleUser(id());
    expect(outcome).toBe('linked_reset_password');
    const u = await row('ana@gmail.com');
    expect(u).toMatchObject({ email_verified: true, google_sub: 'g-1', password_set: false });
    expect(await bcrypt.compare('laClaveDelBot', u.password_hash)).toBe(false);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM email_verifications`)).rows[0].n).toBe(0);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM password_resets`)).rows[0].n).toBe(0);
  });

  it('the same Google account keeps its user even if its email changed', async () => {
    const first = await resolveGoogleUser(id());
    const again = await resolveGoogleUser(id({ email: 'ana.nueva@gmail.com' }));
    expect(again.outcome).toBe('existing_google');
    expect(again.user.id).toBe(first.user.id);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email LIKE '%@gmail.com'`)).rows[0].n).toBe(1);   // no second account was created
  });

  it('matches the email regardless of case', async () => {
    await addUser('ana@gmail.com', 'x12345678', true);
    expect((await resolveGoogleUser(id({ email: 'ANA@Gmail.com' }))).outcome).toBe('linked');
  });

  it('refuses an email Google has not verified: nothing is created or linked', async () => {
    await expect(resolveGoogleUser(id({ emailVerified: false }))).rejects.toBeInstanceOf(GoogleEmailNotVerified);
    expect(await row('ana@gmail.com')).toBeUndefined();
    await addUser('bo@gmail.com', 'x12345678', true);
    await expect(resolveGoogleUser(id({ sub: 'g-2', email: 'bo@gmail.com', emailVerified: false }))).rejects.toBeInstanceOf(GoogleEmailNotVerified);
    expect((await row('bo@gmail.com')).google_sub).toBeNull();
  });

  it('refuses to attach a second Google account to an email already linked to another one', async () => {
    await resolveGoogleUser(id());
    await expect(resolveGoogleUser(id({ sub: 'g-OTRO' }))).rejects.toBeInstanceOf(GoogleAccountConflict);
  });
});

// ── the whole flow through the real routes ─────────────────────────────────────────
function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((_req: Request, res: Response, next) => {
    res.locals.siteUrl = 'https://ojoalprecio.test'; res.locals.gaMeasurementId = ''; res.locals.affiliateUrl = (u: string) => u;
    res.locals.googleEnabled = !!googleConfig(); res.locals.passwordSignup = passwordSignupEnabled();
    next();
  });
  app.use('/auth', authRouter);
  app.use('/', accountRouter);
  return app;
}
class Browser {
  cookie = '';
  constructor(private base: string) {}
  async req(p: string, init: RequestInit = {}) {
    const r = await fetch(this.base + p, { redirect: 'manual', ...init, headers: { ...(init.headers as any), ...(this.cookie ? { cookie: this.cookie } : {}) } });
    const set = (r.headers as any).getSetCookie?.() as string[] | undefined;
    if (set?.length) this.cookie = set.map(c => c.split(';')[0]).join('; ');
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  }
  post(p: string, data: Record<string, string>) {
    return this.req(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() });
  }
}
async function withServer<T>(fn: (b: () => Browser) => Promise<T>): Promise<T> {
  const server = http.createServer(buildApp());
  await new Promise<void>(r => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try { return await fn(() => new Browser(base)); } finally { await new Promise(r => server.close(r)); }
}
/** Starts the flow and returns what Google would send back, signed for the nonce/state this browser holds. */
async function startGoogle(b: Browser, claims: Record<string, unknown>, next?: string) {
  const r = await b.req('/auth/google' + (next ? `?next=${encodeURIComponent(next)}` : ''));
  const u = new URL(r.location!);
  nextIdToken = await idToken({ sub: 'g-1', email: 'ana@gmail.com', email_verified: true, ...claims, nonce: claims.nonce ?? u.searchParams.get('nonce') });
  return { authUrl: u, state: u.searchParams.get('state')!, status: r.status };
}

describe('Google sign-in through the routes', () => {
  beforeEach(resetDb);

  it('sends the person to Google with state, nonce and PKCE', async () => {
    await withServer(async (mk) => {
      const b = mk(); const g = await startGoogle(b, {});
      expect(g.status).toBe(302);
      expect(g.authUrl.host).toBe('accounts.google.com');
      expect(g.authUrl.searchParams.get('redirect_uri')).toBe('https://ojoalprecio.test/auth/google/callback');
      expect(g.authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    });
  });

  it('a new person ends up logged in, on a verified account, and can create a password from "Mi cuenta"', async () => {
    await withServer(async (mk) => {
      const b = mk(); const g = await startGoogle(b, {}, '/p/B0DJC3WYTP');
      const cb = await b.req(`/auth/google/callback?code=abc&state=${g.state}`);
      expect(cb.status).toBe(302);
      expect(cb.location).toBe('/p/B0DJC3WYTP');                       // back where they were going
      const acc = await b.req('/account');
      expect(acc.status).toBe(200);
      expect(acc.text).toContain('Crear una contraseña');              // no password yet
      expect(acc.text).toContain('conectada con Google');
      // creating one: Google keeps working AND the email+password login now works
      expect((await b.post('/account/set-password', { newPassword: 'unaClaveLarga1', confirmPassword: 'unaClaveLarga1' })).status).toBe(302);
      const login = mk(); const l = await login.post('/auth/login', { email: 'ana@gmail.com', password: 'unaClaveLarga1' });
      expect(l.status).toBe(302);
      expect(l.location).not.toContain('verify-pending');
      expect((await row('ana@gmail.com')).password_set).toBe(true);
    });
  });

  it('a person with a password cannot "create" another one without the current one', async () => {
    await withServer(async (mk) => {
      await addUser('ana@gmail.com', 'laDeSiempre123', true);
      const b = mk(); const g = await startGoogle(b, {});
      await b.req(`/auth/google/callback?code=abc&state=${g.state}`);
      const r = await b.post('/account/set-password', { newPassword: 'otraClaveNueva1', confirmPassword: 'otraClaveNueva1' });
      expect(r.status).toBe(400);
      expect(await bcrypt.compare('laDeSiempre123', (await row('ana@gmail.com')).password_hash)).toBe(true);
    });
  });

  it('the bot that registered someone\'s email can no longer log in once the real owner uses Google', async () => {
    await withServer(async (mk) => {
      await addUser('ana@gmail.com', 'laClaveDelBot', false);
      const bot = mk();
      const before = await bot.post('/auth/login', { email: 'ana@gmail.com', password: 'laClaveDelBot' });
      expect(before.location).toContain('verify-pending');             // the bot got in (unverified) before
      const owner = mk(); const g = await startGoogle(owner, {});
      expect((await owner.req(`/auth/google/callback?code=abc&state=${g.state}`)).location).toBe('/');
      const after = await mk().post('/auth/login', { email: 'ana@gmail.com', password: 'laClaveDelBot' });
      expect(after.status).toBe(200);                                  // login page again, with the error
      expect(after.text).toContain('incorrectos');
    });
  });

  it('rejects a callback with the wrong state, and a code that is reused', async () => {
    await withServer(async (mk) => {
      const b = mk(); const g = await startGoogle(b, {});
      const bad = await b.req('/auth/google/callback?code=abc&state=OTRO');
      expect(bad.status).toBe(200); expect(bad.text).toContain('caducado');
      expect(await row('ana@gmail.com')).toBeUndefined();
      // the flow state is single-use: a second callback with the right state after a failure also fails
      const again = await b.req(`/auth/google/callback?code=abc&state=${g.state}`);
      expect(again.text).toContain('caducado');
    });
  });

  it('rejects a token whose nonce is not the one of this browser (replay) and an unverified Google email', async () => {
    await withServer(async (mk) => {
      const b1 = mk(); const g1 = await startGoogle(b1, { nonce: 'nonce-de-otro-navegador' });
      const r1 = await b1.req(`/auth/google/callback?code=abc&state=${g1.state}`);
      expect(r1.text).toContain('No hemos podido iniciar sesión con Google');
      const b2 = mk(); const g2 = await startGoogle(b2, { email_verified: false });
      const r2 = await b2.req(`/auth/google/callback?code=abc&state=${g2.state}`);
      expect(r2.text).toContain('no tiene el email verificado');
      expect(await row('ana@gmail.com')).toBeUndefined();
    });
  });

  it('survives the person pressing "cancel" at Google', async () => {
    await withServer(async (mk) => {
      const b = mk(); await startGoogle(b, {});
      const r = await b.req('/auth/google/callback?error=access_denied');
      expect(r.status).toBe(200); expect(r.text).toContain('cancelado');
    });
  });

  it('the login and register pages show the Google button when it is configured', async () => {
    await withServer(async (mk) => {
      const l = await mk().req('/auth/login'); expect(l.text).toContain('Continuar con Google');
      const r = await mk().req('/auth/register'); expect(r.text).toContain('Continuar con Google');
      expect(r.text).toContain('action="/auth/register"');             // password sign-up still open by default
    });
  });

  it('PASSWORD_SIGNUP=off closes the password form: no page form, and POST /auth/register is refused', async () => {
    process.env.PASSWORD_SIGNUP = 'off';
    try {
      await withServer(async (mk) => {
        const r = await mk().req('/auth/register');
        expect(r.text).toContain('Continuar con Google'); expect(r.text).not.toContain('action="/auth/register"');
        const p = await mk().post('/auth/register', { email: 'bot@yahoo.com', password: 'unaClaveLarga1', passwordConfirm: 'unaClaveLarga1' });
        expect(p.status).toBe(403);
        expect(await row('bot@yahoo.com')).toBeUndefined();
        expect((await mk().req('/auth/login')).text).not.toContain('Regístrate');
      });
    } finally { delete process.env.PASSWORD_SIGNUP; }
  });
});
