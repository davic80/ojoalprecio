import { describe, it, expect, beforeEach, vi } from 'vitest';

// The add request kicks off a background scrape: replace it so no browser is launched.
vi.mock('../../src/scraper/amazon', async (orig) => {
  const actual = await orig<typeof import('../../src/scraper/amazon')>();
  return { ...actual, scrapeProduct: vi.fn().mockRejectedValue(new Error('scraper disabled in test')) };
});

import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import productsRouter from '../../src/routes/products';

function buildApp(userId: number) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req: Request, res: Response, next) => {
    Object.assign(req.session as any, { userId, emailVerified: true, userEmail: 'ana@test.local' });
    res.locals.siteUrl = 'https://example.test'; res.locals.gaMeasurementId = ''; res.locals.affiliateUrl = (u: string) => u;
    next();
  });
  app.use('/', productsRouter);
  return app;
}
async function post(userId: number, url: string): Promise<{ status: number; location: string | null; body: string }> {
  const server = http.createServer(buildApp(userId));
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/products`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
      body: new URLSearchParams({ url }).toString(),
    });
    return { status: r.status, location: r.headers.get('location'), body: await r.text() };
  } finally { await new Promise(r => server.close(r)); }
}

describe('adding a product by its bare ASIN', () => {
  let uid: number;
  beforeEach(async () => {
    await resetDb();
    uid = (await pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ('ana@test.local','x',TRUE) RETURNING id`)).rows[0].id;
  });

  it('a bare ASIN creates the product with the canonical amazon.es URL and follows it', async () => {
    const r = await post(uid, 'b0djc3wytp');
    expect(r.status).toBe(302);
    expect(r.location).toBe('/p/B0DJC3WYTP?opciones=1');
    const p = (await pool.query(`SELECT id, asin, url FROM products WHERE asin='B0DJC3WYTP'`)).rows[0];
    expect(p.url).toBe('https://www.amazon.es/dp/B0DJC3WYTP');
    expect((await pool.query(`SELECT 1 FROM user_products WHERE user_id=$1 AND product_id=$2`, [uid, p.id])).rowCount).toBe(1);
  });

  it('the same product via full URL and via ASIN is ONE product', async () => {
    await post(uid, 'https://www.amazon.es/gp/product/B0DJC3WYTP/ref=ox_sc_act_title_2?smid=A1&th=1&psc=1');
    await post(uid, 'B0DJC3WYTP');
    expect((await pool.query(`SELECT COUNT(*)::int n FROM products WHERE asin='B0DJC3WYTP'`)).rows[0].n).toBe(1);
  });

  it('something that is neither a URL nor an id is still rejected', async () => {
    const r = await post(uid, 'zapatillas');
    expect(r.status).toBe(400);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM products`)).rows[0].n).toBe(0);
  });
});
