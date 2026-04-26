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
  // Migration 5: public product pages
  `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_is_public ON products(is_public) WHERE is_public = TRUE;
  `,
  // Migration 6: advanced alert types + Telegram channel
  `
  ALTER TABLE alerts
    ADD COLUMN IF NOT EXISTS alert_type         VARCHAR(20)     DEFAULT 'price' NOT NULL,
    ADD COLUMN IF NOT EXISTS percentage_drop    NUMERIC(5,2),
    ADD COLUMN IF NOT EXISTS reference_price    NUMERIC(10,2),
    ADD COLUMN IF NOT EXISTS notification_channel VARCHAR(20)   DEFAULT 'email' NOT NULL,
    ADD COLUMN IF NOT EXISTS telegram_chat_id   VARCHAR(50);
  ALTER TABLE alerts ALTER COLUMN threshold_price DROP NOT NULL;
  `,
  // Migration 7: Telegram chat ID per user
  `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50);
  `,
  // Migration 8: product availability tracking
  `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS is_available BOOLEAN DEFAULT TRUE NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_is_available ON products(is_available) WHERE is_available = FALSE;
  `,
  // Migration 9: categories
  `
  CREATE TABLE IF NOT EXISTS categories (
    id         SERIAL PRIMARY KEY,
    name       VARCHAR(100) NOT NULL UNIQUE,
    slug       VARCHAR(100) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );
  ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL;
  CREATE INDEX IF NOT EXISTS idx_products_category_id ON products(category_id);
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
