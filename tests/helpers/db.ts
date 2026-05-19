import { pool } from '../../src/db/client';

/**
 * Wipes every public table (except _migrations) and resets sequences.
 * Call from a `beforeEach` so each test starts from a clean slate without
 * paying the cost of re-running the migration suite.
 */
export async function resetDb(): Promise<void> {
  await pool.query(`
    DO $$
    DECLARE r RECORD;
    BEGIN
      FOR r IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public' AND tablename <> '_migrations'
      LOOP
        EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE';
      END LOOP;
    END $$;
  `);
}
