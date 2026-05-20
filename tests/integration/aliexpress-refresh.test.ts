import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import { refreshAEProduct, refreshSimilars, refreshAllAETracks } from '../../src/scheduler/aliexpress';
import type { AliExpressClient } from '../../src/marketplaces/aliexpress/client';
import type { AliExpressProduct } from '../../src/marketplaces/aliexpress/types';

function productStub(id: string, title: string, salePrice: number): AliExpressProduct {
  return {
    productId: id, title,
    imageUrl: null, productUrl: `https://es.aliexpress.com/item/${id}.html`,
    promotionUrl: null,
    salePrice, originalPrice: salePrice * 2, discountPct: 50, currency: 'EUR',
    rating: 95.0, ordersCount: 100,
    categoryId: null, categoryName: 'Test', shopId: null, shopName: 'Shop',
  };
}
async function makeUser(email = 'r@t.local'): Promise<number> {
  const r = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1,'x') RETURNING id`, [email]);
  return r.rows[0].id as number;
}
async function seedProduct(p: AliExpressProduct) {
  await pool.query(
    `INSERT INTO aliexpress_products (product_id, title, product_url, sale_price, currency)
     VALUES ($1, $2, $3, $4, 'EUR')`,
    [p.productId, p.title, p.productUrl, p.salePrice],
  );
}

describe('AE refreshAEProduct', () => {
  beforeEach(resetDb);

  it('upserts the latest snapshot and appends a price history row', async () => {
    const original = productStub('1005000000000001', 'Baofeng BF-88E', 20.0);
    await seedProduct(original);

    const updated = productStub('1005000000000001', 'Baofeng BF-88E', 16.5);
    const client = {
      productDetail: vi.fn().mockResolvedValue(updated),
      productQuery:  vi.fn(),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const res = await refreshAEProduct(client, '1005000000000001');
    expect(res?.salePrice).toBe(16.5);

    const row = await pool.query(`SELECT sale_price::float AS p FROM aliexpress_products WHERE product_id = $1`, ['1005000000000001']);
    expect(row.rows[0].p).toBe(16.5);
    const ph = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_price_history WHERE product_id = $1`, ['1005000000000001']);
    expect(ph.rows[0].n).toBe(1);  // one new tick from this refresh
  });

  it('returns null and writes nothing when productDetail rejects with an AE error', async () => {
    await seedProduct(productStub('1005000000000001', 'X', 10));
    const { AliExpressError } = await import('../../src/marketplaces/aliexpress/client');
    const client = {
      productDetail: vi.fn().mockRejectedValue(new AliExpressError('rate limit', 'ApiCallLimit')),
      productQuery:  vi.fn(), smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    expect(await refreshAEProduct(client, '1005000000000001')).toBeNull();
    const ph = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_price_history WHERE product_id = $1`, ['1005000000000001']);
    expect(ph.rows[0].n).toBe(0);
  });
});

describe('AE refreshSimilars', () => {
  beforeEach(resetDb);

  it('upserts kept candidates and prunes edges not re-seen in 7 days', async () => {
    const master = productStub('1005000000000001', 'Baofeng BF-88E walkie talkie', 16.0);
    const stale  = productStub('1005000000000099', 'Baofeng STALE old listing',    19.0);
    const fresh  = productStub('1005000000000002', 'Baofeng BF-88E walkie new',    18.0);
    await seedProduct(master); await seedProduct(stale); await seedProduct(fresh);

    // Pre-existing stale edge (last seen 30d ago) — must be pruned this cycle.
    await pool.query(`
      INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source, text_score, first_seen_at, last_seen_at)
      VALUES ($1, $2, 'query', 0.5, NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days')
    `, [master.productId, stale.productId]);

    const client = {
      productDetail: vi.fn(),
      productQuery:  vi.fn().mockResolvedValue({ products: [fresh], totalCount: 1, pageNo: 1, pageSize: 30 }),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const n = await refreshSimilars(client, master);
    expect(n).toBe(1);

    const edges = await pool.query(`SELECT similar_product_id FROM aliexpress_similars WHERE master_product_id = $1 ORDER BY similar_product_id`, [master.productId]);
    expect(edges.rows.length).toBe(1);
    expect(edges.rows[0].similar_product_id).toBe(fresh.productId);  // stale pruned, fresh kept
  });
});

describe('AE refreshAllAETracks', () => {
  beforeEach(resetDb);

  it('iterates over all distinct tracked productIds, ignoring per-product failures', async () => {
    const ok    = productStub('1005000000000001', 'OK product', 10);
    const fail  = productStub('1005000000000002', 'Fail product', 20);
    await seedProduct(ok); await seedProduct(fail);
    const u1 = await makeUser('a@x'); const u2 = await makeUser('b@x');
    await pool.query(`INSERT INTO aliexpress_user_tracks (user_id, product_id) VALUES ($1, $2)`, [u1, ok.productId]);
    await pool.query(`INSERT INTO aliexpress_user_tracks (user_id, product_id) VALUES ($1, $2)`, [u2, ok.productId]);  // duplicate → distinct collapses to 1
    await pool.query(`INSERT INTO aliexpress_user_tracks (user_id, product_id) VALUES ($1, $2)`, [u1, fail.productId]);

    const client = {
      productDetail: vi.fn()
        .mockImplementation(async (id: string) => id === ok.productId ? productStub(id, ok.title, 9.5) : null),
      productQuery:  vi.fn().mockResolvedValue({ products: [], totalCount: 0, pageNo: 1, pageSize: 30 }),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const r = await refreshAllAETracks(client);
    expect(r.totalProducts).toBe(2);
    expect(r.refreshed).toBe(1);
    expect(r.failed).toBe(1);
  }, 15_000);  // generous timeout — sequential with sleep(250) between calls
});
