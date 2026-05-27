import express, { Router, type Request, type Response } from 'express';
import os from 'os';
import { db } from '../db/client';
import { categories, products, users, recommendationLists, recommendationItems, scrapeAnomalies, priceHistory } from '../db/schema';
import { eq, sql, asc, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { requireAdmin } from '../middleware/admin';
import { scrapeUrlForAsins, extractAsin, normaliseAmazonUrl } from '../scraper/amazon';
import { getScraperStatus, triggerScrape } from '../scheduler';
import { getBestUnpostedDeal, postDailyDeal, POST_HOURS } from '../scheduler/social';
import { refreshAllAETracks, refreshAEEquivalents, refreshAEHotProducts } from '../scheduler/aliexpress';
import {
  getAliExpressClient,
  discoverAndPersistEquivalent,
  getOAuthConfig,
  getCurrentAccessToken,
  getOAuthStatus,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  AliExpressOAuthRequiredError,
  AliExpressOAuthError,
} from '../marketplaces/aliexpress';
import { randomBytes } from 'crypto';
import { importAmazonCsv } from '../marketplaces/amazon-affiliates/csv-import';
import { getAllSettings, setSetting, getSetting } from '../db/settings';

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

// ── GET /admin — Hub page ─────────────────────────────────────────────────────
router.get('/admin', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  // Single command-center page — every section is fetched in parallel and rendered inline.
  // Sub-pages remain accessible via "ver todo" links inside each section for full filtered views.
  const [
    statsRow,
    alertsStatsRow,
    problematicRows,
    topDealsRows,
    recentAlertsRows,
    recentEventsRows,
    recentUsersRows,
    settings,
    nextDeal,
  ] = await Promise.all([
    db.execute(sql`
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE is_on_sale = TRUE)            AS on_sale,
        COUNT(*) FILTER (WHERE is_public  = TRUE)            AS featured,
        COUNT(*) FILTER (WHERE feature_lock = 'auto' AND is_public = TRUE) AS featured_auto,
        COUNT(*) FILTER (WHERE feature_lock = 'pin')         AS featured_pin,
        COUNT(*) FILTER (WHERE feature_lock = 'mute')        AS featured_mute,
        COUNT(*) FILTER (WHERE is_failed  = TRUE)            AS failed,
        COUNT(*) FILTER (WHERE is_available = FALSE)         AS unavailable,
        COUNT(*) FILTER (
          WHERE last_error IS NOT NULL
            AND is_available = TRUE
            AND last_error NOT LIKE 'Buybox no cualificado%'
        )                                                    AS with_error,
        (SELECT COUNT(*) FROM users WHERE email != 'system@ojoalprecio.local') AS users_total,
        (SELECT COUNT(*) FROM page_views WHERE day = TO_CHAR(CURRENT_DATE, 'YYYY-MM-DD')) AS views_today
      FROM products WHERE is_active = TRUE
    `),
    db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM alerts)                                              AS total,
        (SELECT COUNT(*) FROM alerts WHERE is_active = TRUE AND notified_at IS NULL) AS armed,
        (SELECT COUNT(*) FROM alerts WHERE notified_at IS NOT NULL)                AS notified,
        (SELECT COUNT(*) FROM alert_events WHERE triggered_at >= CURRENT_DATE)     AS today,
        (SELECT COUNT(*) FROM scrape_anomalies WHERE status = 'pending')           AS anomalies_pending
    `),
    db.execute(sql`
      SELECT id, asin, name, last_error, is_failed, consecutive_failures, total_failures
      FROM products
      WHERE is_active = TRUE
        AND (
          is_failed = TRUE
          OR (
            last_error IS NOT NULL
            AND is_available = TRUE
            AND last_error NOT LIKE 'Buybox no cualificado%'
          )
        )
      ORDER BY is_failed DESC, consecutive_failures DESC
      LIMIT 8
    `),
    db.execute(sql`
      SELECT p.id, p.asin, p.name, p.image_url AS "imageUrl", p.deal_score::float AS "dealScore",
             p.sale_tier AS "saleTier", p.was_price::float AS "wasPrice", p.is_public AS "isFeatured",
             (SELECT ph.price::float FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice"
      FROM products p
      WHERE p.is_active = TRUE AND p.is_on_sale = TRUE AND p.is_available = TRUE
      ORDER BY p.deal_score DESC NULLS LAST
      LIMIT 6
    `),
    db.execute(sql`
      SELECT a.id, a.alert_type AS "alertType", a.threshold_price::float AS "thresholdPrice",
             a.percentage_drop::float AS "percentageDrop", a.is_default AS "isDefault",
             a.notification_channel AS "notificationChannel", a.created_at AS "createdAt",
             p.asin AS "productAsin", p.name AS "productName",
             u.email AS "userEmail"
      FROM alerts a
      JOIN products p ON p.id = a.product_id
      JOIN users u ON u.id = a.user_id
      WHERE a.is_default = FALSE
      ORDER BY a.created_at DESC LIMIT 5
    `),
    db.execute(sql`
      SELECT ae.id, ae.alert_type AS "alertType", ae.price_at_time::float AS "priceAtTime",
             ae.threshold_label AS "thresholdLabel", ae.triggered_at AS "triggeredAt",
             p.asin AS "productAsin", p.name AS "productName",
             u.email AS "userEmail"
      FROM alert_events ae
      JOIN products p ON p.id = ae.product_id
      JOIN users   u ON u.id = ae.user_id
      ORDER BY ae.triggered_at DESC LIMIT 5
    `),
    db.execute(sql`
      SELECT id, email, email_verified AS "emailVerified", telegram_chat_id AS "telegramChatId", created_at AS "createdAt",
             (SELECT COUNT(*) FROM alerts WHERE alerts.user_id = users.id) AS "alertCount"
      FROM users
      WHERE email != 'system@ojoalprecio.local'
      ORDER BY created_at DESC LIMIT 6
    `),
    getAllSettings(),
    getBestUnpostedDeal().catch(() => null),
  ]);

  const s  = statsRow.rows[0] as any ?? {};
  const sa = alertsStatsRow.rows[0] as any ?? {};
  const scraperStatus = getScraperStatus();

  res.render('admin-hub', {
    user: { email: req.session.userEmail },
    isAdmin: true,
    stats: {
      total:       parseInt(s.total, 10),
      onSale:      parseInt(s.on_sale, 10),
      featured:    parseInt(s.featured, 10),
      featuredAuto: parseInt(s.featured_auto, 10),
      featuredPin:  parseInt(s.featured_pin, 10),
      featuredMute: parseInt(s.featured_mute, 10),
      failed:      parseInt(s.failed, 10),
      unavailable: parseInt(s.unavailable, 10),
      withError:   parseInt(s.with_error, 10),
      users:       parseInt(s.users_total, 10),
      viewsToday:  parseInt(s.views_today, 10),
      alertsTotal:    parseInt(sa.total, 10),
      alertsArmed:    parseInt(sa.armed, 10),
      alertsNotified: parseInt(sa.notified, 10),
      eventsToday:    parseInt(sa.today, 10),
      anomaliesPending: parseInt(sa.anomalies_pending, 10),
    },
    problematic:   problematicRows.rows,
    topDeals:      topDealsRows.rows,
    recentAlerts:  recentAlertsRows.rows,
    recentEvents:  recentEventsRows.rows,
    recentUsers:   recentUsersRows.rows,
    settings,
    nextDeal,
    scraperStatus,
  });
});

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

// ── GET /admin/alerts — Configured alerts (filterable list) ───────────────────
router.get('/admin/alerts', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const q          = String(req.query.q          ?? '').trim();
  const userEmail  = String(req.query.user       ?? '').trim();
  const alertType  = String(req.query.type       ?? '').trim();
  const channel    = String(req.query.channel    ?? '').trim();
  const status     = String(req.query.status     ?? '').trim(); // active | notified | inactive | default
  const sort       = ['recent', 'oldest', 'user', 'product'].includes(String(req.query.sort ?? '')) ? String(req.query.sort) : 'recent';

  const where: any[] = [];
  if (q)         where.push(sql`(p.name ILIKE ${'%' + q + '%'} OR p.asin ILIKE ${'%' + q + '%'})`);
  if (userEmail) where.push(sql`u.email = ${userEmail}`);
  if (alertType) where.push(sql`a.alert_type = ${alertType}`);
  if (channel)   where.push(sql`a.notification_channel = ${channel}`);
  if (status === 'active')   where.push(sql`a.is_active = TRUE  AND a.notified_at IS NULL`);
  if (status === 'notified') where.push(sql`a.notified_at IS NOT NULL`);
  if (status === 'inactive') where.push(sql`a.is_active = FALSE`);
  if (status === 'default')  where.push(sql`a.is_default = TRUE`);
  if (status === 'custom')   where.push(sql`a.is_default = FALSE`);
  const whereSql = where.length ? sql.join([sql`WHERE`, sql.join(where, sql` AND `)], sql` `) : sql``;

  const orderSql =
    sort === 'oldest'  ? sql`ORDER BY a.created_at ASC` :
    sort === 'user'    ? sql`ORDER BY u.email ASC, a.created_at DESC` :
    sort === 'product' ? sql`ORDER BY p.name ASC NULLS LAST, a.created_at DESC` :
                         sql`ORDER BY a.created_at DESC`;

  const [rows, totalRow, userOptions, channelStats, typeStats] = await Promise.all([
    db.execute(sql`
      SELECT
        a.id, a.alert_type AS "alertType",
        a.threshold_price::float AS "thresholdPrice",
        a.percentage_drop::float AS "percentageDrop",
        a.reference_price::float AS "referencePrice",
        a.notification_email     AS "notificationEmail",
        a.notification_channel   AS "notificationChannel",
        a.telegram_chat_id       AS "telegramChatId",
        a.is_active              AS "isActive",
        a.is_default             AS "isDefault",
        a.notified_at            AS "notifiedAt",
        a.created_at             AS "createdAt",
        p.id    AS "productId",
        p.asin  AS "productAsin",
        p.name  AS "productName",
        u.id    AS "userId",
        u.email AS "userEmail",
        (SELECT ph.price::float FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice"
      FROM alerts a
      JOIN products p ON p.id = a.product_id
      JOIN users    u ON u.id = a.user_id
      ${whereSql}
      ${orderSql}
      LIMIT 500
    `),
    db.execute(sql`SELECT COUNT(*)::int AS n FROM alerts a JOIN products p ON p.id = a.product_id JOIN users u ON u.id = a.user_id ${whereSql}`),
    db.execute(sql`SELECT u.email FROM users u WHERE EXISTS (SELECT 1 FROM alerts a WHERE a.user_id = u.id) ORDER BY u.email`),
    db.execute(sql`SELECT notification_channel AS c, COUNT(*)::int AS n FROM alerts GROUP BY notification_channel`),
    db.execute(sql`SELECT alert_type AS t, COUNT(*)::int AS n FROM alerts GROUP BY alert_type`),
  ]);

  res.render('admin-alerts', {
    alerts: rows.rows,
    total: (totalRow.rows[0] as any)?.n ?? 0,
    filters: { q, user: userEmail, type: alertType, channel, status, sort },
    userOptions: (userOptions.rows as any[]).map(r => r.email),
    channelStats: channelStats.rows,
    typeStats: typeStats.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── GET /admin/alerts/events — Historical alert firings ───────────────────────
router.get('/admin/alerts/events', requireAuth, requireAdmin, async (req: Request, res: Response) => {
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

  res.render('admin-alert-events', {
    events: events.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── DELETE /admin/alerts/:id — Force-delete any user's alert ──────────────────
router.delete('/admin/alerts/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.execute(sql`DELETE FROM alerts WHERE id = ${id}`);
  if (req.headers['hx-request']) return res.send('');
  res.json({ success: true });
});

// ── POST /admin/alerts/:id/toggle-active — Activate / pause an alert ──────────
router.post('/admin/alerts/:id/toggle-active', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.execute(sql`UPDATE alerts SET is_active = NOT is_active WHERE id = ${id}`);
  if (req.headers['hx-request']) {
    res.setHeader('HX-Refresh', 'true');
    return res.status(200).send('');
  }
  res.json({ success: true });
});

// ── POST /admin/categories/auto-categorize-uncategorized — Backfill on demand ─
// Walks every active product with category_id IS NULL AND name IS NOT NULL,
// runs the auto-cat dictionary against the name, and assigns the matching
// category. Anything that doesn't match stays uncategorized for manual review.
router.post('/admin/categories/auto-categorize-uncategorized', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { autoCategorizeId, invalidateCategoryCache } = await import('../scraper/categorize');
  invalidateCategoryCache();
  const rows = await db.execute(sql`SELECT id, name FROM products WHERE category_id IS NULL AND is_active = TRUE AND name IS NOT NULL`);
  let assigned = 0;
  for (const row of rows.rows as any[]) {
    const cid = await autoCategorizeId(row.name as string);
    if (cid !== null) {
      await db.update(products).set({ categoryId: cid }).where(eq(products.id, row.id));
      assigned++;
    }
  }
  console.log(`[admin] auto-categorize backfill: ${assigned}/${rows.rows.length} assigned`);
  if (req.headers['hx-request']) { res.setHeader('HX-Refresh', 'true'); return res.status(200).send(''); }
  res.json({ assigned, total: rows.rows.length });
});

// ── GET /admin/anomalies — Review queue ───────────────────────────────────────
router.get('/admin/anomalies', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const status = ['pending', 'approved', 'denied', 'all'].includes(String(req.query.status ?? '')) ? String(req.query.status) : 'pending';
  const type   = ['low', 'high', 'used', 'unqualified', 'all'].includes(String(req.query.type ?? '')) ? String(req.query.type) : 'all';
  const productAsin = String(req.query.product ?? '').trim().toUpperCase();

  const where: any[] = [];
  if (status !== 'all') where.push(sql`a.status = ${status}`);
  if (type   !== 'all') where.push(sql`a.anomaly_type = ${type}`);
  if (productAsin)      where.push(sql`p.asin = ${productAsin}`);
  const whereSql = where.length ? sql.join([sql`WHERE`, sql.join(where, sql` AND `)], sql` `) : sql``;

  // Auto-prune anomalies older than 30 days that aren't pending. Cheap lazy GC.
  await db.execute(sql`DELETE FROM scrape_anomalies WHERE status != 'pending' AND detected_at < NOW() - INTERVAL '30 days'`);

  const [rows, counts] = await Promise.all([
    db.execute(sql`
      SELECT a.id, a.anomaly_type AS "anomalyType", a.detected_at AS "detectedAt",
             a.suspect_price::float AS "suspectPrice",
             a.median_price::float  AS "medianPrice",
             a.scraper_message      AS "scraperMessage",
             a.page_snippet         AS "pageSnippet",
             a.status,
             p.id    AS "productId",
             p.asin  AS "productAsin",
             p.name  AS "productName",
             p.bypass_anomaly_guard AS "productBypass",
             (SELECT ph.price::float FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice",
             (SELECT COUNT(*) FROM scrape_anomalies WHERE product_id = p.id AND status = 'approved') AS "approvedCount",
             (SELECT COUNT(*) FROM scrape_anomalies WHERE product_id = p.id AND status = 'denied')   AS "deniedCount"
      FROM scrape_anomalies a
      JOIN products p ON p.id = a.product_id
      ${whereSql}
      ORDER BY a.detected_at DESC
      LIMIT 200
    `),
    db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')  AS pending,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved,
        COUNT(*) FILTER (WHERE status = 'denied')   AS denied,
        COUNT(*) FILTER (WHERE anomaly_type = 'low'         AND status = 'pending') AS pending_low,
        COUNT(*) FILTER (WHERE anomaly_type = 'high'        AND status = 'pending') AS pending_high,
        COUNT(*) FILTER (WHERE anomaly_type = 'used'        AND status = 'pending') AS pending_used,
        COUNT(*) FILTER (WHERE anomaly_type = 'unqualified' AND status = 'pending') AS pending_unq
      FROM scrape_anomalies
    `),
  ]);

  res.render('admin-anomalies', {
    anomalies: rows.rows,
    counts: counts.rows[0] ?? {},
    filters: { status, type, product: productAsin },
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── POST /admin/anomalies/:id/approve — Accept the suspect capture ─────────────
router.post('/admin/anomalies/:id/approve', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;
  const [a] = await db.select().from(scrapeAnomalies).where(eq(scrapeAnomalies.id, id)).limit(1);
  if (!a || a.status !== 'pending') return res.status(404).json({ error: 'Anomalía no encontrada o ya revisada.' });

  // For low/high we have a suspect_price → insert it as a price record at
  // detected_at and recompute sale flags. For used/unqualified there's no
  // price; approving is just acknowledging "yes this is unavailable" — no
  // data change beyond marking the anomaly reviewed.
  if ((a.anomalyType === 'low' || a.anomalyType === 'high') && a.suspectPrice) {
    await db.insert(priceHistory).values({
      productId: a.productId,
      price:     String(a.suspectPrice),
      currency:  'EUR',
      scrapedAt: a.detectedAt,
    });
    // Re-run sale + featured re-evaluation against the new latest price by
    // updating the row's deal flags from a quick recompute. Cheap inline.
    await db.execute(sql`
      WITH stats AS (
        SELECT MAX(price)::float AS amax,
               (SELECT price::float FROM price_history WHERE product_id = ${a.productId} ORDER BY scraped_at DESC LIMIT 1) AS cur
        FROM price_history WHERE product_id = ${a.productId}
      )
      UPDATE products SET
        is_on_sale = (SELECT cur < amax * 0.93 FROM stats),
        deal_score = (SELECT ROUND(((amax - cur) / amax * 100)::numeric, 1) FROM stats WHERE amax > 0)
      WHERE id = ${a.productId}
    `);
  }
  await db.update(scrapeAnomalies)
    .set({ status: 'approved', reviewedBy: userId, reviewedAt: new Date() })
    .where(eq(scrapeAnomalies.id, id));

  if (req.headers['hx-request']) { res.setHeader('HX-Refresh', 'true'); return res.status(200).send(''); }
  res.json({ success: true });
});

// ── POST /admin/anomalies/:id/deny — Mark the anomaly as confirmed bad ────────
router.post('/admin/anomalies/:id/deny', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;
  await db.update(scrapeAnomalies)
    .set({ status: 'denied', reviewedBy: userId, reviewedAt: new Date() })
    .where(eq(scrapeAnomalies.id, id));
  if (req.headers['hx-request']) { res.setHeader('HX-Refresh', 'true'); return res.status(200).send(''); }
  res.json({ success: true });
});

// ── POST /admin/anomalies/:id/bypass-product — Always accept this product's anomalies
router.post('/admin/anomalies/:id/bypass-product', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;
  const [a] = await db.select().from(scrapeAnomalies).where(eq(scrapeAnomalies.id, id)).limit(1);
  if (!a) return res.status(404).json({ error: 'Anomalía no encontrada.' });

  await db.update(products).set({ bypassAnomalyGuard: true }).where(eq(products.id, a.productId));
  await db.update(scrapeAnomalies)
    .set({ status: 'approved', reviewedBy: userId, reviewedAt: new Date() })
    .where(eq(scrapeAnomalies.id, id));
  if (req.headers['hx-request']) { res.setHeader('HX-Refresh', 'true'); return res.status(200).send(''); }
  res.json({ success: true });
});

// ── POST /admin/anomalies/:id/mark-unavailable — Confirm product is unbuyable ─
router.post('/admin/anomalies/:id/mark-unavailable', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;
  const [a] = await db.select().from(scrapeAnomalies).where(eq(scrapeAnomalies.id, id)).limit(1);
  if (!a) return res.status(404).json({ error: 'Anomalía no encontrada.' });

  await db.execute(sql`
    UPDATE products SET
      is_available = FALSE,
      is_on_sale   = FALSE,
      sale_tier    = NULL,
      deal_score   = NULL,
      is_public    = CASE WHEN feature_lock = 'auto' THEN FALSE ELSE is_public END,
      featured_at  = CASE WHEN feature_lock = 'auto' THEN NULL  ELSE featured_at END
    WHERE id = ${a.productId}
  `);
  await db.update(scrapeAnomalies)
    .set({ status: 'denied', reviewedBy: userId, reviewedAt: new Date() })
    .where(eq(scrapeAnomalies.id, id));
  if (req.headers['hx-request']) { res.setHeader('HX-Refresh', 'true'); return res.status(200).send(''); }
  res.json({ success: true });
});

// ── DELETE /admin/anomalies/:id — Discard outright ────────────────────────────
router.delete('/admin/anomalies/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  await db.delete(scrapeAnomalies).where(eq(scrapeAnomalies.id, id));
  if (req.headers['hx-request']) return res.send('');
  res.json({ success: true });
});

