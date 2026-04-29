import { Router, type Request, type Response, type NextFunction } from 'express';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { affiliateUrl } from '../scraper/amazon';

const router = Router();

// ── GET /:slug — Public recommendation list ───────────────────────────────────
// Must be registered LAST in server.ts — acts as a catch-all for slugs.
router.get('/:slug([a-z0-9-]+)', async (req: Request, res: Response, next: NextFunction) => {
  const slug = String(req.params.slug).toLowerCase();

  const listRow = await db.execute(sql`
    SELECT id, slug, name, description FROM recommendation_lists WHERE slug = ${slug} LIMIT 1
  `);
  const list = (listRow.rows as any[])[0];
  if (!list) return next();

  const itemRows = await db.execute(sql`
    SELECT
      ri.note, ri.position,
      p.id, p.asin, p.name, p.image_url AS "imageUrl", p.url,
      p.is_available AS "isAvailable",
      (
        SELECT ph.price FROM price_history ph
        WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1
      ) AS "currentPrice",
      (SELECT MIN(ph2.price) FROM price_history ph2 WHERE ph2.product_id = p.id) AS "minPrice",
      (SELECT MAX(ph3.price) FROM price_history ph3 WHERE ph3.product_id = p.id) AS "maxPrice"
    FROM recommendation_items ri
    JOIN products p ON p.id = ri.product_id
    WHERE ri.list_id = ${list.id}
    ORDER BY ri.position ASC, ri.created_at ASC
  `);

  const items = (itemRows.rows as any[]).map(r => ({
    ...r,
    amazonUrl: affiliateUrl(r.url),
    currentPrice: r.currentPrice ? parseFloat(r.currentPrice) : null,
    minPrice: r.minPrice ? parseFloat(r.minPrice) : null,
    maxPrice: r.maxPrice ? parseFloat(r.maxPrice) : null,
    isAtLow: r.minPrice && r.currentPrice && parseFloat(r.currentPrice) <= parseFloat(r.minPrice) + 0.01,
  }));

  res.render('recommendation', { list, items });
});

export default router;
