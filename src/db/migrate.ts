import type { Pool } from 'pg';
import { pool as defaultPool } from './client';

export const MIGRATIONS: string[] = [
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
  // Migration 35: anomaly review queue. Instead of silently discarding the
  // anomalies the scheduler/scraper detect (low/high outliers, used buybox,
  // unqualified buybox), enqueue them for admin to approve / deny. Admin can
  // also flag a product as "bypass_anomaly_guard" so its future anomalies are
  // auto-accepted without queueing (for products with naturally wide swings).
  `
  CREATE TABLE IF NOT EXISTS scrape_anomalies (
    id              SERIAL PRIMARY KEY,
    product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    detected_at     TIMESTAMP DEFAULT NOW() NOT NULL,
    anomaly_type    VARCHAR(20) NOT NULL,
    suspect_price   NUMERIC(10,2),
    median_price    NUMERIC(10,2),
    scraper_message TEXT,
    page_snippet    TEXT,
    status          VARCHAR(20) DEFAULT 'pending' NOT NULL,
    reviewed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at     TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_scrape_anomalies_pending ON scrape_anomalies(detected_at DESC) WHERE status = 'pending';
  CREATE INDEX IF NOT EXISTS idx_scrape_anomalies_product ON scrape_anomalies(product_id, detected_at DESC);

  ALTER TABLE products ADD COLUMN IF NOT EXISTS bypass_anomaly_guard BOOLEAN DEFAULT FALSE NOT NULL;
  `,
  // Migration 36: variant auto-ingest + stale-unavailable purge.
  //   variants_json           — list of twister sibling ASINs+labels harvested
  //                             from each successful scrape; used to render
  //                             "Otras variantes" and to ingest new ASINs.
  //   consecutive_unavailable — counter of back-to-back ProductUnavailableError
  //                             scrapes. ≥3 + no alerts + no non-system follower
  //                             ⇒ product is auto-deleted. Reset on success.
  `
  ALTER TABLE products ADD COLUMN IF NOT EXISTS variants_json           TEXT;
  ALTER TABLE products ADD COLUMN IF NOT EXISTS consecutive_unavailable INTEGER DEFAULT 0 NOT NULL;
  `,
  // Migration 37: category cleanup. Five categories are folded into others or
  // dropped because they were brand-buckets / duplicates / empty:
  //   Coche (26)            → merged into Automoción (21)
  //   Cuidado Personal (5)  → merged into Salud y Belleza (16)
  //   Apple (1)             → split by product type (Watch/AirTag → Electrónica,
  //                            AirPods → Audio, iPad/Magic* → Informática,
  //                            anything else → Electrónica)
  //   Bricolaje (15)        → empty, source disabled
  //   Moda (17)             → empty, source disabled
  // amazon_category_sources rows are deactivated (not deleted) so re-enabling
  // them later is one-click. Lookups by slug are used to keep the migration
  // robust if any of these IDs got remapped on prior fresh installs.
  `
  -- 1. Distribute Apple before any merges
  UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'audio')
    WHERE category_id = (SELECT id FROM categories WHERE slug = 'apple')
      AND name ILIKE '%airpods%';

  UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'informatica')
    WHERE category_id = (SELECT id FROM categories WHERE slug = 'apple')
      AND (name ILIKE '%ipad%' OR name ILIKE '%magic trackpad%' OR name ILIKE '%magic mouse%' OR name ILIKE '%macbook%');

  UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'electronica')
    WHERE category_id = (SELECT id FROM categories WHERE slug = 'apple');

  -- 2. Merge Coche → Automoción
  UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'automocion')
    WHERE category_id = (SELECT id FROM categories WHERE slug = 'coche');

  -- 3. Merge Cuidado Personal → Salud y Belleza
  UPDATE products SET category_id = (SELECT id FROM categories WHERE slug = 'salud-y-belleza')
    WHERE category_id = (SELECT id FROM categories WHERE slug = 'cuidado-personal');

  -- 4. Disable amazon_category_sources for the categories we're about to drop
  UPDATE amazon_category_sources SET is_active = FALSE
    WHERE category_id IN (
      SELECT id FROM categories WHERE slug IN ('apple','coche','cuidado-personal','bricolaje','moda')
    );

  -- 5. Delete the obsolete categories (FK on amazon_category_sources is SET NULL)
  DELETE FROM categories WHERE slug IN ('apple','coche','cuidado-personal','bricolaje','moda');
  `,
  // Migration 38: aggressive purge of system-discovered variants + featured cap.
  //   purged_asins        — blacklist consulted by ingestNewVariants. Without
  //                          this, every parent scrape re-discovers the
  //                          variant we just deleted ⇒ infinite churn loop.
  //   featured_max_count  — soft cap on /ofertas. After each scrape, the
  //                          worst-ranked auto-featured products are demoted
  //                          back to is_public=FALSE so the panel only ever
  //                          shows the N best chollos.
  `
  CREATE TABLE IF NOT EXISTS purged_asins (
    asin       VARCHAR(20) PRIMARY KEY,
    purged_at  TIMESTAMP DEFAULT NOW() NOT NULL,
    reason     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_purged_asins_recent ON purged_asins(purged_at DESC);

  INSERT INTO app_settings (key, value, value_type, label, hint) VALUES
    ('featured_max_count', '100', 'integer',
     'Máximo de productos destacados en /ofertas',
     'Tras cada scrape se demotan los productos auto-destacados con peor deal_score que caigan fuera del top N. Los pin manuales del admin no cuentan en el cap. Default 100.')
  ON CONFLICT (key) DO NOTHING;
  `,
  // Migration 39: rename products.user_id → products.created_by_user_id. The
  // field is purely an audit "who first added this ASIN" since user_products
  // took over ownership/follow semantics. The old name kept making us reach
  // for it as if it were an access-control key — explicit name kills the
  // confusion. ON DELETE CASCADE behaviour preserved (not touched here).
  `ALTER TABLE products RENAME COLUMN user_id TO created_by_user_id;`,
  // Migration 40: soften CASCADE on the creator FK. With user_products tracking
  // real follows, a product that one user added is often followed by many
  // others; cascading the deletion when the creator's account vanishes would
  // wipe out a product 50 other people still want. Drop NOT NULL and change
  // the FK action to SET NULL: the product survives, just loses its creator
  // attribution. App logic decides separately whether to delete it (only when
  // no real follower remains, see purge logic).
  `
  ALTER TABLE products ALTER COLUMN created_by_user_id DROP NOT NULL;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_user_id_users_id_fk;
  ALTER TABLE products DROP CONSTRAINT IF EXISTS products_created_by_user_id_users_id_fk;
  ALTER TABLE products
    ADD CONSTRAINT products_created_by_user_id_users_id_fk
    FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
  `,
  // Migration 41: AliExpress tables (parallel namespace to Amazon — strategy
  // (a) per the project decision log). Kept separate from `products` because
  // AliExpress has concepts Amazon doesn't (multiple vendors per item,
  // similars-graph, separate affiliate URL) and merging them would mean
  // nullable cols + branchy CASE logic everywhere.
  //
  // - aliexpress_products      : catalog of fetched products (master + similars
  //                              both live here; they're not distinguishable at
  //                              this level)
  // - aliexpress_user_tracks   : explicit user follows (composite PK)
  // - aliexpress_similars      : master ↔ similar edges with provenance + score
  // - aliexpress_price_history : append-only price log, mirrors price_history
  //
  // productId is the canonical numeric AliExpress id, stored as VARCHAR(20)
  // to avoid bigint precision games and preserve any leading-zero edge case.
  `
  CREATE TABLE IF NOT EXISTS aliexpress_products (
    product_id       VARCHAR(20) PRIMARY KEY,
    title            TEXT NOT NULL,
    image_url        TEXT,
    product_url      TEXT NOT NULL,
    promotion_url    TEXT,
    sale_price       NUMERIC(10,2),
    original_price   NUMERIC(10,2),
    discount_pct     INTEGER,
    currency         VARCHAR(5) DEFAULT 'EUR' NOT NULL,
    rating           NUMERIC(3,2),
    orders_count     INTEGER,
    category_id      BIGINT,
    category_name    TEXT,
    shop_id          BIGINT,
    shop_name        TEXT,
    is_available     BOOLEAN DEFAULT TRUE NOT NULL,
    last_fetched_at  TIMESTAMP,
    created_at       TIMESTAMP DEFAULT NOW() NOT NULL
  );

  CREATE TABLE IF NOT EXISTS aliexpress_user_tracks (
    user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id       VARCHAR(20) NOT NULL REFERENCES aliexpress_products(product_id) ON DELETE CASCADE,
    threshold_price  NUMERIC(10,2),
    alert_enabled    BOOLEAN DEFAULT TRUE NOT NULL,
    added_at         TIMESTAMP DEFAULT NOW() NOT NULL,
    PRIMARY KEY (user_id, product_id)
  );
  CREATE INDEX IF NOT EXISTS idx_aliexpress_user_tracks_user ON aliexpress_user_tracks(user_id);

  CREATE TABLE IF NOT EXISTS aliexpress_similars (
    master_product_id   VARCHAR(20) NOT NULL REFERENCES aliexpress_products(product_id) ON DELETE CASCADE,
    similar_product_id  VARCHAR(20) NOT NULL REFERENCES aliexpress_products(product_id) ON DELETE CASCADE,
    source              VARCHAR(20) NOT NULL,
    text_score          NUMERIC(3,2),
    first_seen_at       TIMESTAMP DEFAULT NOW() NOT NULL,
    last_seen_at        TIMESTAMP DEFAULT NOW() NOT NULL,
    PRIMARY KEY (master_product_id, similar_product_id),
    CHECK (master_product_id <> similar_product_id),
    CHECK (source IN ('query', 'smartmatch'))
  );
  CREATE INDEX IF NOT EXISTS idx_aliexpress_similars_master ON aliexpress_similars(master_product_id);

  CREATE TABLE IF NOT EXISTS aliexpress_price_history (
    id           SERIAL PRIMARY KEY,
    product_id   VARCHAR(20) NOT NULL REFERENCES aliexpress_products(product_id) ON DELETE CASCADE,
    price        NUMERIC(10,2) NOT NULL,
    currency     VARCHAR(5) DEFAULT 'EUR' NOT NULL,
    scraped_at   TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_aliexpress_price_history_product ON aliexpress_price_history(product_id);
  CREATE INDEX IF NOT EXISTS idx_aliexpress_price_history_scraped ON aliexpress_price_history(scraped_at DESC);
  `,
  // Migration 42: widen aliexpress_products.rating. Original NUMERIC(3,2)
  // was sized for 0-5 Amazon-style stars; AliExpress actually returns
  // `evaluate_rate` as a 0-100 satisfaction percentage (e.g. 90.2),
  // which overflows. NUMERIC(5,2) safely holds 0.00-999.99.
  `ALTER TABLE aliexpress_products ALTER COLUMN rating TYPE NUMERIC(5,2);`,
  // Migration 43: notified_at on AE user tracks — dedupe price-drop
  // alerts so we don't email the same user every 8h while the price
  // stays below their threshold. Reset to NULL on any subsequent
  // *increase* above threshold so the next dip re-triggers cleanly.
  `ALTER TABLE aliexpress_user_tracks ADD COLUMN IF NOT EXISTS notified_at TIMESTAMP;`,
  // Migration 44: cross-marketplace equivalents (Amazon → AliExpress).
  // One row per Amazon product. ae_product_id NULL means "we looked but
  // didn't find a good match" — distinct from "we never checked" so we
  // can cache the negative result and not re-query every page load.
  // Eligibility flag is denormalised at write time so the /p/:asin
  // route doesn't have to recompute the rule on every render.
  `
  CREATE TABLE IF NOT EXISTS amazon_ae_equivalents (
    amazon_product_id    INTEGER PRIMARY KEY REFERENCES products(id) ON DELETE CASCADE,
    ae_product_id        VARCHAR(20) REFERENCES aliexpress_products(product_id) ON DELETE SET NULL,
    text_score           NUMERIC(3,2),
    ae_price_snapshot    NUMERIC(10,2),
    amazon_price_snapshot NUMERIC(10,2),
    pct_cheaper          NUMERIC(5,2),
    is_eligible          BOOLEAN DEFAULT FALSE NOT NULL,
    checked_at           TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_amazon_ae_equivalents_checked ON amazon_ae_equivalents(checked_at);
  `,
  // Migration 45: log clicks on the cross-marketplace nudge banner.
  // The .ae-nudge on /p/:asin now points at /ae/r/:amazonId which 302s
  // to the AE promotion_url after writing a row here. ae_product_id is
  // a snapshot, not a FK, because the equivalent can change later — we
  // want the click record to remain even if the AE listing disappears.
  `
  CREATE TABLE IF NOT EXISTS ae_nudge_clicks (
    id                SERIAL PRIMARY KEY,
    amazon_product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    ae_product_id     VARCHAR(20),
    user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_agent        TEXT,
    referer           TEXT,
    clicked_at        TIMESTAMP DEFAULT NOW() NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_ae_nudge_clicks_amazon  ON ae_nudge_clicks(amazon_product_id);
  CREATE INDEX IF NOT EXISTS idx_ae_nudge_clicks_clicked ON ae_nudge_clicks(clicked_at DESC);
  `,
  // Migration 46: sale_tier on aliexpress_products, mirroring the
  // Amazon-side ladder. Derived from discount_pct at ingest/refresh
  // time via the shared saleTierFromDiscountPct helper, so the same
  // `oferta` / `super-oferta` / `mega-oferta` / `broooooferton` /
  // `67oferta` strings render the same `badge-tier-*` overlays.
  // Backfills existing rows in-place so the dashboard badges appear
  // without waiting for the next 8h refresh.
  `
  ALTER TABLE aliexpress_products ADD COLUMN IF NOT EXISTS sale_tier VARCHAR(20);
  UPDATE aliexpress_products SET sale_tier = CASE
    WHEN discount_pct >= 67 THEN '67oferta'
    WHEN discount_pct >= 50 THEN 'broooooferton'
    WHEN discount_pct >= 30 THEN 'mega-oferta'
    WHEN discount_pct >= 15 THEN 'super-oferta'
    WHEN discount_pct >=  7 THEN 'oferta'
    ELSE NULL
  END
  WHERE sale_tier IS NULL AND discount_pct IS NOT NULL;
  `,
  // Migration 47: aggregate view counter for the cross-marketplace nudge.
  // Counts every render of the .ae-nudge banner (eligible match displayed
  // to a user) per Amazon product per day. We DON'T log per-request rows —
  // page-view-style aggregation keeps row count linear with active
  // products, not with traffic. Combined with ae_nudge_clicks gives the
  // CTR the admin dashboard couldn't compute without a denominator.
  `
  CREATE TABLE IF NOT EXISTS ae_nudge_views (
    amazon_product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    day               TEXT    NOT NULL,
    count             INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (amazon_product_id, day)
  );
  CREATE INDEX IF NOT EXISTS idx_ae_nudge_views_day ON ae_nudge_views(day DESC);
  `,
  // Migration 48: surface attribution for nudge clicks. Until now every
  // click came from the auto-banner (.ae-nudge). The new manual button
  // ("Buscar en AliExpress") needs the same plumbing but its clicks
  // should be distinguishable so we can compare which discovery surface
  // converts better. Default 'banner' keeps existing rows attributed
  // correctly; the new /ae/s/:id endpoint writes 'search'.
  `
  ALTER TABLE ae_nudge_clicks ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'banner' NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_ae_nudge_clicks_source ON ae_nudge_clicks(source);
  `,
  // Migration 49: storage for CSV-imported Amazon Affiliates stats.
  // Amazon doesn't expose an earnings API, so admin uploads the CSV
  // they download from afiliados.amazon.es periodically. The composite
  // PK (tracking_id, asin, day) is the natural grain — rows from
  // overlapping uploads UPSERT and the last upload wins (most recent
  // numbers are correct because Amazon revises earlier rows for
  // returns/adjustments). asin = '*' means "aggregate row, no per-item
  // breakdown" (some Amazon reports aggregate by day only).
  // raw_row keeps the original parsed object so future schema changes
  // can re-derive columns from past uploads without re-importing.
  `
  CREATE TABLE IF NOT EXISTS amazon_affiliate_stats (
    tracking_id    VARCHAR(50) NOT NULL,
    asin           VARCHAR(20) NOT NULL DEFAULT '*',
    day            DATE        NOT NULL,
    clicks         INTEGER,
    items_ordered  INTEGER,
    items_returned INTEGER,
    earnings       NUMERIC(12,2),
    currency       VARCHAR(5)  DEFAULT 'EUR',
    raw_row        JSONB,
    uploaded_at    TIMESTAMP   DEFAULT NOW() NOT NULL,
    PRIMARY KEY (tracking_id, asin, day)
  );
  CREATE INDEX IF NOT EXISTS idx_amazon_affiliate_stats_day  ON amazon_affiliate_stats(day DESC);
  CREATE INDEX IF NOT EXISTS idx_amazon_affiliate_stats_asin ON amazon_affiliate_stats(asin) WHERE asin <> '*';
  `,
  // Migration 50: convert amazon_affiliate_stats.day from DATE to TEXT.
  // The schema (Drizzle) was declared as text + all the report queries
  // compare with TO_CHAR(...) which returns text → Postgres bailed with
  // "operator does not exist: date >= text" on /admin/affiliates. Aligns
  // with the page_views / ae_nudge_views convention of storing ISO
  // 'YYYY-MM-DD' strings.
  `ALTER TABLE amazon_affiliate_stats ALTER COLUMN day TYPE TEXT USING TO_CHAR(day, 'YYYY-MM-DD');`,
  // Migration 51: hot-products feed columns on aliexpress_products.
  // hotproduct.query (Advanced API perm, approved 2026-05-21) returns
  // the top-trending AE products globally. We refresh a small pool
  // daily and surface them on /ofertas/aliexpress. Reuses the existing
  // catalog row when an AE product appears both as a hot one AND as
  // someone's tracked / similar — no duplication.
  //   is_hot          : filter for the public page
  //   hot_rank        : preserves the API's order (1 = top)
  //   hot_fetched_at  : lets us age out stale entries
  `
  ALTER TABLE aliexpress_products
    ADD COLUMN IF NOT EXISTS is_hot         BOOLEAN DEFAULT FALSE NOT NULL,
    ADD COLUMN IF NOT EXISTS hot_rank       INTEGER,
    ADD COLUMN IF NOT EXISTS hot_fetched_at TIMESTAMP;
  CREATE INDEX IF NOT EXISTS idx_aliexpress_products_hot_rank
    ON aliexpress_products(hot_rank) WHERE is_hot = TRUE;
  `,

  // 52: OAuth token storage for the AliExpress Dropshipping namespace.
  // The DS endpoints (aliexpress.ds.*) — including ds.product.get, which
  // is the only AE method that returns per-variant sku_info — reject
  // app-key+sign-only requests with "MissingParameter: access_token".
  // The app owner runs the authorize-code dance once via /admin/
  // aliexpress/oauth/start; we persist the resulting tokens here and a
  // refresh worker keeps access_token fresh (AE access_token TTL = 24 h,
  // refresh_token TTL = ~60 days and rotates per refresh).
  //
  // Single-row table: this is an app-level OAuth, not per-user. The id=1
  // sentinel UNIQUE constraint keeps INSERT ... ON CONFLICT (id) sane.
  `
  CREATE TABLE IF NOT EXISTS aliexpress_oauth_tokens (
    id                     INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    access_token           TEXT NOT NULL,
    refresh_token          TEXT NOT NULL,
    expires_at             TIMESTAMP NOT NULL,
    refresh_expires_at     TIMESTAMP NOT NULL,
    ae_user_id             TEXT,
    ae_account             TEXT,
    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
  );
  `,

  // 53: Product popularity metadata + auto-cleanup infrastructure.
  // Auto-pause cron uses three Amazon-side signals to decide whether an
  // auto-imported, unowned, alert-less product is dead weight:
  //   bsr_value          — Best Sellers Rank number (lower = better)
  //   review_count       — total customer reviews
  //   bought_last_month  — count from "+X comprados último mes" badge,
  //                        NULL when no badge (only top sellers get it)
  // Scraper captures all three best-effort each scrape; missing data
  // stays NULL so a missed scrape doesn't trigger a purge.
  //
  // last_metadata_at = freshness gate; we only consider a product for
  // auto-pause if we've successfully captured metadata at least once
  // AND it's >24 h old (so a fresh scrape can't pause something we
  // just learned about).
  `
  ALTER TABLE products
    ADD COLUMN IF NOT EXISTS bsr_value          INTEGER,
    ADD COLUMN IF NOT EXISTS bsr_category       TEXT,
    ADD COLUMN IF NOT EXISTS review_count       INTEGER,
    ADD COLUMN IF NOT EXISTS bought_last_month  INTEGER,
    ADD COLUMN IF NOT EXISTS last_metadata_at   TIMESTAMP;

  CREATE INDEX IF NOT EXISTS idx_products_bsr        ON products(bsr_value);
  CREATE INDEX IF NOT EXISTS idx_products_metadata_at ON products(last_metadata_at);

  -- Audit log for the auto-pause cron. Lets us trace why any given
  -- product disappeared from active scraping without searching app logs.
  -- 30-day retention enforced by maintenance housekeeping (not here).
  CREATE TABLE IF NOT EXISTS auto_cleanup_log (
    id            SERIAL PRIMARY KEY,
    product_id    INTEGER NOT NULL,
    asin          VARCHAR(20) NOT NULL,
    name          TEXT,
    action        VARCHAR(20) NOT NULL,                 -- 'paused' | 'resumed'
    reason        TEXT,                                  -- human-readable why
    bsr_value     INTEGER,
    review_count  INTEGER,
    bought_last_month INTEGER,
    at            TIMESTAMP NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS idx_auto_cleanup_log_at      ON auto_cleanup_log(at DESC);
  CREATE INDEX IF NOT EXISTS idx_auto_cleanup_log_product ON auto_cleanup_log(product_id);

  -- Feature flag + cap. Defaults: disabled, 100/hour. Toggle via
  -- /admin/settings.
  INSERT INTO app_settings (key, value, value_type, label, hint) VALUES
    ('auto_cleanup_enabled', 'false', 'boolean',
     'Auto-pause de productos irrelevantes',
     'Cuando está activo, cada hora se pausan (is_active=FALSE) hasta N productos auto-importados que no tienen reviews, BSR malo, sin badge de ventas, sin alertas ni follows. Reversible: si un usuario añade el producto, se reanuda automáticamente.'),
    ('auto_cleanup_cap_per_hour', '100', 'integer',
     'Máximo de productos a pausar por hora (1–500)',
     'Tope de seguridad: el auto-cleanup nunca pausa más de N productos por ciclo, aunque haya más candidatos.')
  ON CONFLICT (key) DO NOTHING;
  `,
];

export async function migrate(pool: Pool = defaultPool): Promise<void> {
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
