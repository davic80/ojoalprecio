import { sql } from 'drizzle-orm';
import { db } from '../db/client';

let cached: number | null = null;

/**
 * Id of the internal "system" user that owns discovered products. Resolved once and passed to queries
 * as a plain number: writing it as an inline subquery inside a correlated EXISTS stops Postgres from
 * hashing it and made the dashboard query ~10x slower.
 */
export async function getSystemUserId(): Promise<number> {
  if (cached !== null) return cached;
  const r = await db.execute(sql`SELECT id FROM users WHERE email = 'system@ojoalprecio.local' LIMIT 1`);
  const id = (r.rows[0] as { id?: number } | undefined)?.id;
  if (typeof id === 'number') cached = id;
  return id ?? -1;
}
