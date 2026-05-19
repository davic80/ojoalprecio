import { inject, afterAll } from 'vitest';

// Must set DATABASE_URL BEFORE any test file imports src/db/client, since
// client.ts builds the singleton pg.Pool at module-load time from that env.
// Migrations were already applied once in globalSetup against the same DB.
process.env.DATABASE_URL = inject('databaseUrl');

afterAll(async () => {
  // Only close the pool if it was actually opened by a test file.
  try {
    const { pool } = await import('../../src/db/client');
    await pool.end();
  } catch {
    /* pool never created in this worker — nothing to close */
  }
});
