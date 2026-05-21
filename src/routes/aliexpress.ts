import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { isAdmin } from '../middleware/admin';
import { requireAuth } from '../middleware/auth';
import {
  extractBrandModel,
  resolveAndParseProductId as resolveAEProductId,
  getAliExpressClient,
  ingestProduct as ingestAEProduct,
  AliExpressError,
} from '../marketplaces/aliexpress';

const router = Router();

// ── GET /ofertas/aliexpress — public hot-products feed ──────────────────────
// Cron refresh runs daily (see scheduler/aliexpress.ts startAliExpressScheduler
// → 04:10 Madrid). This route just reads the cached pool — no API hit per
// request. Anonymous-friendly, SEO-optimised description.
router.get('/ofertas/aliexpress', async (req: Request, res: Response) => {
  const rows = await db.execute(sql`
    SELECT
      product_id           AS "productId",
      title,
      image_url            AS "imageUrl",
      product_url          AS "productUrl",
      promotion_url        AS "promotionUrl",
      sale_price::float    AS "salePrice",
      original_price::float AS "originalPrice",
      discount_pct         AS "discountPct",
      currency,
      sale_tier            AS "saleTier",
      orders_count         AS "ordersCount",
      shop_name            AS "shopName",
      hot_rank             AS "hotRank",
      hot_fetched_at       AS "hotFetchedAt"
    FROM aliexpress_products
    WHERE is_hot = TRUE
    ORDER BY hot_rank ASC NULLS LAST
    LIMIT 100
  `);
  const products = rows.rows as any[];
  const lastFetched = products[0]?.hotFetchedAt ?? null;

  res.render('aliexpress-hot', {
    user:    req.session.userId ? { email: req.session.userEmail } : null,
    isAdmin: isAdmin(req),
    products,
    lastFetched,
  });
});

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
    INSERT INTO ae_nudge_clicks (amazon_product_id, ae_product_id, user_id, user_agent, referer, source)
    VALUES (
      ${id},
      ${eq.aeProductId ?? null},
      ${req.session.userId ?? null},
      ${(req.headers['user-agent'] as string) ?? null},
      ${(req.headers['referer']    as string) ?? null},
      'banner'
    )
  `).catch((err: unknown) => console.warn(`[ae-nudge-click] log failed: ${(err as Error).message}`));

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.redirect(302, target);
});

// ── GET /ae/s/:amazonProductId — tracked redirect to AE search ───────────
// Counterpart to /ae/r for the *manual* "Buscar en AliExpress" button. The
// button shows on every /p/:asin (not just where eligible match exists),
// so we want its clicks distinguishable from the curated banner clicks
// — same table, different `source`. Brand+model keywords are extracted
// server-side from the product's title (same heuristic the auto-discovery
// uses) so the keywords stay consistent regardless of what the link
// happened to encode at render time.
router.get('/ae/s/:amazonProductId', async (req: Request, res: Response) => {
  const id = parseInt(String(req.params.amazonProductId), 10);
  if (!Number.isFinite(id) || id < 1) {
    return res.status(404).render('404', {
      user: req.session.userId ? { email: req.session.userEmail } : null,
    });
  }

  const productRows = await db.execute(sql`
    SELECT name FROM products WHERE id = ${id}
  `);
  const product = productRows.rows[0] as { name: string | null } | undefined;
  if (!product?.name) {
    return res.status(404).render('404', {
      user: req.session.userId ? { email: req.session.userEmail } : null,
    });
  }

  const keywords = extractBrandModel(product.name);
  if (!keywords) {
    // Title was all stopwords — nothing meaningful to search. Bounce to
    // the open search page so the user can refine manually.
    return res.redirect(302, '/search?marketplace=aliexpress');
  }

  void db.execute(sql`
    INSERT INTO ae_nudge_clicks (amazon_product_id, user_id, user_agent, referer, source)
    VALUES (
      ${id},
      ${req.session.userId ?? null},
      ${(req.headers['user-agent'] as string) ?? null},
      ${(req.headers['referer']    as string) ?? null},
      'search'
    )
  `).catch((err: unknown) => console.warn(`[ae-search-click] log failed: ${(err as Error).message}`));

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  return res.redirect(302, `/search?q=${encodeURIComponent(keywords)}&marketplace=aliexpress`);
});

// ── POST /aliexpress/bulk — paste multiple AE URLs at once ──────────────────
// Body: { urls: string } where `urls` is a textarea, one URL per line.
// Caps at MAX_BULK so a runaway paste can't burn the API budget. Each
// line goes through the same resolve → ingest pipeline as the single-URL
// flow on /products. Returns a redirect to / with summary query params
// the dashboard reads to render a flash banner.
const MAX_BULK = 20;
router.post('/aliexpress/bulk', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const raw    = String(req.body?.urls ?? '');
  const lines  = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean).slice(0, MAX_BULK);

  if (lines.length === 0) {
    return res.redirect('/?bulk_added=0&bulk_existed=0&bulk_failed=0&bulk_first_error=' +
      encodeURIComponent('No has pegado ninguna URL.'));
  }

  const client = getAliExpressClient();
  if (!client) {
    return res.redirect('/?bulk_added=0&bulk_existed=0&bulk_failed=' + lines.length +
      '&bulk_first_error=' + encodeURIComponent('AliExpress no está configurado en este servidor.'));
  }

  let added = 0, existed = 0, failed = 0;
  let firstError: string | null = null;

  for (const url of lines) {
    try {
      const productId = await resolveAEProductId(url);
      if (!productId) {
        failed++;
        firstError ??= `URL no válida: ${url.slice(0, 60)}`;
        continue;
      }

      // Detect already-tracked BEFORE the ingest API call so we avoid
      // burning AE quota on duplicates.
      const existing = await db.execute(sql`
        SELECT 1 FROM aliexpress_user_tracks
        WHERE user_id = ${userId} AND product_id = ${productId}
        LIMIT 1
      `);
      if (existing.rows.length > 0) { existed++; continue; }

      await ingestAEProduct({ client, productId, userId });
      added++;
    } catch (err) {
      failed++;
      const msg = err instanceof AliExpressError ? `AliExpress: ${err.message}` : (err as Error).message;
      firstError ??= msg.slice(0, 140);
    }
  }

  const qs = new URLSearchParams({
    bulk_added:   String(added),
    bulk_existed: String(existed),
    bulk_failed:  String(failed),
  });
  if (firstError) qs.set('bulk_first_error', firstError);
  res.redirect(`/?${qs.toString()}`);
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

  // Raised from 200 → 5000 so the chart's "Todo" range works long-term
  // (3 ticks/day × 5000 = ~4.5 years of data). 5000 floats ≈ 40 KB JSON.
  const historyRows = await db.execute(sql`
    SELECT id, price::float AS price, currency, scraped_at AS "scrapedAt"
    FROM aliexpress_price_history
    WHERE product_id = ${productId}
    ORDER BY scraped_at DESC
    LIMIT 5000
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