// ── POST /admin/anomalies/bulk — multi-anomaly action over an id list ─────
// Body: { ids: number[], action: 'approve' | 'deny' | 'delete' }
// Loops single-row handlers so the same data-mutation logic stays in one
// place (approve inserts the suspect price, etc). Returns per-id outcomes.
router.post('/admin/anomalies/bulk', requireAuth, requireAdmin, express.json(), async (req: Request, res: Response) => {
  const body = req.body as { ids?: unknown; action?: unknown } | undefined;
  const ids = Array.isArray(body?.ids) ? body!.ids.map((v) => parseInt(String(v), 10)).filter((n) => Number.isFinite(n) && n > 0) : [];
  const action = String(body?.action ?? '');
  if (!ids.length) return res.status(400).json({ error: 'ids vacíos.' });
  if (!['approve', 'deny', 'delete'].includes(action)) return res.status(400).json({ error: 'action debe ser approve|deny|delete' });
  const userId = req.session.userId!;

  let ok = 0, skipped = 0;
  for (const id of ids) {
    try {
      if (action === 'delete') {
        const r = await db.delete(scrapeAnomalies).where(eq(scrapeAnomalies.id, id));
        ok += (r as unknown as { rowCount?: number }).rowCount ?? 1;
        continue;
      }
      const [a] = await db.select().from(scrapeAnomalies).where(eq(scrapeAnomalies.id, id)).limit(1);
      if (!a || a.status !== 'pending') { skipped++; continue; }
      if (action === 'approve' && (a.anomalyType === 'low' || a.anomalyType === 'high') && a.suspectPrice) {
        await db.insert(priceHistory).values({
          productId: a.productId,
          price:     String(a.suspectPrice),
          currency:  'EUR',
          scrapedAt: a.detectedAt,
        });
        await db.execute(sql`
          WITH stats AS (
            SELECT MAX(price)::float AS amax,
                   (SELECT price::float FROM price_history WHERE product_id = ${a.productId} ORDER BY scraped_at DESC LIMIT 1) AS cur
            FROM price_history WHERE product_id = ${a.productId}
          )
          UPDATE products SET
            is_on_sale = (SELECT cur < amax * 0.93 FROM stats),
            deal_score = (SELECT ROUND(((amax - cur) / amax * 100)::numeric, 1) FROM stats WHERE amax > 0)
          WHERE id = ${a.productId}
        `);
      }
      await db.update(scrapeAnomalies)
        .set({ status: action === 'approve' ? 'approved' : 'denied', reviewedBy: userId, reviewedAt: new Date() })
        .where(eq(scrapeAnomalies.id, id));
      ok++;
    } catch (err) {
      console.warn(`[admin-anomalies-bulk] ${action} id=${id} failed:`, (err as Error).message);
      skipped++;
    }
  }
  res.json({ ok, skipped, total: ids.length });
});

