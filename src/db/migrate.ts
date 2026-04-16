import { pool } from './client';

const MIGRATIONS = [
  `
  CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         VARCHAR(255) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    created_at    TIMESTAMP DEFAULT NOW() NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS products (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asin        VARCHAR(20) NOT NULL,
    url         TEXT NOT NULL,
    name        TEXT,
    image_url   TEXT,
    is_active   BOOLEAN DEFAULT TRUE NOT NULL,
    last_error  TEXT,
    created_at  TIMESTAMP DEFAULT NOW() NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS price_history (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price       NUMERIC(10,2) NOT NULL,
    currency    VARCHAR(5) DEFAULT 'EUR' NOT NULL,
    scraped_at  TIMESTAMP DEFAULT NOW() NOT NULL
  );
  `,
  `
  CREATE TABLE IF NOT EXISTS alerts (
    id                  SERIAL PRIMARY KEY,
    product_id          INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id             INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    threshold_price     NUMERIC(10,2) NOT NULL,
    notification_email  VARCHAR(255) NOT NULL,
    is_active           BOOLEAN DEFAULT TRUE NOT NULL,
    notified_at         TIMESTAMP,
    created_at          TIMESTAMP DEFAULT NOW() NOT NULL
  );
  `,
  `
  CREATE INDEX IF NOT EXISTS idx_price_history_product_id ON price_history(product_id);
  CREATE INDEX IF NOT EXISTS idx_price_history_scraped_at ON price_history(scraped_at DESC);
  CREATE INDEX IF NOT EXISTS idx_products_user_id ON products(user_id);
  CREATE INDEX IF NOT EXISTS idx_alerts_product_id ON alerts(product_id);
  `,
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log('[migrate] Running migrations…');

    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id      SERIAL PRIMARY KEY,
        idx     INTEGER NOT NULL UNIQUE,
        run_at  TIMESTAMP DEFAULT NOW() NOT NULL
      );
    `);

    const { rows } = await client.query<{ idx: number }>('SELECT idx FROM _migrations ORDER BY idx');
    const applied = new Set(rows.map((r) => r.idx));

    for (let i = 0; i < MIGRATIONS.length; i++) {
      if (applied.has(i)) continue;
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[i]);
        await client.query('INSERT INTO _migrations (idx) VALUES ($1)', [i]);
        await client.query('COMMIT');
        console.log(`[migrate] Applied migration ${i}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }

    console.log('[migrate] All migrations applied.');
  } finally {
    client.release();
  }
}

// Allow running directly: npx tsx src/db/migrate.ts
if (require.main === module) {
  migrate().catch((err) => {
    console.error('[migrate] Failed:', err);
    process.exit(1);
  });
}
