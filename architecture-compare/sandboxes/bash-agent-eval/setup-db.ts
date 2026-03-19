/**
 * Create a SQLite database from the JSON data files.
 * Used by the SQL agent in the bash-agent-eval harness.
 *
 * Usage:
 *   node --experimental-strip-types sandboxes/bash-agent-eval/setup-db.ts [dataDir] [dbPath]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const DATA_FILES = [
  'api_usage',
  'chat_sessions',
  'customers',
  'features',
  'invoices',
  'organizations',
  'payment_intents',
  'prices',
  'products',
  'subscriptions',
  'users',
];

export function setupDatabase(dataDir: string, dbPath: string): void {
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  for (const file of DATA_FILES) {
    const filePath = path.join(dataDir, `${file}.json`);
    if (!fs.existsSync(filePath)) continue;

    const rows: Record<string, any>[] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (rows.length === 0) continue;

    const columns = Object.keys(rows[0]);
    const colDefs = columns.map(c => `"${c}" TEXT`).join(', ');
    db.exec(`CREATE TABLE IF NOT EXISTS "${file}" (${colDefs})`);

    const placeholders = columns.map(() => '?').join(', ');
    const insert = db.prepare(`INSERT INTO "${file}" (${columns.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`);

    const insertMany = db.transaction((items: Record<string, any>[]) => {
      for (const row of items) {
        insert.run(...columns.map(c => {
          const val = row[c];
          return val === null || val === undefined ? null : String(val);
        }));
      }
    });

    insertMany(rows);
  }

  db.close();
}

// CLI entry point
if (process.argv[1]?.endsWith('setup-db.ts')) {
  const dataDir = process.argv[2] || path.resolve(import.meta.dirname || '.', '../../data');
  const dbPath = process.argv[3] || path.resolve(import.meta.dirname || '.', 'data.sqlite');
  setupDatabase(dataDir, dbPath);
  console.log(`Database created at ${dbPath}`);
}