// ── POST /admin/products/bulk-pause — set is_active=FALSE on N products ───
// Alternative to outright delete: keeps history + DB row, just stops the
// scheduler from picking it up. Reversible via POST /admin/products/:id/resume
// or direct SQL toggle. Used from /admin/cleanup as a soft action.
router.post('/admin/products/bulk-pause', requireAuth, requireAdmin, express.json(), async (req: Request, res: Response) => {
  const body = req.body as { ids?: unknown } | undefined;
  const ids = Array.isArray(body?.ids) ? body!.ids.map((v) => parseInt(String(v), 10)).filter((n) => Number.isFinite(n) && n > 0) : [];
  if (!ids.length) return res.status(400).json({ error: 'ids vacíos.' });
  const r = await db.execute(sql`
    UPDATE products SET is_active = FALSE
    WHERE id IN (${sql.join(ids.map(i => sql`${i}`), sql`, `)})
  `);
  res.json({ paused: (r as unknown as { rowCount?: number }).rowCount ?? 0, total: ids.length });
});

// ── POST /admin/products/:id/resume — flip is_active back to TRUE ─────────
// Symmetric to bulk-pause for one product; writes a 'resumed' row to
// auto_cleanup_log so the pause/resume sequence stays traceable. No-op
// (404-shaped 200) when the product is already active or doesn't exist.
router.post('/admin/products/:id/resume', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'id inválido' });
  const rows = await db.execute(sql`SELECT asin, name FROM products WHERE id = ${id} LIMIT 1`);
  const row = (rows.rows as Array<{ asin: string; name: string | null }>)[0];
  if (!row) return res.status(404).json({ error: 'producto no encontrado' });
  const { autoResumeIfPaused } = await import('../scheduler/auto-cleanup');
  const resumed = await autoResumeIfPaused(id, row.asin, row.name, 'admin manual');
  res.json({ resumed, asin: row.asin });
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
          createdByUserId: systemUserId,
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

