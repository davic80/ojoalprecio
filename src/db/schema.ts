import { pgTable, serial, varchar, text, boolean, timestamp, numeric, integer, index, primaryKey } from 'drizzle-orm/pg-core';

// ── Categories ───────────────────────────────────────────────────────────────

export const categories = pgTable('categories', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull().unique(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  telegramChatId: varchar('telegram_chat_id', { length: 50 }),
  emailVerified: boolean('email_verified').default(false).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Email Verifications ───────────────────────────────────────────────────────

export const emailVerifications = pgTable('email_verifications', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Password Resets ───────────────────────────────────────────────────────────

export const passwordResets = pgTable('password_resets', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token: varchar('token', { length: 64 }).notNull().unique(),
  expiresAt: timestamp('expires_at').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Products ─────────────────────────────────────────────────────────────────

export const products = pgTable('products', {
  id: serial('id').primaryKey(),
  // Audit-only: who first added this ASIN to the catalog. Ownership and
  // follow semantics live in `user_products`. Nullable + ON DELETE SET NULL
  // since migration 40 — when a creator deletes their account, the product
  // survives for other followers (a real-user-follow check + alert check
  // decides whether to also delete the product, in app-level logic).
  createdByUserId: integer('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
  asin: varchar('asin', { length: 20 }).notNull(),
  url: text('url').notNull(),
  name: text('name'),
  imageUrl: text('image_url'),
  extraImages: text('extra_images'),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').default(true).notNull(),
  isPublic: boolean('is_public').default(false).notNull(),
  isAvailable: boolean('is_available').default(true).notNull(),
  isOnSale: boolean('is_on_sale').default(false).notNull(),
  saleTier: varchar('sale_tier', { length: 20 }),
  dealScore: numeric('deal_score', { precision: 5, scale: 1 }),
  wasPrice: numeric('was_price', { precision: 10, scale: 2 }),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  consecutiveAnomalies: integer('consecutive_anomalies').default(0).notNull(),
  totalFailures: integer('total_failures').default(0).notNull(),
  isFailed: boolean('is_failed').default(false).notNull(),
  lastError: text('last_error'),
  // Auto-curation of /ofertas. 'auto' = scheduler decides on each scrape;
  // 'pin' = admin force-keeps it featured; 'mute' = admin force-keeps it out.
  featureLock: varchar('feature_lock', { length: 10 }).default('auto').notNull(),
  featuredAt:  timestamp('featured_at'),
  // Per-product opt-out of the anomaly guard. Admin can flip this on for
  // products with naturally wide swings (e.g. clearance items, low-volume
  // listings) so future anomalies aren't queued for review.
  bypassAnomalyGuard: boolean('bypass_anomaly_guard').default(false).notNull(),
  // Twister sibling ASINs harvested on each successful scrape (JSON array of
  // { asin, label, selectable }). Used to render "Otras variantes" on the
  // product page and to auto-ingest new variant ASINs into the catalog.
  variantsJson: text('variants_json'),
  // Counter of consecutive ProductUnavailableError scrapes. Reset to 0 on
  // any successful capture. ≥3 + no alerts + no non-system follower ⇒ purged.
  consecutiveUnavailable: integer('consecutive_unavailable').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Purged ASIN blacklist ─────────────────────────────────────────────────────
// Stores ASINs that were auto-purged so the variant ingester doesn't keep
// re-discovering them on every parent scrape. Entries TTL out after ~30 days
// (lazy cleanup at query time).

export const purgedAsins = pgTable('purged_asins', {
  asin:      varchar('asin', { length: 20 }).primaryKey(),
  purgedAt:  timestamp('purged_at').defaultNow().notNull(),
  reason:    text('reason'),
});

// ── Scrape Anomalies (review queue) ───────────────────────────────────────────

export const scrapeAnomalies = pgTable('scrape_anomalies', {
  id:             serial('id').primaryKey(),
  productId:      integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  detectedAt:     timestamp('detected_at').defaultNow().notNull(),
  // 'low' | 'high' | 'used' | 'unqualified'
  anomalyType:    varchar('anomaly_type', { length: 20 }).notNull(),
  suspectPrice:   numeric('suspect_price',  { precision: 10, scale: 2 }),
  medianPrice:    numeric('median_price',   { precision: 10, scale: 2 }),
  scraperMessage: text('scraper_message'),
  pageSnippet:    text('page_snippet'),
  // 'pending' | 'approved' | 'denied'
  status:         varchar('status', { length: 20 }).default('pending').notNull(),
  reviewedBy:     integer('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
  reviewedAt:     timestamp('reviewed_at'),
});

export type ScrapeAnomaly    = typeof scrapeAnomalies.$inferSelect;
export type NewScrapeAnomaly = typeof scrapeAnomalies.$inferInsert;

// ── User ↔ Product follows (many-to-many) ────────────────────────────────────
// Composite PK (user_id, product_id). The legacy products.user_id is preserved
// as "creator/added_by" only — actual ownership for dashboard/alerts purposes
// is determined by membership in this table.

export const userProducts = pgTable('user_products', {
  userId:    integer('user_id').notNull().references(() => users.id,    { onDelete: 'cascade' }),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  addedAt:   timestamp('added_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.productId] }),
}));

// ── Price History ─────────────────────────────────────────────────────────────

export const priceHistory = pgTable('price_history', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  price: numeric('price', { precision: 10, scale: 2 }).notNull(),
  currency: varchar('currency', { length: 5 }).default('EUR').notNull(),
  scrapedAt: timestamp('scraped_at').defaultNow().notNull(),
});

// ── Alerts ────────────────────────────────────────────────────────────────────

export const alerts = pgTable('alerts', {
  id: serial('id').primaryKey(),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  // 'price' = fixed threshold | 'percent' = % drop from reference | 'alltime_low' = any new all-time low
  alertType: varchar('alert_type', { length: 20 }).default('price').notNull(),
  thresholdPrice: numeric('threshold_price', { precision: 10, scale: 2 }),
  percentageDrop: numeric('percentage_drop', { precision: 5, scale: 2 }),
  referencePrice: numeric('reference_price', { precision: 10, scale: 2 }),
  notificationEmail: varchar('notification_email', { length: 255 }).notNull(),
  // 'email' | 'telegram' | 'both'
  notificationChannel: varchar('notification_channel', { length: 20 }).default('email').notNull(),
  telegramChatId: varchar('telegram_chat_id', { length: 50 }),
  isActive: boolean('is_active').default(true).notNull(),
  isDefault: boolean('is_default').default(false).notNull(),
  notifiedAt: timestamp('notified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Alert Events ──────────────────────────────────────────────────────────────

export const alertEvents = pgTable('alert_events', {
  id: serial('id').primaryKey(),
  alertId: integer('alert_id').references(() => alerts.id, { onDelete: 'set null' }),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  alertType: varchar('alert_type', { length: 20 }).notNull(),
  priceAtTime: numeric('price_at_time', { precision: 10, scale: 2 }).notNull(),
  thresholdLabel: text('threshold_label'),
  triggeredAt: timestamp('triggered_at').defaultNow().notNull(),
});
export type AlertEvent = typeof alertEvents.$inferSelect;
export type NewAlertEvent = typeof alertEvents.$inferInsert;

// ── AliExpress (parallel namespace — strategy "(a) separate tables") ─────────
// AliExpress integration lives in its own table set because the data model
// differs from Amazon (no stable ASIN, multiple vendors per item, similars
// graph, separate affiliate URL). productId is the canonical AE numeric id
// stored as VARCHAR(20) to avoid bigint precision issues.

export const aliexpressProducts = pgTable('aliexpress_products', {
  productId:      varchar('product_id', { length: 20 }).primaryKey(),
  title:          text('title').notNull(),
  imageUrl:       text('image_url'),
  productUrl:     text('product_url').notNull(),
  promotionUrl:   text('promotion_url'),
  salePrice:      numeric('sale_price',     { precision: 10, scale: 2 }),
  originalPrice:  numeric('original_price', { precision: 10, scale: 2 }),
  discountPct:    integer('discount_pct'),
  currency:       varchar('currency', { length: 5 }).default('EUR').notNull(),
  rating:         numeric('rating', { precision: 5, scale: 2 }),  // 0-100 % satisfaction
  ordersCount:    integer('orders_count'),
  categoryId:     integer('category_id'),
  categoryName:   text('category_name'),
  shopId:         integer('shop_id'),
  shopName:       text('shop_name'),
  saleTier:       varchar('sale_tier', { length: 20 }),
  isAvailable:    boolean('is_available').default(true).notNull(),
  lastFetchedAt:  timestamp('last_fetched_at'),
  createdAt:      timestamp('created_at').defaultNow().notNull(),
});

export const aliexpressUserTracks = pgTable('aliexpress_user_tracks', {
  userId:         integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  productId:      varchar('product_id', { length: 20 }).notNull().references(() => aliexpressProducts.productId, { onDelete: 'cascade' }),
  thresholdPrice: numeric('threshold_price', { precision: 10, scale: 2 }),
  alertEnabled:   boolean('alert_enabled').default(true).notNull(),
  notifiedAt:     timestamp('notified_at'),
  addedAt:        timestamp('added_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.productId] }),
}));

export const aliexpressSimilars = pgTable('aliexpress_similars', {
  masterProductId:  varchar('master_product_id',  { length: 20 }).notNull().references(() => aliexpressProducts.productId, { onDelete: 'cascade' }),
  similarProductId: varchar('similar_product_id', { length: 20 }).notNull().references(() => aliexpressProducts.productId, { onDelete: 'cascade' }),
  source:           varchar('source', { length: 20 }).notNull(),  // 'query' | 'smartmatch'
  textScore:        numeric('text_score', { precision: 3, scale: 2 }),
  firstSeenAt:      timestamp('first_seen_at').defaultNow().notNull(),
  lastSeenAt:       timestamp('last_seen_at').defaultNow().notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.masterProductId, t.similarProductId] }),
}));

export const aliexpressPriceHistory = pgTable('aliexpress_price_history', {
  id:         serial('id').primaryKey(),
  productId:  varchar('product_id', { length: 20 }).notNull().references(() => aliexpressProducts.productId, { onDelete: 'cascade' }),
  price:      numeric('price', { precision: 10, scale: 2 }).notNull(),
  currency:   varchar('currency', { length: 5 }).default('EUR').notNull(),
  scrapedAt:  timestamp('scraped_at').defaultNow().notNull(),
});

export type AliexpressProduct       = typeof aliexpressProducts.$inferSelect;
export type NewAliexpressProduct    = typeof aliexpressProducts.$inferInsert;
export type AliexpressUserTrack     = typeof aliexpressUserTracks.$inferSelect;
export type NewAliexpressUserTrack  = typeof aliexpressUserTracks.$inferInsert;
export type AliexpressSimilar       = typeof aliexpressSimilars.$inferSelect;
export type NewAliexpressSimilar    = typeof aliexpressSimilars.$inferInsert;

// Cross-marketplace: one Amazon product → at most one AliExpress equivalent.
// ae_product_id is nullable to record negative-cache ("checked, no match")
// so we don't re-query the API on every product-page view.
export const amazonAeEquivalents = pgTable('amazon_ae_equivalents', {
  amazonProductId:     integer('amazon_product_id').primaryKey().references(() => products.id, { onDelete: 'cascade' }),
  aeProductId:         varchar('ae_product_id', { length: 20 }).references(() => aliexpressProducts.productId, { onDelete: 'set null' }),
  textScore:           numeric('text_score', { precision: 3, scale: 2 }),
  aePriceSnapshot:     numeric('ae_price_snapshot',     { precision: 10, scale: 2 }),
  amazonPriceSnapshot: numeric('amazon_price_snapshot', { precision: 10, scale: 2 }),
  pctCheaper:          numeric('pct_cheaper', { precision: 5, scale: 2 }),
  isEligible:          boolean('is_eligible').default(false).notNull(),
  checkedAt:           timestamp('checked_at').defaultNow().notNull(),
});
export type AmazonAeEquivalent    = typeof amazonAeEquivalents.$inferSelect;
export type NewAmazonAeEquivalent = typeof amazonAeEquivalents.$inferInsert;

// Click log for the cross-marketplace nudge banner. Insert-only, never
// mutated. ae_product_id is stored as a plain string (no FK) on purpose
// so the click record outlives any AE catalog cleanup.
// Daily-aggregated view counter for the cross-marketplace nudge banner.
// Insert with ON CONFLICT DO UPDATE SET count = count + 1, so one row per
// (amazon_product, day) regardless of traffic. Drizzle's primaryKey() is
// applied via the second argument below.
export const aeNudgeViews = pgTable('ae_nudge_views', {
  amazonProductId: integer('amazon_product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  day:             text('day').notNull(),   // ISO 'YYYY-MM-DD'
  count:           integer('count').default(1).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.amazonProductId, t.day] }),
}));
export type AeNudgeView    = typeof aeNudgeViews.$inferSelect;
export type NewAeNudgeView = typeof aeNudgeViews.$inferInsert;

export const aeNudgeClicks = pgTable('ae_nudge_clicks', {
  id:               serial('id').primaryKey(),
  amazonProductId:  integer('amazon_product_id').references(() => products.id, { onDelete: 'cascade' }),
  aeProductId:      varchar('ae_product_id', { length: 20 }),
  userId:           integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  userAgent:        text('user_agent'),
  referer:          text('referer'),
  // 'banner'  : auto-nudge on /p/:asin (curated equivalent shown)
  // 'search'  : manual "Buscar en AliExpress" button on /p/:asin
  source:           varchar('source', { length: 20 }).default('banner').notNull(),
  clickedAt:        timestamp('clicked_at').defaultNow().notNull(),
});
export type AeNudgeClick    = typeof aeNudgeClicks.$inferSelect;
export type NewAeNudgeClick = typeof aeNudgeClicks.$inferInsert;

// ── Types ─────────────────────────────────────────────────────────────────────

export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type EmailVerification = typeof emailVerifications.$inferSelect;
export type NewEmailVerification = typeof emailVerifications.$inferInsert;

export type PasswordReset = typeof passwordResets.$inferSelect;
export type NewPasswordReset = typeof passwordResets.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export type UserProduct = typeof userProducts.$inferSelect;
export type NewUserProduct = typeof userProducts.$inferInsert;

export type PriceHistory = typeof priceHistory.$inferSelect;
export type NewPriceHistory = typeof priceHistory.$inferInsert;

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;

// ── Page Views ────────────────────────────────────────────────────────────────

export const pageViews = pgTable('page_views', {
  path: varchar('path', { length: 500 }).notNull(),
  day: text('day').notNull(),
  source: varchar('source', { length: 50 }).notNull().default('Directo'),
  deviceType: varchar('device_type', { length: 20 }).notNull().default('Escritorio'),
  count: integer('count').default(1).notNull(),
});

// ── Recommendation Lists ──────────────────────────────────────────────────────

export const recommendationLists = pgTable('recommendation_lists', {
  id: serial('id').primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 200 }).notNull(),
  description: text('description'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const recommendationItems = pgTable('recommendation_items', {
  id: serial('id').primaryKey(),
  listId: integer('list_id').notNull().references(() => recommendationLists.id, { onDelete: 'cascade' }),
  productId: integer('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
  note: text('note'),
  position: integer('position').default(0).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Amazon Category Sources ───────────────────────────────────────────────────

export const amazonCategorySources = pgTable('amazon_category_sources', {
  id: serial('id').primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  amazonUrl: text('amazon_url').notNull(),
  categoryId: integer('category_id').references(() => categories.id, { onDelete: 'set null' }),
  isActive: boolean('is_active').default(true).notNull(),
  lastImportedAt: timestamp('last_imported_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── App Settings ──────────────────────────────────────────────────────────────

export const appSettings = pgTable('app_settings', {
  key:       varchar('key',        { length: 100 }).primaryKey(),
  value:     text('value').notNull(),
  valueType: varchar('value_type', { length: 20 }).notNull().default('string'),
  label:     varchar('label',      { length: 200 }).notNull().default(''),
  hint:      text('hint'),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
