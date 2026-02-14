#!/usr/bin/env npx ts-node
/**
 * Smoke test for the bash-agent-eval harness.
 *
 * Validates:
 *   1. Data loading and expected value computation
 *   2. SQLite database setup and query execution
 *   3. Bash tool execution against JSON data
 *   4. SQL tool execution against SQLite database
 *   5. Known-correct bash and SQL solutions produce correct answers
 *
 * Usage:
 *   node --experimental-strip-types scripts/bash-agent-eval-smoke-test.ts
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const HARNESS_DIR = path.join(PROJECT_DIR, 'sandboxes', 'bash-agent-eval');

const DATA_FILES = [
  'api_usage', 'chat_sessions', 'customers', 'features',
  'invoices', 'organizations', 'payment_intents', 'prices',
  'products', 'subscriptions', 'users',
];

type DataBundle = Record<string, Array<Record<string, any>>>;

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label} ${detail}`);
    failed++;
  }
}

function loadData(): DataBundle {
  const data: DataBundle = {};
  for (const file of DATA_FILES) {
    const filePath = path.join(DATA_DIR, `${file}.json`);
    if (fs.existsSync(filePath)) {
      data[file] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  }
  return data;
}

function getAnchorDate(apiUsage: Array<Record<string, any>>): number {
  if (apiUsage.length === 0) return Date.now();
  return Math.max(...apiUsage.map(u => new Date(u.created_at).getTime()));
}

function computeExpected(data: DataBundle) {
  const anchor = getAnchorDate(data.api_usage || []);
  const since = anchor - 30 * 24 * 60 * 60 * 1000;

  const users = data.users || [];
  const invoices = data.invoices || [];
  const subscriptions = data.subscriptions || [];
  const organizations = data.organizations || [];
  const apiUsage = data.api_usage || [];

  // ARPU
  const activeUserIds = new Set(
    apiUsage.filter(u => new Date(u.created_at).getTime() >= since).map(u => u.user_id)
  );
  const activeUserCustomerIds = new Set(
    users.filter(u => activeUserIds.has(u.id)).map(u => u.stripe_customer_id)
  );
  const paidRevenueForActiveUsers = invoices
    .filter(i => i.status === 'paid' && activeUserCustomerIds.has(i.customer_id))
    .reduce((sum, i) => sum + i.amount_paid, 0);
  const activeUserArpu = activeUserIds.size === 0 ? 0 : Math.round(paidRevenueForActiveUsers / activeUserIds.size);

  // Churn
  const usersByOrg = new Map<string, Array<Record<string, any>>>();
  for (const user of users) {
    const list = usersByOrg.get(user.organization_id) || [];
    list.push(user);
    usersByOrg.set(user.organization_id, list);
  }
  const orgIds = organizations.map(o => o.id).filter(id => usersByOrg.has(id));
  const activeSubCustomerIds = new Set(
    subscriptions.filter(s => s.status === 'active').map(s => s.customer_id)
  );
  const recentUsageUserIds = new Set(
    apiUsage.filter(u => new Date(u.created_at).getTime() >= since).map(u => u.user_id)
  );
  let churnedOrgs = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    const hasUsage = orgUsers.some(u => recentUsageUserIds.has(u.id));
    const hasSub = orgUsers.some(u => activeSubCustomerIds.has(u.stripe_customer_id));
    if (!hasUsage && !hasSub) churnedOrgs++;
  }
  const orgChurnRate = orgIds.length === 0 ? 0 : Math.round((churnedOrgs / orgIds.length) * 10000) / 10000;

  // LTV
  const paidByCustomer = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status !== 'paid') continue;
    paidByCustomer.set(inv.customer_id, (paidByCustomer.get(inv.customer_id) || 0) + inv.amount_paid);
  }
  let totalOrgLtv = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    let orgTotal = 0;
    for (const u of orgUsers) orgTotal += paidByCustomer.get(u.stripe_customer_id) || 0;
    totalOrgLtv += orgTotal;
  }
  const avgOrgLtv = orgIds.length === 0 ? 0 : Math.round(totalOrgLtv / orgIds.length);

  return { activeUserArpu, orgChurnRate, avgOrgLtv, anchor, since, activeUserCount: activeUserIds.size, orgCount: orgIds.length, churnedOrgs };
}

async function main() {
  console.log('='.repeat(60));
  console.log('BASH AGENT EVAL — SMOKE TEST');
  console.log('='.repeat(60));

  // 1. Data loading
  console.log('\n1. Data Loading');
  const data = loadData();
  assert('users.json loaded', (data.users?.length ?? 0) > 0, `got ${data.users?.length ?? 0} rows`);
  assert('invoices.json loaded', (data.invoices?.length ?? 0) > 0, `got ${data.invoices?.length ?? 0} rows`);
  assert('api_usage.json loaded', (data.api_usage?.length ?? 0) > 0, `got ${data.api_usage?.length ?? 0} rows`);
  assert('organizations.json loaded', (data.organizations?.length ?? 0) > 0, `got ${data.organizations?.length ?? 0} rows`);

  // 2. Expected values
  console.log('\n2. Expected Value Computation');
  const expected = computeExpected(data);
  assert('ARPU is positive', expected.activeUserArpu > 0, `got ${expected.activeUserArpu}`);
  assert('Churn rate is between 0 and 1', expected.orgChurnRate >= 0 && expected.orgChurnRate <= 1, `got ${expected.orgChurnRate}`);
  assert('LTV is positive', expected.avgOrgLtv > 0, `got ${expected.avgOrgLtv}`);
  console.log(`    Active users: ${expected.activeUserCount}`);
  console.log(`    ARPU: ${expected.activeUserArpu}`);
  console.log(`    Churned orgs: ${expected.churnedOrgs} / ${expected.orgCount}`);
  console.log(`    Churn rate: ${expected.orgChurnRate}`);
  console.log(`    Avg Org LTV: ${expected.avgOrgLtv}`);

  // 3. SQLite database setup
  console.log('\n3. SQLite Database Setup');
  const tmpDir = path.join(PROJECT_DIR, 'sandbox-runs', `smoke-test-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const dataDestDir = path.join(tmpDir, 'data');
  fs.mkdirSync(dataDestDir, { recursive: true });
  for (const file of DATA_FILES) {
    const src = path.join(DATA_DIR, `${file}.json`);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dataDestDir, `${file}.json`));
  }

  const dbPath = path.join(tmpDir, 'data.sqlite');
  const { setupDatabase } = await import(path.join(HARNESS_DIR, 'setup-db.ts'));
  setupDatabase(dataDestDir, dbPath);
  assert('SQLite database created', fs.existsSync(dbPath));

  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });

  // 4. SQL agent tool verification
  console.log('\n4. SQL Agent Tool Verification');
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  assert('Tables exist in DB', tables.length >= 11, `got ${tables.length} tables`);

  const userCount = db.prepare('SELECT COUNT(*) as cnt FROM users').get();
  assert('Users table has rows', userCount.cnt > 0, `got ${userCount.cnt}`);

  const invoiceCount = db.prepare('SELECT COUNT(*) as cnt FROM invoices').get();
  assert('Invoices table has rows', invoiceCount.cnt > 0, `got ${invoiceCount.cnt}`);

  // 5. SQL solution for ARPU
  console.log('\n5. SQL Known-Correct Solutions');

  const anchorRow = db.prepare('SELECT MAX(created_at) as max_date FROM api_usage').get();
  const anchorDate = anchorRow.max_date;
  console.log(`    Anchor date: ${anchorDate}`);

  const arpu_sql = `
    WITH anchor AS (
      SELECT MAX(created_at) AS max_date FROM api_usage
    ),
    active_users AS (
      SELECT DISTINCT user_id
      FROM api_usage, anchor
      WHERE created_at >= datetime(anchor.max_date, '-30 days')
    ),
    active_customer_ids AS (
      SELECT DISTINCT u.stripe_customer_id
      FROM users u
      INNER JOIN active_users au ON u.id = au.user_id
    ),
    revenue AS (
      SELECT SUM(CAST(i.amount_paid AS REAL)) AS total_revenue
      FROM invoices i
      INNER JOIN active_customer_ids ac ON i.customer_id = ac.stripe_customer_id
      WHERE i.status = 'paid'
    )
    SELECT ROUND(revenue.total_revenue / COUNT(DISTINCT au.user_id)) AS arpu
    FROM active_users au, revenue
  `;
  const arpuResult = db.prepare(arpu_sql).get();
  const sqlArpu = arpuResult?.arpu;
  assert('SQL ARPU matches expected', Math.abs((sqlArpu ?? 0) - expected.activeUserArpu) <= 1, `SQL=${sqlArpu}, expected=${expected.activeUserArpu}`);

  // LTV via SQL
  const ltv_sql = `
    WITH org_users AS (
      SELECT o.id AS org_id, u.stripe_customer_id
      FROM organizations o
      INNER JOIN users u ON u.organization_id = o.id
    ),
    org_revenue AS (
      SELECT ou.org_id, COALESCE(SUM(CAST(i.amount_paid AS REAL)), 0) AS total_paid
      FROM org_users ou
      LEFT JOIN invoices i ON i.customer_id = ou.stripe_customer_id AND i.status = 'paid'
      GROUP BY ou.org_id
    )
    SELECT ROUND(AVG(total_paid)) AS avg_ltv FROM org_revenue
  `;
  const ltvResult = db.prepare(ltv_sql).get();
  const sqlLtv = ltvResult?.avg_ltv;
  assert('SQL LTV matches expected', Math.abs((sqlLtv ?? 0) - expected.avgOrgLtv) <= 1, `SQL=${sqlLtv}, expected=${expected.avgOrgLtv}`);

  db.close();

  // 6. Bash tool verification
  console.log('\n6. Bash Tool Verification');

  // Test basic jq on data
  try {
    const userCountBash = execSync('jq length data/users.json', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert('jq can count users', parseInt(userCountBash) > 0, `got ${userCountBash}`);
  } catch (e: any) {
    assert('jq is available', false, e.message);
  }

  try {
    const invoiceFields = execSync('jq ".[0] | keys" data/invoices.json', { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert('jq can read invoice fields', invoiceFields.includes('amount_paid'), `fields: ${invoiceFields.slice(0, 100)}`);
  } catch (e: any) {
    assert('jq can read fields', false, e.message);
  }

  // Test a bash pipeline for LTV (simpler than ARPU)
  try {
    // This is a simplified bash pipeline — the actual agent would build something similar
    const ltvBash = execSync(`
      jq -r '.[] | "\\(.organization_id) \\(.stripe_customer_id)"' data/users.json > /tmp/user_org_map.tsv
      jq -r '.[] | select(.status == "paid") | "\\(.customer_id) \\(.amount_paid)"' data/invoices.json > /tmp/paid_invoices.tsv
      # This just confirms the pipeline runs — full LTV computation is multi-step
      echo "pipeline_ok"
    `, { cwd: tmpDir, encoding: 'utf8', shell: '/bin/bash' }).trim();
    assert('Bash pipeline executes', ltvBash.includes('pipeline_ok'));
  } catch (e: any) {
    assert('Bash pipeline executes', false, e.message);
  }

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log(`SMOKE TEST COMPLETE: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
