import { Router, type Request, type Response } from 'express';
import { body, validationResult } from 'express-validator';
import { db } from '../db/client';
import { products, priceHistory, alerts, categories } from '../db/schema';
import { eq, and, desc, sql, asc, inArray } from 'drizzle-orm';
import { extractAsin, normaliseAmazonUrl, scrapeProduct, scrapeWishlist, affiliateUrl, ProductUnavailableError } from '../scraper/amazon';
import { requireAuth } from '../middleware/auth';
import { isAdmin, requireAdmin } from '../middleware/admin';

const router = Router();

// ── GET / — Dashboard (redirect guests to /ofertas) ──────────────────────────
router.get('/', (req: Request, res: Response, next) => {
  if (!req.session.userId) return res.redirect('/ofertas');
  if (!req.session.emailVerified) return res.redirect('/auth/verify-pending');
  next();
}, async (req: Request, res: Response) => {
  const userId = req.session.userId!;

  const q          = String(req.query.q ?? '').trim();
  const catFilter  = String(req.query.category ?? '').trim();
  const status     = String(req.query.status ?? 'all').trim();
  const sortBy     = ['recent', 'price_desc', 'price_asc', 'discount'].includes(String(req.query.sort ?? '')) ? String(req.query.sort) : 'recent';
  const perPage    = [10, 20, 50].includes(Number(req.query.per_page)) ? Number(req.query.per_page) : 20;
  const page       = Math.max(1, parseInt(String(req.query.page ?? '1'), 10));
  const offset     = (page - 1) * perPage;

  const adminUser = isAdmin(req);
  // Admin sees all products; regular users see only their own
  const whereClauses = adminUser ? [] : [sql`p.user_id = ${userId}`];
  if (q)         whereClauses.push(sql`(p.name ILIKE ${'%' + q + '%'} OR p.asin ILIKE ${'%' + q + '%'})`);
  if (catFilter) whereClauses.push(catFilter === 'none' ? sql`p.category_id IS NULL` : sql`p.category_id = ${parseInt(catFilter, 10)}`);
  if (status === 'scraped')    whereClauses.push(sql`EXISTS     (SELECT 1 FROM price_history ph WHERE ph.product_id = p.id)`);
  if (status === 'on_sale')    whereClauses.push(sql`p.is_on_sale = TRUE`);
  if (status === 'unavailable') whereClauses.push(sql`p.is_available = FALSE`);
  if (status === 'error')      whereClauses.push(sql`p.last_error IS NOT NULL`);
  if (status === 'failed')     whereClauses.push(sql`p.is_failed = TRUE`);
  if (status === 'pending')    whereClauses.push(sql`NOT EXISTS (SELECT 1 FROM price_history ph WHERE ph.product_id = p.id)`);
  const where = whereClauses.length ? sql.join(whereClauses, sql` AND `) : sql`TRUE`;

  const [countRow, rows, allCategories] = await Promise.all([
    db.execute(sql`SELECT COUNT(*) AS total FROM products p WHERE ${where}`),
    db.execute(sql`
      SELECT
        p.id, p.asin, p.url, p.name,
        p.image_url   AS "imageUrl",
        p.category_id  AS "categoryId",
        (SELECT c.name FROM categories c WHERE c.id = p.category_id) AS "categoryName",
        (SELECT c.slug FROM categories c WHERE c.id = p.category_id) AS "categorySlug",
        (p.user_id = ${userId}) AS "isOwnProduct",
        p.is_active    AS "isActive",
        p.is_public    AS "isPublic",
        p.is_available AS "isAvailable",
        p.is_on_sale   AS "isOnSale",
        p.is_failed    AS "isFailed",
        p.consecutive_failures AS "consecutiveFailures",
        p.total_failures       AS "totalFailures",
        p.last_error   AS "lastError",
        p.created_at   AS "createdAt",
        (SELECT ph.price  FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice",
        (SELECT ph.price  FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC OFFSET 1 LIMIT 1) AS "previousPrice",
        (SELECT MIN(ph2.price) FROM price_history ph2 WHERE ph2.product_id = p.id) AS "minPrice",
        (SELECT MAX(ph3.price) FROM price_history ph3 WHERE ph3.product_id = p.id) AS "maxPrice",
        (SELECT COUNT(*)       FROM price_history ph4 WHERE ph4.product_id = p.id) AS "checkCount",
        (SELECT json_agg(sub.price ORDER BY sub.scraped_at ASC)
         FROM (SELECT price, scraped_at FROM price_history WHERE product_id = p.id ORDER BY scraped_at DESC LIMIT 20) sub
        ) AS "sparklineData",
        (SELECT ph.price  FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1)::float AS "_sortPrice",
        (SELECT MAX(ph3.price) FROM price_history ph3 WHERE ph3.product_id = p.id)::float AS "_sortMax"
      FROM products p
      WHERE ${where}
      ORDER BY ${
        sortBy === 'price_desc' ? sql`"_sortPrice" DESC NULLS LAST` :
        sortBy === 'price_asc'  ? sql`"_sortPrice" ASC  NULLS LAST` :
        sortBy === 'discount'   ? sql`CASE WHEN "_sortMax" > 0 THEN ("_sortMax" - "_sortPrice") / "_sortMax" ELSE 0 END DESC NULLS LAST` :
        sql`p.created_at DESC`
      }
      LIMIT ${perPage} OFFSET ${offset}
    `),
    db.select().from(categories).orderBy(asc(categories.name)),
  ]);

  const totalCount = parseInt(String((countRow.rows[0] as any).total), 10);
  const totalPages = Math.ceil(totalCount / perPage);
  const prods = rows.rows as any[];

  // stats computed over all visible products (all for admin, own for regular users)
  const statsWhere = adminUser ? sql`TRUE` : sql`p.user_id = ${userId}`;
  const allRows = await db.execute(sql`
    SELECT p.is_available, p.last_error, p.is_on_sale, p.is_failed,
      (SELECT ph.price FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "currentPrice",
      (SELECT MIN(ph2.price) FROM price_history ph2 WHERE ph2.product_id = p.id) AS "minPrice",
      (SELECT COUNT(*) FROM price_history ph4 WHERE ph4.product_id = p.id) AS "checkCount"
    FROM products p WHERE ${statsWhere}
  `);
  const all = allRows.rows as any[];
  const stats = {
    total:     all.length,
    withPrice: all.filter(p => p.currentPrice !== null).length,
    pending:   all.filter(p => p.currentPrice === null).length,
    onSale:    all.filter(p => p.is_on_sale).length,
    withError: all.filter(p => p.last_error).length,
    failed:    all.filter(p => p.is_failed).length,
  };

  res.render('dashboard', {
    products: prods, stats,
    filters: { q, category: catFilter, status, sort: sortBy, perPage },
    page, totalPages, totalCount,
    allCategories,
    user: { email: req.session.userEmail },
    isAdmin: isAdmin(req),
  });
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
          .set({ name: result.name, imageUrl: result.imageUrl, extraImages: result.extraImages.length ? JSON.stringify(result.extraImages) : null, lastError: null })
          .where(eq(products.id, product.id));

        await db.insert(priceHistory).values({
          productId: product.id,
          price: String(result.price),
          currency: result.currency,
        });
      })
      .catch(async (err) => {
        if (err instanceof ProductUnavailableError) {
          await db.update(products).set({ isAvailable: false, lastError: null }).where(eq(products.id, product.id));
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          await db.update(products).set({ lastError: msg }).where(eq(products.id, product.id));
        }
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
    .where(isAdmin(req) ? eq(products.id, productId) : and(eq(products.id, productId), eq(products.userId, userId)))
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
    .where(isAdmin(req) ? eq(products.id, productId) : and(eq(products.id, productId), eq(products.userId, userId)))
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

  const [allCategories, viewCountRow] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.name)),
    db.execute(sql`SELECT COALESCE(SUM(count),0) AS views FROM page_views WHERE path = ${'/p/' + product.asin}`),
  ]);

  res.render('product', {
    product,
    history,
    alerts: productAlerts,
    categories: allCategories,
    user: { email: req.session.userEmail },
    amazonUrl: affiliateUrl(product.url),
    isAdmin: isAdmin(req),
    viewCount: parseInt(String((viewCountRow.rows[0] as any)?.views ?? '0'), 10),
  });
});

