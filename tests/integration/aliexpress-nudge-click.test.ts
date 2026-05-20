import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import aliexpressRouter from '../../src/routes/aliexpress';

/**
 * In-process express app so we can hit /ae/r/:id with real HTTP. Avoids
 * spinning up the full server (no DB pool, no scheduler, no Playwright).
 * EJS engine + views path mirror production so res.render('404') works.
 */
function buildTestApp(userId: number | null) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  // Inject a session so the click log records user_id when configured.
  app.use((req: Request, _res: Response, next) => {
    if (userId !== null) (req.session as any).userId = userId;
    next();
  });
  app.use('/', aliexpressRouter);
  return app;
}

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  return await new Promise(resolve => {
    const server = http.createServer(app).listen(0, () => {
      const port = (server.address() as { port: number }).port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise(r => server.close(() => r())),
      });
    });
  });
}

async function seedAmazonProduct(id: number, asin: string): Promise<void> {
  await pool.query(`INSERT INTO users (email, password_hash) VALUES ('owner@x.local', 'x') ON CONFLICT DO NOTHING`);
  const u = await pool.query(`SELECT id FROM users WHERE email = 'owner@x.local'`);
  await pool.query(
    `INSERT INTO products (id, created_by_user_id, asin, url) VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING`,
    [id, u.rows[0].id, asin, `https://amazon.es/dp/${asin}`],
  );
}

async function seedAEProduct(productId: string, promotionUrl: string): Promise<void> {
  await pool.query(
    `INSERT INTO aliexpress_products (product_id, title, product_url, promotion_url, sale_price)
     VALUES ($1, 'X', $2, $3, 10) ON CONFLICT DO NOTHING`,
    [productId, `https://es.aliexpress.com/item/${productId}.html`, promotionUrl],
  );
}

async function seedEquivalent(amazonId: number, aeId: string, eligible: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO amazon_ae_equivalents (amazon_product_id, ae_product_id, is_eligible, checked_at)
     VALUES ($1, $2, $3, NOW()) ON CONFLICT (amazon_product_id) DO UPDATE SET is_eligible = EXCLUDED.is_eligible`,
    [amazonId, aeId, eligible],
  );
}

describe('GET /ae/r/:amazonProductId — nudge click tracking', () => {
  beforeEach(resetDb);

  it('302s to the AE promotion_url and logs a click row', async () => {
    await seedAmazonProduct(42, 'B00AAA0001');
    await seedAEProduct('1005000000000001', 'https://s.click.aliexpress.com/e/_TARGET');
    await seedEquivalent(42, '1005000000000001', true);

    const { url, close } = await listen(buildTestApp(null));
    try {
      const res = await fetch(`${url}/ae/r/42`, { redirect: 'manual', headers: { 'User-Agent': 'TestAgent/1.0', 'Referer': 'http://example/p/B00AAA0001' } });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://s.click.aliexpress.com/e/_TARGET');
      expect(res.headers.get('cache-control')).toMatch(/no-store/);
    } finally { await close(); }

    // Click should land in the DB (fire-and-forget, give it a tick)
    await new Promise(r => setTimeout(r, 50));
    const click = await pool.query(`SELECT amazon_product_id, ae_product_id, user_id, user_agent, referer FROM ae_nudge_clicks WHERE amazon_product_id = 42`);
    expect(click.rows.length).toBe(1);
    expect(click.rows[0].ae_product_id).toBe('1005000000000001');
    expect(click.rows[0].user_id).toBeNull();
    expect(click.rows[0].user_agent).toBe('TestAgent/1.0');
    expect(click.rows[0].referer).toBe('http://example/p/B00AAA0001');
  });

  it('404s when no eligible equivalent exists', async () => {
    await seedAmazonProduct(43, 'B00AAA0002');
    // No equivalent row at all

    const { url, close } = await listen(buildTestApp(null));
    try {
      const res = await fetch(`${url}/ae/r/43`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    } finally { await close(); }

    const click = await pool.query(`SELECT COUNT(*)::int AS n FROM ae_nudge_clicks WHERE amazon_product_id = 43`);
    expect(click.rows[0].n).toBe(0);
  });

  it('404s when the equivalent exists but is_eligible = FALSE', async () => {
    await seedAmazonProduct(44, 'B00AAA0003');
    await seedAEProduct('1005000000000002', 'https://s.click.aliexpress.com/e/_X');
    await seedEquivalent(44, '1005000000000002', false);   // explicitly NOT eligible

    const { url, close } = await listen(buildTestApp(null));
    try {
      const res = await fetch(`${url}/ae/r/44`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });

  it('falls back to product_url when promotion_url is null', async () => {
    await seedAmazonProduct(45, 'B00AAA0004');
    await pool.query(
      `INSERT INTO aliexpress_products (product_id, title, product_url, promotion_url, sale_price)
       VALUES ('1005000000000003', 'X', 'https://es.aliexpress.com/item/1005000000000003.html', NULL, 10)`,
    );
    await seedEquivalent(45, '1005000000000003', true);

    const { url, close } = await listen(buildTestApp(null));
    try {
      const res = await fetch(`${url}/ae/r/45`, { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://es.aliexpress.com/item/1005000000000003.html');
    } finally { await close(); }
  });

  it('rejects non-numeric ids without hitting the DB', async () => {
    const { url, close } = await listen(buildTestApp(null));
    try {
      const res = await fetch(`${url}/ae/r/foo`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    } finally { await close(); }
  });
});
