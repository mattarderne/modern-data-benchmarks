#!/usr/bin/env npx ts-node
/**
 * Architecture Smoke Test: Validate app-typed, app-drizzle, warehouse-dbt sandboxes.
 * Writes known-correct implementations and ensures validators accept them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxConfig, Task } from '../sandboxes/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const SANDBOXES_DIR = path.join(PROJECT_DIR, 'sandboxes');

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

type DataBundle = Record<string, Array<Record<string, any>>>;

function loadData(): DataBundle {
  const data: DataBundle = {};
  for (const file of DATA_FILES) {
    const filePath = path.join(PROJECT_DIR, 'data', `${file}.json`);
    data[file] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
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

  const activeUserIds = new Set(
    apiUsage
      .filter(u => new Date(u.created_at).getTime() >= since)
      .map(u => u.user_id)
  );

  const activeUserCustomerIds = new Set(
    users
      .filter(u => activeUserIds.has(u.id))
      .map(u => u.stripe_customer_id)
  );

  const paidRevenueForActiveUsers = invoices
    .filter(i => i.status === 'paid' && activeUserCustomerIds.has(i.customer_id))
    .reduce((sum, i) => sum + i.amount_paid, 0);

  const activeUserCount = activeUserIds.size;
  const activeUserArpu = activeUserCount === 0 ? 0 : Math.round(paidRevenueForActiveUsers / activeUserCount);

  const usersByOrg = new Map<string, Array<Record<string, any>>>();
  for (const user of users) {
    const list = usersByOrg.get(user.organization_id) || [];
    list.push(user);
    usersByOrg.set(user.organization_id, list);
  }

  const orgIds = organizations
    .map(o => o.id)
    .filter(orgId => usersByOrg.has(orgId));

  const activeSubCustomerIds = new Set(
    subscriptions.filter(s => s.status === 'active').map(s => s.customer_id)
  );

  const recentUsageUserIds = new Set(
    apiUsage
      .filter(u => new Date(u.created_at).getTime() >= since)
      .map(u => u.user_id)
  );

  let churnedOrgs = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    const hasRecentUsage = orgUsers.some(u => recentUsageUserIds.has(u.id));
    const hasActiveSubscription = orgUsers.some(u => activeSubCustomerIds.has(u.stripe_customer_id));
    if (!hasRecentUsage && !hasActiveSubscription) {
      churnedOrgs += 1;
    }
  }

  const orgChurnRate = orgIds.length === 0
    ? 0
    : Math.round((churnedOrgs / orgIds.length) * 10000) / 10000;

  const paidByCustomer = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.status !== 'paid') continue;
    const total = paidByCustomer.get(invoice.customer_id) || 0;
    paidByCustomer.set(invoice.customer_id, total + invoice.amount_paid);
  }

  let totalOrgLtv = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    let orgTotal = 0;
    for (const user of orgUsers) {
      orgTotal += paidByCustomer.get(user.stripe_customer_id) || 0;
    }
    totalOrgLtv += orgTotal;
  }

  const avgOrgLtv = orgIds.length === 0 ? 0 : Math.round(totalOrgLtv / orgIds.length);

  return { activeUserArpu, orgChurnRate, avgOrgLtv };
}

const APP_TYPED_IMPL = `
export function calculateActiveUserARPU(users: User[], apiUsage: ApiUsage[], invoices: StripeInvoice[]): number {
  if (apiUsage.length === 0) return 0;
  const latest = apiUsage.reduce((max, u) => {
    const t = new Date(u.created_at).getTime();
    return t > max ? t : max;
  }, 0);
  const since = latest - 30 * 24 * 60 * 60 * 1000;

  const activeUserIds = new Set(
    apiUsage
      .filter(u => new Date(u.created_at).getTime() >= since)
      .map(u => u.user_id)
  );

  const activeCustomerIds = new Set(
    users.filter(u => activeUserIds.has(u.id)).map(u => u.stripe_customer_id)
  );

  const total = invoices
    .filter(i => i.status === 'paid' && activeCustomerIds.has(i.customer_id))
    .reduce((sum, i) => sum + i.amount_paid, 0);

  return activeUserIds.size === 0 ? 0 : Math.round(total / activeUserIds.size);
}

export function calculateOrgChurnRate(
  organizations: Organization[],
  users: User[],
  subscriptions: StripeSubscription[],
  apiUsage: ApiUsage[]
): number {
  if (apiUsage.length === 0) return 0;
  const latest = apiUsage.reduce((max, u) => {
    const t = new Date(u.created_at).getTime();
    return t > max ? t : max;
  }, 0);
  const since = latest - 30 * 24 * 60 * 60 * 1000;

  const usersByOrg = new Map<string, User[]>();
  for (const user of users) {
    const list = usersByOrg.get(user.organization_id) || [];
    list.push(user);
    usersByOrg.set(user.organization_id, list);
  }

  const orgIds = organizations.map(o => o.id).filter(id => usersByOrg.has(id));

  const activeSubCustomers = new Set(
    subscriptions.filter(s => s.status === 'active').map(s => s.customer_id)
  );
  const recentUsageUsers = new Set(
    apiUsage.filter(u => new Date(u.created_at).getTime() >= since).map(u => u.user_id)
  );

  let churned = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    const hasRecentUsage = orgUsers.some(u => recentUsageUsers.has(u.id));
    const hasActiveSubscription = orgUsers.some(u => activeSubCustomers.has(u.stripe_customer_id));
    if (!hasRecentUsage && !hasActiveSubscription) churned += 1;
  }

  if (orgIds.length === 0) return 0;
  return Math.round((churned / orgIds.length) * 10000) / 10000;
}

export function calculateAvgOrgLTV(organizations: Organization[], users: User[], invoices: StripeInvoice[]): number {
  const usersByOrg = new Map<string, User[]>();
  for (const user of users) {
    const list = usersByOrg.get(user.organization_id) || [];
    list.push(user);
    usersByOrg.set(user.organization_id, list);
  }

  const orgIds = organizations.map(o => o.id).filter(id => usersByOrg.has(id));

  const paidByCustomer = new Map<string, number>();
  for (const invoice of invoices) {
    if (invoice.status !== 'paid') continue;
    const total = paidByCustomer.get(invoice.customer_id) || 0;
    paidByCustomer.set(invoice.customer_id, total + invoice.amount_paid);
  }

  let total = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    let orgTotal = 0;
    for (const user of orgUsers) {
      orgTotal += paidByCustomer.get(user.stripe_customer_id) || 0;
    }
    total += orgTotal;
  }

  if (orgIds.length === 0) return 0;
  return Math.round(total / orgIds.length);
}
`;

const APP_DRIZZLE_IMPL = `
export async function calculateActiveUserARPU(): Promise<number> {
  const usage = await db.select({ user_id: apiUsage.user_id, created_at: apiUsage.created_at }).from(apiUsage);
  if (usage.length === 0) return 0;

  const latest = usage.reduce((max, u) => {
    const t = new Date(u.created_at).getTime();
    return t > max ? t : max;
  }, 0);
  const since = latest - 30 * 24 * 60 * 60 * 1000;

  const activeUserIds = new Set(
    usage.filter(u => new Date(u.created_at).getTime() >= since).map(u => u.user_id)
  );

  const allUsers = await db.select({ id: users.id, stripe_customer_id: users.stripe_customer_id }).from(users);
  const activeCustomerIds = new Set(
    allUsers.filter(u => activeUserIds.has(u.id)).map(u => u.stripe_customer_id)
  );

  const allInvoices = await db.select({ customer_id: invoices.customer_id, amount_paid: invoices.amount_paid, status: invoices.status }).from(invoices);
  const total = allInvoices
    .filter(i => i.status === 'paid' && activeCustomerIds.has(i.customer_id))
    .reduce((sum, i) => sum + Number(i.amount_paid), 0);

  return activeUserIds.size === 0 ? 0 : Math.round(total / activeUserIds.size);
}

export async function calculateOrgChurnRate(): Promise<number> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const allUsers = await db.select({ id: users.id, organization_id: users.organization_id, stripe_customer_id: users.stripe_customer_id }).from(users);
  const subs = await db.select({ customer_id: subscriptions.customer_id, status: subscriptions.status }).from(subscriptions);
  const usage = await db.select({ user_id: apiUsage.user_id, created_at: apiUsage.created_at }).from(apiUsage);

  if (usage.length === 0) return 0;

  const latest = usage.reduce((max, u) => {
    const t = new Date(u.created_at).getTime();
    return t > max ? t : max;
  }, 0);
  const since = latest - 30 * 24 * 60 * 60 * 1000;

  const usersByOrg = new Map<string, Array<{ id: string; stripe_customer_id: string }>>();
  for (const user of allUsers) {
    const list = usersByOrg.get(user.organization_id) || [];
    list.push({ id: user.id, stripe_customer_id: user.stripe_customer_id });
    usersByOrg.set(user.organization_id, list);
  }

  const orgIds = orgs.map(o => o.id).filter(id => usersByOrg.has(id));

  const activeSubCustomers = new Set(subs.filter(s => s.status === 'active').map(s => s.customer_id));
  const recentUsageUsers = new Set(usage.filter(u => new Date(u.created_at).getTime() >= since).map(u => u.user_id));

  let churned = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    const hasRecentUsage = orgUsers.some(u => recentUsageUsers.has(u.id));
    const hasActiveSubscription = orgUsers.some(u => activeSubCustomers.has(u.stripe_customer_id));
    if (!hasRecentUsage && !hasActiveSubscription) churned += 1;
  }

  if (orgIds.length === 0) return 0;
  return Math.round((churned / orgIds.length) * 10000) / 10000;
}

export async function calculateAvgOrgLTV(): Promise<number> {
  const orgs = await db.select({ id: organizations.id }).from(organizations);
  const allUsers = await db.select({ id: users.id, organization_id: users.organization_id, stripe_customer_id: users.stripe_customer_id }).from(users);
  const allInvoices = await db.select({ customer_id: invoices.customer_id, amount_paid: invoices.amount_paid, status: invoices.status }).from(invoices);

  const usersByOrg = new Map<string, Array<{ stripe_customer_id: string }>>();
  for (const user of allUsers) {
    const list = usersByOrg.get(user.organization_id) || [];
    list.push({ stripe_customer_id: user.stripe_customer_id });
    usersByOrg.set(user.organization_id, list);
  }

  const orgIds = orgs.map(o => o.id).filter(id => usersByOrg.has(id));

  const paidByCustomer = new Map<string, number>();
  for (const invoice of allInvoices) {
    if (invoice.status !== 'paid') continue;
    const total = paidByCustomer.get(invoice.customer_id) || 0;
    paidByCustomer.set(invoice.customer_id, total + Number(invoice.amount_paid));
  }

  let total = 0;
  for (const orgId of orgIds) {
    const orgUsers = usersByOrg.get(orgId) || [];
    let orgTotal = 0;
    for (const user of orgUsers) {
      orgTotal += paidByCustomer.get(user.stripe_customer_id) || 0;
    }
    total += orgTotal;
  }

  if (orgIds.length === 0) return 0;
  return Math.round(total / orgIds.length);
}
`;

const WAREHOUSE_SQL = {
  active_user_arpu: `
with latest_usage as (
  select max(cast(usage_created_at as timestamp)) as latest_ts
  from stg_app_api_usage
),
active_usage as (
  select u.user_id
  from stg_app_api_usage u
  cross join latest_usage l
  where cast(u.usage_created_at as timestamp) >= l.latest_ts - interval '30 days'
  group by 1
),
active_users as (
  select au.user_id, u.stripe_customer_id
  from active_usage au
  join stg_app_users u on u.user_id = au.user_id
),
active_customers as (
  select distinct stripe_customer_id
  from active_users
)
select
  case when (select count(distinct user_id) from active_users) = 0 then 0
       else sum(case when i.status = 'paid' then i.amount_paid else 0 end)
            / (select count(distinct user_id) from active_users)
  end as active_user_arpu
from active_customers
left join stg_stripe_invoices i
  on i.customer_id = active_customers.stripe_customer_id;
`,
  org_churn_rate: `
with latest_usage as (
  select max(cast(usage_created_at as timestamp)) as latest_ts
  from stg_app_api_usage
),
org_users as (
  select organization_id, user_id, stripe_customer_id
  from stg_app_users
),
orgs_with_users as (
  select distinct organization_id
  from org_users
),
active_subs as (
  select distinct customer_id
  from stg_stripe_subscriptions
  where status = 'active'
),
recent_usage_users as (
  select distinct user_id
  from stg_app_api_usage, latest_usage
  where cast(usage_created_at as timestamp) >= latest_ts - interval '30 days'
),
org_flags as (
  select
    o.organization_id,
    max(case when ru.user_id is not null then 1 else 0 end) as has_recent_usage,
    max(case when a.customer_id is not null then 1 else 0 end) as has_active_sub
  from orgs_with_users o
  join org_users u on u.organization_id = o.organization_id
  left join recent_usage_users ru on ru.user_id = u.user_id
  left join active_subs a on a.customer_id = u.stripe_customer_id
  group by 1
)
select
  case when count(*) = 0 then 0
       else round(sum(case when has_recent_usage = 0 and has_active_sub = 0 then 1 else 0 end) * 1.0 / count(*), 4)
  end as org_churn_rate
from org_flags;
`,
  avg_org_ltv: `
with org_users as (
  select organization_id, stripe_customer_id
  from stg_app_users
),
orgs_with_users as (
  select distinct organization_id
  from org_users
),
paid_by_customer as (
  select customer_id, sum(amount_paid) as total_paid
  from stg_stripe_invoices
  where status = 'paid'
  group by 1
),
org_ltv as (
  select
    o.organization_id,
    coalesce(sum(p.total_paid), 0) as org_total
  from orgs_with_users o
  join org_users u on u.organization_id = o.organization_id
  left join paid_by_customer p on p.customer_id = u.stripe_customer_id
  group by 1
)
select
  case when count(*) = 0 then 0
       else round(avg(org_total), 0)
  end as avg_org_ltv
from org_ltv;
`,
};

// ============================================
// HELPERS
// ============================================

function copyRecursive(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (entry === 'node_modules' || entry === '.git') continue;
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

function setupSandbox(sandboxId: string): string {
  const sandboxDir = path.join(PROJECT_DIR, 'sandbox-smoke-architecture', sandboxId);

  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  copyRecursive(path.join(SANDBOXES_DIR, sandboxId), sandboxDir);
  copyRecursive(path.join(PROJECT_DIR, 'data'), path.join(sandboxDir, 'data'));

  const packageJson = sandboxId === 'app-typed' || sandboxId === 'app-drizzle'
    ? { type: 'module' }
    : {};
  fs.writeFileSync(path.join(sandboxDir, 'package.json'), JSON.stringify(packageJson, null, 2));

  return sandboxDir;
}

const TASKS: Task[] = [
  {
    id: 'active_user_arpu',
    name: 'Active User ARPU',
    description: 'Calculate ARPU for active users',
    dataFile: 'invoices',
    dataFiles: ['users', 'api_usage', 'invoices'],
    functionName: 'calculateActiveUserARPU',
    sqlFile: 'fct_active_user_arpu.sql',
    measureName: 'active_user_arpu',
    signature: 'calculateActiveUserARPU(users: User[], apiUsage: ApiUsage[], invoices: StripeInvoice[]): number',
    expectedValue: () => 0,
    tolerance: 1,
  },
  {
    id: 'org_churn_rate',
    name: 'Organization Churn Rate',
    description: 'Calculate organization churn rate',
    dataFile: 'subscriptions',
    dataFiles: ['organizations', 'users', 'subscriptions', 'api_usage'],
    functionName: 'calculateOrgChurnRate',
    sqlFile: 'fct_org_churn_rate.sql',
    measureName: 'org_churn_rate',
    signature: 'calculateOrgChurnRate(organizations: Organization[], users: User[], subscriptions: StripeSubscription[], apiUsage: ApiUsage[]): number',
    expectedValue: () => 0,
    tolerance: 0.001,
  },
  {
    id: 'avg_org_ltv',
    name: 'Average Org LTV',
    description: 'Calculate average organization LTV',
    dataFile: 'invoices',
    dataFiles: ['organizations', 'users', 'invoices'],
    functionName: 'calculateAvgOrgLTV',
    sqlFile: 'fct_avg_org_ltv.sql',
    measureName: 'avg_org_ltv',
    signature: 'calculateAvgOrgLTV(organizations: Organization[], users: User[], invoices: StripeInvoice[]): number',
    expectedValue: () => 0,
    tolerance: 1,
  },
];

async function testAppTyped(expected: ReturnType<typeof computeExpected>): Promise<boolean> {
  console.log('\n--- Testing: app-typed ---');
  const sandboxDir = setupSandbox('app-typed');

  const queriesPath = path.join(sandboxDir, 'src/analytics/queries.ts');
  const existing = fs.readFileSync(queriesPath, 'utf8');
  let updated = existing;
  if (!existing.includes("../types/internal")) {
    updated = `import type { Organization, User, ApiUsage } from '../types/internal';\n` + existing;
  }
  if (!updated.includes("../types/stripe")) {
    updated = `import type { StripeInvoice, StripeSubscription } from '../types/stripe';\n` + updated;
  }
  fs.writeFileSync(queriesPath, updated + APP_TYPED_IMPL);

  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  let allPass = true;
  for (const task of TASKS) {
    const result = await config.validate(sandboxDir, task);
    const expectedValue = task.id === 'active_user_arpu' ? expected.activeUserArpu
      : task.id === 'org_churn_rate' ? expected.orgChurnRate
      : expected.avgOrgLtv;

    const diff = Math.abs((result.actual ?? 0) - expectedValue);
    const pass = result.valid && diff <= task.tolerance;
    console.log(`  ${pass ? '✓' : '✗'} ${task.id} (got ${result.actual}, expected ${expectedValue})`);
    if (!pass) allPass = false;
  }

  return allPass;
}

async function testAppDrizzle(expected: ReturnType<typeof computeExpected>): Promise<boolean> {
  console.log('\n--- Testing: app-drizzle ---');
  const sandboxDir = setupSandbox('app-drizzle');

  const queriesPath = path.join(sandboxDir, 'src/queries.ts');
  const existing = fs.readFileSync(queriesPath, 'utf8');
  fs.writeFileSync(queriesPath, existing + APP_DRIZZLE_IMPL);

  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  let allPass = true;
  for (const task of TASKS) {
    const result = await config.validate(sandboxDir, task);
    const expectedValue = task.id === 'active_user_arpu' ? expected.activeUserArpu
      : task.id === 'org_churn_rate' ? expected.orgChurnRate
      : expected.avgOrgLtv;

    const diff = Math.abs((result.actual ?? 0) - expectedValue);
    const pass = result.valid && diff <= task.tolerance;
    console.log(`  ${pass ? '✓' : '✗'} ${task.id} (got ${result.actual}, expected ${expectedValue})`);
    if (!pass) allPass = false;
  }

  return allPass;
}

async function testWarehouseDbt(expected: ReturnType<typeof computeExpected>): Promise<boolean> {
  console.log('\n--- Testing: warehouse-dbt ---');
  const sandboxDir = setupSandbox('warehouse-dbt');

  fs.writeFileSync(path.join(sandboxDir, 'models/marts/fct_active_user_arpu.sql'), WAREHOUSE_SQL.active_user_arpu.trim());
  fs.writeFileSync(path.join(sandboxDir, 'models/marts/fct_org_churn_rate.sql'), WAREHOUSE_SQL.org_churn_rate.trim());
  fs.writeFileSync(path.join(sandboxDir, 'models/marts/fct_avg_org_ltv.sql'), WAREHOUSE_SQL.avg_org_ltv.trim());

  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  let allPass = true;
  for (const task of TASKS) {
    const result = await config.validate(sandboxDir, task);
    const expectedValue = task.id === 'active_user_arpu' ? expected.activeUserArpu
      : task.id === 'org_churn_rate' ? expected.orgChurnRate
      : expected.avgOrgLtv;

    const diff = Math.abs((result.actual ?? 0) - expectedValue);
    const pass = result.valid && diff <= task.tolerance;
    console.log(`  ${pass ? '✓' : '✗'} ${task.id} (got ${result.actual}, expected ${expectedValue})`);
    if (!pass) allPass = false;
  }

  return allPass;
}

async function main() {
  console.log('='.repeat(60));
  console.log('ARCHITECTURE SMOKE TEST');
  console.log('='.repeat(60));

  const data = loadData();
  const expected = computeExpected(data);

  console.log(`Expected active_user_arpu: ${expected.activeUserArpu}`);
  console.log(`Expected org_churn_rate: ${expected.orgChurnRate}`);
  console.log(`Expected avg_org_ltv: ${expected.avgOrgLtv}`);

  const results: Record<string, boolean> = {};
  results['app-typed'] = await testAppTyped(expected);
  results['app-drizzle'] = await testAppDrizzle(expected);
  results['warehouse-dbt'] = await testWarehouseDbt(expected);

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  for (const [sandbox, passed] of Object.entries(results)) {
    console.log(`  ${passed ? '✓' : '✗'} ${sandbox}`);
  }

  const allPass = Object.values(results).every(Boolean);
  if (!allPass) {
    console.log('\nSome architecture smoke tests failed.');
    process.exitCode = 1;
  } else {
    console.log('\nAll architecture smoke tests passed.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
