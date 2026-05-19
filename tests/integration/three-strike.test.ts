import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import { ProductUnavailableError } from '../../src/scraper/amazon';

// Stub every side effect the scheduler can fan out to. We're only here to
// observe DB transitions caused by the 3-strike branching.
vi.mock('../../src/scraper/amazon', async (orig) => {
  const actual = await orig<typeof import('../../src/scraper/amazon')>();
  return {
    ...actual,
    scrapeProduct: vi.fn(),
    affiliateUrl: (url: string) => url,
  };
});
vi.mock('../../src/mailer',          () => ({ sendPriceAlert: vi.fn(), sendBackInStockAlert: vi.fn() }));
vi.mock('../../src/mailer/telegram', () => ({ sendTelegramAlert: vi.fn(), sendTelegramBackInStock: vi.fn() }));
vi.mock('../../src/lib/product-events', () => ({ emitScrapeUpdate: vi.fn() }));

const { scrapeProduct } = await import('../../src/scraper/amazon');
const { checkProduct }  = await import('../../src/scheduler');

async function insertProduct(): Promise<number> {
  const u = await pool.query(
    `INSERT INTO users (email, password_hash) VALUES ('test@example.com', 'x') RETURNING id`,
  );
  const userId = u.rows[0].id as number;
  const p = await pool.query(
    `INSERT INTO products (created_by_user_id, asin, url, name, is_active, is_available, consecutive_unavailable)
     VALUES ($1, 'B000TEST01', 'https://amazon.es/dp/B000TEST01', 'Test product', TRUE, TRUE, 0)
     RETURNING id`,
    [userId],
  );
  const productId = p.rows[0].id as number;
  // Real follower so the orphan-purge path doesn't delete the product on the
  // strike that flips it unavailable — we want to observe is_available state,
  // not a tombstone.
  await pool.query(
    `INSERT INTO user_products (user_id, product_id) VALUES ($1, $2)`,
    [userId, productId],
  );
  return productId;
}

async function readProduct(id: number) {
  const r = await pool.query(
    `SELECT is_available, consecutive_unavailable, last_error FROM products WHERE id = $1`,
    [id],
  );
  return r.rows[0] as { is_available: boolean; consecutive_unavailable: number; last_error: string | null };
}

async function countPendingAnomalies(productId: number): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM scrape_anomalies WHERE product_id = $1 AND status = 'pending'`,
    [productId],
  );
  return r.rows[0].n as number;
}

describe('3-strike rule for unqualified buybox', () => {
  beforeEach(async () => {
    await resetDb();
    vi.mocked(scrapeProduct).mockReset();
  });

  it('keeps product available on strikes 1 and 2, marks unavailable on strike 3', async () => {
    const id = await insertProduct();
    vi.mocked(scrapeProduct).mockRejectedValue(
      new ProductUnavailableError('unqualified buybox', 'unqualified', '<snippet/>'),
    );

    // Strike 1
    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test #1');
    let p = await readProduct(id);
    expect(p.is_available).toBe(true);
    expect(p.consecutive_unavailable).toBe(1);
    expect(p.last_error).toMatch(/1\/3/);
    expect(await countPendingAnomalies(id)).toBe(0);

    // Strike 2
    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test #2');
    p = await readProduct(id);
    expect(p.is_available).toBe(true);
    expect(p.consecutive_unavailable).toBe(2);
    expect(p.last_error).toMatch(/2\/3/);
    expect(await countPendingAnomalies(id)).toBe(0);

    // Strike 3 — now it should flip
    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test #3');
    p = await readProduct(id);
    expect(p.is_available).toBe(false);
    expect(p.consecutive_unavailable).toBe(3);
    expect(await countPendingAnomalies(id)).toBe(1);
  });

  it('marks unavailable immediately when reason is not "unqualified" (e.g. used)', async () => {
    const id = await insertProduct();
    vi.mocked(scrapeProduct).mockRejectedValue(
      new ProductUnavailableError('used buybox', 'used'),
    );

    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test used');
    const p = await readProduct(id);
    expect(p.is_available).toBe(false);
    expect(p.consecutive_unavailable).toBe(1);
    expect(await countPendingAnomalies(id)).toBe(1);
  });

  it('resets the counter when a successful scrape lands', async () => {
    const id = await insertProduct();
    // Two strikes
    vi.mocked(scrapeProduct).mockRejectedValue(
      new ProductUnavailableError('unqualified buybox', 'unqualified', null),
    );
    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test #1');
    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test #2');
    expect((await readProduct(id)).consecutive_unavailable).toBe(2);

    // Then a successful scrape
    vi.mocked(scrapeProduct).mockReset();
    vi.mocked(scrapeProduct).mockResolvedValue({
      asin: 'B000TEST01',
      name: 'Test product',
      price: 99.99,
      currency: 'EUR',
      imageUrl: 'https://example.com/p.jpg',
      extraImages: [],
      url: 'https://amazon.es/dp/B000TEST01',
      wasPrice: null,
      variants: [],
    });
    await checkProduct(id, 'https://amazon.es/dp/B000TEST01', 'Test ok');

    const p = await readProduct(id);
    expect(p.is_available).toBe(true);
    expect(p.consecutive_unavailable).toBe(0);
  });
});