// ── GET /admin/system-stats ───────────────────────────────────────────────────
router.get('/admin/system-stats', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  const [l1, l5, l15] = os.loadavg();
  const totalMem = os.totalmem();
  const freeMem  = os.freemem();
  res.json({
    load: { l1: l1.toFixed(2), l5: l5.toFixed(2), l15: l15.toFixed(2) },
    mem:  { totalMb: Math.round(totalMem / 1024 / 1024), freeMb: Math.round(freeMem / 1024 / 1024) },
    uptime: Math.round(os.uptime()),
  });
});

// ── POST /admin/scrape/trigger — Force-start a new scrape cycle ───────────────
router.post('/admin/scrape/trigger', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  const started = triggerScrape();
  res.json({ started, message: started ? 'Ciclo iniciado.' : 'Ya hay un ciclo en marcha.' });
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
        p.sale_tier        AS "saleTier",
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
         alertTotalsRow, alertByProductRows, alertByUserRows, alertDailyRows,
         trafficSourceRows, deviceRows] = await Promise.all([
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
    db.execute(sql`
      SELECT source, SUM(count) AS views
      FROM page_views
      WHERE device_type != 'Bot'
      GROUP BY source ORDER BY views DESC
    `),
    db.execute(sql`
      SELECT device_type, SUM(count) AS views
      FROM page_views
      GROUP BY device_type ORDER BY views DESC
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
    trafficSources: trafficSourceRows.rows,
    devices: deviceRows.rows,
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
        (SELECT COUNT(*) FROM products p WHERE p.created_by_user_id = u.id AND p.is_active = TRUE)  AS "productCount",
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

  const [listRow, itemRows] = await Promise.all([
    db.execute(sql`SELECT id, slug, name, description FROM recommendation_lists WHERE id = ${id} LIMIT 1`),
    db.execute(sql`
      SELECT ri.id AS "itemId", ri.note, ri.position, p.id, p.asin, p.name,
        (SELECT ph.price FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice"
      FROM recommendation_items ri
      JOIN products p ON p.id = ri.product_id
      WHERE ri.list_id = ${id}
      ORDER BY ri.position ASC, ri.created_at ASC
    `),
  ]);

  const list = (listRow.rows as any[])[0];
  if (!list) return res.status(404).render('404', { user: { email: req.session.userEmail } });

  res.render('admin-list-edit', {
    list,
    items: itemRows.rows,
    user: { email: req.session.userEmail },
    isAdmin: true,
  });
});

// ── GET /admin/lists/:id/search-products ─────────────────────────────────────
router.get('/admin/lists/:id/search-products', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const listId = parseInt(String(req.params.id), 10);
  const q = String(req.query.q ?? '').trim();
  if (q.length < 2) return res.json([]);

  const rows = await db.execute(sql`
    SELECT p.id, p.asin, p.name,
      (SELECT ph.price FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice"
    FROM products p
    WHERE p.is_active = TRUE
      AND p.id NOT IN (SELECT product_id FROM recommendation_items WHERE list_id = ${listId})
      AND (p.name ILIKE ${'%' + q + '%'} OR p.asin ILIKE ${'%' + q + '%'} OR p.id::text = ${q})
    ORDER BY p.name ASC NULLS LAST
    LIMIT 20
  `);
  res.json(rows.rows);
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

// ── GET /admin/settings ───────────────────────────────────────────────────────
router.get('/admin/settings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const settings = await getAllSettings();
  const envDefaults: Record<string, string> = {
    category_import_enabled:        'true',
    scraper_concurrency:            '2',
    retry_failed_per_cycle:         '30',
    scraper_timeout_seconds:        '30',
    min_age_minutes:                '59',
    telegram_public_channel:        '',
    auto_cleanup_enabled:           'false',
    auto_cleanup_cap_per_hour:      '100',
    auto_cleanup_review_threshold:  '5',
    auto_cleanup_bsr_threshold:     '100000',
    auto_cleanup_grace_days:        '7',
    auto_cleanup_protected_brands:  '',
  };
  res.render('admin-settings', { user: { email: req.session.userEmail }, settings, envDefaults });
});

// ── POST /admin/settings/:key ─────────────────────────────────────────────────
const SETTINGS_WHITELIST = new Set([
  'category_import_enabled',
  'scraper_concurrency',
  'retry_failed_per_cycle',
  'scraper_timeout_seconds',
  'min_age_minutes',
  'telegram_public_channel',
  'auto_cleanup_enabled',
  'auto_cleanup_cap_per_hour',
  'auto_cleanup_review_threshold',
  'auto_cleanup_bsr_threshold',
  'auto_cleanup_grace_days',
  'auto_cleanup_protected_brands',
]);

router.post('/admin/settings/:key', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const key = String(req.params.key);
  if (!SETTINGS_WHITELIST.has(key)) return res.status(400).send('Clave no permitida');

  // Checkbox sends 'true' when checked; hidden field sends 'false' as fallback
  const raw = req.body.value;
  const value = String(Array.isArray(raw) ? raw[raw.length - 1] : (raw ?? '')).trim();
  await setSetting(key, value);

  if (req.headers['hx-request']) {
    return res.send(`<span class="setting-saved" id="saved-${key}">✓ Guardado</span>`);
  }
  res.redirect('/admin/settings');
});

// ── GET /admin/aliexpress — AliExpress integration dashboard ─────────────────
router.get('/admin/aliexpress', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const stats = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM aliexpress_products)                                    AS "totalAEProducts",
      (SELECT COUNT(*)::int FROM aliexpress_user_tracks)                                 AS "totalAETracks",
      (SELECT COUNT(DISTINCT product_id)::int FROM aliexpress_user_tracks)               AS "trackedUniqueProducts",
      (SELECT COUNT(*)::int FROM aliexpress_similars)                                    AS "totalSimilarEdges",
      (SELECT COUNT(*)::int FROM amazon_ae_equivalents)                                  AS "totalEquivalentsChecked",
      (SELECT COUNT(*)::int FROM amazon_ae_equivalents WHERE is_eligible = TRUE)         AS "totalEligibleEquivalents",
      (SELECT COUNT(*)::int FROM ae_nudge_clicks WHERE source = 'banner')                                   AS "totalNudgeClicks",
      (SELECT COUNT(*)::int FROM ae_nudge_clicks WHERE source = 'banner' AND clicked_at >= NOW() - INTERVAL '7 days')   AS "nudgeClicks7d",
      (SELECT COUNT(*)::int FROM ae_nudge_clicks WHERE source = 'banner' AND clicked_at >= NOW() - INTERVAL '1 day')    AS "nudgeClicks24h",
      (SELECT COUNT(*)::int FROM ae_nudge_clicks WHERE source = 'search')                                   AS "totalSearchClicks",
      (SELECT COUNT(*)::int FROM ae_nudge_clicks WHERE source = 'search' AND clicked_at >= NOW() - INTERVAL '7 days')   AS "searchClicks7d",
      (SELECT COUNT(*)::int FROM ae_nudge_clicks WHERE source = 'search' AND clicked_at >= NOW() - INTERVAL '1 day')    AS "searchClicks24h",
      (SELECT COALESCE(SUM(count), 0)::int FROM ae_nudge_views)                          AS "totalNudgeViews",
      (SELECT COALESCE(SUM(count), 0)::int FROM ae_nudge_views WHERE day >= TO_CHAR(NOW() - INTERVAL '7 days', 'YYYY-MM-DD'))  AS "nudgeViews7d",
      (SELECT MAX(last_fetched_at) FROM aliexpress_products)                             AS "lastAEFetch",
      (SELECT MAX(checked_at)      FROM amazon_ae_equivalents)                           AS "lastEquivalentCheck",
      (SELECT MAX(scraped_at)      FROM aliexpress_price_history)                        AS "lastPriceTick",
      (SELECT MAX(clicked_at)      FROM ae_nudge_clicks)                                 AS "lastNudgeClick"
  `);
  const row = stats.rows[0] as any;

  // Top equivalents currently surfaced as banners — sanity-check what users actually see
  const topEquivalentsRes = await db.execute(sql`
    SELECT
      e.amazon_product_id        AS "amazonId",
      p.asin                     AS "amazonAsin",
      p.name                     AS "amazonName",
      e.amazon_price_snapshot::float AS "amazonPrice",
      e.ae_product_id            AS "aeId",
      ae.title                   AS "aeTitle",
      e.ae_price_snapshot::float AS "aePrice",
      e.pct_cheaper::float       AS "pctCheaper",
      e.text_score::float        AS "textScore",
      e.checked_at               AS "checkedAt"
    FROM amazon_ae_equivalents e
    JOIN products p ON p.id = e.amazon_product_id
    LEFT JOIN aliexpress_products ae ON ae.product_id = e.ae_product_id
    WHERE e.is_eligible = TRUE
    ORDER BY e.pct_cheaper DESC NULLS LAST
    LIMIT 20
  `);

  // Most-clicked equivalents in the last 7 days. Banner-source clicks
  // only, since CTR is per-product and the search-source clicks come
  // from a surface that's shown on every product page (different
  // denominator). JOINs views aggregate to compute per-product CTR.
  const topClickedRes = await db.execute(sql`
    WITH
      clicks7d AS (
        SELECT amazon_product_id, COUNT(*)::int AS n, MAX(clicked_at) AS last_clicked
        FROM ae_nudge_clicks
        WHERE source = 'banner' AND clicked_at >= NOW() - INTERVAL '7 days'
        GROUP BY amazon_product_id
      ),
      views7d AS (
        SELECT amazon_product_id, SUM(count)::int AS n
        FROM ae_nudge_views
        WHERE day >= TO_CHAR(NOW() - INTERVAL '7 days', 'YYYY-MM-DD')
        GROUP BY amazon_product_id
      )
    SELECT
      c.amazon_product_id  AS "amazonId",
      p.asin               AS "amazonAsin",
      p.name               AS "amazonName",
      c.n                  AS "clicks",
      COALESCE(v.n, 0)     AS "views",
      CASE WHEN COALESCE(v.n, 0) > 0
           THEN ROUND((c.n::numeric / v.n) * 100, 1)::float
           ELSE NULL END   AS "ctr",
      c.last_clicked       AS "lastClickedAt",
      e.pct_cheaper::float AS "pctCheaper"
    FROM clicks7d c
    LEFT JOIN views7d v               ON v.amazon_product_id = c.amazon_product_id
    LEFT JOIN products p              ON p.id = c.amazon_product_id
    LEFT JOIN amazon_ae_equivalents e ON e.amazon_product_id = c.amazon_product_id
    ORDER BY c.n DESC
    LIMIT 10
  `);

  // Top manual-search clicks (source='search') in the last 7 days. The
  // denominator (page_views for /p/:asin) gives us the search-button CTR
  // per product, comparable to the banner CTR table above. The button
  // shows on EVERY /p/:asin page, so views = SUM(count) where path =
  // '/p/' || asin within the same 7-day window.
  const topSearchClickedRes = await db.execute(sql`
    WITH
      sclicks7d AS (
        SELECT amazon_product_id, COUNT(*)::int AS n, MAX(clicked_at) AS last_clicked
        FROM ae_nudge_clicks
        WHERE source = 'search' AND clicked_at >= NOW() - INTERVAL '7 days'
        GROUP BY amazon_product_id
      )
    SELECT
      c.amazon_product_id  AS "amazonId",
      p.asin               AS "amazonAsin",
      p.name               AS "amazonName",
      c.n                  AS "clicks",
      COALESCE(v.views, 0) AS "views",
      CASE WHEN COALESCE(v.views, 0) > 0
           THEN ROUND((c.n::numeric / v.views) * 100, 1)::float
           ELSE NULL END   AS "ctr",
      c.last_clicked       AS "lastClickedAt"
    FROM sclicks7d c
    LEFT JOIN products p ON p.id = c.amazon_product_id
    LEFT JOIN LATERAL (
      SELECT SUM(count)::int AS views FROM page_views
      WHERE path = '/p/' || p.asin
        AND day >= TO_CHAR(NOW() - INTERVAL '7 days', 'YYYY-MM-DD')
    ) v ON TRUE
    ORDER BY c.n DESC
    LIMIT 10
  `);

  // Global search CTR — sum search clicks over sum /p/:asin views in 7d.
  // Single-number sanity check that complements the per-product table.
  const globalSearchCTRRes = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM ae_nudge_clicks
        WHERE source = 'search' AND clicked_at >= NOW() - INTERVAL '7 days') AS clicks,
      (SELECT COALESCE(SUM(count), 0)::int FROM page_views
        WHERE path LIKE '/p/%' AND day >= TO_CHAR(NOW() - INTERVAL '7 days', 'YYYY-MM-DD')) AS views
  `);
  const gsc = globalSearchCTRRes.rows[0] as { clicks: number; views: number };
  const searchCTR7d = gsc.views > 0 ? Number(((gsc.clicks / gsc.views) * 100).toFixed(2)) : null;

  const aeConfigured = getAliExpressClient() !== null;

  res.render('admin-aliexpress', {
    user: { email: req.session.userEmail },
    stats: row,
    topEquivalents: topEquivalentsRes.rows,
    topClicked: topClickedRes.rows,
    topSearchClicked: topSearchClickedRes.rows,
    searchCTR7d,
    aeConfigured,
  });
});

// ── POST /admin/aliexpress/refresh-now — manual cron trigger ─────────────────
// Skips the wait for the next 8h tick. Fires-and-logs in the background so
// the request returns immediately — refresh of the full catalog can take
// minutes.
router.post('/admin/aliexpress/refresh-now', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const client = getAliExpressClient();
  if (!client) {
    return res.status(503).json({ error: 'La integración con AliExpress no está configurada.' });
  }
  // Fire-and-forget; admin can refresh the dashboard to see updated stats.
  void (async () => {
    const started = Date.now();
    console.log('[ae-admin] manual refresh triggered');
    try {
      const t = await refreshAllAETracks(client);
      const e = await refreshAEEquivalents(client);
      const h = await refreshAEHotProducts(client);
      const ms = Date.now() - started;
      console.log(
        `[ae-admin] manual refresh done in ${(ms / 1000).toFixed(1)}s — ` +
        `tracks: ${t.refreshed}/${t.totalProducts} (${t.alertsSent} alerts); ` +
        `equivalents: ${e.updated}/${e.candidates} (${e.eligible} eligible); ` +
        `hot: ${h.persisted}/${h.fetched}.`
      );
    } catch (err) {
      console.error('[ae-admin] manual refresh failed:', err);
    }
  })();

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', '/admin/aliexpress?refresh=started');
    return res.status(200).send('');
  }
  res.redirect('/admin/aliexpress?refresh=started');
});

// ── GET /admin/cleanup — candidates to delete ───────────────────────────────
// Auto-imported products that nobody is using and that the scraper has lost
// touch with. The criteria:
//   - ≥3 days old (don't judge brand-new adds that haven't had time to
//     accumulate datapoints)
//   - <3 price_history rows in the last 3 days (i.e. <1/day average —
//     scrape failing, listing dead, blacklisted, etc.)
//   - 0 user follows excluding the system user (no human cares)
//   - 0 alerts (related: nobody set one up)
//   - created_by_user_id IS NULL OR = system user (auto-imported by
//     wishlist/category/twister, not manually added by a human)
// All four gates together → safe to nuke. Capped at 500 for the UI; if
// the catalog grows past that we can paginate.
router.get('/admin/cleanup', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const rows = await db.execute(sql`
    WITH sys_user AS (
      SELECT id FROM users WHERE email = ${SYSTEM_EMAIL} LIMIT 1
    )
    SELECT
      p.id,
      p.asin,
      p.name,
      p.image_url                                    AS "imageUrl",
      p.last_error                                   AS "lastError",
      p.is_available                                 AS "isAvailable",
      p.created_at                                   AS "createdAt",
      EXTRACT(DAY FROM (NOW() - p.created_at))::int  AS "daysOld",
      (SELECT COUNT(*)::int FROM price_history ph
        WHERE ph.product_id = p.id
          AND ph.scraped_at >= NOW() - INTERVAL '3 days')   AS "datapoints3d",
      (SELECT COUNT(*)::int FROM price_history ph
        WHERE ph.product_id = p.id)                          AS "datapointsTotal",
      (SELECT MAX(ph.scraped_at) FROM price_history ph
        WHERE ph.product_id = p.id)                          AS "lastScrapeAt"
    FROM products p
    LEFT JOIN sys_user su ON TRUE
    WHERE p.is_active = TRUE
      AND p.created_at < NOW() - INTERVAL '3 days'
      AND (p.created_by_user_id IS NULL
           OR (su.id IS NOT NULL AND p.created_by_user_id = su.id))
      AND NOT EXISTS (
        SELECT 1 FROM user_products up
        WHERE up.product_id = p.id
          AND (su.id IS NULL OR up.user_id <> su.id)
      )
      AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.product_id = p.id)
      AND (SELECT COUNT(*) FROM price_history ph
            WHERE ph.product_id = p.id
              AND ph.scraped_at >= NOW() - INTERVAL '3 days') < 3
    ORDER BY "datapoints3d" ASC, p.created_at ASC
    LIMIT 500
  `);

  // Auto-cleanup status + recent activity for the UI banner.
  const autoCleanupEnabled = (await getSetting('auto_cleanup_enabled', false)) === true;
  const autoCleanupCap     = Number(await getSetting('auto_cleanup_cap_per_hour', 100));
  const recentLog = await db.execute(sql`
    SELECT id, product_id AS "productId", asin, name, action, reason, at
    FROM auto_cleanup_log
    ORDER BY at DESC
    LIMIT 50
  `);
  const lastRunSummary = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE action = 'paused')  AS "lastRunPaused",
      COUNT(*) FILTER (WHERE action = 'resumed') AS "lastRunResumed",
      MAX(at) AS "lastRunAt"
    FROM auto_cleanup_log
    WHERE at >= NOW() - INTERVAL '24 hours'
  `)).rows[0] as { lastRunPaused: string | number; lastRunResumed: string | number; lastRunAt: Date | null };

  res.render('admin-cleanup', {
    user: { email: req.session.userEmail },
    candidates: rows.rows,
    autoCleanup: {
      enabled:     autoCleanupEnabled,
      cap:         autoCleanupCap,
      pausedLast24h:  Number(lastRunSummary?.lastRunPaused  ?? 0),
      resumedLast24h: Number(lastRunSummary?.lastRunResumed ?? 0),
      lastRunAt:   lastRunSummary?.lastRunAt ?? null,
      recentLog:   recentLog.rows,
    },
  });
});

