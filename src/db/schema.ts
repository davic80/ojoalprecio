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
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
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
  totalFailures: integer('total_failures').default(0).notNull(),
  isFailed: boolean('is_failed').default(false).notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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
