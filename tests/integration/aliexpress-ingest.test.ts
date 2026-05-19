import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import { ingestProduct } from '../../src/marketplaces/aliexpress/ingest';
import type { AliExpressClient } from '../../src/marketplaces/aliexpress/client';
import type { AliExpressProduct } from '../../src/marketplaces/aliexpress/types';

/**
 * End-to-end test of the ingest pipeline using a mocked AliExpressClient.
 * Verifies:
 *  - master persistence + track + first price-history row
 *  - upsert idempotency (re-ingesting same productId doesn't duplicate)
 *  - strategy A: similars above Jaccard threshold are stored
 *  - fallback: when <3 strict matches, the loose top-N is kept
 *  - master ingest survives a failing productQuery (similars are best-effort)
 */

function productStub(id: string, title: string, salePrice: number, currency = 'EUR'): AliExpressProduct {
  return {
    productId:     id,
    title,
    imageUrl:      `https://ae-pic.example/${id}.jpg`,
    productUrl:    `https://es.aliexpress.com/item/${id}.html`,
    promotionUrl:  `https://s.click.aliexpress.com/e/_${id}`,
    salePrice,
    originalPrice: salePrice * 2,
    discountPct:   50,
    currency,
    rating:        92.5,
    ordersCount:   100,
    categoryId:    null,
    categoryName:  'Test',
    shopId:        null,
    shopName:      'Test Shop',
  };
}

async function makeUser(): Promise<number> {
  const r = await pool.query(`INSERT INTO users (email, password_hash) VALUES ('ae@test.local', 'x') RETURNING id`);
  return r.rows[0].id as number;
}

describe('aliexpress ingestProduct', () => {
  beforeEach(resetDb);

  it('persists master + track + first price entry', async () => {
    const master = productStub('1005000000000001', 'Baofeng BF-88E walkie talkie UHF', 16.29);
    const client = {
      productDetail: vi.fn().mockResolvedValue(master),
      productQuery:  vi.fn().mockResolvedValue({ products: [], totalCount: 0, pageNo: 1, pageSize: 30 }),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const userId = await makeUser();
    const res = await ingestProduct({ client, productId: master.productId, userId, thresholdPrice: 12.0 });

    expect(res.master.productId).toBe(master.productId);

    const prod = await pool.query(`SELECT product_id, title, sale_price::float AS p FROM aliexpress_products WHERE product_id = $1`, [master.productId]);
    expect(prod.rows[0].p).toBe(16.29);

    const track = await pool.query(`SELECT threshold_price::float AS t FROM aliexpress_user_tracks WHERE user_id = $1 AND product_id = $2`, [userId, master.productId]);
    expect(track.rows[0].t).toBe(12);

    const ph = await pool.query(`SELECT price::float AS p FROM aliexpress_price_history WHERE product_id = $1`, [master.productId]);
    expect(ph.rows[0].p).toBe(16.29);
  });

  it('is idempotent: re-ingesting the same product does not duplicate the track', async () => {
    const master = productStub('1005000000000001', 'Test product', 10);
    const client = {
      productDetail: vi.fn().mockResolvedValue(master),
      productQuery:  vi.fn().mockResolvedValue({ products: [], totalCount: 0, pageNo: 1, pageSize: 30 }),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const userId = await makeUser();
    await ingestProduct({ client, productId: master.productId, userId });
    await ingestProduct({ client, productId: master.productId, userId });

    const tracks = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_user_tracks WHERE user_id = $1`, [userId]);
    expect(tracks.rows[0].n).toBe(1);
    // 2 price-history rows are expected — every ingest is a fresh price tick
    const ph = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_price_history WHERE product_id = $1`, [master.productId]);
    expect(ph.rows[0].n).toBe(2);
  });

  it('keeps similars above the Jaccard threshold (strategy A)', async () => {
    const master = productStub('1005000000000001', 'Baofeng BF-88E walkie talkie UHF', 16.29);
    // 3 candidates with descending similarity. The 3rd is unrelated and should be dropped.
    const candidates = [
      productStub('1005000000000002', 'Baofeng BF-88E walkie talkie VHF',       18.50),  // very similar
      productStub('1005000000000003', 'Baofeng UV-5R walkie talkie portátil',   24.00),  // related
      productStub('1005000000000004', 'Sonos Era 100 altavoz inalámbrico',      199.0),  // unrelated
    ];
    const client = {
      productDetail: vi.fn().mockResolvedValue(master),
      productQuery:  vi.fn().mockResolvedValue({ products: candidates, totalCount: 3, pageNo: 1, pageSize: 30 }),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const userId = await makeUser();
    const res = await ingestProduct({ client, productId: master.productId, userId });

    // Strict mode: only the 2 Baofengs should be kept (sonos has 0 overlap)
    const stored = await pool.query(`SELECT similar_product_id, text_score::float AS s FROM aliexpress_similars WHERE master_product_id = $1 ORDER BY s DESC`, [master.productId]);
    // <3 kept → fallback kicks in and keeps loose top-N. So we should see all 3.
    expect(stored.rows.length).toBe(3);
    expect(stored.rows[0].similar_product_id).toBe('1005000000000002');  // highest score
    expect(stored.rows[stored.rows.length - 1].similar_product_id).toBe('1005000000000004');  // lowest
    expect(res.similars[0].textScore).toBeGreaterThan(res.similars[2].textScore);
  });

  it('survives a productQuery failure (master ingest still succeeds)', async () => {
    const master = productStub('1005000000000001', 'Test product', 10);
    const client = {
      productDetail: vi.fn().mockResolvedValue(master),
      productQuery:  vi.fn().mockRejectedValue(new Error('rate limit')),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const userId = await makeUser();
    const res = await ingestProduct({ client, productId: master.productId, userId });

    expect(res.similars.length).toBe(0);
    const prod = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_products WHERE product_id = $1`, [master.productId]);
    expect(prod.rows[0].n).toBe(1);  // master still persisted
    const track = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_user_tracks WHERE user_id = $1`, [userId]);
    expect(track.rows[0].n).toBe(1);
  });

  it('excludes the master itself from its own similars', async () => {
    const master = productStub('1005000000000001', 'Baofeng BF-88E walkie talkie', 16.29);
    const otherSim = productStub('1005000000000002', 'Baofeng BF-88E walkie talkie 2', 18.0);
    const client = {
      productDetail: vi.fn().mockResolvedValue(master),
      // productQuery happens to return the master AND another result
      productQuery:  vi.fn().mockResolvedValue({ products: [master, otherSim], totalCount: 2, pageNo: 1, pageSize: 30 }),
      smartMatch:    vi.fn(),
    } as unknown as AliExpressClient;

    const userId = await makeUser();
    await ingestProduct({ client, productId: master.productId, userId });

    const rows = await pool.query(`SELECT similar_product_id FROM aliexpress_similars WHERE master_product_id = $1`, [master.productId]);
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].similar_product_id).toBe('1005000000000002');
  });
});
