import { describe, it, expect, beforeEach } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';
import { assignGroup, backfillProductGroups } from '../../src/scheduler/groups';

async function addProduct(asin: string, variants?: Array<{ asin: string; label: string; dim?: string }>) {
  await pool.query(
    `INSERT INTO products (asin, url, variants_json) VALUES ($1, $2, $3)`,
    [asin, `https://www.amazon.es/dp/${asin}`, variants ? JSON.stringify(variants) : null],
  );
}
const groupOf = async (asin: string) =>
  (await pool.query(`SELECT group_id, variant_label, variant_dim FROM products WHERE asin = $1`, [asin])).rows[0];

describe('variant groups (Postgres)', () => {
  beforeEach(resetDb);

  it('assignGroup puts a product and its siblings in one group and labels the siblings', async () => {
    await addProduct('B0AAAAAAA1'); await addProduct('B0AAAAAAA2'); await addProduct('B0AAAAAAA3');
    await assignGroup('B0AAAAAAA1', 'B0PARENT01', [
      { asin: 'B0AAAAAAA2', label: '42', dim: 'size_name' },
      { asin: 'B0AAAAAAA3', label: '43 /* .a{} */', dim: 'size_name' },
    ]);
    const [a, b, c] = [await groupOf('B0AAAAAAA1'), await groupOf('B0AAAAAAA2'), await groupOf('B0AAAAAAA3')];
    expect(a.group_id).not.toBeNull();
    expect(b.group_id).toBe(a.group_id);
    expect(c.group_id).toBe(a.group_id);
    expect(b).toMatchObject({ variant_label: '42', variant_dim: 'size_name' });
    expect(c.variant_label).toBe('43');
    const g = await pool.query(`SELECT key FROM product_groups`);
    expect(g.rows).toEqual([{ key: 'B0PARENT01' }]);
  });

  it('is idempotent', async () => {
    await addProduct('B0AAAAAAA1'); await addProduct('B0AAAAAAA2');
    const v = [{ asin: 'B0AAAAAAA2', label: '42', dim: 'size_name' }];
    await assignGroup('B0AAAAAAA1', null, v);
    await assignGroup('B0AAAAAAA1', null, v);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM product_groups`)).rows[0].n).toBe(1);
  });

  it('merges two groups that turn out to be the same family and adopts the parent ASIN as key', async () => {
    for (const a of ['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3', 'B0AAAAAAA4']) await addProduct(a);
    await assignGroup('B0AAAAAAA1', null, [{ asin: 'B0AAAAAAA2', label: 'a' }]);
    await assignGroup('B0AAAAAAA3', null, [{ asin: 'B0AAAAAAA4', label: 'b' }]);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM product_groups`)).rows[0].n).toBe(2);
    // a scrape that sees both pairs as one family
    await assignGroup('B0AAAAAAA2', 'B0PARENT09', [{ asin: 'B0AAAAAAA1', label: 'a' }, { asin: 'B0AAAAAAA3', label: 'c' }]);
    const ids = new Set(await Promise.all(['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3', 'B0AAAAAAA4'].map(async a => (await groupOf(a)).group_id)));
    expect(ids.size).toBe(1);
    const g = await pool.query(`SELECT key FROM product_groups`);
    expect(g.rows).toEqual([{ key: 'B0PARENT09' }]);
  });

  it('ignores untagged "related products" when the twister rows are tagged', async () => {
    await addProduct('B0AAAAAAA1'); await addProduct('B0AAAAAAA2'); await addProduct('B0RELATED1');
    await assignGroup('B0AAAAAAA1', null, [{ asin: 'B0AAAAAAA2', label: '42', dim: 'size_name' }, { asin: 'B0RELATED1', label: 'otro' }]);
    expect((await groupOf('B0RELATED1')).group_id).toBeNull();
  });

  it('backfill builds groups from stored variants_json and labels every member, including the seed', async () => {
    await addProduct('B0AAAAAAA1', [{ asin: 'B0AAAAAAA2', label: '42' }, { asin: 'B0AAAAAAA3', label: '43' }]);
    await addProduct('B0AAAAAAA2', [{ asin: 'B0AAAAAAA1', label: '41' }, { asin: 'B0AAAAAAA3', label: '43' }]);
    await addProduct('B0AAAAAAA3', [{ asin: 'B0AAAAAAA1', label: '41' }, { asin: 'B0AAAAAAA2', label: '42' }]);
    await addProduct('B0LONELY01');                       // no variants → stays standalone
    await backfillProductGroups();
    const rows = await Promise.all(['B0AAAAAAA1', 'B0AAAAAAA2', 'B0AAAAAAA3'].map(groupOf));
    expect(new Set(rows.map(r => r.group_id)).size).toBe(1);
    expect(rows.map(r => r.variant_label)).toEqual(['41', '42', '43']);
    expect((await groupOf('B0LONELY01')).group_id).toBeNull();
  });

  it('refuses a merge that would glue two huge families together', async () => {
    const mkFamily = async (prefix: string, n: number) => {
      const asins = Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
      for (const a of asins) await addProduct(a);
      await assignGroup(asins[0], null, asins.slice(1).map(a => ({ asin: a, label: a })));
      return asins;
    };
    const a = await mkFamily('B0FAMA', 80);
    const b = await mkFamily('B0FAMB', 80);
    expect((await pool.query(`SELECT COUNT(*)::int n FROM product_groups`)).rows[0].n).toBe(2);
    await assignGroup(a[0], null, [{ asin: b[0], label: 'stray' }]);     // a stray link between the families
    expect((await pool.query(`SELECT COUNT(*)::int n FROM product_groups`)).rows[0].n).toBe(2);
    expect((await groupOf(a[0])).group_id).not.toBe((await groupOf(b[0])).group_id);
  });

  it('stores composed names for sizes ("Negro · 43"), plain colour names, and the page\'s own full option', async () => {
    await addProduct('B0AAAAAAA1'); await addProduct('B0AAAAAAA2'); await addProduct('B0AAAAAAA3');
    await assignGroup('B0AAAAAAA1', null, [
      { asin: 'B0AAAAAAA1', label: 'Negro', dim: 'color_name', self: true } as any,
      { asin: 'B0AAAAAAA1', label: '42', dim: 'size_name', self: true } as any,
      { asin: 'B0AAAAAAA2', label: '43', dim: 'size_name' },
      { asin: 'B0AAAAAAA3', label: 'Rojo', dim: 'color_name' },
    ]);
    expect((await groupOf('B0AAAAAAA1')).variant_label).toBe('Negro · 42');
    expect((await groupOf('B0AAAAAAA2')).variant_label).toBe('Negro · 43');
    expect((await groupOf('B0AAAAAAA3')).variant_label).toBe('Rojo');
  });

  it('a sibling-derived label never overwrites what the product reported about itself', async () => {
    await addProduct('B0AAAAAAA1'); await addProduct('B0AAAAAAA2');
    await assignGroup('B0AAAAAAA2', null, [
      { asin: 'B0AAAAAAA2', label: 'Rojo', dim: 'color_name', self: true } as any,
      { asin: 'B0AAAAAAA2', label: '43', dim: 'size_name', self: true } as any,
      { asin: 'B0AAAAAAA1', label: 'Negro', dim: 'color_name' },
    ]);
    expect((await groupOf('B0AAAAAAA2')).variant_label).toBe('Rojo · 43');   // own, authoritative
    await assignGroup('B0AAAAAAA1', null, [
      { asin: 'B0AAAAAAA1', label: 'Negro', dim: 'color_name', self: true } as any,
      { asin: 'B0AAAAAAA1', label: '42', dim: 'size_name', self: true } as any,
      { asin: 'B0AAAAAAA2', label: 'Verde', dim: 'color_name' },               // wrong-ish hint about the other product
    ]);
    expect((await groupOf('B0AAAAAAA1')).variant_label).toBe('Negro · 42');
    expect((await groupOf('B0AAAAAAA2')).variant_label).toBe('Rojo · 43');   // untouched
  });
});
