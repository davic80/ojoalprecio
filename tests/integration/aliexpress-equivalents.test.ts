import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import { findAEEquivalent, discoverAndPersistEquivalent } from '../../src/marketplaces/aliexpress/equivalents';
import type { AliExpressClient } from '../../src/marketplaces/aliexpress/client';
import type { AliExpressProduct } from '../../src/marketplaces/aliexpress/types';

function aeStub(id: string, title: string, salePrice: number): AliExpressProduct {
  return {
    productId: id, title,
    imageUrl: null, productUrl: `https://es.aliexpress.com/item/${id}.html`,
    promotionUrl: `https://s.click.aliexpress.com/e/_${id}`,
    salePrice, originalPrice: salePrice * 2, discountPct: 50, currency: 'EUR',
    rating: 95, ordersCount: 100,
    categoryId: null, categoryName: 'Test', shopId: null, shopName: 'Shop',
  };
}
async function insertAmazonProduct(id: number, name: string): Promise<void> {
  await pool.query(`INSERT INTO users (email, password_hash) VALUES ('z@x.local', 'x') ON CONFLICT DO NOTHING`);
  const u = await pool.query(`SELECT id FROM users WHERE email = 'z@x.local'`);
  await pool.query(
    `INSERT INTO products (id, created_by_user_id, asin, url, name, is_active, is_available)
     VALUES ($1, $2, $3, $4, $5, TRUE, TRUE)
     ON CONFLICT (id) DO NOTHING`,
    [id, u.rows[0].id, `B00TEST${String(id).padStart(4, '0')}`, 'https://amazon.es/dp/X', name],
  );
}

describe('findAEEquivalent (pure)', () => {
  beforeEach(resetDb);

  it('picks the highest-scoring candidate, marks eligible when both gates pass', async () => {
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockResolvedValue({
        products: [
          aeStub('1', 'Random keyboard mouse combo',       18),  // low score
          aeStub('2', 'Sonos Era 100 altavoz inalámbrico', 120), // high score, 40% cheaper
          aeStub('3', 'Sonos Era 100 altavoz blanco',      130), // also high but pricier
        ],
        totalCount: 3, pageNo: 1, pageSize: 20,
      }),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    const r = await findAEEquivalent(client, { title: 'Sonos Era 100 Altavoz Inteligente Wifi', price: 200 });
    expect(r.candidate?.productId).toBe('2');
    expect(r.textScore).toBeGreaterThanOrEqual(0.4);
    expect(r.pctCheaper).toBeCloseTo(40, 0);
    expect(r.isEligible).toBe(true);
  });

  it('rejects when text score is too low (cross-marketplace requires ≥0.4)', async () => {
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockResolvedValue({
        // Same brand and product type but otherwise generic — score will end up below 0.4
        products: [aeStub('1', 'Sonos altavoz cualquiera', 80)],
        totalCount: 1, pageNo: 1, pageSize: 20,
      }),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    const r = await findAEEquivalent(client, { title: 'Sonos Era 100 Altavoz Inteligente Wifi Bluetooth Pack', price: 200 });
    expect(r.isEligible).toBe(false);  // text similarity too weak
  });

  it('rejects when price difference is below 10%', async () => {
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockResolvedValue({
        products: [aeStub('1', 'Sonos Era 100 altavoz', 195)],  // only 2.5% cheaper than 200
        totalCount: 1, pageNo: 1, pageSize: 20,
      }),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    const r = await findAEEquivalent(client, { title: 'Sonos Era 100 Altavoz', price: 200 });
    expect(r.candidate?.productId).toBe('1');
    expect(r.isEligible).toBe(false);  // pct_cheaper below 10
  });

  it('returns empty negative on API error (no throw)', async () => {
    const { AliExpressError } = await import('../../src/marketplaces/aliexpress/client');
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockRejectedValue(new AliExpressError('rate limit', 'ApiCallLimit')),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    const r = await findAEEquivalent(client, { title: 'X', price: 100 });
    expect(r).toEqual({ candidate: null, textScore: 0, pctCheaper: 0, isEligible: false });
  });
});

describe('discoverAndPersistEquivalent (cache layer)', () => {
  beforeEach(resetDb);

  it('persists the AE candidate row + the cross-marketplace edge on first lookup', async () => {
    await insertAmazonProduct(7777, 'Sonos Era 100 Altavoz Inteligente Wifi');
    const candidate = aeStub('1005000000000001', 'Sonos Era 100 altavoz inalámbrico', 120);
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockResolvedValue({ products: [candidate], totalCount: 1, pageNo: 1, pageSize: 20 }),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    const r = await discoverAndPersistEquivalent(client, 7777, { title: 'Sonos Era 100 Altavoz Inteligente Wifi', price: 200 });
    expect(r?.isEligible).toBe(true);

    const eq = await pool.query(`SELECT ae_product_id, is_eligible, pct_cheaper::float AS p FROM amazon_ae_equivalents WHERE amazon_product_id = 7777`);
    expect(eq.rows[0].ae_product_id).toBe('1005000000000001');
    expect(eq.rows[0].is_eligible).toBe(true);
    expect(eq.rows[0].p).toBeCloseTo(40, 0);

    const ae = await pool.query(`SELECT title FROM aliexpress_products WHERE product_id = '1005000000000001'`);
    expect(ae.rows[0].title).toBe(candidate.title);
  });

  it('hits the cache on the second call within TTL — no extra API call', async () => {
    await insertAmazonProduct(7778, 'Sonos Era 100');
    const candidate = aeStub('1005000000000001', 'Sonos Era 100 altavoz', 120);
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockResolvedValue({ products: [candidate], totalCount: 1, pageNo: 1, pageSize: 20 }),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    await discoverAndPersistEquivalent(client, 7778, { title: 'Sonos Era 100', price: 200 });
    await discoverAndPersistEquivalent(client, 7778, { title: 'Sonos Era 100', price: 200 });
    expect(client.productQuery).toHaveBeenCalledTimes(1);  // second call hit cache
  });

  it('caches the negative — second call after a miss still skips the API', async () => {
    await insertAmazonProduct(7779, 'Some niche product nobody sells on AE');
    const client = {
      productDetail: vi.fn(),
      productQuery: vi.fn().mockResolvedValue({ products: [], totalCount: 0, pageNo: 1, pageSize: 20 }),
      smartMatch: vi.fn(),
    } as unknown as AliExpressClient;

    const r1 = await discoverAndPersistEquivalent(client, 7779, { title: 'Acme Niche Product 9000', price: 50 });
    expect(r1?.candidate).toBeNull();

    const r2 = await discoverAndPersistEquivalent(client, 7779, { title: 'Acme Niche Product 9000', price: 50 });
    expect(r2?.candidate).toBeNull();
    expect(client.productQuery).toHaveBeenCalledTimes(1);  // negative cached
  });
});
