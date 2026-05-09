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
  // Migration 10: automatic sale detection (>7% price drop record-to-record)
  `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS is_on_sale BOOLEAN DEFAULT FALSE NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_is_on_sale ON products(is_on_sale) WHERE is_on_sale = TRUE;
  `,
  // Migration 11: backfill is_on_sale from existing price history (record-to-record, superseded by 12)
  `
  UPDATE products p
  SET is_on_sale = TRUE
  WHERE is_active = TRUE
    AND is_available = TRUE
    AND (
      SELECT ph1.price FROM price_history ph1
      WHERE ph1.product_id = p.id
      ORDER BY ph1.scraped_at DESC
      LIMIT 1
    ) < (
      SELECT ph2.price FROM price_history ph2
      WHERE ph2.product_id = p.id
      ORDER BY ph2.scraped_at DESC
      OFFSET 1 LIMIT 1
    ) * 0.93;
  `,
  // Migration 12: re-backfill is_on_sale using 3-day max as reference
  `
  UPDATE products p
  SET is_on_sale = COALESCE((
    WITH latest AS (
      SELECT price, scraped_at
      FROM price_history
      WHERE product_id = p.id
      ORDER BY scraped_at DESC
      LIMIT 1
    )
    SELECT latest.price < MAX(ph.price) * 0.93
    FROM latest
    JOIN price_history ph ON ph.product_id = p.id
    WHERE ph.scraped_at >= latest.scraped_at - INTERVAL '3 days'
      AND ph.scraped_at < latest.scraped_at
    GROUP BY latest.price
  ), FALSE)
  WHERE is_active = TRUE
    AND EXISTS (SELECT 1 FROM price_history WHERE product_id = p.id);
  `,
  // Migration 13: make all on-sale products public
  `
  UPDATE products SET is_public = TRUE WHERE is_on_sale = TRUE;
  `,
  // Migration 14: alert event history table
  `
  CREATE TABLE IF NOT EXISTS alert_events (
    id             SERIAL PRIMARY KEY,
    alert_id       INTEGER REFERENCES alerts(id) ON DELETE SET NULL,
    product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_type     VARCHAR(20) NOT NULL,
    price_at_time  NUMERIC(10,2) NOT NULL,
    threshold_label TEXT,
    triggered_at   TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_alert_events_user_id ON alert_events(user_id);
  CREATE INDEX IF NOT EXISTS idx_alert_events_triggered_at ON alert_events(triggered_at DESC);
  `,
  // Migration 15: email verification
  `
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE NOT NULL;
  UPDATE users SET email_verified = TRUE;
  CREATE TABLE IF NOT EXISTS email_verifications (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token);
  `,
  // Migration 16: password reset tokens
  `
  CREATE TABLE IF NOT EXISTS password_resets (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token      VARCHAR(64) NOT NULL UNIQUE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token);
  `,
  // Migration 17: extra product images (JSON array, up to 2 alt images)
  `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS extra_images TEXT;
  `,
  // Migration 18: Amazon category sources for hourly auto-import
  `
  CREATE TABLE IF NOT EXISTS amazon_category_sources (
    id               SERIAL PRIMARY KEY,
    name             VARCHAR(100) NOT NULL,
    amazon_url       TEXT NOT NULL,
    category_id      INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    is_active        BOOLEAN DEFAULT TRUE NOT NULL,
    last_imported_at TIMESTAMP,
    created_at       TIMESTAMP DEFAULT NOW() NOT NULL
  );

  INSERT INTO amazon_category_sources (name, amazon_url) VALUES
    ('Electrónica',      'https://www.amazon.es/gp/bestsellers/electronics/'),
    ('Informática',      'https://www.amazon.es/gp/bestsellers/computers/'),
    ('Hogar y cocina',   'https://www.amazon.es/gp/bestsellers/kitchen/'),
    ('Deportes',         'https://www.amazon.es/gp/bestsellers/sports/'),
    ('Juguetes',         'https://www.amazon.es/gp/bestsellers/toys/'),
    ('Cámara y foto',    'https://www.amazon.es/gp/bestsellers/photo/'),
    ('Bricolaje',        'https://www.amazon.es/gp/bestsellers/diy/'),
    ('Salud y belleza',  'https://www.amazon.es/gp/bestsellers/drugstore/'),
    ('Ropa',             'https://www.amazon.es/gp/bestsellers/apparel/'),
    ('Jardín',           'https://www.amazon.es/gp/bestsellers/garden/')
  ON CONFLICT DO NOTHING;

  INSERT INTO users (email, password_hash, email_verified)
  VALUES ('system@ojoalprecio.local', '$system-no-login$', TRUE)
  ON CONFLICT (email) DO NOTHING;
  `,
  // Migration 19: recommendation lists + items (v2.0.0)
  `
  CREATE TABLE IF NOT EXISTS recommendation_lists (
    id          SERIAL PRIMARY KEY,
    slug        VARCHAR(100) NOT NULL UNIQUE,
    name        VARCHAR(200) NOT NULL,
    description TEXT,
    created_at  TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS recommendation_items (
    id          SERIAL PRIMARY KEY,
    list_id     INTEGER NOT NULL REFERENCES recommendation_lists(id) ON DELETE CASCADE,
    product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    note        TEXT,
    position    INTEGER DEFAULT 0 NOT NULL,
    created_at  TIMESTAMP DEFAULT NOW() NOT NULL,
    UNIQUE(list_id, product_id)
  );

  CREATE INDEX IF NOT EXISTS idx_recommendation_items_list_id ON recommendation_items(list_id);
  `,
  // Migration 20: no-op placeholder (idx 20 was applied in v2.1.0 deploy as duplicate recommendation_lists)
  `SELECT 1`,
  // Migration 21: page view aggregates (path + day → count)
  `
  CREATE TABLE IF NOT EXISTS page_views (
    path  VARCHAR(500) NOT NULL,
    day   TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (path, day)
  );
  `,
  // Migration 22: create ojoalprecio categories + link amazon_category_sources with category_id and corrected URLs
  `
  INSERT INTO categories (name, slug) VALUES
    ('Electrónica',            'electronica'),
    ('Informática',            'informatica'),
    ('Hogar y Cocina',         'hogar-y-cocina'),
    ('Deportes',               'deportes'),
    ('Juguetes',               'juguetes'),
    ('Cámara y Foto',          'camara-y-foto'),
    ('Bricolaje',              'bricolaje'),
    ('Salud y Belleza',        'salud-y-belleza'),
    ('Moda',                   'moda'),
    ('Jardín',                 'jardin'),
    ('Videojuegos',            'videojuegos'),
    ('Mascotas',               'mascotas'),
    ('Automoción',             'automocion'),
    ('Bebé',                   'bebe'),
    ('Alimentación',           'alimentacion')
  ON CONFLICT (slug) DO NOTHING;

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/electronics/',
    category_id = (SELECT id FROM categories WHERE slug = 'electronica')
  WHERE name = 'Electrónica';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/computers/',
    category_id = (SELECT id FROM categories WHERE slug = 'informatica')
  WHERE name = 'Informática';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/kitchen/',
    category_id = (SELECT id FROM categories WHERE slug = 'hogar-y-cocina')
  WHERE name = 'Hogar y cocina';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/sports/',
    category_id = (SELECT id FROM categories WHERE slug = 'deportes')
  WHERE name = 'Deportes';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/toys/',
    category_id = (SELECT id FROM categories WHERE slug = 'juguetes')
  WHERE name = 'Juguetes';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/photo/',
    category_id = (SELECT id FROM categories WHERE slug = 'camara-y-foto')
  WHERE name = 'Cámara y foto';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/diy/',
    category_id = (SELECT id FROM categories WHERE slug = 'bricolaje')
  WHERE name = 'Bricolaje';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/drugstore/',
    category_id = (SELECT id FROM categories WHERE slug = 'salud-y-belleza')
  WHERE name = 'Salud y belleza';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/apparel/',
    category_id = (SELECT id FROM categories WHERE slug = 'moda')
  WHERE name = 'Ropa';

  UPDATE amazon_category_sources SET
    amazon_url = 'https://www.amazon.es/gp/bestsellers/garden/',
    category_id = (SELECT id FROM categories WHERE slug = 'jardin')
  WHERE name = 'Jardín';

  INSERT INTO amazon_category_sources (name, amazon_url, category_id) VALUES
    ('Videojuegos',   'https://www.amazon.es/gp/bestsellers/videogames/',
      (SELECT id FROM categories WHERE slug = 'videojuegos')),
    ('Mascotas',      'https://www.amazon.es/gp/bestsellers/pet-supplies/',
      (SELECT id FROM categories WHERE slug = 'mascotas')),
    ('Automoción',    'https://www.amazon.es/gp/bestsellers/automotive/',
      (SELECT id FROM categories WHERE slug = 'automocion')),
    ('Bebé',          'https://www.amazon.es/gp/bestsellers/baby/',
      (SELECT id FROM categories WHERE slug = 'bebe')),
    ('Alimentación',  'https://www.amazon.es/gp/bestsellers/grocery/',
      (SELECT id FROM categories WHERE slug = 'alimentacion'))
  ON CONFLICT DO NOTHING;
  `,
  `
  CREATE TABLE IF NOT EXISTS social_post_log (
    id          SERIAL PRIMARY KEY,
    product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
    platform    VARCHAR(20) NOT NULL,
    post_id     TEXT,
    content     TEXT,
    posted_at   TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS social_post_log_product_platform ON social_post_log(product_id, platform);
  `,
  // Migration 24: consecutive failure tracking — marks products as failed after 3 scrape errors
  `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS is_failed            BOOLEAN DEFAULT FALSE NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_products_is_failed ON products(is_failed) WHERE is_failed = TRUE;
  `,
  // Migration 25: traffic source + device type on page_views
  `
  ALTER TABLE page_views
    ADD COLUMN IF NOT EXISTS source      VARCHAR(50) NOT NULL DEFAULT 'Directo',
    ADD COLUMN IF NOT EXISTS device_type VARCHAR(20) NOT NULL DEFAULT 'Escritorio';
  ALTER TABLE page_views DROP CONSTRAINT IF EXISTS page_views_pkey;
  ALTER TABLE page_views ADD PRIMARY KEY (path, day, source, device_type);
  `,
  // Migration 26: total_failures — cumulative error counter, never resets unlike consecutive_failures
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS total_failures INTEGER DEFAULT 0 NOT NULL;`,
  // Migration 27: sale tiers + deal score; reset is_on_sale so scheduler recalculates with new all-time-max logic
  `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS sale_tier  VARCHAR(20),
    ADD COLUMN IF NOT EXISTS deal_score DECIMAL(5,1);
  UPDATE products SET is_on_sale = FALSE, sale_tier = NULL, deal_score = NULL;
  `,
  // Migration 28: was_price — Amazon's "Precio recomendado" / struck-through reference price
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS was_price NUMERIC(10,2);`,
  // Migration 29: runtime-configurable app settings (DB overrides env vars)
  `
  CREATE TABLE IF NOT EXISTS app_settings (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT         NOT NULL,
    value_type VARCHAR(20)  NOT NULL DEFAULT 'string',
    label      VARCHAR(200) NOT NULL DEFAULT '',
    hint       TEXT,
    updated_at TIMESTAMP    DEFAULT NOW() NOT NULL
  );
  INSERT INTO app_settings (key, value, value_type, label, hint) VALUES
    ('category_import_enabled', 'true', 'boolean', 'Importación automática de categorías',
     'Activa o desactiva el scraping horario de categorías de Amazon para añadir productos nuevos.'),
    ('scraper_concurrency',     '1',    'integer', 'Workers Chromium en paralelo (1–8)',
     'Número de instancias de Chromium que se ejecutan simultáneamente. Reduce si la Pi se satura.'),
    ('retry_failed_per_cycle',  '30',   'integer', 'Productos fallidos a reintentar por ciclo (0–100)',
     'Cuántos productos marcados como fallidos se reintroducen en cada ciclo horario.'),
    ('scraper_timeout_seconds', '30',   'integer', 'Timeout de scraping por producto en segundos (15–120)',
     'Tiempo máximo antes de abortar el scraping de un producto y marcarlo como error.'),
    ('min_age_minutes',         '59',   'integer', 'Tiempo mínimo entre re-scrapes del mismo producto (30–1440 min)',
     'Un producto no se vuelve a scrapear si fue comprobado más recientemente que este valor.')
  ON CONFLICT (key) DO NOTHING;
  `,
  // Migration 30: is_default flag on alerts — marks auto-created 1% watch alerts
  `ALTER TABLE alerts ADD COLUMN IF NOT EXISTS is_default BOOLEAN DEFAULT FALSE NOT NULL;`,
  // Migration 31: telegram_public_channel moves from .env to app_settings for runtime control
  `
  INSERT INTO app_settings (key, value, value_type, label, hint) VALUES
    ('telegram_public_channel', '', 'string',
     'Canal público de Telegram (handle sin @)',
     'Handle del canal donde se publican ofertas automáticamente (ej: ojoalprecio). Vacío = desactivado.')
  ON CONFLICT (key) DO NOTHING;
  `,
  // Migration 32: user_products — many-to-many follow relation between users and products.
  // Products are now a shared global catalog; users "follow" them. Removing a follow leaves
  // the product (and its history) intact and the scheduler keeps scraping it. Only admin
  // can hard-delete a product. Backfills follows from the legacy products.user_id "creator".
  `
  CREATE TABLE IF NOT EXISTS user_products (
    user_id    INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    added_at   TIMESTAMP DEFAULT NOW() NOT NULL,
    PRIMARY KEY (user_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_user_products_user_id    ON user_products(user_id);
  CREATE INDEX IF NOT EXISTS idx_user_products_product_id ON user_products(product_id);

  INSERT INTO user_products (user_id, product_id, added_at)
  SELECT user_id, id, created_at FROM products
  ON CONFLICT DO NOTHING;
  `,
  // Migration 33: consecutive_anomalies — counter for rejected price scrapes that
  // diverge wildly from the recent median (e.g. selectors picking up accessory or
  // "Nuevo y de segunda mano desde X €" prices). After 3 consecutive anomalies the
  // guard accepts the new price (in case the real price genuinely shifted).
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS consecutive_anomalies INTEGER DEFAULT 0 NOT NULL;`,
  // Migration 34: auto-curation of /ofertas. feature_lock controls whether the
  // scheduler can toggle is_public on its own ('auto') or whether admin has
  // pinned it in ('pin') or out ('mute'). featured_at marks when a product
  // last entered /ofertas via auto-curation, used for fatigue (max 14 days).
  // Conservative backfill: any product that's currently is_public=TRUE gets
  // feature_lock='pin' so manual curation isn't lost.
  `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS feature_lock VARCHAR(10) DEFAULT 'auto' NOT NULL;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS featured_at  TIMESTAMP;
  UPDATE products SET feature_lock = 'pin', featured_at = NOW() WHERE is_public = TRUE;

  INSERT INTO app_settings (key, value, value_type, label, hint) VALUES
    ('featured_min_deal_score', '20', 'integer',
     'Umbral % para auto-destacar en /ofertas',
     'deal_score mínimo (en %) para que un producto entre automáticamente en /ofertas. Sale al bajar 5 puntos por debajo (histéresis). Default 20.')
  ON CONFLICT (key) DO NOTHING;
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
