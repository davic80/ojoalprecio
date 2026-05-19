#!/usr/bin/env tsx
/**
 * Smoke test for the AliExpress Affiliate API wiring.
 *
 * Reads ALIEXPRESS_APP_KEY / _APP_SECRET / _TRACKING_ID from your `.env`
 * (so the keys never touch the repo) and exercises productDetail() +
 * productQuery() against the live API with a productId of your choice.
 *
 * Usage:
 *   npx tsx scripts/aliexpress-smoke.ts <productId>
 *   npx tsx scripts/aliexpress-smoke.ts 1005006789012345
 *   npx tsx scripts/aliexpress-smoke.ts "https://es.aliexpress.com/item/1005006789012345.html"
 *
 * If the call fails, the TOP error code/message is printed verbatim so we
 * can debug signing, permissions or wire-format mismatches.
 */
import 'dotenv/config';
import { AliExpressClient, AliExpressError, AliExpressPermissionError } from '../src/marketplaces/aliexpress/client';
import { parseProductId } from '../src/marketplaces/aliexpress/url';

async function main() {
  const raw = process.argv[2];
  if (!raw) {
    console.error('Usage: tsx scripts/aliexpress-smoke.ts <productId | aliexpress URL>');
    process.exit(2);
  }
  const productId = parseProductId(raw);
  if (!productId) {
    console.error(`Could not extract a productId from "${raw}"`);
    process.exit(2);
  }

  const { ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET, ALIEXPRESS_TRACKING_ID } = process.env;
  if (!ALIEXPRESS_APP_KEY || !ALIEXPRESS_APP_SECRET || !ALIEXPRESS_TRACKING_ID) {
    console.error('Set ALIEXPRESS_APP_KEY, ALIEXPRESS_APP_SECRET and ALIEXPRESS_TRACKING_ID in .env first.');
    process.exit(2);
  }

  const client = new AliExpressClient({
    appKey:     ALIEXPRESS_APP_KEY,
    appSecret:  ALIEXPRESS_APP_SECRET,
    trackingId: ALIEXPRESS_TRACKING_ID,
  });

  console.log(`→ productDetail(${productId})\n`);
  try {
    const p = await client.productDetail(productId);
    if (!p) { console.log('(no product returned)'); }
    else {
      console.log({
        productId:   p.productId,
        title:       p.title.slice(0, 100) + (p.title.length > 100 ? '…' : ''),
        salePrice:   p.salePrice,
        currency:    p.currency,
        originalPrice: p.originalPrice,
        discountPct: p.discountPct,
        rating:      p.rating,
        ordersCount: p.ordersCount,
        category:    p.categoryName,
        shop:        p.shopName,
        imageUrl:    p.imageUrl?.slice(0, 80) + (p.imageUrl && p.imageUrl.length > 80 ? '…' : ''),
        promotionUrl: p.promotionUrl?.slice(0, 80) + (p.promotionUrl && p.promotionUrl.length > 80 ? '…' : ''),
      });
    }
  } catch (e) {
    if (e instanceof AliExpressPermissionError) {
      console.error('PERMISSION DENIED for productDetail (shouldn\'t happen — it\'s default-perm):', e.raw);
    } else if (e instanceof AliExpressError) {
      console.error('API error:', e.message, '\nraw:', e.raw);
    } else throw e;
    process.exit(1);
  }

  // Sanity: keyword search by the product title (first 6 words) to confirm
  // productQuery wiring + signing both work.
  const queryRes = await client.productDetail(productId);
  const keywords = (queryRes?.title ?? '').split(/\s+/).slice(0, 6).join(' ');
  if (keywords) {
    console.log(`\n→ productQuery(keywords="${keywords}")\n`);
    try {
      const r = await client.productQuery({ keywords, pageSize: 5 });
      console.log(`  ${r.products.length} of ${r.totalCount} results, page ${r.pageNo}`);
      for (const p of r.products) {
        console.log(`  • ${p.productId}  ${p.salePrice} ${p.currency}  ${p.title.slice(0, 60)}…`);
      }
    } catch (e) {
      if (e instanceof AliExpressError) console.error('productQuery error:', e.message, e.raw);
      else throw e;
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
