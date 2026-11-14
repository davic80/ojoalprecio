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
async function get(p: string): Promise<string> {
  const server = http.createServer(buildApp());
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).text(); }
  finally { await new Promise(r => server.close(r)); }
}

describe('public listings show one card per article', () => {
  beforeEach(async () => {
    await resetDb();
    const g = (await pool.query(`INSERT INTO product_groups (key) VALUES ('B0PARENT01') RETURNING id`)).rows[0].id;
    const mk = async (asin: string, name: string, price: number, score: number, group: number | null) => {
      const r = await pool.query(
        `INSERT INTO products (asin, url, name, group_id, is_public, is_on_sale, deal_score, sale_tier)
         VALUES ($1,$2,$3,$4,TRUE,TRUE,$5,'oferta') RETURNING id`,
        [asin, `https://www.amazon.es/dp/${asin}`, name, group, score]);
      await pool.query(`INSERT INTO price_history (product_id, price, scraped_at) VALUES ($1,$2, NOW() - INTERVAL '2 days'), ($1,$3, NOW())`, [r.rows[0].id, price * 1.5, price]);
    };
    await mk('B0AAAAAAA1', 'Zapatillas Vans Range', 54.99, 20, g);
    await mk('B0AAAAAAA2', 'Zapatillas Vans Range', 49.9, 35, g);   // best offer of the group
    await mk('B0AAAAAAA3', 'Zapatillas Vans Range', 59.9, 10, g);
    await mk('B0LONELY01', 'Cafetera suelta', 30, 15, null);
  });

  const cards = (html: string) => (html.match(/class="product-card"/g) ?? []).length;

  it('/ofertas collapses the three sizes into one card (the best offer) + the standalone product', async () => {
    const html = await get('/ofertas');
    expect(cards(html)).toBe(2);
    expect(html).toContain('3 opciones');
    expect(html).toContain('49,90 €');                    // "desde" the lowest price of the group
    expect(html).toContain('href="/p/B0AAAAAAA2"');       // represented by its best offer
    expect(html).not.toContain('href="/p/B0AAAAAAA1"');
  });

  it('search returns the article once', async () => {
    const html = await get('/search?q=Vans');
    expect(html).toContain('3 opciones');
    expect((html.match(/href="\/p\/B0AAAAAAA\d"/g) ?? []).length).toBe(1);
  });
});
