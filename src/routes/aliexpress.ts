import { Router, type Request, type Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { isAdmin } from '../middleware/admin';

const router = Router();

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

  // Track state — is the current user following this product?
  let isTracking = false;
  if (req.session.userId) {
    const trackRows = await db.execute(sql`
      SELECT 1 FROM aliexpress_user_tracks
      WHERE user_id = ${req.session.userId} AND product_id = ${productId}
      LIMIT 1
    `);
    isTracking = trackRows.rows.length > 0;
  }

  res.render('aliexpress-product', {
    user:       req.session.userId ? { email: req.session.userEmail } : null,
    isLogged:   !!req.session.userId,
    adminMode:  isAdmin(req),
    product:    master,
    similars:   similarsRows.rows,
    isTracking,
  });
});

export default router;
