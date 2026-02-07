import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.ts';

// Create in-memory database
const sqlite = new Database(':memory:');

export const db = drizzle(sqlite, { schema });

import fs from 'node:fs';
import path from 'node:path';

// Helper to load JSON data into the database
export function loadData(dataDir: string) {

  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      metadata_source TEXT,
      metadata_segment TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      active INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prices (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      nickname TEXT NOT NULL,
      unit_amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      billing_interval TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      price_id TEXT NOT NULL,
      status TEXT NOT NULL,
      current_period_start TEXT NOT NULL,
      current_period_end TEXT NOT NULL,
      cancel_at_period_end INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      subscription_id TEXT NOT NULL,
      amount_due INTEGER NOT NULL,
      amount_paid INTEGER NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS payment_intents (
      id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Load data from JSON files
  const tables = ['customers', 'invoices', 'subscriptions', 'prices', 'products'];

  for (const table of tables) {
    const jsonPath = path.join(dataDir, `${table}.json`);
    if (fs.existsSync(jsonPath)) {
      const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));

      for (const row of data) {
        // Flatten metadata for customers
        if (table === 'customers' && row.metadata) {
          row.metadata_source = row.metadata.source;
          row.metadata_segment = row.metadata.segment;
          delete row.metadata;
        }

        // Convert booleans to integers for SQLite
        for (const key of Object.keys(row)) {
          if (typeof row[key] === 'boolean') {
            row[key] = row[key] ? 1 : 0;
          }
        }

        const columns = Object.keys(row).join(', ');
        const placeholders = Object.keys(row).map(() => '?').join(', ');
        const values = Object.values(row);

        try {
          sqlite.prepare(`INSERT OR IGNORE INTO ${table} (${columns}) VALUES (${placeholders})`).run(...values);
        } catch (e) {
          // Ignore insert errors for duplicate keys
        }
      }
    }
  }
}

export { sqlite };