// ── POST /admin/aliexpress/equivalent/:amazonProductId/recheck ──────────────
// Force-re-run the cross-marketplace discovery for one Amazon product,
// bypassing the 24h cache. Used from the admin diagnostic block on /p/:asin
// so admin can verify that the discovery is actually working after a
// config change without waiting for the cache to expire.
router.post('/admin/aliexpress/equivalent/:amazonProductId/recheck',
  requireAuth, requireAdmin,
  async (req: Request, res: Response) => {
    const id = parseInt(String(req.params.amazonProductId), 10);
    if (!Number.isFinite(id) || id < 1) {
      return res.status(404).json({ error: 'Producto no válido.' });
    }
    const client = getAliExpressClient();
    if (!client) {
      return res.status(503).json({ error: 'AliExpress no está configurado.' });
    }

    // Drop the cache row first so discoverAndPersistEquivalent treats this
    // as a miss + re-fetches from the API.
    await db.execute(sql`DELETE FROM amazon_ae_equivalents WHERE amazon_product_id = ${id}`);

    // Fetch the product info we need for discovery
    const productRows = await db.execute(sql`
      SELECT p.asin, p.name,
        (SELECT ph.price::float FROM price_history ph
          WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS price
      FROM products p WHERE p.id = ${id}
    `);
    const p = productRows.rows[0] as { asin: string; name: string | null; price: number | null } | undefined;
    if (!p?.name || !p.price) {
      return res.status(400).json({ error: 'Producto sin nombre o sin precio actual.' });
    }

    try {
      await discoverAndPersistEquivalent(client, id, { title: p.name, price: p.price });
    } catch (err) {
      console.warn(`[admin-recheck] discovery for ${id} failed: ${(err as Error).message}`);
    }

    if (req.headers['hx-request']) {
      res.setHeader('HX-Redirect', `/p/${p.asin}`);
      return res.status(200).send('');
    }
    return res.redirect(`/p/${p.asin}`);
  },
);

