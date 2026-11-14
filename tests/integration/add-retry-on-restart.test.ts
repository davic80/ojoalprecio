import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.MANUAL_ADD_RESTART_RETRY_MS = '10';          // do not wait 20 s in a test

const scrape = vi.fn();
vi.mock('../../src/scraper/amazon', async (orig) => {
  const actual = await orig<typeof import('../../src/scraper/amazon')>();
  return { ...actual, scrapeProduct: (...a: unknown[]) => scrape(...a) };
});

import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import productsRouter from '../../src/routes/products';

const result = (asin: string) => ({
  asin, name: 'Producto de prueba', price: 47, currency: 'EUR', imageUrl: null, extraImages: [],
  url: `https://www.amazon.es/dp/${asin}`, wasPrice: null, variants: [], parentAsin: null,
  bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null, brand: null,
});

function buildApp(userId: number) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req: Request, res: Response, next) => {
    Object.assign(req.session as any, { userId, emailVerified: true, userEmail: 'ana@test.local' });
    res.locals.siteUrl = 'https://example.test'; res.locals.gaMeasurementId = ''; res.locals.affiliateUrl = (u: string) => u;
    next();
  });
  app.use('/', productsRouter);
  return app;
}
async function add(userId: number, url: string) {
  const server = http.createServer(buildApp(userId));
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try {
    await fetch(`http://127.0.0.1:${port}/products`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }, body: new URLSearchParams({ url }).toString() });
  } finally { await new Promise(r => server.close(r)); }
}
const waitFor = async (fn: () => Promise<boolean>, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 50)); } return false; };

describe('adding a product while Chromium is restarted by the scheduler', () => {
  let uid: number;
  beforeEach(async () => {
    await resetDb(); scrape.mockReset();
    uid = (await pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ('ana@test.local','x',TRUE) RETURNING id`)).rows[0].id;
  });
  const prices = async () => (await pool.query(`SELECT COUNT(*)::int n FROM price_history`)).rows[0].n as number;

  it('retries once the browser is back and the product gets its price', async () => {
    scrape.mockRejectedValueOnce(new Error('page.evaluate: Target page, context or browser has been closed')).mockResolvedValue(result('B0F3D55D5R'));
    await add(uid, 'B0F3D55D5R');
    expect(await waitFor(async () => (await prices()) === 1)).toBe(true);
    expect(scrape).toHaveBeenCalledTimes(2);
    expect((await pool.query(`SELECT last_error FROM products WHERE asin='B0F3D55D5R'`)).rows[0].last_error).toBeNull();
  });

  it('gives up after two retries and records the error (the first-scrape loop takes over)', async () => {
    scrape.mockRejectedValue(new Error('page.evaluate: Target page, context or browser has been closed'));
    await add(uid, 'B0F3D55D5R');
    expect(await waitFor(async () => !!(await pool.query(`SELECT last_error FROM products WHERE asin='B0F3D55D5R'`)).rows[0]?.last_error)).toBe(true);
    expect(scrape).toHaveBeenCalledTimes(3);
    expect(await prices()).toBe(0);
  });

  it('does not retry when the product itself is the problem', async () => {
    scrape.mockRejectedValue(new Error('algo propio del producto'));
    await add(uid, 'B0F3D55D5R');
    expect(await waitFor(async () => !!(await pool.query(`SELECT last_error FROM products WHERE asin='B0F3D55D5R'`)).rows[0]?.last_error)).toBe(true);
    expect(scrape).toHaveBeenCalledTimes(1);
  });
});
