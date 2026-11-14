// DB side of variant groups (see lib/groups.ts and the product_groups migration).
import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { planGroups, chooseGroupKey, groupableVariants, variantLabels, MAX_GROUP_SIZE, ownLabel, type RawVariant, type VariantLabel } from '../lib/groups';

/**
 * `authoritative` = the product's own page named itself (always wins). Otherwise the name comes from a
 * sibling's list and only fills an empty label: it must never overwrite what the product itself reported.
 */
async function applyLabels(rows: VariantLabel[], authoritative = false): Promise<void> {
  if (!rows.length) return;
  const values = sql.join(rows.map(r => sql`(${r.asin}::text, ${r.label}::text, ${r.dim}::text)`), sql`, `);
  await db.execute(sql`
    UPDATE products p SET variant_label = v.label, variant_dim = v.dim
    FROM (VALUES ${values}) AS v(asin, label, dim)
    WHERE p.asin = v.asin AND (p.variant_label IS DISTINCT FROM v.label OR p.variant_dim IS DISTINCT FROM v.dim)
      ${authoritative ? sql`` : sql`AND p.variant_label IS NULL`}
  `);
}

/**
 * Put a product and the siblings listed by its twister into one group (creating, reusing or merging
 * groups as needed) and store the option label of each sibling. Idempotent.
 */
export async function assignGroup(asin: string, parentAsin: string | null, variants: RawVariant[]): Promise<void> {
  const siblings = groupableVariants(variants, asin);
  if (!siblings.length) return;
  const asins = [asin, ...siblings.map(v => v.asin)];
  const list = sql.join(asins.map(a => sql`${a}`), sql`, `);

  const known = await db.execute(sql`SELECT DISTINCT group_id FROM products WHERE asin IN (${list}) AND group_id IS NOT NULL`);
  const ids: number[] = (known.rows as any[]).map(r => Number(r.group_id));
  if (parentAsin) {
    const byKey = await db.execute(sql`SELECT id FROM product_groups WHERE key = ${parentAsin} LIMIT 1`);
    if (byKey.rows[0]) ids.push(Number((byKey.rows[0] as any).id));
  }
  const plan = planGroups(ids);
  let target = plan.target;
  if (target === null) {
    const key = chooseGroupKey(asin, parentAsin);
    const r = await db.execute(sql`
      INSERT INTO product_groups (key) VALUES (${key})
      ON CONFLICT (key) DO UPDATE SET key = EXCLUDED.key RETURNING id`);
    target = Number((r.rows[0] as any).id);
  } else if (plan.merge.length) {
    const merge = sql.join(plan.merge.map(i => sql`${i}`), sql`, `);
    const size = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM products WHERE group_id = ${target} OR group_id IN (${merge}) OR asin IN (${list})`);
    if (Number((size.rows[0] as any).n) > MAX_GROUP_SIZE) {
      console.warn(`[groups] merge of ${plan.merge.length + 1} groups around ${asin} skipped: would exceed ${MAX_GROUP_SIZE} members`);
      return;
    }
    await db.execute(sql`UPDATE products SET group_id = ${target} WHERE group_id IN (${merge})`);
    await db.execute(sql`DELETE FROM product_groups WHERE id IN (${merge})`);
  }
  // Once Amazon's parent ASIN is known it becomes the group's key (if nobody else holds it).
  if (parentAsin) {
    await db.execute(sql`
      UPDATE product_groups g SET key = ${parentAsin}
      WHERE g.id = ${target} AND g.key <> ${parentAsin}
        AND NOT EXISTS (SELECT 1 FROM product_groups o WHERE o.key = ${parentAsin})`);
  }
  await db.execute(sql`UPDATE products SET group_id = ${target} WHERE asin IN (${list}) AND group_id IS DISTINCT FROM ${target}`);
  // Full option names ("Negro · 42"), composed with this page's selected option in the other rows.
  await applyLabels(variantLabels(siblings, variants.filter(v => v.self && v.asin === asin)));
  const own = ownLabel(variants, asin);
  if (own) await applyLabels([{ asin, label: own.label, dim: own.dim }], true);
}

let _backfilled = false;

/**
 * One-off (idempotent) build of the groups for what is already in the catalog, from the sibling lists
 * stored in products.variants_json. Then fills the option label of every member from its siblings' lists
 * (a product never lists itself, so its own label can only come from the others).
 */
export async function backfillProductGroups(): Promise<{ grouped: number }> {
  if (_backfilled) return { grouped: 0 };
  _backfilled = true;
  const rows = await db.execute(sql`
    SELECT asin, variants_json FROM products
    WHERE variants_json IS NOT NULL AND left(variants_json, 1) = '[' AND group_id IS NULL
    ORDER BY id`);
  let grouped = 0;
  for (const r of rows.rows as any[]) {
    try {
      const vs = JSON.parse(String(r.variants_json)) as RawVariant[];
      await assignGroup(String(r.asin), null, vs);
      grouped++;
    } catch (err) {
      console.warn(`[groups] backfill skipped ${r.asin}:`, err instanceof Error ? err.message : err);
    }
  }
  // Labels of members that no one has labelled yet.
  const src = await db.execute(sql`
    SELECT DISTINCT ON (e->>'asin') e->>'asin' AS asin, e->>'label' AS label, e->>'dim' AS dim
    FROM products o, jsonb_array_elements(o.variants_json::jsonb) e
    WHERE o.variants_json IS NOT NULL AND left(o.variants_json, 1) = '[' AND o.group_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM products m WHERE m.asin = e->>'asin' AND m.group_id IS NOT NULL AND m.variant_label IS NULL)`);
  const labels = variantLabels((src.rows as any[]).map(r => ({ asin: r.asin, label: r.label ?? '', dim: r.dim ?? undefined })));
  for (let i = 0; i < labels.length; i += 200) await applyLabels(labels.slice(i, i + 200));
  console.log(`[groups] backfill: ${grouped} productos agrupados, ${labels.length} etiquetas de opción rellenadas.`);
  return { grouped };
}
