// AppApprove app-owned tables (Phase 3.7 D). Independent of the
// Shopify-synced tables in schema.server.ts — these are records your app
// owns end-to-end (CRUD permitted, no Shopify round-trip needed).
//
// To add to the schema and migrate: append to schema.server.ts, then run
// `pnpm db:generate` to emit the next migration file under migrations/.

import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

// Per-shop app settings — config the merchant edits in your admin UI.
// Single row per shop; the JSON `value` column is the catch-all for
// schemaless config so you don't have to migrate when adding a new field.
export const appSettings = sqliteTable("app_settings", {
  shop: text("shop").primaryKey(),
  value: text("value", { mode: "json" }).notNull().$type<Record<string, unknown>>().$defaultFn(() => ({})),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
});

// Custom records — a generic key/value table per (shop, namespace, key).
// Useful as a starter for app-specific data without designing a new
// schema upfront. Replace with a typed table once your data shape
// stabilises.
export const customRecords = sqliteTable("custom_records", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shop: text("shop").notNull(),
  namespace: text("namespace").notNull(),
  key: text("key").notNull(),
  value: text("value", { mode: "json" }).notNull().$type<unknown>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  pk: index("custom_records_lookup_idx").on(table.shop, table.namespace, table.key),
}));

// ─── Subscriptions (Feature 1) ────────────────────────────────────────
// One row per active product subscription a customer holds on a shop.
// Status drives the dunning + skip/pause/cancel state machine.
export const subscriptions = sqliteTable("subscriptions", {
  id: text("id").primaryKey(),
  shop: text("shop").notNull(),
  customerRemoteId: text("customer_remote_id").notNull(),
  customerEmail: text("customer_email"),
  productRemoteId: text("product_remote_id").notNull(),
  variantRemoteId: text("variant_remote_id"),
  quantity: integer("quantity").notNull().default(1),
  intervalDays: integer("interval_days").notNull().default(30),
  status: text("status", {
    enum: ["active", "paused", "skipped", "cancelled", "past_due"],
  }).notNull().default("active"),
  nextChargeAt: integer("next_charge_at", { mode: "timestamp_ms" }),
  pausedUntil: integer("paused_until", { mode: "timestamp_ms" }),
  dunningAttempts: integer("dunning_attempts").notNull().default(0),
  lastDunningAt: integer("last_dunning_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopCustomerIdx: index("subscriptions_shop_customer_idx").on(table.shop, table.customerRemoteId),
  nextChargeIdx: index("subscriptions_next_charge_idx").on(table.nextChargeAt, table.status),
}));

// ─── Bundles (Feature 2) ──────────────────────────────────────────────
// A bundle pairs N product variants with a bundle-only price. Items are
// stored in JSON so a single row holds the full bundle definition.
export const bundles = sqliteTable("bundles", {
  id: text("id").primaryKey(),
  shop: text("shop").notNull(),
  title: text("title").notNull(),
  handle: text("handle").notNull(),
  priceCents: integer("price_cents").notNull(),
  currencyCode: text("currency_code").notNull().default("USD"),
  items: text("items", { mode: "json" })
    .notNull()
    .$type<Array<{ productRemoteId: string; variantRemoteId: string; quantity: number }>>(),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopHandleIdx: index("bundles_shop_handle_idx").on(table.shop, table.handle),
}));

// ─── Loyalty (Feature 3) ──────────────────────────────────────────────
// Wallet balance per (shop, customer). Mutations go through the ledger
// so balance can be rebuilt deterministically.
export const loyaltyAccounts = sqliteTable("loyalty_accounts", {
  shop: text("shop").notNull(),
  customerRemoteId: text("customer_remote_id").notNull(),
  customerEmail: text("customer_email"),
  pointsBalance: integer("points_balance").notNull().default(0),
  lifetimePoints: integer("lifetime_points").notNull().default(0),
  tier: text("tier", { enum: ["bronze", "silver", "gold", "platinum"] })
    .notNull()
    .default("bronze"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  pk: primaryKey({ columns: [table.shop, table.customerRemoteId] }),
}));

export const loyaltyLedger = sqliteTable("loyalty_ledger", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shop: text("shop").notNull(),
  customerRemoteId: text("customer_remote_id").notNull(),
  delta: integer("delta").notNull(),
  reason: text("reason", {
    enum: ["order_earned", "redemption", "manual_adjust", "expired", "refund"],
  }).notNull(),
  orderRemoteId: text("order_remote_id"),
  note: text("note"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopCustomerIdx: index("loyalty_ledger_shop_customer_idx").on(table.shop, table.customerRemoteId),
}));

// ─── Reviews (Feature 4) ──────────────────────────────────────────────
// Post-purchase review requests + submissions. requestedAt drives the
// outbound-email cron; submittedAt latches once the customer responds.
export const reviewRequests = sqliteTable("review_requests", {
  id: text("id").primaryKey(),
  shop: text("shop").notNull(),
  orderRemoteId: text("order_remote_id").notNull(),
  productRemoteId: text("product_remote_id").notNull(),
  customerEmail: text("customer_email").notNull(),
  customerRemoteId: text("customer_remote_id"),
  status: text("status", { enum: ["pending", "sent", "submitted", "bounced"] })
    .notNull()
    .default("pending"),
  scheduledFor: integer("scheduled_for", { mode: "timestamp_ms" }).notNull(),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
  token: text("token").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  scheduledIdx: index("review_requests_scheduled_idx").on(table.scheduledFor, table.status),
  shopOrderIdx: index("review_requests_shop_order_idx").on(table.shop, table.orderRemoteId),
  tokenIdx: index("review_requests_token_idx").on(table.token),
}));

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  shop: text("shop").notNull(),
  requestId: text("request_id"),
  productRemoteId: text("product_remote_id").notNull(),
  customerEmail: text("customer_email").notNull(),
  rating: integer("rating").notNull(),
  title: text("title"),
  body: text("body"),
  photoUrls: text("photo_urls", { mode: "json" }).$type<string[]>(),
  approved: integer("approved", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(() => new Date()),
}, (table) => ({
  shopProductIdx: index("reviews_shop_product_idx").on(table.shop, table.productRemoteId),
}));
