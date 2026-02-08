import type { SandboxConfig, Task, ValidationResult } from '../types';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const config: SandboxConfig = {
  id: 'warehouse-dbt',
  name: 'Warehouse + DBT',

  contextFiles: [
    'models/staging/stg_app_users.sql',
    'models/staging/stg_app_organizations.sql',
    'models/staging/stg_app_api_usage.sql',
    'models/staging/stg_stripe_invoices.sql',
    'models/staging/stg_stripe_subscriptions.sql',
    'models/marts/dim_orgs.sql',
    'models/marts/fct_org_revenue.sql',
  ],

  targetFile: 'models/marts/',

  systemPrompt: `You are creating a DBT-style SQL model in a warehouse architecture.

Available tools:
<tool>read_file</tool><path>relative/path</path>
<tool>write_file</tool><path>relative/path</path><content>...</content>
<tool>list_files</tool><path>optional/dir</path>
<tool>done</tool>

CONSTRAINT: Your SQL will be executed directly against DuckDB.

RAW TABLES (warehouse sources):
- raw_app_organizations
- raw_app_users
- raw_app_api_usage
- raw_app_chat_sessions
- raw_app_features
- raw_stripe_customers
- raw_stripe_invoices
- raw_stripe_subscriptions
- raw_stripe_prices
- raw_stripe_products
- raw_stripe_payment_intents

You may also reference staging/mart models (stg_* / fct_* / dim_*) for patterns.

REQUIREMENTS:
- Write valid SQL that executes in DuckDB
- Query MUST return a single row with the metric value
- Use standard SQL syntax (DuckDB is PostgreSQL-compatible)
- Do NOT use Jinja/DBT templating (no {{ config(...) }} or {{ ref(...) }})

WORKFLOW:
1. Read existing staging or mart models for column names
2. Read the JSON data if needed
3. Write your SQL model to models/marts/
4. Use <tool>done</tool> when complete`,

  taskPrompt: (task: Task) => `
TASK: Create SQL model "${task.sqlFile}" in models/marts/

Output should be a single row with a column containing the metric value.

${task.description}

Start by reading an existing staging or mart model for reference.
`,

  validate: async (sandboxDir: string, task: Task): Promise<ValidationResult> => {
    const stagingDir = path.join(sandboxDir, 'models/staging');
    const martsDir = path.join(sandboxDir, 'models/marts');

    const baseName = task.sqlFile.replace(/^(stg_|fct_|dim_)/, '').replace(/\.sql$/, '');
    const variations = [
      task.sqlFile,
      `${baseName}.sql`,
      `fct_${baseName}.sql`,
      `stg_${baseName}.sql`,
      `dim_${baseName}.sql`,
      `metric_${baseName}.sql`,
      `${baseName}_metric.sql`,
    ];

    const candidateDirs = [martsDir, stagingDir];
    let actualSqlPath: string | null = null;

    for (const dir of candidateDirs) {
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
      for (const variation of variations) {
        if (files.includes(variation)) {
          actualSqlPath = path.join(dir, variation);
          break;
        }
      }
      if (actualSqlPath) break;
    }

    if (!actualSqlPath) {
      for (const dir of candidateDirs) {
        if (!fs.existsSync(dir)) continue;
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql'));
        if (files.length === 0) continue;

        const normalizedBase = baseName.toLowerCase();
        const baseNoUnderscore = normalizedBase.replace(/_/g, '');
        const taskId = task.id.toLowerCase();

        const scoreFile = (file: string): number => {
          const name = file.toLowerCase();
          let score = 0;
          if (name === task.sqlFile.toLowerCase()) score += 100;
          if (name === `${normalizedBase}.sql`) score += 90;
          if (name.includes(normalizedBase)) score += 50;
          if (name.includes(baseNoUnderscore)) score += 40;
          if (name.includes(taskId)) score += 30;
          if (taskId === 'org_churn_rate' && name.includes('churn')) score += 20;
          if (taskId === 'avg_org_ltv' && name.includes('ltv')) score += 20;
          if (taskId === 'active_user_arpu' && name.includes('arpu')) score += 20;
          return score;
        };

        const best = files
          .map(f => ({ f, score: scoreFile(f) }))
          .sort((a, b) => b.score - a.score)[0];

        if (best && best.score > 0) {
          actualSqlPath = path.join(dir, best.f);
          break;
        }
      }
    }

    if (!actualSqlPath || !fs.existsSync(actualSqlPath)) {
      return { valid: false, error: `No SQL file matching ${task.sqlFile} found in models/marts or models/staging` };
    }

    const sql = fs.readFileSync(actualSqlPath, 'utf8');
    if (!sql.toLowerCase().includes('select')) {
      return { valid: false, error: 'SQL does not contain SELECT' };
    }

    const viewStatements: string[] = [];
    const addViewsFromDir = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.sql')) continue;
        const fullPath = path.join(dir, file);
        if (fullPath === actualSqlPath) continue;
        const viewName = path.basename(file, '.sql');
        const viewSql = fs.readFileSync(fullPath, 'utf8').trim().replace(/;\s*$/, '');
        if (!viewSql.toLowerCase().includes('select')) continue;
        viewStatements.push(`CREATE OR REPLACE VIEW ${viewName} AS ${viewSql}`);
      }
    };

    addViewsFromDir(stagingDir);
    addViewsFromDir(martsDir);

    const duckdbScript = `
const Database = require('duckdb').Database;
const fs = require('fs');

const db = new Database(':memory:');

db.exec(\`
  CREATE TABLE raw_app_organizations AS SELECT * FROM read_json_auto('./data/organizations.json');
  CREATE TABLE raw_app_users AS SELECT * FROM read_json_auto('./data/users.json');
  CREATE TABLE raw_app_api_usage AS SELECT * FROM read_json_auto('./data/api_usage.json');
  CREATE TABLE raw_app_chat_sessions AS SELECT * FROM read_json_auto('./data/chat_sessions.json');
  CREATE TABLE raw_app_features AS SELECT * FROM read_json_auto('./data/features.json');

  CREATE TABLE raw_stripe_customers AS SELECT * FROM read_json_auto('./data/customers.json');
  CREATE TABLE raw_stripe_invoices AS SELECT * FROM read_json_auto('./data/invoices.json');
  CREATE TABLE raw_stripe_subscriptions AS SELECT * FROM read_json_auto('./data/subscriptions.json');
  CREATE TABLE raw_stripe_prices AS SELECT * FROM read_json_auto('./data/prices.json');
  CREATE TABLE raw_stripe_products AS SELECT * FROM read_json_auto('./data/products.json');
  CREATE TABLE raw_stripe_payment_intents AS SELECT * FROM read_json_auto('./data/payment_intents.json');
\`);

const views = ${JSON.stringify(viewStatements)};
for (const stmt of views) {
  try {
    db.exec(stmt);
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

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
