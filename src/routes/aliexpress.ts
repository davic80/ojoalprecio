import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { isAdmin } from '../middleware/admin';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── GET /ae/r/:amazonProductId — tracked redirect to the AE equivalent ──────
// The .ae-nudge banner on /p/:asin links here. We look up the current
// eligible equivalent, log a click row (best-effort, never blocks the
// redirect), then 302 to the AE promotion_url so the affiliate cookie
// drops. Cache headers prevent browsers/CDNs from caching the 302 — we
// need every click to register.
router.get('/ae/r/:amazonProductId', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.amazonProductId), 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(404).render('404', {
      user: req.session.userId ? { email: req.session.userEmail } : null,
    });
  }

  const rows = await db.execute(sql`
    SELECT e.ae_product_id AS "aeProductId",
           p.promotion_url AS "promotionUrl",
           p.product_url   AS "productUrl"
    FROM amazon_ae_equivalents e
    LEFT JOIN aliexpress_products p ON p.product_id = e.ae_product_id
    WHERE e.amazon_product_id = ${id} AND e.is_eligible = TRUE
  `);
  const eq = rows.rows[0] as any;
  const target: string | null = eq?.promotionUrl || eq?.productUrl || null;
  if (!target) {
    return res.status(404).render('404', {
      user: req.session.userId ? { email: req.session.userEmail } : null,
    });
  }

  // Fire-and-forget click log. Failures here never block the redirect —
  // the affiliate cookie is the priority; metrics are nice-to-have.
  void db.execute(sql`
    INSERT INTO ae_nudge_clicks (amazon_product_id, ae_product_id, user_id, user_agent, referer)
    VALUES (
      ${id},
      ${eq.aeProductId ?? null},
      ${req.session.userId ?? null},
      ${(req.headers['user-agent'] as string) ?? null},
      ${(req.headers['referer']    as string) ?? null}
    )
  `).catch((err: unknown) => console.warn(`[ae-nudge-click] log failed: ${(err as Error).message}`));

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.redirect(302, target);
});

// ── POST /ae/:productId/threshold — set / clear the user's alert threshold ─
// Body: { threshold?: string }. Empty / missing clears it (alerts disabled).
// Any change resets notified_at so the next price tick fairly re-evaluates.
router.post('/ae/:productId/threshold', requireAuth, async (req: Request, res: Response) => {
  const productId = String(req.params.productId).trim();
  const userId    = req.session.userId!;
  if (!/^\d{10,16}$/.test(productId)) return res.status(404).json({ error: 'Producto no válido.' });

  const raw = String(req.body?.threshold ?? '').trim();
  let value: number | null = null;
  if (raw) {
    const n = parseFloat(raw.replace(',', '.'));
    if (!Number.isFinite(n) || n <= 0 || n > 100_000) {
      return res.status(400).json({ error: 'El umbral tiene que ser un número entre 0 y 100 000 €.' });
    }
    value = n;
  }

  const r = await db.execute(sql`
    UPDATE aliexpress_user_tracks
    SET threshold_price = ${value}, notified_at = NULL
    WHERE user_id = ${userId} AND product_id = ${productId}
    RETURNING product_id
  `);
  if (r.rows.length === 0) {
    return res.status(404).json({ error: 'No estás siguiendo este producto.' });
  }

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', `/ae/${productId}`);
    return res.status(200).send('');
  }
  return res.redirect(`/ae/${productId}`);
});

// ── DELETE /ae/:productId/track — stop following an AliExpress product ───────
// User-scoped: removes ONLY this user's track row. The catalog entry
// (aliexpress_products), price history and similars all survive for any
// other follower and for the 8h refresh cron (Phase D).
router.delete('/ae/:productId/track', requireAuth, async (req: Request, res: Response) => {
  const productId = String(req.params.productId).trim();
  const userId    = req.session.userId!;
  if (!/^\d{10,16}$/.test(productId)) return res.status(404).json({ error: 'Producto no válido.' });

  await db.execute(sql`
    DELETE FROM aliexpress_user_tracks
    WHERE user_id = ${userId} AND product_id = ${productId}
  `);

  if (req.headers['hx-request']) return res.send('');
  res.json({ success: true });
});