// ── GET /admin/aliexpress/sku-probe/:productId — DS API permission check ────
// Calls aliexpress.ds.product.get for a known productId and dumps the variant
// breakdown as JSON. Validates both that the SKU Dimension API perm is granted
// AND that the OAuth access_token flow is wired correctly end-to-end.
router.get('/admin/aliexpress/sku-probe/:productId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const productId = String(req.params.productId || '').trim();
  if (!/^\d{10,16}$/.test(productId)) {
    return res.status(400).json({ error: 'productId must be 10-16 digits' });
  }
  const client = getAliExpressClient();
  const oauthCfg = getOAuthConfig();
  if (!client || !oauthCfg) {
    return res.status(503).json({ error: 'AliExpress not configured' });
  }
  try {
    const accessToken = await getCurrentAccessToken(oauthCfg);
    const out = await client.dsProductGet(productId, accessToken);
    if (!out) return res.status(404).json({ error: 'product not found via DS endpoint' });
    return res.json({
      productId,
      master: out.master,
      skuCount: out.skus.length,
      skus: out.skus,
    });
  } catch (err) {
    const e = err as { name?: string; message?: string; code?: string; raw?: unknown };
    const status = err instanceof AliExpressOAuthRequiredError ? 401 : 502;
    return res.status(status).json({
      error:     e.message ?? 'unknown error',
      errorName: e.name,
      errorCode: e.code,
      raw:       e.raw,
      hint:      err instanceof AliExpressOAuthRequiredError
        ? 'Visit /admin/aliexpress/oauth/start to authorize.'
        : undefined,
    });
  }
});

