import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { categories, products, users, recommendationLists, recommendationItems } from '../db/schema';
import { eq, sql, asc, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { scrapeUrlForAsins, extractAsin, normaliseAmazonUrl } from '../scraper/amazon';
import { getScraperStatus } from '../scheduler';
import { getBestUnpostedDeal, postDailyDeal, POST_HOURS } from '../scheduler/social';

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
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS "productCount",
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_on_sale = TRUE) AS "saleCount",
        (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.is_public = TRUE) AS "publicCount"
      FROM categories c
      ORDER BY c.name ASC
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE category_id IS NULL AND is_active = TRUE) AS count,
        COUNT(*) FILTER (WHERE category_id IS NULL AND is_active = TRUE AND is_on_sale = TRUE) AS sale_count,
        COUNT(*) FILTER (WHERE category_id IS NULL AND is_active = TRUE AND is_public = TRUE) AS public_count
      FROM products
    `),
  ]);

  const uncatData = uncatRow.rows[0] as any;
  res.render('admin-categories', {
    categories: cats.rows,
    uncategorizedCount: parseInt(String(uncatData?.count ?? '0'), 10),
    uncategorizedSaleCount: parseInt(String(uncatData?.sale_count ?? '0'), 10),
    uncategorizedPublicCount: parseInt(String(uncatData?.public_count ?? '0'), 10),
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

// ── GET /admin/social ─────────────────────────────────────────────────────────
router.get('/admin/social', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [nextDeal, logRows] = await Promise.all([
    getBestUnpostedDeal(),
    db.execute(sql`
      SELECT sl.id, sl.platform, sl.post_id, sl.posted_at, sl.content,
             p.name, p.asin, p.id AS product_id
      FROM social_post_log sl
      LEFT JOIN products p ON p.id = sl.product_id
      ORDER BY sl.posted_at DESC LIMIT 30
    `),
  ]);

  res.render('admin-social', {
    nextDeal,
    log: logRows.rows,
    postHours: POST_HOURS,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── POST /admin/social/post-now ───────────────────────────────────────────────
router.post('/admin/social/post-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    await postDailyDeal();
  } catch (err) {
    console.error('[admin] Error posting deal:', err);
  }
  res.redirect('/admin/social');
});

// ── GET /admin/scrape-status ──────────────────────────────────────────────────
router.get('/admin/scrape-status', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  res.json(getScraperStatus());
});

// ── GET /admin/deals ──────────────────────────────────────────────────────────
router.get('/admin/deals', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const filterCat    = req.query.category ? Number(req.query.category) : null;
  const filterPublic = req.query.pub === '1' ? true : req.query.pub === '0' ? false : null;
  const filterAtMin  = req.query.atmin === '1';

  const [rows, catsRows] = await Promise.all([
    db.execute(sql`
      SELECT
        p.id,
        p.asin,
        p.name,
        p.image_url        AS "imageUrl",
        p.url,
        p.is_public        AS "isPublic",
        p.is_on_sale       AS "isOnSale",
        p.category_id      AS "categoryId",
        c.name             AS "categoryName",
        ph_last.price      AS "currentPrice",
        ph_min.min_price   AS "minPrice",
        ph_med.median_price AS "medianPrice",
        ph_count.cnt       AS "recordCount",
        ROUND(((1 - ph_last.price / NULLIF(ph_med.median_price, 0)) * 100)::numeric, 1) AS "pctOffMedian",
        ROUND(((1 - ph_last.price / NULLIF(ph_min.min_price, 0)) * 100)::numeric, 1)   AS "pctOffMin"
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      JOIN LATERAL (
        SELECT price::numeric FROM price_history WHERE product_id = p.id ORDER BY scraped_at DESC LIMIT 1
      ) ph_last ON true
      JOIN LATERAL (
        SELECT MIN(price::numeric) AS min_price FROM price_history WHERE product_id = p.id
      ) ph_min ON true
      JOIN LATERAL (
        SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price::numeric) AS median_price
        FROM price_history WHERE product_id = p.id AND scraped_at >= NOW() - INTERVAL '30 days'
      ) ph_med ON true
      JOIN LATERAL (
        SELECT COUNT(*) AS cnt FROM price_history WHERE product_id = p.id
      ) ph_count ON true
      WHERE p.is_available = TRUE
        AND ph_count.cnt >= 10
        AND ph_med.median_price IS NOT NULL
        AND ROUND(((1 - ph_last.price / NULLIF(ph_med.median_price, 0)) * 100)::numeric, 1) >= 5
        ${filterCat !== null ? sql`AND p.category_id = ${filterCat}` : sql``}
        ${filterPublic !== null ? sql`AND p.is_public = ${filterPublic}` : sql``}
        ${filterAtMin ? sql`AND ph_last.price <= ph_min.min_price * 1.005` : sql``}
      ORDER BY "pctOffMedian" DESC
      LIMIT 100
    `),
    db.execute(sql`SELECT id, name FROM categories ORDER BY name ASC`),
  ]);

  res.render('admin-deals', {
    deals: rows.rows,
    categories: catsRows.rows,
    filters: { category: filterCat, pub: req.query.pub ?? null, atmin: filterAtMin },
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── GET /admin/stats ──────────────────────────────────────────────────────────
router.get('/admin/stats', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [totalRow, dailyRows, topProductRows, topPathRows,
         alertTotalsRow, alertByProductRows, alertByUserRows, alertDailyRows] = await Promise.all([
    db.execute(sql`SELECT COALESCE(SUM(count), 0) AS total FROM page_views`),
    db.execute(sql`
      SELECT day, SUM(count) AS views
      FROM page_views
      WHERE day >= TO_CHAR(NOW() - INTERVAL '29 days', 'YYYY-MM-DD')
      GROUP BY day ORDER BY day ASC
    `),
    db.execute(sql`
      SELECT p.asin, p.name, COALESCE(SUM(pv.count), 0) AS views
      FROM products p
      LEFT JOIN page_views pv ON pv.path = '/p/' || p.asin
      GROUP BY p.asin, p.name
      HAVING COALESCE(SUM(pv.count), 0) > 0
      ORDER BY views DESC LIMIT 20
    `),
    db.execute(sql`
      SELECT path, SUM(count) AS views
      FROM page_views
      WHERE path NOT LIKE '/p/%'
      GROUP BY path ORDER BY views DESC LIMIT 10
    `),
    db.execute(sql`
      SELECT
        COUNT(*)                                                            AS total,
        COUNT(*) FILTER (WHERE COALESCE(a.notification_channel,'email') = 'email')    AS by_email,
        COUNT(*) FILTER (WHERE a.notification_channel = 'telegram')        AS by_telegram,
        COUNT(*) FILTER (WHERE a.notification_channel = 'both')            AS by_both
      FROM alert_events ae
      LEFT JOIN alerts a ON a.id = ae.alert_id
    `),
    db.execute(sql`
      SELECT p.id AS product_id, p.asin, p.name, COUNT(*) AS alert_count
      FROM alert_events ae
      JOIN products p ON p.id = ae.product_id
      GROUP BY p.id, p.asin, p.name
      ORDER BY alert_count DESC LIMIT 10
    `),
    db.execute(sql`
      SELECT u.email, COUNT(*) AS alert_count
      FROM alert_events ae
      JOIN users u ON u.id = ae.user_id
      GROUP BY u.id, u.email
      ORDER BY alert_count DESC LIMIT 10
    `),
    db.execute(sql`
      SELECT TO_CHAR(triggered_at, 'YYYY-MM-DD') AS day, COUNT(*) AS count
      FROM alert_events
      WHERE triggered_at >= NOW() - INTERVAL '29 days'
      GROUP BY day ORDER BY day ASC
    `),
  ]);

  res.render('admin-stats', {
    total: parseInt(String((totalRow.rows[0] as any)?.total ?? '0'), 10),
    daily: dailyRows.rows,
    topProducts: topProductRows.rows,
    topPaths: topPathRows.rows,
    alertTotals: alertTotalsRow.rows[0] as any,
    alertByProduct: alertByProductRows.rows,
    alertByUser: alertByUserRows.rows,
    alertDaily: alertDailyRows.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── GET /admin/users ──────────────────────────────────────────────────────────
router.get('/admin/users', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const [usersRows, totalsRow] = await Promise.all([
    db.execute(sql`
      SELECT
        u.id,
        u.email,
        u.email_verified      AS "emailVerified",
        u.telegram_chat_id    AS "telegramChatId",
        u.created_at          AS "createdAt",
        (SELECT COUNT(*) FROM products p WHERE p.user_id = u.id AND p.is_active = TRUE)  AS "productCount",
        (SELECT COUNT(*) FROM alerts   a WHERE a.user_id = u.id AND a.is_active = TRUE)  AS "activeAlertCount",
        (SELECT COUNT(*) FROM alerts   a WHERE a.user_id = u.id)                          AS "totalAlertCount",
        (SELECT COUNT(*) FROM alert_events ae WHERE ae.user_id = u.id)                   AS "alertEventCount"
      FROM users u
      WHERE u.email != ${SYSTEM_EMAIL}
      ORDER BY u.created_at DESC
    `),
    db.execute(sql`
      SELECT
        COUNT(*)                                                 AS total,
        COUNT(*) FILTER (WHERE email_verified = TRUE)           AS verified,
        COUNT(*) FILTER (WHERE telegram_chat_id IS NOT NULL)    AS with_telegram
      FROM users
      WHERE email != ${SYSTEM_EMAIL}
    `),
  ]);

  const totals = totalsRow.rows[0] as any;
  res.render('admin-users', {
    users: usersRows.rows,
    totals: {
      total:        parseInt(String(totals?.total ?? '0'), 10),
      verified:     parseInt(String(totals?.verified ?? '0'), 10),
      withTelegram: parseInt(String(totals?.with_telegram ?? '0'), 10),
    },
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── GET /admin/lists ──────────────────────────────────────────────────────────
router.get('/admin/lists', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const lists = await db.execute(sql`
    SELECT rl.id, rl.slug, rl.name, rl.description,
      (SELECT COUNT(*) FROM recommendation_items ri WHERE ri.list_id = rl.id) AS "itemCount"
    FROM recommendation_lists rl
    ORDER BY rl.name ASC
  `);

  res.render('admin-lists', {
    lists: lists.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── POST /admin/lists ─────────────────────────────────────────────────────────
router.post('/admin/lists', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const name = String(req.body.name ?? '').trim();
  const description = String(req.body.description ?? '').trim() || null;
  if (!name) return res.redirect('/admin/lists');

  const slug = toSlug(name);
  if (!slug) return res.redirect('/admin/lists');

  await db.insert(recommendationLists).values({ name, slug, description } as any).onConflictDoNothing();
  res.redirect('/admin/lists');
});

// ── GET /admin/lists/:id ──────────────────────────────────────────────────────
router.get('/admin/lists/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);

  const [listRow, itemRows, allProducts] = await Promise.all([
    db.execute(sql`SELECT id, slug, name, description FROM recommendation_lists WHERE id = ${id} LIMIT 1`),
    db.execute(sql`
      SELECT ri.id AS "itemId", ri.note, ri.position, p.id, p.asin, p.name,
        (SELECT ph.price FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice"
      FROM recommendation_items ri
      JOIN products p ON p.id = ri.product_id
      WHERE ri.list_id = ${id}
      ORDER BY ri.position ASC, ri.created_at ASC
    `),
    db.execute(sql`
      SELECT p.id, p.asin, p.name,
        (SELECT ph.price FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice"
      FROM products p
      WHERE p.is_active = TRUE
        AND p.id NOT IN (SELECT product_id FROM recommendation_items WHERE list_id = ${id})
      ORDER BY p.name ASC NULLS LAST
      LIMIT 200
    `),
  ]);

  const list = (listRow.rows as any[])[0];
  if (!list) return res.status(404).render('404', { user: { email: req.session.userEmail } });

  res.render('admin-list-edit', {
    list,
    items: itemRows.rows,
    allProducts: allProducts.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── POST /admin/lists/:id/items ───────────────────────────────────────────────
router.post('/admin/lists/:id/items', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const listId = parseInt(String(req.params.id), 10);
  const productId = parseInt(String(req.body.productId ?? ''), 10);
  const note = String(req.body.note ?? '').trim() || null;

  if (productId) {
    const maxPos = await db.execute(sql`
      SELECT COALESCE(MAX(position), -1) AS pos FROM recommendation_items WHERE list_id = ${listId}
    `);
    const nextPos = parseInt(String((maxPos.rows[0] as any)?.pos ?? '-1'), 10) + 1;
    await db.execute(sql`
      INSERT INTO recommendation_items (list_id, product_id, note, position)
      VALUES (${listId}, ${productId}, ${note}, ${nextPos})
      ON CONFLICT (list_id, product_id) DO NOTHING
    `);
  }
  res.redirect(`/admin/lists/${listId}`);
});

// ── DELETE /admin/lists/:id/items/:productId ──────────────────────────────────
router.delete('/admin/lists/:id/items/:productId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const listId = parseInt(String(req.params.id), 10);
  const productId = parseInt(String(req.params.productId), 10);

  await db.execute(sql`
    DELETE FROM recommendation_items WHERE list_id = ${listId} AND product_id = ${productId}
  `);

  if (req.headers['hx-request']) return res.send('');
  res.redirect(`/admin/lists/${listId}`);
});

// ── DELETE /admin/lists/:id ───────────────────────────────────────────────────
router.delete('/admin/lists/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(recommendationLists).where(eq(recommendationLists.id, id));

  if (req.headers['hx-request']) return res.send('');
  res.redirect('/admin/lists');
});

export default router;