/**
 * GET /ae/:productId — public product detail page for an AliExpress SKU.
 *
 * Shows the master product (image, title, price + discount, shop, rating,
 * orders count) and the similars discovered by the ingest pipeline,
 * sorted by % cheaper. Sticky "Comprar en AliExpress" CTA on mobile is
 * the conversion point (uses promotion_url with our tracking id).
 */
router.get('/ae/:productId', async (req: Request, res: Response) => {
  const productId = String(req.params.productId).trim();
  if (!/^\d{10,16}$/.test(productId)) {
    return res.status(404).render('404', {
      user: req.session.userId ? { email: req.session.userEmail } : null,
    });
  }

  // Master product
  const masterRows = await db.execute(sql`
    SELECT
      product_id        AS "productId",
      title,
      image_url         AS "imageUrl",
      product_url       AS "productUrl",
      promotion_url     AS "promotionUrl",
      sale_price::float AS "salePrice",
      original_price::float AS "originalPrice",
      discount_pct      AS "discountPct",
      currency,
      rating::float     AS rating,
      orders_count      AS "ordersCount",
      category_name     AS "categoryName",
      shop_name         AS "shopName",
      sale_tier         AS "saleTier",
      is_available      AS "isAvailable",
      last_fetched_at   AS "lastFetchedAt"
    FROM aliexpress_products
    WHERE product_id = ${productId}
  `);
  const master = masterRows.rows[0] as any | undefined;
  if (!master) {
    return res.status(404).render('404', {
      user: req.session.userId ? { email: req.session.userEmail } : null,
    });
  }

  // Price history — newest first, capped at the latest 200 ticks so the
  // chart stays snappy on long-tracked products (8h cadence × 200 = ~66 days
  // of data, which is plenty for the typical use case).
  const historyRows = await db.execute(sql`
    SELECT id, price::float AS price, currency, scraped_at AS "scrapedAt"
    FROM aliexpress_price_history
    WHERE product_id = ${productId}
    ORDER BY scraped_at DESC
    LIMIT 200
  `);
  const history = historyRows.rows as Array<{ id: number; price: number; currency: string; scrapedAt: Date }>;

  // Similars — JOIN to bring in title/price for display, sort by %-cheaper desc
  // so the most compelling alternatives surface first.
  const similarsRows = await db.execute(sql`
    SELECT
      s.similar_product_id  AS "productId",
      s.source              AS source,
      s.text_score::float   AS "textScore",
      p.title               AS title,
      p.image_url           AS "imageUrl",
      p.product_url         AS "productUrl",
      p.promotion_url       AS "promotionUrl",
      p.sale_price::float   AS "salePrice",
      p.original_price::float AS "originalPrice",
      p.discount_pct        AS "discountPct",
      p.currency            AS currency,
      p.rating::float       AS rating,
      p.orders_count        AS "ordersCount",
      p.shop_name           AS "shopName",
      p.sale_tier           AS "saleTier",
      ROUND(
        CASE
          WHEN ${master.salePrice}::numeric > 0
            THEN ((${master.salePrice}::numeric - p.sale_price) / ${master.salePrice}::numeric * 100)
          ELSE 0
        END::numeric, 1
      )::float AS "pctCheaper"
    FROM aliexpress_similars s
    JOIN aliexpress_products p ON p.product_id = s.similar_product_id
    WHERE s.master_product_id = ${productId}
    ORDER BY "pctCheaper" DESC, s.text_score DESC
  `);

  // Track state for the current user — drives the "+ Seguir / Editar
  // alerta / Quitar" UI on the page.
  let isTracking = false;
  let userThreshold: number | null = null;
  if (req.session.userId) {
    const trackRows = await db.execute(sql`
      SELECT threshold_price::float AS "thresholdPrice"
      FROM aliexpress_user_tracks
      WHERE user_id = ${req.session.userId} AND product_id = ${productId}
      LIMIT 1
    `);
    if (trackRows.rows.length > 0) {
      isTracking = true;
      userThreshold = (trackRows.rows[0] as any).thresholdPrice ?? null;
    }
  }

  res.render('aliexpress-product', {
    user:       req.session.userId ? { email: req.session.userEmail } : null,
    isLogged:   !!req.session.userId,
    adminMode:  isAdmin(req),
    product:    master,
    similars:   similarsRows.rows,
    history,
    isTracking,
    userThreshold,
  });
});

export default router;
