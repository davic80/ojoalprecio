import { Router, type Request, type Response } from 'express';
import { db } from '../db/client';
import { products, priceHistory, alerts, userProducts, categories, users } from '../db/schema';
import { eq, desc, sql, and, asc, inArray } from 'drizzle-orm';
import { affiliateUrl } from '../scraper/amazon';
import { isAdmin } from '../middleware/admin';
import { onScrapeUpdate } from '../lib/product-events';
import { getAliExpressClient, discoverAndPersistEquivalent } from '../marketplaces/aliexpress';

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
    WHERE p.is_public = TRUE AND p.is_active = TRUE AND p.is_available = TRUE AND p.is_on_sale = TRUE
    ORDER BY c.name ASC NULLS LAST, p.deal_score DESC NULLS LAST
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

// ── GET /p/:asin — Canonical product page (public, single view for everyone) ───
// Same template renders for anon visitors, logged-in followers, and admin —
// admin tools and follower alerts panel show conditionally on top.
router.get('/p/:asin', async (req: Request, res: Response) => {
  const asin = String(req.params.asin).toUpperCase();
  const userId = req.session.userId ?? null;
  const adminUser = isAdmin(req);

  // Canonical row per ASIN: most price history wins (resolves legacy duplicates).
  // is_public is no longer a gate — it's a "featured in /ofertas" tag only.
  const rows = await db.execute(sql`
    SELECT p.*
    FROM products p
    WHERE p.asin = ${asin} AND p.is_active = TRUE
    ORDER BY (SELECT COUNT(*) FROM price_history ph WHERE ph.product_id = p.id) DESC
    LIMIT 1
  `);

  const product = (rows.rows as any[])[0];
  if (!product) {
    return res.status(404).render('404', { user: userId ? { email: req.session.userEmail } : null });
  }

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

  // Follower alerts (only when logged in AND following)
  let userFollows = false;
  let userAlerts: any[] = [];
  if (userId) {
    const [follow] = await db.select().from(userProducts)
      .where(and(eq(userProducts.userId, userId), eq(userProducts.productId, product.id)))
      .limit(1);
    userFollows = !!follow;
    if (userFollows) {
      userAlerts = await db.select().from(alerts)
        .where(and(eq(alerts.productId, product.id), eq(alerts.userId, userId)));
    }
  }

  // Admin-only extras: categories list, owner info, view count
  let allCategories: any[] = [];
  let productOwner: { id: number; email: string } | null = null;
  let viewCount = 0;
  if (adminUser) {
    const [cats, ownerRows, viewRow] = await Promise.all([
      db.select().from(categories).orderBy(asc(categories.name)),
      product.created_by_user_id
        ? db.select({ id: users.id, email: users.email }).from(users).where(eq(users.id, product.created_by_user_id)).limit(1)
        : Promise.resolve([] as { id: number; email: string }[]),
      db.execute(sql`SELECT COALESCE(SUM(count),0) AS views FROM page_views WHERE path = ${'/p/' + product.asin}`),
    ]);
    allCategories = cats;
    productOwner = ownerRows[0] ?? null;
    viewCount = parseInt(String((viewRow.rows[0] as any)?.views ?? '0'), 10);
  }

  // Map snake_case from raw SQL to camelCase the template expects
  const productView = {
    id:                   product.id,
    asin:                 product.asin,
    name:                 product.name,
    imageUrl:             product.image_url,
    extraImages:          product.extra_images,
    url:                  product.url,
    categoryId:           product.category_id,
    isActive:             product.is_active,
    isPublic:             product.is_public,
    isAvailable:          product.is_available,
    isOnSale:             product.is_on_sale,
    saleTier:             product.sale_tier,
    dealScore:            product.deal_score,
    wasPrice:             product.was_price,
    consecutiveFailures:  product.consecutive_failures,
    totalFailures:        product.total_failures,
    isFailed:             product.is_failed,
    lastError:            product.last_error,
    featureLock:          product.feature_lock,
    featuredAt:           product.featured_at,
    variantsJson:         product.variants_json,
    createdAt:            product.created_at,
    amazonUrl:            affiliateUrl(product.url),
  };

  // For each variant ASIN we know about, look it up in our catalog so the
  // template can render an internal link if available, or just the label.
  let variantsView: Array<{ asin: string; label: string; selectable: boolean; inCatalog: boolean }> = [];
  try {
    const parsed: Array<{ asin: string; label: string; selectable: boolean }> =
      productView.variantsJson ? JSON.parse(String(productView.variantsJson)) : [];
    if (parsed.length) {
      const asins = parsed.map(v => v.asin);
      const known = await db.selectDistinct({ asin: products.asin }).from(products).where(inArray(products.asin, asins));
      const inDb = new Set(known.map(r => r.asin));
      variantsView = parsed.map(v => ({ ...v, inCatalog: inDb.has(v.asin) }));
    }
  } catch { /* malformed JSON — ignore */ }

  // ── Cross-marketplace banner (Amazon → AliExpress equivalent) ──────────
  // Cheap query against the cache. If there's a recent eligible match,
  // pass it down so the view can render "X € más barato en AliExpress".
  // Stale or missing entries trigger a fire-and-forget discovery so the
  // banner appears on the NEXT visit — never blocks the current render.
  let aeEquivalent: {
    productId: string; title: string; imageUrl: string | null;
    promotionUrl: string | null; productUrl: string;
    salePrice: number; currency: string; pctCheaper: number; saving: number;
  } | null = null;

  const eqRows = await db.execute(sql`
    SELECT e.ae_product_id AS "aeProductId", e.pct_cheaper::float AS "pctCheaper",
           e.ae_price_snapshot::float AS "aePrice", e.is_eligible AS "isEligible",
           e.checked_at AS "checkedAt",
           p.title, p.image_url AS "imageUrl", p.promotion_url AS "promotionUrl",
           p.product_url AS "productUrl", p.currency
    FROM amazon_ae_equivalents e
    LEFT JOIN aliexpress_products p ON p.product_id = e.ae_product_id
    WHERE e.amazon_product_id = ${productView.id}
  `);
  const aeEqRow = eqRows.rows[0] as any;
  const ageMs = aeEqRow ? (Date.now() - new Date(aeEqRow.checkedAt).getTime()) : Infinity;
  const TTL_MS = 24 * 60 * 60 * 1000;

  if (aeEqRow?.isEligible && aeEqRow.aeProductId && currentPrice) {
    aeEquivalent = {
      productId:    aeEqRow.aeProductId,
      title:        aeEqRow.title,
      imageUrl:     aeEqRow.imageUrl,
      promotionUrl: aeEqRow.promotionUrl,
      productUrl:   aeEqRow.productUrl,
      salePrice:    Number(aeEqRow.aePrice),
      currency:     aeEqRow.currency,
      pctCheaper:   Number(aeEqRow.pctCheaper),
      saving:       Number(currentPrice) - Number(aeEqRow.aePrice),
    };
  }

  // Fire-and-forget discovery when missing or stale. We only run it once
  // a candidate price exists (otherwise pct_cheaper is meaningless), and
  // only when an AE client is configured.
  if (currentPrice && (!aeEqRow || ageMs > TTL_MS) && productView.name) {
    const aeClient = getAliExpressClient();
    if (aeClient) {
      void discoverAndPersistEquivalent(aeClient, productView.id, {
        title: productView.name,
        price: Number(currentPrice),
      }).catch((err: unknown) => console.warn(`[ae-equivalent] background lookup for product ${productView.id} failed: ${(err as Error).message}`));
    }
  }

  res.render('public-product', {
    product: productView,
    history,
    currentPrice,
    minPrice,
    maxPrice,
    siteUrl: process.env.SITE_URL ?? 'http://localhost:3000',
    user: userId ? { email: req.session.userEmail } : null,
    userFollows,
    userAlerts,
    isAdmin: adminUser,
    allCategories,
    productOwner,
    viewCount,
    variants: variantsView,
    aeEquivalent,
  });
});

