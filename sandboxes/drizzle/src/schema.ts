import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const customers = sqliteTable('customers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  metadata_source: text('metadata_source'),
  metadata_segment: text('metadata_segment'),
  created_at: text('created_at').notNull(),
});

export const products = sqliteTable('products', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull(),
  created_at: text('created_at').notNull(),
});

export const prices = sqliteTable('prices', {
  id: text('id').primaryKey(),
  product_id: text('product_id').notNull(),
  nickname: text('nickname').notNull(), // starter, growth, team, enterprise
  unit_amount: integer('unit_amount').notNull(),
  currency: text('currency').notNull(),
  billing_interval: text('billing_interval').notNull(),
  created_at: text('created_at').notNull(),
});

export const subscriptions = sqliteTable('subscriptions', {
  id: text('id').primaryKey(),
  customer_id: text('customer_id').notNull(),
  price_id: text('price_id').notNull(),
  status: text('status').notNull(), // active, trialing, canceled, past_due
  current_period_start: text('current_period_start').notNull(),
  current_period_end: text('current_period_end').notNull(),
  cancel_at_period_end: integer('cancel_at_period_end', { mode: 'boolean' }).notNull(),
  created_at: text('created_at').notNull(),
});

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  customer_id: text('customer_id').notNull(),
  subscription_id: text('subscription_id').notNull(),
  amount_due: integer('amount_due').notNull(),
  amount_paid: integer('amount_paid').notNull(),
  status: text('status').notNull(), // paid, open, void, uncollectible
  created_at: text('created_at').notNull(),
});

export const paymentIntents = sqliteTable('payment_intents', {
  id: text('id').primaryKey(),
  customer_id: text('customer_id').notNull(),
  amount: integer('amount').notNull(),
  currency: text('currency').notNull(),
  status: text('status').notNull(),
  created_at: text('created_at').notNull(),
});
