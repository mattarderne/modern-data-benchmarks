#!/usr/bin/env npx ts-node
/**
 * Simple Edit Benchmark
 *
 * Tests: Given existing infrastructure, can an LLM correctly edit files
 * to add new analytics capabilities?
 *
 * Approach:
 * 1. Show the agent the existing file(s)
 * 2. Ask it to add a new function
 * 3. It outputs the complete edited file
 * 4. We run validation code against the edit
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');

interface Task {
  id: string;
  description: string;
  existingFile: string;
  expectedFunctionName: string;
  validationCode: string; // JS code that imports from edited file and returns expected value
}

const TASKS: Task[] = [
  {
    id: 'arpu',
    description: `Add a function called "calculateARPU" that calculates Average Revenue Per User.
ARPU = total paid invoice amount / count of unique paying customers.
The function should take (invoices, customers) as parameters and return a number (rounded to nearest integer).`,
    existingFile: 'typed/src/analytics/queries.ts',
    expectedFunctionName: 'calculateARPU',
    validationCode: `
      const invoices = require('./data/invoices.json');
      const customers = require('./data/customers.json');
      const paid = invoices.filter(i => i.status === 'paid');
      const uniqueCustomers = new Set(paid.map(i => i.customer_id));
      const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
      return Math.round(total / uniqueCustomers.size);
    `,
  },
  {
    id: 'churn_rate',
    description: `Add a function called "calculateChurnRate" that calculates subscription churn rate.
Churn rate = (active subscriptions with cancel_at_period_end=true) / (total active subscriptions).
The function should take (subscriptions) as parameter and return a decimal (4 decimal places).`,
    existingFile: 'typed/src/analytics/queries.ts',
    expectedFunctionName: 'calculateChurnRate',
    validationCode: `
      const subs = require('./data/subscriptions.json');
      const active = subs.filter(s => s.status === 'active');
      const churning = active.filter(s => s.cancel_at_period_end).length;
      return Math.round((churning / active.length) * 10000) / 10000;
    `,
  },
  {
    id: 'ltv',
    description: `Add a function called "calculateCustomerLTV" that calculates average customer lifetime value.
LTV = average of (total paid invoices per customer).
The function should take (invoices) as parameter and return a number (rounded to nearest integer).`,
    existingFile: 'typed/src/analytics/queries.ts',
    expectedFunctionName: 'calculateCustomerLTV',
    validationCode: `
      const invoices = require('./data/invoices.json');
      const paid = invoices.filter(i => i.status === 'paid');
      const byCustomer = {};
      paid.forEach(i => { byCustomer[i.customer_id] = (byCustomer[i.customer_id] || 0) + i.amount_paid; });
      const values = Object.values(byCustomer);
      return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    `,
  },
];

const DBT_TASKS: Task[] = [
  {
    id: 'arpu_sql',
    description: `Add a new staging model "stg_arpu.sql" that calculates Average Revenue Per User.
ARPU = total paid invoice amount / count of unique paying customers.
Use the existing staging model patterns. The query should produce a single row with arpu column.`,
    existingFile: 'warehouse/models/staging/stg_stripe_invoices.sql',
    expectedFunctionName: 'stg_arpu',
    validationCode: `
      const invoices = require('./data/invoices.json');
      const paid = invoices.filter(i => i.status === 'paid');
      const uniqueCustomers = new Set(paid.map(i => i.customer_id));
      const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
      return Math.round(total / uniqueCustomers.size);
    `,
  },
];

function readFile(relativePath: string): string {
  const fullPath = path.join(PROJECT_DIR, relativePath);
  return fs.readFileSync(fullPath, 'utf8');
}

async function callLLM(prompt: string, model: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { content: Array<{ text: string }> };
  return data.content.map(c => c.text).join('');
}

function extractCode(response: string): string {
  const match = response.match(/```(?:typescript|javascript|sql|ts|js)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : response.trim();
}

function validateTypescriptEdit(editedCode: string, task: Task): { valid: boolean; actual?: unknown; expected?: unknown; error?: string } {
  try {
    // Check function exists
    if (!editedCode.includes(`function ${task.expectedFunctionName}`)) {
      return { valid: false, error: `Function ${task.expectedFunctionName} not found` };
    }

    // Try to extract and run the function
    // Find the function in the edited code
    const fnMatch = editedCode.match(
      new RegExp(`export\\s+function\\s+${task.expectedFunctionName}[\\s\\S]*?^\\}`, 'm')
    );
    if (!fnMatch) {
      return { valid: false, error: `Could not extract function ${task.expectedFunctionName}` };
    }

    const fnCode = fnMatch[0];

    // Load test data
    const invoices = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'invoices.json'), 'utf8'));
    const subscriptions = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'subscriptions.json'), 'utf8'));
    const customers = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'customers.json'), 'utf8'));

    // Build a test wrapper
    const testWrapper = `
      const invoices = ${JSON.stringify(invoices)};
      const subscriptions = ${JSON.stringify(subscriptions)};
      const customers = ${JSON.stringify(customers)};

      ${fnCode.replace('export ', '')}

      // Call function with appropriate args based on task
      const taskId = "${task.id}";
      let result;
      if (taskId === 'arpu') {
        result = ${task.expectedFunctionName}(invoices, customers);
      } else if (taskId === 'churn_rate') {
        result = ${task.expectedFunctionName}(subscriptions);
      } else if (taskId === 'ltv') {
        result = ${task.expectedFunctionName}(invoices);
      }
      return result;
    `;

    const fn = new Function(testWrapper);
    const actual = fn();

    // Compute expected
    const expectedFn = new Function('require', task.validationCode);
    const mockRequire = (p: string) => JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, p), 'utf8'));
    const expected = expectedFn(mockRequire);

    // Compare
    const tolerance = Math.abs(Number(expected)) * 0.01 || 1;
    const valid = Math.abs(Number(actual) - Number(expected)) <= tolerance;

    return { valid, actual, expected };
  } catch (error) {
    return { valid: false, error: error instanceof Error ? error.message : String(error) };
  }
}

async function runBenchmark(): Promise<void> {
  const args = process.argv.slice(2);
  const contextType = (args.find(a => a.startsWith('--context='))?.split('=')[1] ?? 'typed') as 'typed' | 'dbt';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';

  const tasks = contextType === 'typed' ? TASKS : DBT_TASKS;
  const contextLabel = contextType === 'typed' ? 'Typed TypeScript' : 'DBT/SQL';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Simple Edit Benchmark`);
  console.log(`Context: ${contextLabel}`);
  console.log(`Model: ${model}`);
  console.log(`${'='.repeat(60)}\n`);

  const results: Array<{ id: string; pass: boolean; error?: string }> = [];

  for (const task of tasks) {
    console.log(`\n--- ${task.id} ---`);
    console.log(`Task: ${task.description.split('\n')[0]}...\n`);

    const existingCode = readFile(task.existingFile);

    const prompt = `You are editing an existing ${contextType === 'typed' ? 'TypeScript' : 'SQL'} file.

## Current file: ${task.existingFile}
\`\`\`${contextType === 'typed' ? 'typescript' : 'sql'}
${existingCode}
\`\`\`

## Task
${task.description}

## Instructions
- Keep ALL existing code unchanged
- ADD the new function at the end of the file
- Export the new function
- Output the COMPLETE edited file (not just the new function)

Output the complete edited file:`;

    const start = Date.now();
    try {
      console.log(`  Calling LLM...`);
      const response = await callLLM(prompt, model);
      const editedCode = extractCode(response);

      console.log(`  Validating...`);
      const validation = validateTypescriptEdit(editedCode, task);
      const duration = Date.now() - start;

      if (validation.valid) {
        console.log(`  ✓ PASS (${(duration/1000).toFixed(1)}s)`);
        console.log(`    Expected: ${validation.expected}, Actual: ${validation.actual}`);
        results.push({ id: task.id, pass: true });
      } else {
        console.log(`  ✗ FAIL: ${validation.error}`);
        if (validation.expected !== undefined) {
          console.log(`    Expected: ${validation.expected}, Actual: ${validation.actual}`);
        }
        results.push({ id: task.id, pass: false, error: validation.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ERROR: ${message.slice(0, 100)}`);
      results.push({ id: task.id, pass: false, error: message });
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY: ${contextLabel}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Passed: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`);
  results.forEach(r => {
    const status = r.pass ? '✓' : '✗';
    const error = r.error ? ` - ${r.error.slice(0, 50)}` : '';
    console.log(`  ${status} ${r.id}${error}`);
  });
}

runBenchmark().catch(console.error);
