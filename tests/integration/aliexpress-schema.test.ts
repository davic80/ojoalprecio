import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';

/**
 * Smoke-level integration test for the AliExpress migration (41). The
 * cardinal worries:
 *   - FK directions are sound (CASCADE chain from users → tracks, from
 *     products → similars and price_history).
 *   - The CHECK constraints actually bite.
 *   - Composite PKs hold up under realistic inserts.
 */

async function insertUser(email = 'a@b.test'): Promise<number> {
  const r = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [email]);
  return r.rows[0].id as number;
}
async function insertAEProduct(id: string, extra: Record<string, unknown> = {}) {
  const cols = ['product_id', 'title', 'product_url'];
  const vals = [id, extra.title ?? 'Test', extra.product_url ?? `https://es.aliexpress.com/item/${id}.html`];
  for (const [k, v] of Object.entries(extra)) {
    if (cols.includes(k)) continue;
    cols.push(k); vals.push(v as any);
  }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await pool.query(`INSERT INTO aliexpress_products (${cols.join(',')}) VALUES (${ph})`, vals);
}

describe('aliexpress schema (migration 41)', () => {
  beforeEach(resetDb);

  it('persists a product, a user track, and a price-history row', async () => {
    const userId = await insertUser();
    await insertAEProduct('1005006789012345', { sale_price: 29.99, currency: 'EUR' });

    await pool.query(
      `INSERT INTO aliexpress_user_tracks (user_id, product_id, threshold_price) VALUES ($1, $2, $3)`,
      [userId, '1005006789012345', 25.00],
    );
    await pool.query(
      `INSERT INTO aliexpress_price_history (product_id, price, currency) VALUES ($1, $2, 'EUR')`,
      ['1005006789012345', 29.99],
    );

    const track = await pool.query(
      `SELECT threshold_price::float AS t FROM aliexpress_user_tracks WHERE user_id = $1 AND product_id = $2`,
      [userId, '1005006789012345'],
    );
    expect(track.rows[0].t).toBe(25);

    const ph = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_price_history WHERE product_id = $1`, ['1005006789012345']);
    expect(ph.rows[0].n).toBe(1);
  });

  it('CASCADE deletes tracks + history when a product is removed', async () => {
    const userId = await insertUser();
    await insertAEProduct('1005006789012345');
    await pool.query(`INSERT INTO aliexpress_user_tracks (user_id, product_id) VALUES ($1, $2)`, [userId, '1005006789012345']);
    await pool.query(`INSERT INTO aliexpress_price_history (product_id, price) VALUES ($1, 10)`, ['1005006789012345']);

    await pool.query(`DELETE FROM aliexpress_products WHERE product_id = $1`, ['1005006789012345']);

    const t = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_user_tracks WHERE product_id = $1`, ['1005006789012345']);
    const p = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_price_history WHERE product_id = $1`, ['1005006789012345']);
    expect(t.rows[0].n).toBe(0);
    expect(p.rows[0].n).toBe(0);
  });

  it('similars CHECK constraints reject self-loops and unknown sources', async () => {
    await insertAEProduct('1005000000000001');
    await insertAEProduct('1005000000000002');

    // Self-loop forbidden
    await expect(pool.query(
      `INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source) VALUES ($1, $1, 'query')`,
      ['1005000000000001'],
    )).rejects.toThrow(/check constraint/i);

    // Unknown source forbidden
    await expect(pool.query(
      `INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source) VALUES ($1, $2, 'random')`,
      ['1005000000000001', '1005000000000002'],
    )).rejects.toThrow(/check constraint/i);

    // Valid insert goes through
    await pool.query(
      `INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source, text_score) VALUES ($1, $2, 'smartmatch', 0.85)`,
      ['1005000000000001', '1005000000000002'],
    );
    const r = await pool.query(`SELECT COUNT(*)::int AS n FROM aliexpress_similars`);
    expect(r.rows[0].n).toBe(1);
  });

  it('similars composite PK prevents duplicate edges from the same source', async () => {
    await insertAEProduct('1005000000000001');
    await insertAEProduct('1005000000000002');

    await pool.query(
      `INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source) VALUES ($1, $2, 'query')`,
      ['1005000000000001', '1005000000000002'],
    );
    await expect(pool.query(
      `INSERT INTO aliexpress_similars (master_product_id, similar_product_id, source) VALUES ($1, $2, 'smartmatch')`,
      ['1005000000000001', '1005000000000002'],
    )).rejects.toThrow(/duplicate key/i);
  });
});
