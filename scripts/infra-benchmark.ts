#!/usr/bin/env npx ts-node
/**
 * Infrastructure Modification Benchmark
 *
 * Tests: Can an LLM agent correctly MODIFY existing data infrastructure
 * to answer new analytics questions?
 *
 * Compares: Typed TypeScript infrastructure vs DBT/SQL infrastructure
 *
 * The agent gets:
 * - Full access to existing infrastructure (read/write)
 * - Raw data files
 * - A new analytics question to answer
 *
 * The agent must:
 * - Understand the existing infrastructure
 * - Modify/extend it as needed
 * - Produce correct answers
 *
 * Run: npx ts-node scripts/infra-benchmark.ts --context=typed|dbt
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const TYPED_DIR = path.join(PROJECT_DIR, 'typed');
const DBT_DIR = path.join(PROJECT_DIR, 'warehouse');
const SANDBOX_DIR = path.join(PROJECT_DIR, 'sandbox');

interface Question {
  id: string;
  question: string;
  hint?: string;
}

// Questions that require infrastructure modifications
const QUESTIONS: Question[] = [
  {
    id: 'monthly_recurring_revenue',
    question: 'Calculate the total Monthly Recurring Revenue (MRR) - sum of amount_paid for paid invoices on active subscriptions.',
  },
  {
    id: 'mrr_by_plan',
    question: 'Break down MRR by plan nickname (from prices table).',
  },
  {
    id: 'customer_lifetime_value',
    question: 'Calculate average customer lifetime value (total paid invoices per customer, averaged across all customers).',
  },
  {
    id: 'churn_rate',
    question: 'Calculate churn rate: (subscriptions with cancel_at_period_end=true AND status=active) / (total active subscriptions).',
  },
  {
    id: 'revenue_by_segment',
    question: 'Calculate total revenue by customer segment (from customers.metadata.segment field).',
  },
  {
    id: 'arpu',
    question: 'Calculate Average Revenue Per User (ARPU): total paid invoice amount / count of unique paying customers.',
  },
];

function readJson<T>(fileName: string): T {
  const filePath = path.join(DATA_DIR, `${fileName}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function computeExpectedAnswers(): Record<string, unknown> {
  type Customer = { id: string; metadata?: { segment?: string } };
  type Subscription = { id: string; customer_id: string; price_id: string; status: string; cancel_at_period_end: boolean };
  type Invoice = { id: string; customer_id: string; subscription_id: string; amount_paid: number; status: string };
  type Price = { id: string; nickname: string };

  const customers = readJson<Customer[]>('customers');
  const subscriptions = readJson<Subscription[]>('subscriptions');
  const invoices = readJson<Invoice[]>('invoices');
  const prices = readJson<Price[]>('prices');

  const activeSubIds = new Set(subscriptions.filter(s => s.status === 'active').map(s => s.id));
  const paidInvoices = invoices.filter(i => i.status === 'paid');
  const paidInvoicesForActive = paidInvoices.filter(i => activeSubIds.has(i.subscription_id));

  const subLookup = Object.fromEntries(subscriptions.map(s => [s.id, s]));
  const priceLookup = Object.fromEntries(prices.map(p => [p.id, p]));
  const customerLookup = Object.fromEntries(customers.map(c => [c.id, c]));

  // monthly_recurring_revenue
  const mrr = paidInvoicesForActive.reduce((sum, i) => sum + i.amount_paid, 0);

  // mrr_by_plan
  const mrrByPlan: Record<string, number> = {};
  paidInvoicesForActive.forEach(inv => {
    const sub = subLookup[inv.subscription_id];
    const price = sub ? priceLookup[sub.price_id] : null;
    const plan = price?.nickname ?? 'unknown';
    mrrByPlan[plan] = (mrrByPlan[plan] ?? 0) + inv.amount_paid;
  });

  // customer_lifetime_value
  const customerTotals: Record<string, number> = {};
  paidInvoices.forEach(inv => {
    customerTotals[inv.customer_id] = (customerTotals[inv.customer_id] ?? 0) + inv.amount_paid;
  });
  const customerValues = Object.values(customerTotals);
  const clv = customerValues.length > 0
    ? customerValues.reduce((a, b) => a + b, 0) / customerValues.length
    : 0;

  // churn_rate
  const activeSubscriptions = subscriptions.filter(s => s.status === 'active');
  const churning = activeSubscriptions.filter(s => s.cancel_at_period_end).length;
  const churnRate = activeSubscriptions.length > 0 ? churning / activeSubscriptions.length : 0;

  // revenue_by_segment
  const revenueBySegment: Record<string, number> = {};
  paidInvoices.forEach(inv => {
    const customer = customerLookup[inv.customer_id];
    const segment = customer?.metadata?.segment ?? 'unknown';
    revenueBySegment[segment] = (revenueBySegment[segment] ?? 0) + inv.amount_paid;
  });

  // arpu
  const payingCustomers = new Set(paidInvoices.map(i => i.customer_id));
  const totalRevenue = paidInvoices.reduce((sum, i) => sum + i.amount_paid, 0);
  const arpu = payingCustomers.size > 0 ? totalRevenue / payingCustomers.size : 0;

  return {
    monthly_recurring_revenue: mrr,
    mrr_by_plan: mrrByPlan,
    customer_lifetime_value: Math.round(clv),
    churn_rate: Math.round(churnRate * 10000) / 10000, // 4 decimal places
    revenue_by_segment: revenueBySegment,
    arpu: Math.round(arpu),
  };
}

function getTypedContext(): string {
  const files = [
    'typed/src/db/schema.ts',
    'typed/src/types/stripe.ts',
    'typed/src/types/internal.ts',
    'typed/src/analytics/queries.ts',
    'typed/src/data/load.ts',
  ];

  let context = `# Reference: Typed TypeScript Infrastructure\n\n`;
  context += `Below is the existing typed TypeScript codebase for analytics. Use it as REFERENCE for patterns and types, but write SELF-CONTAINED code (don't import from these files).\n\n`;

  for (const file of files) {
    const filePath = path.join(PROJECT_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      context += `## ${file}\n\`\`\`typescript\n${content}\n\`\`\`\n\n`;
    }
  }

  context += `## Data files available in ./data/\n`;
  context += `- customers.json, subscriptions.json, invoices.json, prices.json, products.json, users.json, organizations.json\n\n`;

  return context;
}

function getDbtContext(): string {
  const files = [
    'warehouse/dbt_project.yml',
    'warehouse/models/schema.yml',
    'warehouse/models/staging/stg_stripe_customers.sql',
    'warehouse/models/staging/stg_stripe_subscriptions.sql',
    'warehouse/models/staging/stg_stripe_invoices.sql',
    'warehouse/models/staging/stg_stripe_prices.sql',
    'warehouse/models/staging/stg_stripe_products.sql',
    'warehouse/models/marts/fct_mrr.sql',
  ];

  let context = `# Reference: DBT/SQL Infrastructure\n\n`;
  context += `Below is the existing DBT-style SQL codebase. Use it as REFERENCE for the data model and SQL patterns, then write SELF-CONTAINED Node.js code that implements similar logic.\n\n`;

  for (const file of files) {
    const filePath = path.join(PROJECT_DIR, file);
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const ext = path.extname(file).slice(1);
      context += `## ${file}\n\`\`\`${ext}\n${content}\n\`\`\`\n\n`;
    }
  }

  context += `## Data files available in ./data/\n`;
  context += `- customers.json, subscriptions.json, invoices.json, prices.json, products.json, users.json, organizations.json\n\n`;

  return context;
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
  const match = response.match(/```(?:typescript|javascript|ts|js)?\n([\s\S]*?)```/);
  return match ? match[1].trim() : response.trim();
}

function ensureSandbox(): void {
  if (fs.existsSync(SANDBOX_DIR)) {
    fs.rmSync(SANDBOX_DIR, { recursive: true });
  }
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  // Symlink data
  fs.symlinkSync(DATA_DIR, path.join(SANDBOX_DIR, 'data'));
}

function runCode(code: string): string {
  const solutionPath = path.join(SANDBOX_DIR, 'solution.ts');
  fs.writeFileSync(solutionPath, code);

  try {
    const output = execSync(`node --experimental-strip-types "${solutionPath}"`, {
      cwd: SANDBOX_DIR,
      encoding: 'utf8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return output.trim();
  } catch (error: unknown) {
    const e = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(e.stderr || e.message || 'Unknown error');
  }
}

function normalizeToObject(val: unknown): Record<string, number> | null {
  if (Array.isArray(val)) {
    // Convert [{key: 'a', value: 1}, ...] or [{plan: 'a', mrr: 1}, ...] to {a: 1, ...}
    const result: Record<string, number> = {};
    for (const item of val) {
      if (typeof item !== 'object' || item === null) return null;
      const obj = item as Record<string, unknown>;
      // Find key field (key, plan, segment, product, customer_id, etc.)
      const keyField = Object.keys(obj).find(k => typeof obj[k] === 'string');
      // Find value field (value, mrr, revenue, total, count, etc.)
      const valueField = Object.keys(obj).find(k => typeof obj[k] === 'number');
      if (!keyField || !valueField) return null;
      result[obj[keyField] as string] = obj[valueField] as number;
    }
    return result;
  }
  if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
    return val as Record<string, number>;
  }
  return null;
}

function compareResults(actual: unknown, expected: unknown): { match: boolean; detail?: string } {
  if (typeof expected === 'number') {
    const a = Number(actual);
    const e = expected;
    // Allow 1% tolerance for floating point
    const tolerance = Math.abs(e) * 0.01 || 1;
    if (Math.abs(a - e) <= tolerance) {
      return { match: true };
    }
    return { match: false, detail: `Expected ${e}, got ${a}` };
  }

  if (typeof expected === 'object' && expected !== null) {
    const a = normalizeToObject(actual);
    const e = expected as Record<string, number>;

    if (!a) {
      return { match: false, detail: `Could not normalize actual to object` };
    }

    const allKeys = new Set([...Object.keys(a), ...Object.keys(e)]);
    for (const key of allKeys) {
      const av = a[key] ?? 0;
      const ev = e[key] ?? 0;
      const tolerance = Math.abs(ev) * 0.01 || 1;
      if (Math.abs(av - ev) > tolerance) {
        return { match: false, detail: `Key "${key}": expected ${ev}, got ${av}` };
      }
    }
    return { match: true };
  }

  return { match: JSON.stringify(actual) === JSON.stringify(expected) };
}

async function runBenchmark(): Promise<void> {
  const args = process.argv.slice(2);
  const contextType = args.find(a => a.startsWith('--context='))?.split('=')[1] ?? 'typed';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const questionsArg = args.find(a => a.startsWith('--questions='))?.split('=')[1];
  const questionIds = questionsArg ? questionsArg.split(',') : QUESTIONS.map(q => q.id);

  const context = contextType === 'dbt' ? getDbtContext() : getTypedContext();
  const contextLabel = contextType === 'dbt' ? 'DBT/SQL' : 'Typed TypeScript';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Infrastructure Modification Benchmark`);
  console.log(`Context: ${contextLabel}`);
  console.log(`Model: ${model}`);
  console.log(`${'='.repeat(60)}\n`);

  ensureSandbox();
  const expected = computeExpectedAnswers();

  const results: Array<{ id: string; pass: boolean; error?: string; duration: number }> = [];

  const selectedQuestions = QUESTIONS.filter(q => questionIds.includes(q.id));

  for (const q of selectedQuestions) {
    console.log(`\n--- ${q.id} ---`);
    console.log(`Q: ${q.question}\n`);

    const prompt = `${context}

## Task

${q.question}

Write a SELF-CONTAINED Node.js script that:
1. Loads data directly from ./data/*.json using fs.readFileSync
2. Implements the computation following the patterns shown in the existing infrastructure
3. Outputs ONLY the answer to stdout (no imports from the infrastructure, no console.log statements except the final answer)

IMPORTANT:
- Do NOT import from the existing infrastructure files - write self-contained code
- Use: import fs from 'fs'; import path from 'path';
- Load data with: JSON.parse(fs.readFileSync('./data/filename.json', 'utf8'))
- For numeric answers, output just the number: console.log(result)
- For grouped data, output JSON: console.log(JSON.stringify(result))

Write the complete self-contained script:`;

    const start = Date.now();
    try {
      console.log(`  Calling LLM...`);
      const response = await callLLM(prompt, model);
      const code = extractCode(response);

      console.log(`  Running solution...`);
      const output = runCode(code);

      let actual: unknown;
      try {
        actual = JSON.parse(output);
      } catch {
        // Try to extract number
        const num = parseFloat(output);
        if (!isNaN(num)) {
          actual = num;
        } else {
          throw new Error(`Could not parse output: ${output.slice(0, 100)}`);
        }
      }

      const comparison = compareResults(actual, expected[q.id]);
      const duration = Date.now() - start;

      if (comparison.match) {
        console.log(`  ✓ PASS (${duration}ms)`);
        results.push({ id: q.id, pass: true, duration });
      } else {
        console.log(`  ✗ FAIL: ${comparison.detail}`);
        console.log(`    Expected: ${JSON.stringify(expected[q.id])}`);
        console.log(`    Actual:   ${JSON.stringify(actual)}`);
        results.push({ id: q.id, pass: false, error: comparison.detail, duration });
      }
    } catch (error) {
      const duration = Date.now() - start;
      const message = error instanceof Error ? error.message : String(error);
      console.log(`  ✗ ERROR: ${message.slice(0, 200)}`);
      results.push({ id: q.id, pass: false, error: message, duration });
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const totalTime = results.reduce((sum, r) => sum + r.duration, 0);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY: ${contextLabel}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Passed: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`);
  console.log(`Total time: ${(totalTime / 1000).toFixed(1)}s`);
  console.log(`\nResults:`);
  results.forEach(r => {
    const status = r.pass ? '✓' : '✗';
    const error = r.error ? ` - ${r.error.slice(0, 50)}` : '';
    console.log(`  ${status} ${r.id} (${r.duration}ms)${error}`);
  });
}

runBenchmark().catch(console.error);
