import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import adminRouter from '../../src/routes/admin';
import publicRouter from '../../src/routes/public';

const ADMIN = 'admin@test.local';
process.env.ADMIN_EMAIL = ADMIN;

function buildApp(email: string, userId: number) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req: Request, res: Response, next) => {
    Object.assign(req.session as any, { userId, emailVerified: true, userEmail: email });
    res.locals.siteUrl = 'https://example.test'; res.locals.gaMeasurementId = ''; res.locals.affiliateUrl = (u: string) => u;
    next();
  });
  app.use('/', adminRouter);
  app.use('/', publicRouter);
  return app;
}
async function get(email: string, userId: number, p: string) {
  const server = http.createServer(buildApp(email, userId));
  await new Promise<void>(r => server.listen(0, r));
  try { const r = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}${p}`, { redirect: 'manual' }); return { status: r.status, text: await r.text() }; }
  finally { await new Promise(r => server.close(r)); }
}

describe('admin: who follows what', () => {
  let adminId: number, anaId: number, botId: number, p1: number, p2: number;
  beforeEach(async () => {
    await resetDb();
    const mkUser = async (email: string, verified = true) => (await pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ($1,'x',$2) RETURNING id`, [email, verified])).rows[0].id as number;
    adminId = await mkUser(ADMIN); anaId = await mkUser('ana@gmail.com'); botId = await mkUser('bot123@yahoo.com', false);
    const mkProd = async (asin: string, name: string, label: string | null, price: number) => {
      const id = (await pool.query(`INSERT INTO products (asin, url, name, variant_label) VALUES ($1,$2,$3,$4) RETURNING id`, [asin, `https://www.amazon.es/dp/${asin}`, name, label])).rows[0].id as number;
      await pool.query(`INSERT INTO price_history (product_id, price) VALUES ($1,$2)`, [id, price]); return id;
    };
    p1 = await mkProd('B0AAAAAAA1', 'Zapatillas Vans', 'Azul · 43 EU', 54.99);
    p2 = await mkProd('B0AAAAAAA2', 'Freidora Dreame', null, 99);
    for (const [u, p] of [[adminId, p1], [anaId, p1], [anaId, p2]]) await pool.query(`INSERT INTO user_products (user_id, product_id) VALUES ($1,$2)`, [u, p]);
    await pool.query(`INSERT INTO alerts (product_id, user_id, alert_type, threshold_price, notification_email, notification_channel, is_active, is_default) VALUES ($1,$2,'price',50,'ana@gmail.com','email',TRUE,FALSE)`, [p1, anaId]);
  });

  it('the list counts FOLLOWED products and filters by activity', async () => {
    const con = (await get(ADMIN, adminId, '/admin/users?actividad=con')).text;
    expect(con).toContain('ana@gmail.com'); expect(con).not.toContain('bot123@yahoo.com');
    const sin = (await get(ADMIN, adminId, '/admin/users?actividad=sin')).text;
    expect(sin).toContain('bot123@yahoo.com'); expect(sin).not.toContain('ana@gmail.com');
    expect((await get(ADMIN, adminId, '/admin/users')).text).toContain(`/admin/users/${anaId}`);   // each email links to its detail
  });

  it('the detail page lists what the user follows with option, price and alert', async () => {
    const r = await get(ADMIN, adminId, `/admin/users/${anaId}`);
    expect(r.status).toBe(200);
    expect(r.text).toContain('ana@gmail.com');
    expect(r.text).toContain('Zapatillas Vans'); expect(r.text).toContain('Azul · 43 EU'); expect(r.text).toContain('Freidora Dreame');
    expect(r.text).toContain('54,99 €');
    expect(r.text).toContain('baja de 50,00 €');
    expect((await get(ADMIN, adminId, `/admin/users/${botId}`)).text).toContain('No sigue ningún producto');
  });

  it('unknown users give 404 and non-admins cannot see any of it', async () => {
    expect((await get(ADMIN, adminId, '/admin/users/999999')).status).toBe(404);
    expect((await get('ana@gmail.com', anaId, `/admin/users/${anaId}`)).status).toBe(403);
    expect((await get('ana@gmail.com', anaId, '/admin/users')).status).toBe(403);
  });

  it('the product page shows to the admin who follows it (and not to anyone else)', async () => {
    const a = (await get(ADMIN, adminId, '/p/B0AAAAAAA1')).text;
    expect(a).toContain('Seguido por');
    expect(a).toContain(`/admin/users/${anaId}`);
    const u = (await get('ana@gmail.com', anaId, '/p/B0AAAAAAA1')).text;
    expect(u).not.toContain('Seguido por');
    expect(u).not.toContain('admin/users');
  });
});
