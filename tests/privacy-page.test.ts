import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import http from 'http';
import path from 'path';
import type { AddressInfo } from 'net';
import publicRouter from '../src/routes/public';

async function get(p: string, locals: Record<string, unknown> = {}) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', 'src', 'views'));
  app.use((_req, res, next) => { Object.assign(res.locals, { siteUrl: 'https://ojoalprecio.test', affiliateUrl: (u: string) => u }, locals); next(); });
  app.use('/', publicRouter);
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${p}`);
    return { status: r.status, text: await r.text() };
  } finally { await new Promise(r => server.close(r)); }
}

describe('/privacidad', () => {
  afterEach(() => { delete process.env.PRIVACY_CONTACT_EMAIL; delete process.env.LEGAL_NAME; });

  it('is public and says what is stored, who gets it and the affiliate notice', async () => {
    const r = await get('/privacidad');
    expect(r.status).toBe(200);
    for (const t of ['Política de privacidad', 'Brevo', 'Hetzner', 'Cloudflare Turnstile', 'Como afiliado de Amazon', 'Tus derechos', 'aepd.es']) expect(r.text).toContain(t);
  });

  it('says analytics is cookieless, and only when it is enabled; never mentions Google Analytics', async () => {
    const off = (await get('/privacidad', { analyticsToken: '' })).text;
    expect(off).not.toContain('Cloudflare Web Analytics');
    const on = (await get('/privacidad', { analyticsToken: 'tok123' })).text;
    expect(on).toContain('Cloudflare Web Analytics');
    expect(on).toContain('sin cookies');
    expect(on + off).not.toContain('Google Analytics');
  });

  it('the beacon is emitted only with a token, and no Google Analytics script ever is', async () => {
    const on = (await get('/privacidad', { analyticsToken: 'tok123' })).text;
    expect(on).toContain('static.cloudflareinsights.com/beacon.min.js');
    expect(on).toContain('tok123');
    expect(on).not.toContain('googletagmanager');
    expect((await get('/privacidad')).text).not.toContain('cloudflareinsights');
  });

  it('shows the contact email and legal name only when configured (nothing personal in the repo)', async () => {
    const plain = (await get('/privacidad')).text;
    expect(plain).not.toContain('mailto:');
    expect(plain).toContain('responde a cualquiera de los correos');
    process.env.PRIVACY_CONTACT_EMAIL = 'privacidad@ojoalprecio.test'; process.env.LEGAL_NAME = 'Ana Pérez';
    const full = (await get('/privacidad')).text;
    expect(full).toContain('mailto:privacidad@ojoalprecio.test');
    expect(full).toContain('Ana Pérez');
  });

  it('is linked from the footer', async () => {
    expect((await get('/privacidad')).text).toContain('href="/privacidad"');
  });
});
