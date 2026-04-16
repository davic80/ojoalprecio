import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { priceHistory } from '../db/schema';
import { products } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── GET /products/:id/prices — JSON price history for Chart.js ───────────────
router.get('/products/:id/prices', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '720', 10), 2000);

  // Verify ownership
  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  const rows = await db
    .select({
      price: priceHistory.price,
      scrapedAt: priceHistory.scrapedAt,
      currency: priceHistory.currency,
    })
    .from(priceHistory)
    .where(eq(priceHistory.productId, productId))
    .orderBy(desc(priceHistory.scrapedAt))
    .limit(limit);

  // Return in chronological order for Chart.js
  const data = rows.reverse().map((r) => ({
    t: r.scrapedAt,
    y: parseFloat(String(r.price)),
    currency: r.currency,
  }));

  res.json({ productId, data });
});

export default router;
