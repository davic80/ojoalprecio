import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import express, { type Request, type Response } from 'express';
import session from 'express-session';
import http from 'http';
import path from 'path';
import publicRouter from '../../src/routes/public';

function buildApp(userId: number) {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.resolve(__dirname, '..', '..', 'src', 'views'));
  app.use(session({ secret: 'test', resave: false, saveUninitialized: false }));
  app.use((req: Request, res: Response, next) => {
    Object.assign(req.session as any, { userId, emailVerified: true, userEmail: 'ana@test.local' });
    res.locals.siteUrl = 'https://example.test'; res.locals.gaMeasurementId = ''; res.locals.affiliateUrl = (u: string) => u;
    next();
  });
  app.use('/', publicRouter);
  return app;
}
async function get(userId: number, p: string): Promise<string> {
  const server = http.createServer(buildApp(userId));
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  try { return await (await fetch(`http://127.0.0.1:${port}${p}`)).text(); }
  finally { await new Promise(r => server.close(r)); }
}
const panel = (html: string) => (html.match(/<div id="options-panel"[\s\S]*?\n<\/div>/) ?? [''])[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

describe('options panel ("Tu aviso de precio")', () => {
  let uid: number;
  beforeEach(async () => {
    await resetDb();
    uid = (await pool.query(`INSERT INTO users (email, password_hash, email_verified) VALUES ('ana@test.local','x',TRUE) RETURNING id`)).rows[0].id;
    const g = (await pool.query(`INSERT INTO product_groups (key) VALUES ('B0PARENT01') RETURNING id`)).rows[0].id;
    const twister = [
      { asin: 'B0AAAAAAA1', label: 'Rojo', dim: 'color_name', self: true, selectable: true },
      { asin: 'B0AAAAAAA1', label: '42 EU', dim: 'size_name', self: true, selectable: true },
      { asin: 'B0AAAAAAA2', label: '43 EU', dim: 'size_name', selectable: true },      // followed already
      { asin: 'B0AAAAAAA3', label: '44 EU', dim: 'size_name', selectable: true },      // can be followed
      { asin: 'B0AAAAAAA4', label: '45 EU', dim: 'size_name', selectable: false },     // sold out
    ];
    const mk = async (asin: string, label: string, price: number | null, follow: boolean, threshold: number | null, vj?: unknown) => {
      const r = await pool.query(
        `INSERT INTO products (asin, url, name, group_id, variant_label, variants_json) VALUES ($1,$2,'Zapatillas',$3,$4,$5) RETURNING id`,
        [asin, `https://www.amazon.es/dp/${asin}`, g, label, vj ? JSON.stringify(vj) : null]);
      const id = r.rows[0].id;
      if (price !== null) await pool.query(`INSERT INTO price_history (product_id, price) VALUES ($1,$2)`, [id, price]);
      if (follow) await pool.query(`INSERT INTO user_products (user_id, product_id) VALUES ($1,$2)`, [uid, id]);
      if (threshold !== null) await pool.query(`INSERT INTO alerts (product_id, user_id, alert_type, threshold_price, notification_email, notification_channel, is_active, is_default) VALUES ($1,$2,'price',$3,'ana@test.local','email',TRUE,FALSE)`, [id, uid, threshold]);
    };
    await mk('B0AAAAAAA1', 'Rojo · 42 EU', 54.99, true, 50, twister);
    await mk('B0AAAAAAA2', 'Rojo · 43 EU', 59.9, true, 55);
    await mk('B0AAAAAAA3', 'Rojo · 44 EU', 61, false, null);
  });

  it('shows the current option, the others already followed (with their alert) and only followable options', async () => {
    const t = panel(await get(uid, '/p/B0AAAAAAA1'));
    expect(t).toContain('Tu aviso de precio');
    expect(t).toContain('Rojo · 42 EU');                       // current option, named
    expect(t).toContain('También sigues');
    expect(t).toContain('Rojo · 43 EU');                       // followed sibling listed with its own alert
    expect(t).toContain('Seguir otra opción');
    expect(t).toContain('(1 disponibles)');                    // only 44 EU is followable
    expect(t).toContain('Talla · 44 EU');
    expect(t).not.toContain('Talla · 43 EU');                  // already listed above, not repeated
    expect(t).not.toContain('45 EU');                          // sold out: not offered…
    expect(t).toContain('1 opción agotada');                   // …but counted
  });

  it('alert values are prefilled for the followed ones', async () => {
    const html = await get(uid, '/p/B0AAAAAAA1');
    expect(html).toMatch(/name="threshold"[^>]*value="50"/);   // current
    expect(html).toMatch(/name="threshold"[^>]*value="55"/);   // the followed sibling
  });
});
