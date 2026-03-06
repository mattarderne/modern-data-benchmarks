-- Upstream app/ORM database tables (from app_surface/src/db.ts)
CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  stripe_customer_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE api_usage (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE chat_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  message_count INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE features (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  metadata_source TEXT,
  metadata_segment TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  nickname TEXT NOT NULL,
  unit_amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  billing_interval TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE subscriptions (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  price_id TEXT NOT NULL,
  status TEXT NOT NULL,
  current_period_start TEXT NOT NULL,
  current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  amount_due INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE payment_intents (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
