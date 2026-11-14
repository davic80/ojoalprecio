import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import productsRouter from '../../src/routes/products';

function buildApp(sess: Record<string, unknown>) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req: Request, res: Response, next) => {
    Object.assign(req.session as any, sess);
    res.locals.siteUrl = 'https://example.test'; res.locals.gaMeasurementId = '';
    res.locals.affiliateUrl = (u: string) => u;
    next();
  });
  app.use('/', productsRouter);
  return app;
}
async function get(app: express.Express, p: string): Promise<string> {
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).text(); }
  finally { await new Promise(r => server.close(r)); }
}

async function user(email: string): Promise<number> {
  return (await pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ($1,'x',TRUE) RETURNING id`, [email])).rows[0].id;
}

describe('dashboard shows one card per variant group', () => {
  let groupId: number, sysId: number, uid: number;
  const ids: Record<string, number> = {};

  beforeEach(async () => {
    await resetDb();
    uid = await user('ana@test.local');
    sysId = (await pool.query(`SELECT id FROM users WHERE email='system@ojoalprecio.local'`)).rows[0]?.id
      ?? await user('system@ojoalprecio.local');
    groupId = (await pool.query(`INSERT INTO product_groups (key) VALUES ('B0PARENT01') RETURNING id`)).rows[0].id;
    const mk = async (asin: string, label: string, creator: number, price: number | null) => {
      const r = await pool.query(
        `INSERT INTO products (asin, url, name, created_by_user_id, group_id, variant_label) VALUES ($1,$2,'Zapatillas Vans',$3,$4,$5) RETURNING id`,
        [asin, `https://www.amazon.es/dp/${asin}`, creator, groupId, label]);
      ids[asin] = r.rows[0].id;
      if (price !== null) await pool.query(`INSERT INTO price_history (product_id, price) VALUES ($1,$2)`, [ids[asin], price]);
    };
    await mk('B0AAAAAAA1', '42', uid, 54.99);     // followed by Ana
    await mk('B0AAAAAAA2', '43', uid, 59.9);      // followed by Ana
    await mk('B0AAAAAAA3', '44', sysId, 61);      // discovered, nobody follows it
    await mk('B0AAAAAAA4', '45', sysId, 62);      // discovered, nobody follows it
    for (const a of ['B0AAAAAAA1', 'B0AAAAAAA2']) await pool.query(`INSERT INTO user_products (user_id, product_id) VALUES ($1,$2)`, [uid, ids[a]]);
    for (const a of ['B0AAAAAAA3', 'B0AAAAAAA4']) await pool.query(`INSERT INTO user_products (user_id, product_id) VALUES ($1,$2)`, [sysId, ids[a]]);
  });

  const cards = (html: string) => (html.match(/class="product-card"/g) ?? []).length;

  it('a regular user sees ONE card with the followed options and a count of the rest', async () => {
    const html = await get(buildApp({ userId: uid, emailVerified: true, userEmail: 'ana@test.local' }), '/');
    expect(cards(html)).toBe(1);
    expect(html).toContain('2 opciones seguidas');
    expect(html).toContain('42 · 54,99 €');
    expect(html).toContain('43 · 59,90 €');
    expect(html).toContain('y 2 más sin seguir');
  });

  it('the admin does not see system-discovered variants that nobody follows', async () => {
    const adminEmail = 'admin@test.local';
    process.env.ADMIN_EMAIL = adminEmail;
    const aid = await user(adminEmail);
    const html = await get(buildApp({ userId: aid, emailVerified: true, userEmail: adminEmail, isAdmin: true }), '/');
    expect(cards(html)).toBe(1);                       // the group, once (represented by Ana's option)
    expect(html).not.toContain('B0AAAAAAA3');
    expect(html).not.toContain('B0AAAAAAA4');
  });
});
