import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { products, priceHistory } from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { affiliateUrl } from '../scraper/amazon';

const router = Router();

// ── GET /ofertas — Public deals page ─────────────────────────────────────────
router.get('/ofertas', async (_req: Request, res: Response) => {
  const rows = await db.execute(sql`
    SELECT
      p.id, p.asin, p.name, p.image_url AS "imageUrl", p.url,
      (
        SELECT ph.price FROM price_history ph
        WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1
      ) AS "currentPrice",
      (SELECT MIN(ph2.price) FROM price_history ph2 WHERE ph2.product_id = p.id) AS "minPrice",
      (SELECT MAX(ph3.price) FROM price_history ph3 WHERE ph3.product_id = p.id) AS "maxPrice",
      (SELECT COUNT(*) FROM price_history ph4 WHERE ph4.product_id = p.id) AS "checkCount",
      (SELECT ph5.scraped_at FROM price_history ph5
       WHERE ph5.product_id = p.id ORDER BY ph5.scraped_at DESC LIMIT 1) AS "lastChecked"
    FROM products p
    WHERE p.is_public = TRUE AND p.is_active = TRUE
    ORDER BY p.created_at DESC
  `);

  // Filter products with price data, sort by proximity to historical low (best deals first)
  const deals = (rows.rows as any[])
    .filter(p => p.currentPrice && p.minPrice)
    .map(p => ({
      ...p,
      amazonUrl: affiliateUrl(p.url),
      discountFromMax: p.maxPrice
        ? Math.round((1 - parseFloat(p.currentPrice) / parseFloat(p.maxPrice)) * 100)
        : 0,
      isAtLow: parseFloat(p.currentPrice) <= parseFloat(p.minPrice) + 0.01,
    }))
    .sort((a, b) => {
      // Products at historical low first, then by biggest discount
      if (a.isAtLow && !b.isAtLow) return -1;
      if (!a.isAtLow && b.isAtLow) return 1;
      return b.discountFromMax - a.discountFromMax;
    });

  res.render('deals', { deals });
});

// ── GET /p/:asin — Public product page ───────────────────────────────────────
router.get('/p/:asin', async (req: Request, res: Response) => {
  const asin = String(req.params.asin).toUpperCase();

  // Find any public product with this ASIN (pick most history if multiple users)
  const rows = await db.execute(sql`
    SELECT p.id, p.asin, p.name, p.image_url AS "imageUrl", p.url, p.created_at AS "createdAt"
    FROM products p
    WHERE p.asin = ${asin} AND p.is_public = TRUE AND p.is_active = TRUE
    ORDER BY (SELECT COUNT(*) FROM price_history ph WHERE ph.product_id = p.id) DESC
    LIMIT 1
  `);

  const product = (rows.rows as any[])[0];
  if (!product) return res.status(404).render('404', { user: null });

  const history = await db
    .select()
    .from(priceHistory)
    .where(eq(priceHistory.productId, product.id))
    .orderBy(desc(priceHistory.scrapedAt))
    .limit(500);

  const prices = history.map(h => parseFloat(String(h.price)));
  const currentPrice = prices[0] ?? null;
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;

  res.render('public-product', {
    product: { ...product, amazonUrl: affiliateUrl(product.url) },
    history,
    currentPrice,
    minPrice,
    maxPrice,
    siteUrl: process.env.SITE_URL ?? 'http://localhost:3000',
  });
});

export default router;