// ── OAuth flow for AE Dropshipping namespace ────────────────────────────────
// Single admin runs this once; resulting tokens land in aliexpress_oauth_tokens
// (single-row, id=1) and getCurrentAccessToken() handles refresh-on-read.

// In-memory `state` store. OAuth code exchange takes seconds and the admin is
// a single human — a tiny Map with TTL is fine without dragging in a session
// store. Server restart invalidates pending flows; admin retries.
const _oauthStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

router.get('/admin/aliexpress/oauth/start', requireAuth, requireAdmin, (_req: Request, res: Response) => {
  const cfg = getOAuthConfig();
  if (!cfg) return res.status(503).send('AliExpress not configured (ALIEXPRESS_APP_KEY/_APP_SECRET).');
  // Sweep expired states opportunistically.
  const now = Date.now();
  for (const [k, ts] of _oauthStates) if (now - ts > STATE_TTL_MS) _oauthStates.delete(k);
  const state = randomBytes(16).toString('hex');
  _oauthStates.set(state, now);
  return res.redirect(buildAuthorizeUrl(cfg, state));
});

router.get('/admin/aliexpress/oauth/callback', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const cfg   = getOAuthConfig();
  if (!cfg) return res.status(503).send('AliExpress not configured.');
  const code  = String(req.query.code  || '');
  const state = String(req.query.state || '');
  console.log(`[ae-oauth] callback hit: code=${code.slice(0, 12)}… state=${state.slice(0, 12)}… known-states=${_oauthStates.size}`);
  if (!code)  return res.status(400).send('Missing ?code in callback.');
  // Verify the state matches one we issued and is within TTL.
  const issued = _oauthStates.get(state);
  if (!issued || Date.now() - issued > STATE_TTL_MS) {
    console.warn(`[ae-oauth] state rejected: issued=${issued} known=${[..._oauthStates.keys()].map(k => k.slice(0,12)).join(',')}`);
    return res.status(400).send('Invalid or expired OAuth state — retry from /admin/aliexpress/oauth/start.');
  }
  _oauthStates.delete(state);
  try {
    await exchangeCodeForToken(cfg, code);
    console.log('[ae-oauth] token exchange OK, redirecting to admin');
  } catch (err) {
    const e = err as AliExpressOAuthError;
    console.error(`[ae-oauth] token exchange FAILED: code=${e.code} msg=${e.message} raw=${JSON.stringify(e.raw)}`);
    // 400 (not 502) so Cloudflare doesn't replace our body with its
    // generic "Bad Gateway" page. Our text gives the real diagnostic.
    return res.status(400).type('text/plain').send(
      `AE OAuth token exchange failed.\n\nCode: ${e.code ?? 'unknown'}\nMessage: ${e.message}\nRaw: ${JSON.stringify(e.raw)}\n\nCheck server logs ([ae-oauth] tag) for the full AE response.`,
    );
  }
  return res.redirect('/admin/aliexpress?oauth=ok');
});

// Light JSON endpoint the admin UI can poll to render OAuth status.
router.get('/admin/aliexpress/oauth/status', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  return res.json(await getOAuthStatus());
});

