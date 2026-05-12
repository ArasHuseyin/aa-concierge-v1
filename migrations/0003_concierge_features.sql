-- AA Concierge V1 — feature tables: product subscriptions (with dunning),
-- bundles, loyalty (accounts + ledger), and post-purchase review requests
-- + submissions. Hand-written because the app-tables schema lives outside
-- of drizzle.config.ts's schema entry; future schema edits should regenerate
-- this migration via drizzle-kit once the config is widened to include
-- app-tables.schema.server.ts.

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  customer_remote_id TEXT NOT NULL,
  customer_email TEXT,
  product_remote_id TEXT NOT NULL,
  variant_remote_id TEXT,
  quantity INTEGER NOT NULL DEFAULT 1,
  interval_days INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active',
  next_charge_at INTEGER,
  paused_until INTEGER,
  dunning_attempts INTEGER NOT NULL DEFAULT 0,
  last_dunning_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX subscriptions_shop_customer_idx ON subscriptions(shop, customer_remote_id);
CREATE INDEX subscriptions_next_charge_idx ON subscriptions(next_charge_at, status);

CREATE TABLE bundles (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  title TEXT NOT NULL,
  handle TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency_code TEXT NOT NULL DEFAULT 'USD',
  items TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX bundles_shop_handle_idx ON bundles(shop, handle);

CREATE TABLE loyalty_accounts (
  shop TEXT NOT NULL,
  customer_remote_id TEXT NOT NULL,
  customer_email TEXT,
  points_balance INTEGER NOT NULL DEFAULT 0,
  lifetime_points INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'bronze',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (shop, customer_remote_id)
);

CREATE TABLE loyalty_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  customer_remote_id TEXT NOT NULL,
  delta INTEGER NOT NULL,
  reason TEXT NOT NULL,
  order_remote_id TEXT,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX loyalty_ledger_shop_customer_idx ON loyalty_ledger(shop, customer_remote_id);

CREATE TABLE review_requests (
  id TEXT PRIMARY KEY,
  shop TEXT NOT NULL,
  order_remote_id TEXT NOT NULL,
  product_remote_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  customer_remote_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_for INTEGER NOT NULL,
  sent_at INTEGER,
  submitted_at INTEGER,
  token TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX review_requests_scheduled_idx ON review_requests(scheduled_for, status);
CREATE INDEX review_requests_shop_order_idx ON review_requests(shop, order_remote_id);
CREATE INDEX review_requests_token_idx ON review_requests(token);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop TEXT NOT NULL,
  request_id TEXT,
  product_remote_id TEXT NOT NULL,
  customer_email TEXT NOT NULL,
  rating INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  photo_urls TEXT,
  approved INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX reviews_shop_product_idx ON reviews(shop, product_remote_id);
