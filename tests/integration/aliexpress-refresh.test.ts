import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import { refreshAEProduct, refreshSimilars, refreshAllAETracks, processAEPriceAlerts } from '../../src/scheduler/aliexpress';
import type { AliExpressClient } from '../../src/marketplaces/aliexpress/client';
import type { AliExpressProduct } from '../../src/marketplaces/aliexpress/types';

// Stub out the alert senders globally so processAEPriceAlerts tests can run
// without SMTP / Telegram setup. We assert on send-count via the mocks.
vi.mock('../../src/mailer',          () => ({ sendPriceAlert: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/mailer/telegram', () => ({ sendTelegramAlert: vi.fn().mockResolvedValue(undefined) }));
const { sendPriceAlert }    = await import('../../src/mailer');
const { sendTelegramAlert } = await import('../../src/mailer/telegram');

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

describe('AE processAEPriceAlerts', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(sendPriceAlert).mockClear();
    vi.mocked(sendTelegramAlert).mockClear();
  });

  async function setupTrack(threshold: number, opts: { withTg?: boolean } = {}) {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, telegram_chat_id) VALUES ('a@x.local', 'x', $1) RETURNING id`,
      [opts.withTg ? '123456' : null],
    );
    const userId = u.rows[0].id as number;
    await seedProduct(productStub('1005000000000001', 'Baofeng walkie', 20.0));
    await pool.query(
      `INSERT INTO aliexpress_user_tracks (user_id, product_id, threshold_price, alert_enabled)
       VALUES ($1, '1005000000000001', $2, TRUE)`,
      [userId, threshold],
    );
    return userId;
  }

  it('fires both email and Telegram when price <= threshold and not yet notified', async () => {
    const userId = await setupTrack(18.0, { withTg: true });
    const sent = await processAEPriceAlerts('1005000000000001', 16.5);
    expect(sent).toBe(1);
    expect(sendPriceAlert).toHaveBeenCalledTimes(1);
    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);

    const notif = await pool.query(`SELECT notified_at FROM aliexpress_user_tracks WHERE user_id = $1`, [userId]);
    expect(notif.rows[0].notified_at).not.toBeNull();
  });

  it('is idempotent — re-running with same price does not re-notify', async () => {
    await setupTrack(18.0);
    await processAEPriceAlerts('1005000000000001', 16.5);
    vi.mocked(sendPriceAlert).mockClear();
    const sent = await processAEPriceAlerts('1005000000000001', 16.5);
    expect(sent).toBe(0);
    expect(sendPriceAlert).not.toHaveBeenCalled();
  });

  it('does not notify when price > threshold', async () => {
    await setupTrack(15.0);
    const sent = await processAEPriceAlerts('1005000000000001', 19.99);
    expect(sent).toBe(0);
    expect(sendPriceAlert).not.toHaveBeenCalled();
  });

  it('re-arms (clears notified_at) once price climbs back ≥ threshold × 1.05', async () => {
    const userId = await setupTrack(20.0);
    // First dip fires + sets notified_at
    await processAEPriceAlerts('1005000000000001', 18.0);
    // Tiny rebound — still under the 1.05 buffer (20 × 1.05 = 21) — stays armed
    vi.mocked(sendPriceAlert).mockClear();
    await processAEPriceAlerts('1005000000000001', 20.5);
    let n = await pool.query(`SELECT notified_at FROM aliexpress_user_tracks WHERE user_id = $1`, [userId]);
    expect(n.rows[0].notified_at).not.toBeNull();  // still deduped
    // Real rebound above the buffer → reset
    await processAEPriceAlerts('1005000000000001', 22.0);
    n = await pool.query(`SELECT notified_at FROM aliexpress_user_tracks WHERE user_id = $1`, [userId]);
    expect(n.rows[0].notified_at).toBeNull();
    // And the NEXT dip alerts again
    const sent = await processAEPriceAlerts('1005000000000001', 17.0);
    expect(sent).toBe(1);
  });

  it('skips tracks where alert_enabled = FALSE', async () => {
    const u = await pool.query(`INSERT INTO users (email, password_hash) VALUES ('b@x', 'x') RETURNING id`);
    await seedProduct(productStub('1005000000000001', 'Baofeng', 20));
    await pool.query(
      `INSERT INTO aliexpress_user_tracks (user_id, product_id, threshold_price, alert_enabled)
       VALUES ($1, '1005000000000001', 18, FALSE)`,
      [u.rows[0].id],
    );
    const sent = await processAEPriceAlerts('1005000000000001', 10);
    expect(sent).toBe(0);
  });

  it('skips tracks with threshold_price IS NULL', async () => {
    const u = await pool.query(`INSERT INTO users (email, password_hash) VALUES ('c@x', 'x') RETURNING id`);
    await seedProduct(productStub('1005000000000001', 'Baofeng', 20));
    await pool.query(
      `INSERT INTO aliexpress_user_tracks (user_id, product_id, threshold_price, alert_enabled)
       VALUES ($1, '1005000000000001', NULL, TRUE)`,
      [u.rows[0].id],
    );
    const sent = await processAEPriceAlerts('1005000000000001', 5);
    expect(sent).toBe(0);
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
