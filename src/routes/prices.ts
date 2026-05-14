import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { priceHistory, userProducts } from '../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { isAdmin } from '../middleware/admin';

const router = Router();

// ── GET /products/:id/prices — JSON price history for Chart.js ───────────────
router.get('/products/:id/prices', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;
  const limit = Math.min(parseInt((req.query.limit as string) ?? '720', 10), 2000);

  // Authorize via user_products (real follow) or admin role. The legacy
  // products.user_id used to gate this and got it wrong under the new model:
  // followers other than the original creator were getting 404.
  if (!isAdmin(req)) {
    const [follow] = await db.select().from(userProducts)
      .where(and(eq(userProducts.userId, userId), eq(userProducts.productId, productId)))
      .limit(1);
    if (!follow) return res.status(404).json({ error: 'Producto no encontrado.' });
  }

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
