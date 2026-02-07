#!/usr/bin/env npx ts-node
/**
 * Smoke Test: Validate all sandbox configurations work correctly
 *
 * This test:
 * 1. Sets up each sandbox
 * 2. Manually writes a correct implementation
 * 3. Validates that the validator accepts it
 *
 * No API keys needed - tests the infrastructure only.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SandboxConfig, Task } from '../sandboxes/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const SANDBOXES_DIR = path.join(PROJECT_DIR, 'sandboxes');

// ============================================
// TEST IMPLEMENTATIONS (Known correct)
// ============================================

const TYPED_ARPU_IMPL = `
export function calculateARPU(invoices: StripeInvoice[]): number {
  const paid = invoices.filter(i => i.status === 'paid');
  const customers = new Set(paid.map(i => i.customer_id));
  const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
  return Math.round(total / customers.size);
}
`;

const DBT_ARPU_SQL = `
SELECT
  CAST(SUM(amount_paid) AS INTEGER) / COUNT(DISTINCT customer_id) as arpu
FROM invoices
WHERE status = 'paid'
`;

const DRIZZLE_ARPU_IMPL = `
export async function calculateARPU(): Promise<number> {
  const result = await db
    .select({
      total: sum(invoices.amount_paid),
      customers: countDistinct(invoices.customer_id),
    })
    .from(invoices)
    .where(eq(invoices.status, 'paid'));

  return Math.round(Number(result[0].total) / Number(result[0].customers));
}
`;

const CUBE_ARPU_MEASURE = `
    arpu: {
      type: 'number',
      sql: \`CAST(SUM(\${invoices.amount_paid}) AS REAL) / COUNT(DISTINCT \${invoices.customer_id})\`,
    },
`;

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
  const sandboxDir = path.join(PROJECT_DIR, 'sandbox-smoke', sandboxId);

  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy sandbox template
  copyRecursive(path.join(SANDBOXES_DIR, sandboxId), sandboxDir);

  // Copy data
  copyRecursive(path.join(PROJECT_DIR, 'data'), path.join(sandboxDir, 'data'));

  // Create package.json
  const packageJson = sandboxId === 'typed' || sandboxId === 'drizzle' || sandboxId === 'cube'
    ? { type: 'module' }
    : {};
  fs.writeFileSync(
    path.join(sandboxDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  return sandboxDir;
}

const TASK: Task = {
  id: 'arpu',
  name: 'Average Revenue Per User',
  description: 'Calculate ARPU',
  dataFile: 'invoices.json',
  functionName: 'calculateARPU',
  sqlFile: 'stg_arpu.sql',
  measureName: 'arpu',
  signature: 'calculateARPU(invoices: StripeInvoice[]): number',
  expectedValue: () => {
    const invoices = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'data/invoices.json'), 'utf8'));
    const paid = invoices.filter((i: any) => i.status === 'paid');
    const customers = new Set(paid.map((i: any) => i.customer_id));
    const total = paid.reduce((sum: number, i: any) => sum + i.amount_paid, 0);
    return Math.round(total / customers.size);
  },
  tolerance: 1,
};

// ============================================
// SMOKE TESTS
// ============================================

async function testTyped(): Promise<boolean> {
  console.log('\n--- Testing: typed ---');

  const sandboxDir = setupSandbox('typed');
  console.log(`  Sandbox: ${sandboxDir}`);

  // Read existing queries.ts and append our implementation
  const queriesPath = path.join(sandboxDir, 'src/analytics/queries.ts');
  const existing = fs.readFileSync(queriesPath, 'utf8');
  fs.writeFileSync(queriesPath, existing + TYPED_ARPU_IMPL);
  console.log('  Added calculateARPU function');

  // Load and run validator
  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  const result = await config.validate(sandboxDir, TASK);
  const expected = TASK.expectedValue();

  if (result.valid && Math.abs((result.actual ?? 0) - expected) <= TASK.tolerance) {
    console.log(`  ✓ PASS: Got ${result.actual}, expected ${expected}`);
    return true;
  } else {
    console.log(`  ✗ FAIL: ${result.error || `Got ${result.actual}, expected ${expected}`}`);
    return false;
  }
}

async function testDbt(): Promise<boolean> {
  console.log('\n--- Testing: dbt ---');

  const sandboxDir = setupSandbox('dbt');
  console.log(`  Sandbox: ${sandboxDir}`);

  // Write SQL model
  const sqlPath = path.join(sandboxDir, 'models/staging/stg_arpu.sql');
  fs.writeFileSync(sqlPath, DBT_ARPU_SQL);
  console.log('  Created stg_arpu.sql');

  // Load and run validator
  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  const result = await config.validate(sandboxDir, TASK);
  const expected = TASK.expectedValue();

  if (result.valid && Math.abs((result.actual ?? 0) - expected) <= TASK.tolerance) {
    console.log(`  ✓ PASS: Got ${result.actual}, expected ${expected}`);
    return true;
  } else {
    console.log(`  ✗ FAIL: ${result.error || `Got ${result.actual}, expected ${expected}`}`);
    return false;
  }
}

async function testDrizzle(): Promise<boolean> {
  console.log('\n--- Testing: drizzle ---');

  const sandboxDir = setupSandbox('drizzle');
  console.log(`  Sandbox: ${sandboxDir}`);

  // Read existing queries.ts and append our implementation
  const queriesPath = path.join(sandboxDir, 'src/queries.ts');
  const existing = fs.readFileSync(queriesPath, 'utf8');
  fs.writeFileSync(queriesPath, existing + DRIZZLE_ARPU_IMPL);
  console.log('  Added calculateARPU function');

  // Load and run validator
  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  const result = await config.validate(sandboxDir, TASK);
  const expected = TASK.expectedValue();

  if (result.valid && Math.abs((result.actual ?? 0) - expected) <= TASK.tolerance) {
    console.log(`  ✓ PASS: Got ${result.actual}, expected ${expected}`);
    return true;
  } else {
    console.log(`  ✗ FAIL: ${result.error || `Got ${result.actual}, expected ${expected}`}`);
    return false;
  }
}

async function testCube(): Promise<boolean> {
  console.log('\n--- Testing: cube ---');

  const sandboxDir = setupSandbox('cube');
  console.log(`  Sandbox: ${sandboxDir}`);

  // Read existing cubes.ts and add measure to invoicesCube
  const cubesPath = path.join(sandboxDir, 'src/cubes.ts');
  const existing = fs.readFileSync(cubesPath, 'utf8');

  // Insert measure after "Add your measures below:" comment
  const updated = existing.replace(
    '// Add your measures below:',
    '// Add your measures below:\n' + CUBE_ARPU_MEASURE
  );
  fs.writeFileSync(cubesPath, updated);
  console.log('  Added arpu measure');

  // Load and run validator
  const configModule = await import(path.join(sandboxDir, 'sandbox.config.ts'));
  const config: SandboxConfig = configModule.config;

  const result = await config.validate(sandboxDir, TASK);
  const expected = TASK.expectedValue();

  if (result.valid && Math.abs((result.actual ?? 0) - expected) <= TASK.tolerance) {
    console.log(`  ✓ PASS: Got ${result.actual}, expected ${expected}`);
    return true;
  } else {
    console.log(`  ✗ FAIL: ${result.error || `Got ${result.actual}, expected ${expected}`}`);
    return false;
  }
}

// ============================================
// MAIN
// ============================================

async function main() {
  console.log('='.repeat(60));
  console.log('SMOKE TEST: All Sandbox Validators');
  console.log('='.repeat(60));

  const expected = TASK.expectedValue();
  console.log(`\nExpected ARPU value: ${expected}`);

  const results: Record<string, boolean> = {};

  results.typed = await testTyped();
  results.dbt = await testDbt();
  results.drizzle = await testDrizzle();
  results.cube = await testCube();

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  let allPassed = true;
  for (const [sandbox, passed] of Object.entries(results)) {
    console.log(`  ${passed ? '✓' : '✗'} ${sandbox}`);
    if (!passed) allPassed = false;
  }

  console.log('='.repeat(60));

  if (allPassed) {
    console.log('\nAll smoke tests passed!');
    process.exit(0);
  } else {
    console.log('\nSome smoke tests failed.');
    process.exit(1);
  }
}

main().catch(console.error);