// ── GET /p/:asin/fragment/price — HTML fragment of just the price card ────────
// Used by HTMX after an SSE "price-update" tells the browser something
// changed. Returns the same partial that public-product.ejs includes inline.
router.get('/p/:asin/fragment/price', async (req: Request, res: Response) => {
  const asin = String(req.params.asin).toUpperCase();
  const rows = await db.execute(sql`
    SELECT p.* FROM products p
    WHERE p.asin = ${asin} AND p.is_active = TRUE
    ORDER BY (SELECT COUNT(*) FROM price_history ph WHERE ph.product_id = p.id) DESC
    LIMIT 1
  `);
  const product = (rows.rows as any[])[0];
  if (!product) return res.status(404).send('');

  const history = await db.select().from(priceHistory)
    .where(eq(priceHistory.productId, product.id))
    .orderBy(desc(priceHistory.scrapedAt))
    .limit(500);

  const prices = history.map(h => parseFloat(String(h.price)));
  const currentPrice = prices[0] ?? null;
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;

  const productView = {
    asin:        product.asin,
    name:        product.name,
    imageUrl:    product.image_url,
    isAvailable: product.is_available,
    isOnSale:    product.is_on_sale,
    saleTier:    product.sale_tier,
    wasPrice:    product.was_price,
    createdAt:   product.created_at,
    amazonUrl:   affiliateUrl(product.url),
  };

  res.render('partials/price-stats', { product: productView, currentPrice, minPrice, maxPrice, history });
});

// ── GET /events/products/:asin — Server-Sent Events for live price updates ────
// Browser opens a long-lived text/event-stream connection. When the scheduler
// finishes scraping this ASIN it emits on productBus; the listener forwards
// the event down the wire and HTMX's SSE extension wakes up. Auto-reconnect
// is handled natively by EventSource, so Watchtower restarts are invisible.
router.get('/events/products/:asin', (req: Request, res: Response) => {
  const asin = String(req.params.asin).toUpperCase();

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');  // disable nginx buffering if present
  res.flushHeaders();
  res.write('retry: 10000\n\n');              // browser reconnect delay 10s

  // Heartbeat every 25s so proxies / load balancers don't close the idle conn.
  const heartbeat = setInterval(() => { res.write(': ping\n\n'); }, 25_000);

  const unsubscribe = onScrapeUpdate(asin, () => {
    res.write(`event: price-update\ndata: ${JSON.stringify({ asin, at: Date.now() })}\n\n`);
  });

  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

export default router;