// ── POST /products/:id/refresh — Manual refresh (admin only) ─────────────────
router.post('/products/:id/refresh', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);

  const [product] = await db
    .select()
    .from(products)
    .where(eq(products.id, productId))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  try {
    const result = await scrapeProduct(product.url);
    await db
      .update(products)
      .set({ name: result.name, imageUrl: result.imageUrl, extraImages: result.extraImages.length ? JSON.stringify(result.extraImages) : null, lastError: null, isAvailable: true, consecutiveFailures: 0, isFailed: false })
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
    if (err instanceof ProductUnavailableError) {
      await db.update(products).set({ isAvailable: false, lastError: null }).where(eq(products.id, productId));
      if (req.headers['hx-request']) return res.redirect(`/products/${productId}`);
      res.status(200).json({ unavailable: true });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      await db.update(products).set({ lastError: msg, totalFailures: sql`total_failures + 1` }).where(eq(products.id, productId));
      res.status(500).json({ error: msg });
    }
  }
});

// ── POST /products/:id/toggle-public — Toggle public visibility ───────────────
router.post('/products/:id/toggle-public', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [product] = await db
    .select()
    .from(products)
    .where(isAdmin(req) ? eq(products.id, productId) : and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  const [updated] = await db
    .update(products)
    .set({ isPublic: !product.isPublic })
    .where(eq(products.id, productId))
    .returning();

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', `/products/${productId}`);
    return res.status(200).send('');
  }
  res.json({ isPublic: updated.isPublic });
});

