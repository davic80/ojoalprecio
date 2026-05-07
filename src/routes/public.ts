import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { products, priceHistory } from '../db/schema';
import { eq, desc, sql } from 'drizzle-orm';
import { affiliateUrl } from '../scraper/amazon';
import { isAdmin } from '../middleware/admin';

const router = Router();

// ── GET /ofertas — Public deals page ─────────────────────────────────────────
router.get('/ofertas', async (req: Request, res: Response) => {
  const rows = await db.execute(sql`
    SELECT
      p.id, p.asin, p.name, p.image_url AS "imageUrl", p.extra_images AS "extraImages", p.url,
      c.name AS "categoryName", c.slug AS "categorySlug",
      (
        SELECT ph.price FROM price_history ph
        WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1
      ) AS "currentPrice",
      (SELECT MIN(ph2.price) FROM price_history ph2 WHERE ph2.product_id = p.id) AS "minPrice",
      (SELECT MAX(ph3.price) FROM price_history ph3 WHERE ph3.product_id = p.id) AS "maxPrice",
      (
        SELECT json_agg(sub.price)
        FROM (
          SELECT price FROM price_history
          WHERE product_id = p.id
          ORDER BY scraped_at DESC LIMIT 20
        ) sub
      ) AS "sparkline",
      p.is_on_sale AS "isOnSale",
      p.sale_tier  AS "saleTier",
      p.deal_score::float AS "dealScore"
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.is_public = TRUE AND p.is_active = TRUE AND p.is_available = TRUE
    ORDER BY c.name ASC NULLS LAST, p.created_at DESC
  `);

  const deals = (rows.rows as any[])
    .filter(p => p.currentPrice)
    .map(p => ({
      ...p,
      amazonUrl: affiliateUrl(p.url),
      discountFromMax: p.maxPrice
        ? Math.round((1 - parseFloat(p.currentPrice) / parseFloat(p.maxPrice)) * 100)
        : 0,
      isAtLow: p.minPrice && parseFloat(p.currentPrice) <= parseFloat(p.minPrice) + 0.01,
      sparkline: Array.isArray(p.sparkline) ? p.sparkline.map(Number) : [],
      extraImages: (() => { try { return JSON.parse(p.extraImages ?? '[]'); } catch { return []; } })(),
    }));

  // Group by category; uncategorized goes last under "Otros"
  const groupMap = new Map<string, { name: string; slug: string | null; deals: any[] }>();
  for (const deal of deals) {
    const key = deal.categoryName ?? '__none__';
    if (!groupMap.has(key)) {
      groupMap.set(key, { name: deal.categoryName ?? 'Otros', slug: deal.categorySlug ?? null, deals: [] });
    }
    groupMap.get(key)!.deals.push(deal);
  }

  // Sort: on-sale first, then at-low, then by biggest discount from max
  const groups = [...groupMap.values()].map(g => ({
    ...g,
    deals: g.deals.sort((a, b) => {
      if (a.isOnSale && !b.isOnSale) return -1;
      if (!a.isOnSale && b.isOnSale) return 1;
      if (a.isAtLow && !b.isAtLow) return -1;
      if (!a.isAtLow && b.isAtLow) return 1;
      return b.discountFromMax - a.discountFromMax;
    }),
  }));

  res.render('deals', {
    groups,
    user: req.session.userId ? { email: req.session.userEmail } : null,
    isAdmin: isAdmin(req),
  });
});

// ── GET /c/:slug — Public category page ──────────────────────────────────────
router.get('/c/:slug', async (req: Request, res: Response) => {
  const slug = String(req.params.slug).toLowerCase();
  const admin = isAdmin(req);

  const catRow = await db.execute(sql`SELECT id, name, slug FROM categories WHERE slug = ${slug} LIMIT 1`);
  const cat = (catRow.rows as any[])[0];
  if (!cat) return res.status(404).render('404', { user: null });

  const rows = await db.execute(sql`
    SELECT
      p.id, p.asin, p.name, p.image_url AS "imageUrl", p.extra_images AS "extraImages", p.url,
      p.is_public AS "isPublic",
      (
        SELECT ph.price FROM price_history ph
        WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1
      ) AS "currentPrice",
      (SELECT MIN(ph2.price) FROM price_history ph2 WHERE ph2.product_id = p.id) AS "minPrice",
      (SELECT MAX(ph3.price) FROM price_history ph3 WHERE ph3.product_id = p.id) AS "maxPrice",
      (
        SELECT json_agg(sub.price)
        FROM (
          SELECT price FROM price_history
          WHERE product_id = p.id
          ORDER BY scraped_at DESC LIMIT 20
        ) sub
      ) AS "sparkline",
      p.is_on_sale AS "isOnSale",
      p.sale_tier  AS "saleTier",
      p.deal_score::float AS "dealScore"
    FROM products p
    WHERE p.category_id = ${cat.id}
      AND p.is_active = TRUE AND p.is_available = TRUE
      AND (p.is_public = TRUE OR ${admin})
    ORDER BY p.is_on_sale DESC, p.is_public DESC, p.created_at DESC
  `);

  const deals = (rows.rows as any[])
    .filter(p => p.currentPrice)
    .map(p => ({
      ...p,
      amazonUrl: affiliateUrl(p.url),
      discountFromMax: p.maxPrice
        ? Math.round((1 - parseFloat(p.currentPrice) / parseFloat(p.maxPrice)) * 100)
        : 0,
      isAtLow: p.minPrice && parseFloat(p.currentPrice) <= parseFloat(p.minPrice) + 0.01,
      sparkline: Array.isArray(p.sparkline) ? p.sparkline.map(Number) : [],
      extraImages: (() => { try { return JSON.parse(p.extraImages ?? '[]'); } catch { return []; } })(),
    }));

  res.render('category', { category: cat, deals, isAdmin: admin, user: { email: req.session.userEmail ?? '' } });
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
