import { pgTable, serial, varchar, text, boolean, timestamp, numeric, integer, uniqueIndex } from 'drizzle-orm/pg-core';

// ── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  email: varchar('email', { length: 255 }).notNull().unique(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
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
  isActive: boolean('is_active').default(true).notNull(),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

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
  thresholdPrice: numeric('threshold_price', { precision: 10, scale: 2 }).notNull(),
  notificationEmail: varchar('notification_email', { length: 255 }).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  notifiedAt: timestamp('notified_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export type PriceHistory = typeof priceHistory.$inferSelect;
export type NewPriceHistory = typeof priceHistory.$inferInsert;

export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