// ── POST /products/:id/set-category ──────────────────────────────────────────
router.post('/products/:id/set-category', requireAuth, async (req: Request, res: Response) => {
  const productId = parseInt(String(req.params.id), 10);
  const userId = req.session.userId!;

  const [product] = await db
    .select()
    .from(products)
    .where(isAdmin(req) ? eq(products.id, productId) : and(eq(products.id, productId), eq(products.userId, userId)))
    .limit(1);

  if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });

  const rawId = req.body.categoryId;
  const categoryId = rawId && rawId !== '' ? parseInt(String(rawId), 10) : null;

  await db.update(products).set({ categoryId }).where(eq(products.id, productId));

  if (req.headers['hx-request']) {
    res.setHeader('HX-Redirect', `/products/${productId}`);
    return res.status(200).send('');
  }
  res.json({ success: true });
});

// ── POST /products/import-wishlist ────────────────────────────────────────────
router.post('/products/import-wishlist', requireAuth, async (req: Request, res: Response) => {
  const wishlistUrl = String(req.body.wishlistUrl ?? '').trim();
  const userId = req.session.userId!;

  if (!wishlistUrl.includes('amazon.es') || !wishlistUrl.includes('wishlist')) {
    return res.status(400).send('<p class="hint" style="color:var(--red)">URL inválida. Debe ser una wishlist de amazon.es.</p>');
  }

  let urls: string[];
  try {
    urls = await scrapeWishlist(wishlistUrl);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(200).send(`<p class="hint" style="color:var(--red)">${msg}</p>`);
  }

  let added = 0, skipped = 0, errors = 0;

  for (const productUrl of urls) {
    const asin = extractAsin(productUrl);
    if (!asin) { errors++; continue; }

    const [existing] = await db.select().from(products)
      .where(and(eq(products.userId, userId), eq(products.asin, asin))).limit(1);
    if (existing) { skipped++; continue; }

    const canonicalUrl = normaliseAmazonUrl(asin);
    const [product] = await db.insert(products).values({ userId, asin, url: canonicalUrl }).returning();
    added++;

    scrapeProduct(canonicalUrl).then(async result => {
      await db.update(products).set({ name: result.name, imageUrl: result.imageUrl, extraImages: result.extraImages.length ? JSON.stringify(result.extraImages) : null, lastError: null }).where(eq(products.id, product.id));
      await db.insert(priceHistory).values({ productId: product.id, price: String(result.price), currency: result.currency });
    }).catch(async err => {
      const msg = err instanceof Error ? err.message : String(err);
      await db.update(products).set({ lastError: msg }).where(eq(products.id, product.id));
    });
  }

  res.send(`
    <div class="alert-box" style="margin-top:12px; background:var(--green-light,#f0fdf4); border:1px solid var(--green); border-radius:8px; padding:12px 16px">
      <strong>${added} productos añadidos</strong> · ${skipped} ya existían · ${errors} errores
      ${added > 0 ? ' — <a href="/" style="color:var(--green)">Ver dashboard</a>' : ''}
    </div>
  `);
});

// ── POST /products/bulk-set-category (admin only) ─────────────────────────────
router.post('/products/bulk-set-category', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const raw = req.body.ids;
  const ids = (Array.isArray(raw) ? raw : [raw])
    .map(Number)
    .filter(n => Number.isFinite(n) && n > 0);

  if (!ids.length) return res.status(400).json({ error: 'No hay productos seleccionados.' });

  const rawCat = req.body.categoryId;
  const categoryId = rawCat && rawCat !== '' ? parseInt(String(rawCat), 10) : null;

  await db.update(products).set({ categoryId }).where(inArray(products.id, ids));

  res.json({ success: true, updated: ids.length });
});

export default router;
