import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { categories, products } from '../db/schema';
import { eq, sql, asc, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';

const router = Router();

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── GET /admin/categories ─────────────────────────────────────────────────────
router.get('/admin/categories', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const cats = await db.execute(sql`
    SELECT c.id, c.name, c.slug,
      (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS "productCount"
    FROM categories c
    ORDER BY c.name ASC
  `);

  res.render('admin-categories', {
    categories: cats.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── POST /admin/categories ────────────────────────────────────────────────────
router.post('/admin/categories', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const name = String(req.body.name ?? '').trim();
  const redirectTo = String(req.body._redirect ?? '').trim();
  const target = redirectTo.startsWith('/') ? redirectTo : '/admin/categories';

  if (name) {
    const slug = toSlug(name);
    if (slug) await db.insert(categories).values({ name, slug }).onConflictDoNothing();
  }

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', target);
    return res.status(200).send('');
  }
  res.redirect(target);
});

// ── PATCH /admin/categories/:id ───────────────────────────────────────────────
router.post('/admin/categories/:id/rename', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const name = String(req.body.name ?? '').trim();
  if (!name) return res.redirect('/admin/categories');

  const slug = toSlug(name);
  await db.update(categories).set({ name, slug }).where(eq(categories.id, id));
  res.redirect('/admin/categories');
});

// ── GET /admin/alerts ─────────────────────────────────────────────────────────
router.get('/admin/alerts', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const events = await db.execute(sql`
    SELECT
      ae.id,
      ae.alert_type     AS "alertType",
      ae.price_at_time  AS "priceAtTime",
      ae.threshold_label AS "thresholdLabel",
      ae.triggered_at   AS "triggeredAt",
      p.id              AS "productId",
      p.name            AS "productName",
      p.asin            AS "productAsin",
      u.email           AS "userEmail"
    FROM alert_events ae
    JOIN products p ON p.id = ae.product_id
    JOIN users   u ON u.id = ae.user_id
    ORDER BY ae.triggered_at DESC
    LIMIT 200
  `);

  res.render('admin-alerts', {
    events: events.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── DELETE /admin/categories/:id ──────────────────────────────────────────────
router.delete('/admin/categories/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(categories).where(eq(categories.id, id));

  if (req.headers['hx-request']) return res.send('');
  res.redirect('/admin/categories');
});

export default router;
