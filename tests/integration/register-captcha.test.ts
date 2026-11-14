import { describe, it, expect, beforeEach, vi } from 'vitest';

const verify = vi.fn();
vi.mock('../../src/lib/turnstile', async (orig) => {
  const actual = await orig<typeof import('../../src/lib/turnstile')>();
  return { ...actual, verifyTurnstile: (...a: unknown[]) => verify(...a) };
});
vi.mock('../../src/mailer/index', () => ({ sendVerificationEmail: vi.fn(async () => {}), sendPasswordResetEmail: vi.fn(), sendWelcomeEmail: vi.fn() }));

import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import authRouter from '../../src/routes/auth';
import { turnstileConfig } from '../../src/lib/turnstile';
import { sendVerificationEmail } from '../../src/mailer/index';

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((_req: Request, res: Response, next) => {
    res.locals.siteUrl = 'https://ojoalprecio.test'; res.locals.gaMeasurementId = ''; res.locals.affiliateUrl = (u: string) => u;
    res.locals.googleEnabled = false; res.locals.passwordSignup = true; res.locals.turnstileSiteKey = turnstileConfig()?.siteKey ?? '';
    next();
  });
  app.use('/auth', authRouter);
  return app;
}
async function call(p: string, data?: Record<string, string>) {
  const server = http.createServer(buildApp());
  await new Promise<void>(r => server.listen(0, r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, data
      ? { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data).toString() }
      : { redirect: 'manual' });
    return { status: r.status, location: r.headers.get('location'), text: await r.text() };
  } finally { await new Promise(r => server.close(r)); }
}
const form = (extra: Record<string, string> = {}) => ({ email: 'ana@gmail.com', password: 'unaClaveLarga1', passwordConfirm: 'unaClaveLarga1', ...extra });
const users = async () => (await pool.query(`SELECT COUNT(*)::int n FROM users WHERE email='ana@gmail.com'`)).rows[0].n as number;

describe('sign-up form anti-bot', () => {
  beforeEach(async () => {
    await resetDb(); verify.mockReset(); vi.mocked(sendVerificationEmail).mockClear();
    delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
  });
  const enable = () => { process.env.TURNSTILE_SITE_KEY = 'site-key-1'; process.env.TURNSTILE_SECRET_KEY = 'secret-1'; };

  it('without Turnstile keys the form works as before and shows no widget', async () => {
    expect((await call('/auth/register')).text).not.toContain('cf-turnstile');
    const r = await call('/auth/register', form());
    expect(r.status).toBe(302);
    expect(await users()).toBe(1);
    expect(verify).not.toHaveBeenCalled();
  });

  it('with keys the page shows the widget with the site key, and the honeypot is always there', async () => {
    enable();
    const t = (await call('/auth/register')).text;
    expect(t).toContain('class="cf-turnstile"');
    expect(t).toContain('data-sitekey="site-key-1"');
    expect(t).toContain('challenges.cloudflare.com/turnstile');
    expect(t).not.toContain('secret-1');                              // the secret never reaches the page
    expect(t).toContain('name="website"');
  });

  it('a failed or missing captcha creates no account and sends no email', async () => {
    enable(); verify.mockResolvedValue(false);
    const r = await call('/auth/register', form());
    expect(r.status).toBe(400);
    expect(r.text).toContain('comprobar que eres una persona');
    expect(r.text).toContain('value="ana@gmail.com"');                // the email typed is kept
    expect(await users()).toBe(0);
    expect(sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('a solved captcha creates the account, and the token is what the browser sent', async () => {
    enable(); verify.mockResolvedValue(true);
    const r = await call('/auth/register', form({ 'cf-turnstile-response': 'TOKEN-OK' }));
    expect(r.status).toBe(302);
    expect(await users()).toBe(1);
    expect(verify.mock.calls[0][0]).toBe('TOKEN-OK');
    expect(verify.mock.calls[0][2]).toEqual({ siteKey: 'site-key-1', secret: 'secret-1' });
  });

  it('a filled honeypot is rejected even with a valid captcha (and even without captcha configured)', async () => {
    enable(); verify.mockResolvedValue(true);
    expect((await call('/auth/register', form({ website: 'http://spam.example' }))).status).toBe(400);
    expect(await users()).toBe(0);
    delete process.env.TURNSTILE_SITE_KEY; delete process.env.TURNSTILE_SECRET_KEY;
    expect((await call('/auth/register', form({ website: 'x' }))).status).toBe(400);
    expect(await users()).toBe(0);
  });

  it('ordinary validation still works behind the captcha', async () => {
    enable(); verify.mockResolvedValue(true);
    const r = await call('/auth/register', form({ password: 'corta', passwordConfirm: 'corta' }));
    expect(r.text).toContain('al menos 8 caracteres');
    expect(await users()).toBe(0);
  });
});
