import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { categories, products } from '../db/schema';
import { eq, sql, asc } from 'drizzle-orm';
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
  if (!name) return res.redirect('/admin/categories');

  const slug = toSlug(name);
  if (!slug) return res.redirect('/admin/categories');

  await db.insert(categories).values({ name, slug }).onConflictDoNothing();
  res.redirect('/admin/categories');
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

// ── DELETE /admin/categories/:id ──────────────────────────────────────────────
router.delete('/admin/categories/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(categories).where(eq(categories.id, id));

  if (req.headers['hx-request']) return res.send('');
  res.redirect('/admin/categories');
});

export default router;
