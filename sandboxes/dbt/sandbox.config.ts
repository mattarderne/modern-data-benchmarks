import type { SandboxConfig, Task, ValidationResult } from '../types';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const config: SandboxConfig = {
  id: 'dbt',
  name: 'DBT/SQL Models',

  contextFiles: [
    'models/staging/stg_stripe_invoices.sql',
    'models/staging/stg_stripe_subscriptions.sql',
  ],

  targetFile: 'models/staging/',

  systemPrompt: `You are creating a DBT SQL model.

Available tools:
<tool>read_file</tool><path>relative/path</path>
<tool>write_file</tool><path>relative/path</path><content>...</content>
<tool>list_files</tool><path>optional/dir</path>
<tool>done</tool>

CONSTRAINT: Your SQL will be executed directly against DuckDB.

IMPORTANT - Table names:
- Use plain table names: invoices, subscriptions, customers
- Do NOT use schema prefixes like "raw_stripe." - DuckDB doesn't have those
- Ignore any schema prefixes you see in existing files

REQUIREMENTS:
- Write valid SQL that executes in DuckDB
- Query MUST return a single row with the metric value
- Use standard SQL syntax (DuckDB is PostgreSQL-compatible)
- Do NOT use Jinja/DBT templating (no {{ config(...) }} or {{ ref(...) }})

WORKFLOW:
1. Read an existing staging model for patterns
2. Read the JSON data to see column names
3. Write your SQL model to models/staging/
4. Use <tool>done</tool> when complete`,

  taskPrompt: (task: Task) => `
TASK: Create SQL model "${task.sqlFile}" in models/staging/

Output should be a single row with a column containing the metric value.

${task.description}

Start by reading an existing staging model for reference.
`,

  validate: async (sandboxDir: string, task: Task): Promise<ValidationResult> => {
    const stagingDir = path.join(sandboxDir, 'models/staging');

    // Flexible SQL file name matching
    // e.g., stg_arpu.sql, arpu.sql, stg_arpu_metric.sql, arpu_model.sql
    const baseName = task.sqlFile.replace(/^stg_/, '').replace(/\.sql$/, ''); // arpu, churn_rate, ltv
    const variations = [
      task.sqlFile,                    // exact: stg_arpu.sql
      `${baseName}.sql`,               // just: arpu.sql
      `stg_${baseName}_metric.sql`,    // stg_arpu_metric.sql
      `${baseName}_model.sql`,         // arpu_model.sql
      `fct_${baseName}.sql`,           // fct_arpu.sql
    ];

    // Find the actual SQL file
    let actualSqlPath: string | null = null;
    if (fs.existsSync(stagingDir)) {
      const files = fs.readdirSync(stagingDir).filter(f => f.endsWith('.sql'));
      for (const variation of variations) {
        if (files.includes(variation)) {
          actualSqlPath = path.join(stagingDir, variation);
          break;
        }
      }

      // Relaxed matching: prefer any file that clearly targets the metric.
      if (!actualSqlPath && files.length > 0) {
        const normalizedBase = baseName.toLowerCase();
        const baseNoUnderscore = normalizedBase.replace(/_/g, '');
        const taskId = task.id.toLowerCase();

        const scoreFile = (file: string): number => {
          const name = file.toLowerCase();
          let score = 0;

          // Strong matches
          if (name === task.sqlFile.toLowerCase()) score += 100;
          if (name === `${normalizedBase}.sql`) score += 90;

          // Common variants
          if (name.includes(normalizedBase)) score += 50;
          if (name.includes(baseNoUnderscore)) score += 40;
          if (name.includes(taskId)) score += 30;
          if (name.includes(`stripe_${normalizedBase}`)) score += 30;
          if (name.includes(`stripe_${baseNoUnderscore}`)) score += 20;

          // Tokenized hints
          if (taskId === 'churn_rate' && name.includes('churn') && name.includes('rate')) score += 25;
          if (taskId === 'ltv' && name.includes('ltv')) score += 25;
          if (taskId === 'arpu' && name.includes('arpu')) score += 25;

          // Deprioritize base staging tables (not metrics)
          if (name.includes('stripe_invoices') || name.includes('stripe_subscriptions') ||
              name.includes('stripe_customers') || name.includes('stripe_products') ||
              name.includes('stripe_prices')) {
            score -= 20;
          }

          return score;
        };

        const best = files
          .map(f => ({ f, score: scoreFile(f) }))
          .sort((a, b) => b.score - a.score)[0];

        if (best && best.score > 0) {
          actualSqlPath = path.join(stagingDir, best.f);
        }
      }
    }

    if (!actualSqlPath || !fs.existsSync(actualSqlPath)) {
      return { valid: false, error: `No SQL file matching ${task.sqlFile} found in models/staging/` };
    }

    const sql = fs.readFileSync(actualSqlPath, 'utf8');

    if (!sql.toLowerCase().includes('select')) {
      return { valid: false, error: 'SQL does not contain SELECT' };
    }

    // Create DuckDB execution script
    const duckdbScript = `
const Database = require('duckdb').Database;
const fs = require('fs');

const db = new Database(':memory:');

db.exec(\`
  CREATE TABLE invoices AS SELECT * FROM read_json_auto('./data/invoices.json');
  CREATE TABLE subscriptions AS SELECT * FROM read_json_auto('./data/subscriptions.json');
  CREATE TABLE customers AS SELECT * FROM read_json_auto('./data/customers.json');
\`);

const sql = fs.readFileSync('${actualSqlPath}', 'utf8');

db.all(sql, (err, rows) => {
  if (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
  if (rows && rows.length > 0) {
    const row = rows[0];
    const value = Object.values(row).find(v => typeof v === 'number');
    console.log(JSON.stringify({ result: value }));
  } else {
    console.log(JSON.stringify({ error: 'No rows returned' }));
  }
  db.close();
});
`;

    const scriptPath = path.join(sandboxDir, 'run-sql.cjs');
    fs.writeFileSync(scriptPath, duckdbScript);

    try {
      const output = execSync('node run-sql.cjs 2>&1', {
        cwd: sandboxDir,
        encoding: 'utf8',
        timeout: 30000,
      });

      const parsed = JSON.parse(output.trim());
      if (parsed.error) {
        return { valid: false, error: `SQL error: ${parsed.error}` };
      }
      if (typeof parsed.result === 'number') {
        return { valid: true, actual: parsed.result };
      }
      return { valid: false, error: 'SQL did not return a number' };
    } catch (error: any) {
      const msg = error.stdout?.toString() || error.message;
      return { valid: false, error: `DuckDB error: ${msg.slice(0, 300)}` };
    }
  },
};