// ── GET /admin/aliexpress/equivalents/dry-run ───────────────────────────────
// Replays the current textSimilarity() function (the version compiled into
// this binary) against every stored amazon_ae_equivalents row that already
// has an AE candidate, and reports the delta vs the score we persisted at
// discovery time. Lets us preview the impact of a scoring change before
// re-running the cron over the whole catalog. No writes.
router.get('/admin/aliexpress/equivalents/dry-run', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const { textSimilarity } = await import('../marketplaces/aliexpress/text');
  const TEXT_SCORE_MIN  = 0.25;   // mirror equivalents.ts
  const PCT_CHEAPER_MIN = 10.00;
  const PCT_CHEAPER_MAX = 80.00;

  const rows = (await db.execute(sql`
    SELECT
      e.amazon_product_id           AS "amazonProductId",
      e.ae_product_id               AS "aeProductId",
      e.text_score::float           AS "oldScore",
      e.pct_cheaper::float          AS "pctCheaper",
      e.is_eligible                 AS "wasEligible",
      p.name                        AS "amazonTitle",
      aep.title                     AS "aeTitle"
    FROM amazon_ae_equivalents e
    JOIN products p              ON p.id = e.amazon_product_id
    LEFT JOIN aliexpress_products aep ON aep.product_id = e.ae_product_id
    WHERE e.ae_product_id IS NOT NULL
      AND p.name IS NOT NULL
      AND aep.title IS NOT NULL
  `)).rows as Array<{
    amazonProductId: number; aeProductId: string;
    oldScore: number;        pctCheaper: number;
    wasEligible: boolean;
    amazonTitle: string;     aeTitle: string;
  }>;

  let newEligibleNow = 0, becameEligible = 0, lostEligibility = 0;
  const flippedOn:  Array<{ amazonId: number; amazonTitle: string; aeTitle: string; oldScore: number; newScore: number; pctCheaper: number }> = [];
  const flippedOff: Array<{ amazonId: number; amazonTitle: string; aeTitle: string; oldScore: number; newScore: number; pctCheaper: number }> = [];
  let scoreDeltaSum = 0;

  for (const r of rows) {
    const newScore = textSimilarity(r.amazonTitle, r.aeTitle);
    const newEligible = newScore >= TEXT_SCORE_MIN
                     && r.pctCheaper >= PCT_CHEAPER_MIN
                     && r.pctCheaper <= PCT_CHEAPER_MAX;
    scoreDeltaSum += (newScore - r.oldScore);
    if (newEligible) newEligibleNow++;
    if (newEligible && !r.wasEligible) {
      becameEligible++;
      if (flippedOn.length < 25) flippedOn.push({ amazonId: r.amazonProductId, amazonTitle: r.amazonTitle.slice(0, 80), aeTitle: r.aeTitle.slice(0, 80), oldScore: r.oldScore, newScore: Number(newScore.toFixed(3)), pctCheaper: r.pctCheaper });
    }
    if (!newEligible && r.wasEligible) {
      lostEligibility++;
      if (flippedOff.length < 25) flippedOff.push({ amazonId: r.amazonProductId, amazonTitle: r.amazonTitle.slice(0, 80), aeTitle: r.aeTitle.slice(0, 80), oldScore: r.oldScore, newScore: Number(newScore.toFixed(3)), pctCheaper: r.pctCheaper });
    }
  }

  return res.json({
    sampledRows:     rows.length,
    currentEligible: rows.filter(r => r.wasEligible).length,
    newEligible:     newEligibleNow,
    delta:           newEligibleNow - rows.filter(r => r.wasEligible).length,
    becameEligible,
    lostEligibility,
    avgScoreDelta:   rows.length > 0 ? Number((scoreDeltaSum / rows.length).toFixed(3)) : 0,
    flippedOn,
    flippedOff,
    note:            'Read-only preview. Run the cron (or POST /admin/aliexpress/refresh-now) to actually re-score and persist.',
  });
});

// ── GET /admin/affiliates — Amazon affiliate stats dashboard ────────────────
router.get('/admin/affiliates', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const summaryRows = await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM amazon_affiliate_stats) AS "totalRows",
      (SELECT COUNT(DISTINCT day)::int FROM amazon_affiliate_stats) AS "totalDays",
      (SELECT COUNT(DISTINCT tracking_id)::int FROM amazon_affiliate_stats) AS "totalTrackings",
      (SELECT MAX(day) FROM amazon_affiliate_stats) AS "latestDay",
      (SELECT MIN(day) FROM amazon_affiliate_stats) AS "earliestDay",
      (SELECT MAX(uploaded_at) FROM amazon_affiliate_stats) AS "lastUploadAt",
      -- Last 30 / 7 / current month aggregates
      (SELECT COALESCE(SUM(earnings), 0)::float FROM amazon_affiliate_stats WHERE day >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')) AS "earnings30d",
      (SELECT COALESCE(SUM(earnings), 0)::float FROM amazon_affiliate_stats WHERE day >= TO_CHAR(NOW() - INTERVAL '7 days',  'YYYY-MM-DD')) AS "earnings7d",
      (SELECT COALESCE(SUM(earnings), 0)::float FROM amazon_affiliate_stats WHERE day >= TO_CHAR(DATE_TRUNC('month', NOW()), 'YYYY-MM-DD')) AS "earningsMonth",
      (SELECT COALESCE(SUM(clicks),   0)::int   FROM amazon_affiliate_stats WHERE day >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')) AS "clicks30d",
      (SELECT COALESCE(SUM(items_ordered), 0)::int FROM amazon_affiliate_stats WHERE day >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')) AS "orders30d"
  `);
  const summary = summaryRows.rows[0] as any;

  // Top earning ASINs in the last 30 days. Cross-reference with our
  // products catalog so we can show the product name we know it by.
  const topAsinsRows = await db.execute(sql`
    SELECT
      s.asin,
      SUM(s.earnings)::float       AS "earnings",
      SUM(s.items_ordered)::int    AS "items",
      MAX(s.day)                   AS "lastDay",
      p.name                       AS "name",
      p.id                         AS "internalId",
      EXISTS (SELECT 1 FROM products p2 WHERE p2.asin = s.asin) AS "isTracked"
    FROM amazon_affiliate_stats s
    LEFT JOIN products p ON p.asin = s.asin
    WHERE s.day >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')
      AND s.asin <> '*'
      AND s.earnings IS NOT NULL AND s.earnings > 0
    GROUP BY s.asin, p.name, p.id
    ORDER BY earnings DESC
    LIMIT 20
  `);

  // Daily totals last 30d for the chart
  const dailyRows = await db.execute(sql`
    SELECT day, SUM(earnings)::float AS earnings, SUM(items_ordered)::int AS items
    FROM amazon_affiliate_stats
    WHERE day >= TO_CHAR(NOW() - INTERVAL '30 days', 'YYYY-MM-DD')
    GROUP BY day
    ORDER BY day ASC
  `);

  // Flash from the upload redirect
  const flash = req.query.imported != null ? {
    imported: parseInt(String(req.query.imported), 10) || 0,
    updated:  parseInt(String(req.query.updated),  10) || 0,
    skipped:  parseInt(String(req.query.skipped),  10) || 0,
    days:     req.query.days     ? String(req.query.days)     : '',
    firstErr: req.query.first_err ? String(req.query.first_err).slice(0, 200) : '',
  } : null;

  res.render('admin-affiliates', {
    user: { email: req.session.userEmail },
    summary,
    topAsins: topAsinsRows.rows,
    daily:    dailyRows.rows,
    flash,
  });
});

// ── POST /admin/affiliates/import — upload an Amazon CSV ────────────────────
// Body: { csv: string } from the textarea. Caps body at 5MB via
// express.urlencoded default; the file rarely exceeds 200 KB.
router.post('/admin/affiliates/import', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const csv = String(req.body?.csv ?? '').trim();
  if (!csv) {
    return res.redirect('/admin/affiliates?imported=0&updated=0&skipped=0&first_err=' +
      encodeURIComponent('No has pegado contenido.'));
  }
  try {
    const summary = await importAmazonCsv(csv);
    const qs = new URLSearchParams({
      imported: String(summary.imported),
      updated:  String(summary.updated),
      skipped:  String(summary.skipped),
      days:     summary.daysCovered.length
                  ? `${summary.daysCovered[0]}…${summary.daysCovered[summary.daysCovered.length - 1]}`
                  : '',
    });
    if (summary.errors.length) qs.set('first_err', summary.errors[0]);
    res.redirect(`/admin/affiliates?${qs.toString()}`);
  } catch (err) {
    res.redirect('/admin/affiliates?imported=0&updated=0&skipped=0&first_err=' +
      encodeURIComponent((err as Error).message.slice(0, 200)));
  }
});

export default router;
