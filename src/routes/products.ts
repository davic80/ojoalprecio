import { Router, type Request, type Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { products, priceHistory, alerts } from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { extractAsin, normaliseAmazonUrl, scrapeProduct, affiliateUrl } from '../scraper/amazon';
import { requireAuth } from '../middleware/auth';

const router = Router();

// ── GET / — Dashboard ─────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  // Fetch user products with latest price
  const rows = await db.execute(sql`
    SELECT
      p.id,
      p.asin,
      p.url,
      p.name,
      p.image_url AS "imageUrl",
      p.is_active AS "isActive",
      p.last_error AS "lastError",
      p.created_at AS "createdAt",
      (
        SELECT ph.price
        FROM price_history ph
        WHERE ph.product_id = p.id
        ORDER BY ph.scraped_at DESC
        LIMIT 1
      ) AS "currentPrice",
      (
        SELECT MIN(ph2.price)
        FROM price_history ph2
        WHERE ph2.product_id = p.id
      ) AS "minPrice",
      (
        SELECT MAX(ph3.price)
        FROM price_history ph3
        WHERE ph3.product_id = p.id
      ) AS "maxPrice",
      (
        SELECT COUNT(*)
        FROM price_history ph4
        WHERE ph4.product_id = p.id
      ) AS "checkCount"
    FROM products p
    WHERE p.user_id = ${userId}
    ORDER BY p.created_at DESC
  `);

  res.render('dashboard', { products: rows.rows, user: { email: req.session.userEmail } });
});

// ── POST /products — Add product ──────────────────────────────────────────────
router.post(
  '/products',
  requireAuth,
  body('url').trim().notEmpty().withMessage('La URL es obligatoria.'),
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { url } = req.body as { url: string };
    const userId = req.session.userId!;

    const asin = extractAsin(url);
    if (!asin) {
      return res.status(400).json({ error: 'No se pudo extraer el ASIN. ¿Es una URL válida de Amazon.es?' });
    }

    // Check duplicate for this user
    const [existing] = await db
      .select()
      .from(products)
      .where(and(eq(products.userId, userId), eq(products.asin, asin)))
      .limit(1);

    if (existing) {
      return res.status(409).json({ error: 'Ya estás siguiendo este producto.' });
    }

    const canonicalUrl = normaliseAmazonUrl(asin);

    // Insert with minimal info — scheduler will fill name/image on first run
    const [product] = await db
      .insert(products)
      .values({ userId, asin, url: canonicalUrl })
      .returning();

    // Trigger an immediate scrape in background (non-blocking)
    scrapeProduct(canonicalUrl)
      .then(async (result) => {
        await db
          .update(products)
          .set({ name: result.name, imageUrl: result.imageUrl, lastError: null })
          .where(eq(products.id, product.id));

        await db.insert(priceHistory).values({
          productId: product.id,
          price: String(result.price),
          currency: result.currency,
        });
      })
      .catch(async (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        await db
          .update(products)
          .set({ lastError: msg })
          .where(eq(products.id, product.id));
      });

    // Return HTML partial for HTMX or JSON for API
    if (req.headers['hx-request']) {
      res.setHeader('HX-Redirect', '/');
      return res.status(200).send('');
    }
    res.status(201).json({ success: true, productId: product.id });
  },
);

// ── DELETE /products/:id — Remove product ─────────────────────────────────────
router.delete('/products/:id', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  await db.delete(products).where(eq(products.id, productId));

  if (req.headers['hx-request']) {
    return res.send('');
  }
  res.json({ success: true });
});

// ── GET /products/:id — Product detail ───────────────────────────────────────
router.get('/products/:id', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).render('404', { user: { email: req.session.userEmail } });

  const history = await db
    .select()
    .from(priceHistory)
    .where(eq(priceHistory.productId, productId))
    .orderBy(desc(priceHistory.scrapedAt))
    .limit(500);

  const productAlerts = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.productId, productId), eq(alerts.userId, userId)));

  res.render('product', {
    product,
    history,
    alerts: productAlerts,
    user: { email: req.session.userEmail },
    amazonUrl: affiliateUrl(product.url),
  });
});

// ── POST /products/:id/refresh — Manual refresh ───────────────────────────────
router.post('/products/:id/refresh', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [product] = await db
    .select()
    .from(products)
    .where(and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  try {
    const result = await scrapeProduct(product.url);
    await db
      .update(products)
      .set({ name: result.name, imageUrl: result.imageUrl, lastError: null })
      .where(eq(products.id, productId));
    await db.insert(priceHistory).values({
      productId,
      price: String(result.price),
      currency: result.currency,
    });

    if (req.headers['hx-request']) {
      return res.redirect(`/products/${productId}`);
    }
    res.json({ success: true, price: result.price });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db.update(products).set({ lastError: msg }).where(eq(products.id, productId));
    res.status(500).json({ error: msg });
  }
});

export default router;
