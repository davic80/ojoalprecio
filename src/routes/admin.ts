import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { categories, products, users } from '../db/schema';
import { eq, sql, asc, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { scrapeUrlForAsins, extractAsin, normaliseAmazonUrl } from '../scraper/amazon';

const SYSTEM_EMAIL = 'system@ojoalprecio.local';

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
  const [cats, uncatRow] = await Promise.all([
    db.execute(sql`
      SELECT c.id, c.name, c.slug,
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS "productCount"
      FROM categories c
      ORDER BY c.name ASC
    `),
    db.execute(sql`
      SELECT COUNT(*) AS count FROM products WHERE category_id IS NULL AND is_active = TRUE
    `),
  ]);

  res.render('admin-categories', {
    categories: cats.rows,
    uncategorizedCount: parseInt(String((uncatRow.rows[0] as any)?.count ?? '0'), 10),
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

// ── GET /admin/import-url ─────────────────────────────────────────────────────
router.get('/admin/import-url', requireAuth, requireAdmin, (req: Request, res: Response) => {
  res.render('admin-import', {
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── GET /admin/import-url/stream — SSE progress stream ───────────────────────
router.get('/admin/import-url/stream', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const url = String(req.query.url ?? '').trim();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  const send = (type: string, msg: string, extra: Record<string, unknown> = {}) => {
    if (closed) return;
    res.write(`data: ${JSON.stringify({ type, msg, ...extra })}\n\n`);
  };
  const done = (summary: Record<string, unknown>) => {
    if (closed) return;
    res.write(`event: done\ndata: ${JSON.stringify(summary)}\n\n`);
    res.end();
  };

  if (!url) {
    send('error', 'URL no proporcionada.');
    done({ added: 0, skipped: 0, errors: 0 });
    return;
  }

  try {
    send('info', `Cargando: ${url}`);

    const productUrls = await scrapeUrlForAsins(url);

    if (closed) return;
    send('found', `${productUrls.length} ASINs encontrados`, { count: productUrls.length });

    if (productUrls.length === 0) {
      done({ added: 0, skipped: 0, errors: 0 });
      return;
    }

    // Get system user
    const [sysUser] = await db.select({ id: users.id }).from(users).where(eq(users.email, SYSTEM_EMAIL)).limit(1);
    const systemUserId = sysUser?.id;
    if (!systemUserId) {
      send('error', 'Usuario sistema no encontrado. Ejecuta las migraciones.');
      done({ added: 0, skipped: 0, errors: 0 });
      return;
    }

    let added = 0, skipped = 0, errors = 0;

    for (const productUrl of productUrls) {
      if (closed) return;

      const asin = extractAsin(productUrl);
      if (!asin) { errors++; continue; }

      const [existing] = await db.select({ id: products.id }).from(products).where(eq(products.asin, asin)).limit(1);
      if (existing) {
        skipped++;
        send('skip', `${asin} — ya existe`);
        continue;
      }

      try {
        await db.insert(products).values({
          userId: systemUserId,
          asin,
          url: normaliseAmazonUrl(asin),
          isPublic: false,
        });
        added++;
        send('add', `${asin} — añadido`);
      } catch {
        errors++;
        send('error', `${asin} — error al insertar`);
      }
    }

    done({ added, skipped, errors });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    send('error', `Error durante el scraping: ${msg}`);
    done({ added: 0, skipped: 0, errors: 1 });
  }
});

// ── DELETE /admin/categories/:id ──────────────────────────────────────────────
router.delete('/admin/categories/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(categories).where(eq(categories.id, id));

  if (req.headers['hx-request']) return res.send('');
  res.redirect('/admin/categories');
});

export default router;
