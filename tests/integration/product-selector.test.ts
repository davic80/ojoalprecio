import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import publicRouter from '../../src/routes/public';

function buildApp() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((_req: Request, res: Response, next) => {
    res.locals.siteUrl = 'https://example.test'; res.locals.gaMeasurementId = '';
    res.locals.affiliateUrl = (u: string) => u;
    next();
  });
  app.use('/', publicRouter);
  return app;
}
async function get(p: string): Promise<{ status: number; html: string }> {
  const server = http.createServer(buildApp());
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try { const r = await fetch(`http://127.0.0.1:${port}${p}`); return { status: r.status, html: await r.text() }; }
  finally { await new Promise(r => server.close(r)); }
}

describe('product page option selector', () => {
  beforeEach(resetDb);

  it('shows the Amazon-style rows with prices and links to the other options', async () => {
    const twister = [
      { asin: 'B0AAAAAAA1', label: 'Negro', selectable: true, dim: 'color_name', self: true },
      { asin: 'B0AAAAAAA1', label: '42', selectable: true, dim: 'size_name', self: true },
      { asin: 'B0AAAAAAA2', label: '43', selectable: true, dim: 'size_name' },
      { asin: 'B0AAAAAAA3', label: 'Rojo', selectable: true, dim: 'color_name' },
    ];
    const mk = async (asin: string, price: number | null, vj?: unknown) => {
      const r = await pool.query(`INSERT INTO products (asin, url, name, variants_json) VALUES ($1,$2,'Zapatillas Vans',$3) RETURNING id`,
        [asin, `https://www.amazon.es/dp/${asin}`, vj ? JSON.stringify(vj) : null]);
      if (price !== null) await pool.query(`INSERT INTO price_history (product_id, price) VALUES ($1,$2)`, [r.rows[0].id, price]);
    };
    await mk('B0AAAAAAA1', 54.99, twister); await mk('B0AAAAAAA2', 59.9); await mk('B0AAAAAAA3', 70);
    const { status, html } = await get('/p/B0AAAAAAA1');
    expect(status).toBe(200);
    expect(html).toContain('id="variant-selector"');
    expect(html).toContain('<h3>Color</h3>');
    expect(html).toContain('<h3>Talla</h3>');
    expect(html).toContain('href="/p/B0AAAAAAA2"');          // size 43 links to its own page
    expect(html).toContain('href="/p/B0AAAAAAA3"');          // colour Rojo too
    expect(html).toContain('59,90 €');
    expect(html).toContain('aria-current="true"');
  });

  it('a product without variants has no selector', async () => {
    await pool.query(`INSERT INTO products (asin, url, name) VALUES ('B0LONELY01','https://www.amazon.es/dp/B0LONELY01','Solo')`);
    const id = (await pool.query(`SELECT id FROM products WHERE asin='B0LONELY01'`)).rows[0].id;
    await pool.query(`INSERT INTO price_history (product_id, price) VALUES ($1, 10)`, [id]);
    const { status, html } = await get('/p/B0LONELY01');
    expect(status).toBe(200);
    expect(html).not.toContain('id="variant-selector"');
  });
});
