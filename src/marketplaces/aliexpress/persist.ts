import { sql, type SQL } from 'drizzle-orm';
import type { AliExpressProduct } from './types';
import { saleTierFromDiscountPct } from './text';

/**
 * Single source of truth for writing an AliExpress product into the
 * catalog. Used by:
 *   - ingest.ts          (initial add)
 *   - scheduler/aliexpress.ts  (8h refresh)
 *   - equivalents.ts     (cross-marketplace candidate upsert)
 *
 * Every catalog write goes through here so derived fields (sale_tier,
 * is_available=TRUE, last_fetched_at) stay in sync. The previous
 * three-way duplication was already showing drift — sale_tier would have
 * gone in only one place if we hadn't refactored.
 *
 * Returns a drizzle SQL fragment; callers pass it to `db.execute()` or
 * `tx.execute()`. Doesn't run anything itself so it composes inside the
 * transactions the callers already manage.
 */
export function upsertAEProductSql(p: AliExpressProduct): SQL {
  const saleTier = saleTierFromDiscountPct(p.discountPct);
  return sql`
    INSERT INTO aliexpress_products (
      product_id, title, image_url, product_url, promotion_url,
      sale_price, original_price, discount_pct, currency,
      rating, orders_count, category_id, category_name, shop_id, shop_name,
      sale_tier, is_available, last_fetched_at
    ) VALUES (
      ${p.productId}, ${p.title}, ${p.imageUrl}, ${p.productUrl}, ${p.promotionUrl},
      ${p.salePrice}, ${p.originalPrice}, ${p.discountPct}, ${p.currency},
      ${p.rating}, ${p.ordersCount}, ${p.categoryId}, ${p.categoryName}, ${p.shopId}, ${p.shopName},
      ${saleTier}, TRUE, NOW()
    )
    ON CONFLICT (product_id) DO UPDATE SET
      title           = EXCLUDED.title,
      image_url       = EXCLUDED.image_url,
      product_url     = EXCLUDED.product_url,
      promotion_url   = EXCLUDED.promotion_url,
      sale_price      = EXCLUDED.sale_price,
      original_price  = EXCLUDED.original_price,
      discount_pct    = EXCLUDED.discount_pct,
      currency        = EXCLUDED.currency,
      rating          = EXCLUDED.rating,
      orders_count    = EXCLUDED.orders_count,
      category_id     = EXCLUDED.category_id,
      category_name   = EXCLUDED.category_name,
      shop_id         = EXCLUDED.shop_id,
      shop_name       = EXCLUDED.shop_name,
      sale_tier       = EXCLUDED.sale_tier,
      is_available    = TRUE,
      last_fetched_at = NOW()
  `;
}
