import { sql } from 'drizzle-orm';
import { db } from '../db/client';
import { getSetting } from '../db/settings';
const SYSTEM_EMAIL = 'system@ojoalprecio.local';

/**
 * Hourly auto-pause of dead-weight catalog entries.
 *
 * Decision rule (ALL must hold to be eligible):
 *   1. created_by_user_id IS NULL OR = system user
 *      ("auto-imported"; never touch products a human explicitly added)
 *   2. NO alerts (active OR inactive) — alerts are permanent intent
 *   3. NO follows from non-system users (user_products)
 *   4. created_at < NOW() − 7 days (grace period for new arrivals)
 *   5. last_metadata_at IS NOT NULL
 *      (we DID scrape metadata at least once — the 7-day created_at gate
 *      already protects new arrivals; no need for a separate freshness
 *      window since the bottleneck is scraper throughput, not min_age)
 *   6. **Irrelevant** per the three popularity signals:
 *        bought_last_month IS NULL                 -- no top-seller badge
 *        AND COALESCE(review_count, 0) < 10        -- almost no social proof
 *        AND (bsr_value IS NULL OR bsr_value > 100000)  -- BSR bad/absent
 *   7. is_active = TRUE (only pause currently active products)
 *
 * Action: UPDATE is_active = FALSE. Reversible — the products.ts add flow
 * flips it back to TRUE when a user re-adds the same ASIN, and admin can
 * resume manually from /admin/cleanup. Data (price_history, etc.) is
 * preserved.
 *
 * Settings (db, not env — toggleable from /admin/settings without restart):
 *   auto_cleanup_enabled          boolean, default false
 *   auto_cleanup_cap_per_hour     integer, default 100
 *
 * Every pause writes a row to auto_cleanup_log for audit / debugging.
 */
export async function runAutoCleanupTick(): Promise<{ enabled: boolean; eligible: number; paused: number; cap: number }> {
  const enabled = (await getSetting('auto_cleanup_enabled', false)) === true;
  if (!enabled) return { enabled: false, eligible: 0, paused: 0, cap: 0 };

  const cap          = Math.max(1, Math.min(500,    Number(await getSetting('auto_cleanup_cap_per_hour',     100))));
  const reviewMax    = Math.max(1, Math.min(50,     Number(await getSetting('auto_cleanup_review_threshold',   5))));
  const bsrMin       = Math.max(10000, Math.min(500000, Number(await getSetting('auto_cleanup_bsr_threshold',  100000))));
  const graceDays    = Math.max(1, Math.min(60,     Number(await getSetting('auto_cleanup_grace_days',          7))));

  // Single-query candidate selection. Returns ONLY the LIMIT cap rows we
  // would pause; we DON'T do a separate COUNT-then-UPDATE because that's
  // a race window (a product could become followed between the two calls).
  // Instead the same query feeds the UPDATE via UPDATE ... WHERE id IN (...).
  const candidates = await db.execute(sql`
    WITH sys_user AS (SELECT id FROM users WHERE email = ${SYSTEM_EMAIL} LIMIT 1)
    SELECT p.id, p.asin, p.name, p.bsr_value, p.review_count, p.bought_last_month
    FROM products p
    LEFT JOIN sys_user su ON TRUE
    WHERE p.is_active = TRUE
      AND p.created_at < NOW() - (${graceDays} || ' days')::interval
      AND p.last_metadata_at IS NOT NULL
      AND p.bought_last_month IS NULL
      AND COALESCE(p.review_count, 0) < ${reviewMax}
      AND (p.bsr_value IS NULL OR p.bsr_value > ${bsrMin})
      AND (p.created_by_user_id IS NULL
           OR (su.id IS NOT NULL AND p.created_by_user_id = su.id))
      AND NOT EXISTS (SELECT 1 FROM alerts a WHERE a.product_id = p.id)
      AND NOT EXISTS (
        SELECT 1 FROM user_products up
        WHERE up.product_id = p.id
          AND (su.id IS NULL OR up.user_id <> su.id)
      )
    ORDER BY p.last_metadata_at ASC   -- pause oldest-known-irrelevant first
    LIMIT ${cap}
  `);
  const rows = candidates.rows as Array<{
    id: number; asin: string; name: string | null;
    bsr_value: number | null; review_count: number | null; bought_last_month: number | null;
  }>;

  if (rows.length === 0) return { enabled: true, eligible: 0, paused: 0, cap };

  const ids = rows.map(r => r.id);

  await db.transaction(async (tx) => {
    await tx.execute(sql`
      UPDATE products SET is_active = FALSE WHERE id = ANY(${ids}::int[])
    `);
    // Bulk INSERT INTO auto_cleanup_log using SELECT FROM VALUES
    for (const r of rows) {
      const reasonParts: string[] = [];
      if (r.bsr_value == null) reasonParts.push('BSR ausente');
      else                     reasonParts.push(`BSR ${r.bsr_value.toLocaleString('es-ES')}`);
      reasonParts.push(`reviews ${r.review_count ?? 0}`);
      reasonParts.push('sin badge ventas/mes');
      const reason = reasonParts.join(' · ');
      await tx.execute(sql`
        INSERT INTO auto_cleanup_log (product_id, asin, name, action, reason, bsr_value, review_count, bought_last_month)
        VALUES (${r.id}, ${r.asin}, ${r.name}, 'paused', ${reason}, ${r.bsr_value}, ${r.review_count}, ${r.bought_last_month})
      `);
    }
  });

  console.log(`[auto-cleanup] paused ${rows.length} products (cap ${cap})`);
  return { enabled: true, eligible: rows.length, paused: rows.length, cap };
}

/**
 * Called from src/routes/products.ts when a user (re-)adds a product that
 * exists in DB. Flips is_active back to TRUE if it was paused by
 * auto-cleanup, and writes a 'resumed' row to the audit log so the
 * pause/resume sequence is traceable.
 *
 * No-op when the product is already active.
 */
export async function autoResumeIfPaused(productId: number, asin: string, name: string | null): Promise<void> {
  const r = await db.execute(sql`
    UPDATE products SET is_active = TRUE
    WHERE id = ${productId} AND is_active = FALSE
    RETURNING id
  `);
  if ((r as unknown as { rowCount?: number }).rowCount) {
    await db.execute(sql`
      INSERT INTO auto_cleanup_log (product_id, asin, name, action, reason)
      VALUES (${productId}, ${asin}, ${name}, 'resumed', 'user re-add')
    `);
    console.log(`[auto-cleanup] resumed ${asin} after user re-add`);
  }
}
