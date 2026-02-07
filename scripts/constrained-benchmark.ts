#!/usr/bin/env npx ts-node
/**
 * Constrained Benchmark: Forces models to USE the infrastructure
 *
 * TypeScript: Function must be importable and callable
 * DBT/SQL: SQL must execute against DuckDB
 *
 * No "run" tool - models cannot escape to plain JS.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');

interface Task {
  id: string;
  functionName: string;
  sqlFileName: string;
  description: string;
  typedSignature: string;
  sqlOutputColumn: string;
  expectedValue: () => number;
  tolerance: number;
}

const TASKS: Task[] = [
  {
    id: 'arpu',
    functionName: 'calculateARPU',
    sqlFileName: 'stg_arpu.sql',
    typedSignature: 'calculateARPU(invoices: StripeInvoice[]): number',
    sqlOutputColumn: 'arpu',
    description: `Calculate Average Revenue Per User (ARPU).
Formula: total amount_paid from paid invoices / count of unique paying customer_ids
Return: number rounded to nearest integer`,
    expectedValue: () => {
      const invoices = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'data/invoices.json'), 'utf8'));
      const paid = invoices.filter((i: any) => i.status === 'paid');
      const customers = new Set(paid.map((i: any) => i.customer_id));
      const total = paid.reduce((sum: number, i: any) => sum + i.amount_paid, 0);
      return Math.round(total / customers.size);
    },
    tolerance: 1,
  },
  {
    id: 'churn_rate',
    functionName: 'calculateChurnRate',
    sqlFileName: 'stg_churn_rate.sql',
    typedSignature: 'calculateChurnRate(subscriptions: StripeSubscription[]): number',
    sqlOutputColumn: 'churn_rate',
    description: `Calculate subscription churn rate.
Formula: (active subscriptions with cancel_at_period_end=true) / (total active subscriptions)
Return: decimal with 4 decimal places (e.g., 0.2168)`,
    expectedValue: () => {
      const subs = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'data/subscriptions.json'), 'utf8'));
      const active = subs.filter((s: any) => s.status === 'active');
      const churning = active.filter((s: any) => s.cancel_at_period_end).length;
      return Math.round((churning / active.length) * 10000) / 10000;
    },
    tolerance: 0.001,
  },
  {
    id: 'ltv',
    functionName: 'calculateAverageLTV',
    sqlFileName: 'stg_ltv.sql',
    typedSignature: 'calculateAverageLTV(invoices: StripeInvoice[]): number',
    sqlOutputColumn: 'avg_ltv',
    description: `Calculate average customer lifetime value (LTV).
Formula: average of (sum of amount_paid per customer from paid invoices)
Return: number rounded to nearest integer`,
    expectedValue: () => {
      const invoices = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'data/invoices.json'), 'utf8'));
      const paid = invoices.filter((i: any) => i.status === 'paid');
      const byCustomer: Record<string, number> = {};
      paid.forEach((i: any) => {
        byCustomer[i.customer_id] = (byCustomer[i.customer_id] || 0) + i.amount_paid;
      });
      const values = Object.values(byCustomer);
      return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
    },
    tolerance: 1,
  },
];

// ============================================
// VALIDATION FUNCTIONS
// ============================================

interface ValidationResult {
  valid: boolean;
  actual?: number;
  error?: string;
}

function validateTypedFunction(sandboxDir: string, task: Task): ValidationResult {
  const queriesPath = path.join(sandboxDir, 'typed/src/analytics/queries.ts');

  if (!fs.existsSync(queriesPath)) {
    return { valid: false, error: 'queries.ts not found' };
  }

  const code = fs.readFileSync(queriesPath, 'utf8');

  // Check function exists and is exported
  const exportPattern = new RegExp(`export\\s+function\\s+${task.functionName}\\s*\\(`);
  if (!exportPattern.test(code)) {
    return { valid: false, error: `Function ${task.functionName} not found or not exported` };
  }

  // Determine which data to pass based on task
  const dataVar = task.id === 'churn_rate' ? 'subscriptions' : 'invoices';
  const dataFile = task.id === 'churn_rate' ? 'subscriptions.json' : 'invoices.json';

  // Create validation script that imports and calls the function
  const validateScript = `
import { ${task.functionName} } from './typed/src/analytics/queries.ts';
import fs from 'node:fs';

const data = JSON.parse(fs.readFileSync('./data/${dataFile}', 'utf8'));
const result = ${task.functionName}(data);
console.log(JSON.stringify({ result: typeof result === 'number' ? result : null }));
`;

  const validatePath = path.join(sandboxDir, 'validate.mts');
  fs.writeFileSync(validatePath, validateScript);

  try {
    const output = execSync(
      'node --experimental-strip-types validate.mts 2>&1',
      {
        cwd: sandboxDir,
        encoding: 'utf8',
        timeout: 30000,
        env: { ...process.env, NODE_NO_WARNINGS: '1' }
      }
    );

    const match = output.match(/\{"result":([\d.]+|null)\}/);
    if (match && match[1] !== 'null') {
      return { valid: true, actual: parseFloat(match[1]) };
    }
    return { valid: false, error: `Function returned non-number: ${output.slice(0, 200)}` };
  } catch (error: any) {
    const msg = error.stdout?.toString() || error.stderr?.toString() || error.message;
    return { valid: false, error: `TypeScript error: ${msg.slice(0, 300)}` };
  }
}

function validateDbtSql(sandboxDir: string, task: Task): ValidationResult {
  const sqlPath = path.join(sandboxDir, 'warehouse/models/staging', task.sqlFileName);

  if (!fs.existsSync(sqlPath)) {
    return { valid: false, error: `${task.sqlFileName} not found` };
  }

  const sql = fs.readFileSync(sqlPath, 'utf8');

  if (!sql.toLowerCase().includes('select')) {
    return { valid: false, error: 'SQL does not contain SELECT' };
  }

  // Create DuckDB execution script
  const duckdbScript = `
const Database = require('duckdb').Database;
const fs = require('fs');
const path = require('path');

const db = new Database(':memory:');

// Load JSON data as tables
db.exec(\`
  CREATE TABLE invoices AS SELECT * FROM read_json_auto('./data/invoices.json');
  CREATE TABLE subscriptions AS SELECT * FROM read_json_auto('./data/subscriptions.json');
  CREATE TABLE customers AS SELECT * FROM read_json_auto('./data/customers.json');
\`);

// Read and execute the model SQL
const sql = fs.readFileSync('${sqlPath}', 'utf8');

db.all(sql, (err, rows) => {
  if (err) {
    console.log(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
  if (rows && rows.length > 0) {
    // Get the first numeric value from the first row
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
}

// ============================================
// SYSTEM PROMPTS (No run tool!)
// ============================================

const TOOLS_PROMPT = `Available tools (use exactly one per response):

1. READ FILE:
<tool>read_file</tool>
<path>relative/path/to/file</path>

2. WRITE FILE:
<tool>write_file</tool>
<path>relative/path/to/file</path>
<content>
file content here
</content>

3. LIST FILES:
<tool>list_files</tool>
<path>optional/directory</path>

4. DONE (when finished writing your code):
<tool>done</tool>

NOTE: There is NO run/execute tool. We will validate your code directly.`;

const TYPED_PROMPT = `You are adding a TypeScript function to an analytics codebase.

${TOOLS_PROMPT}

CONSTRAINT: Your function will be imported and called directly:
  import { YOUR_FUNCTION } from './typed/src/analytics/queries.ts'

REQUIREMENTS:
- Function MUST be exported (use "export function")
- Function MUST have correct TypeScript types
- Function MUST return a number

FILES:
- typed/src/analytics/queries.ts - ADD your function here
- typed/src/types/stripe.ts - Type definitions (StripeInvoice, StripeSubscription)
- data/*.json - Reference for data structure

WORKFLOW:
1. Read queries.ts to see existing patterns
2. Read stripe.ts to see type definitions
3. Write your function to queries.ts (keep existing code!)
4. Use <tool>done</tool> when complete`;

const DBT_PROMPT = `You are creating a DBT SQL model.

${TOOLS_PROMPT}

CONSTRAINT: Your SQL will be executed against DuckDB.
Tables available: invoices, subscriptions, customers

REQUIREMENTS:
- Write valid SQL that executes in DuckDB
- Query MUST return a single row with the metric value
- Use standard SQL syntax (DuckDB is PostgreSQL-compatible)

FILES:
- warehouse/models/staging/*.sql - Reference existing models
- data/*.json - See column names and data types

WORKFLOW:
1. Read an existing staging model for patterns
2. Read the JSON data to see column names
3. Write your SQL model to warehouse/models/staging/
4. Use <tool>done</tool> when complete`;

// ============================================
// SANDBOX SETUP
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

function setupSandbox(sandboxDir: string, contextType: 'typed' | 'dbt'): void {
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy data
  copyRecursive(path.join(PROJECT_DIR, 'data'), path.join(sandboxDir, 'data'));

  if (contextType === 'typed') {
    copyRecursive(path.join(PROJECT_DIR, 'typed'), path.join(sandboxDir, 'typed'));
    fs.writeFileSync(
      path.join(sandboxDir, 'package.json'),
      JSON.stringify({ type: 'module' }, null, 2)
    );
  } else {
    copyRecursive(path.join(PROJECT_DIR, 'warehouse'), path.join(sandboxDir, 'warehouse'));
    fs.writeFileSync(
      path.join(sandboxDir, 'package.json'),
      JSON.stringify({}, null, 2)
    );
  }

  console.log(`  Sandbox: ${sandboxDir}`);
}

// ============================================
// LLM INTERFACE
// ============================================

function isOpenRouterModel(model: string): boolean {
  return model.includes('/');
}

async function callLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<string> {
  if (isOpenRouterModel(model)) {
    return callOpenRouter(messages, model, systemPrompt);
  }
  return callAnthropic(messages, model, systemPrompt);
}

async function callAnthropic(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status}`);
  }

  const data = await response.json() as { content: Array<{ text: string }> };
  return data.content.map(c => c.text).join('');
}

async function callOpenRouter(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status}`);
  }

  const data = await response.json() as { choices: Array<{ message: { content: string } }> };
  return data.choices[0]?.message?.content || '';
}

// ============================================
// TOOL PARSING & EXECUTION
// ============================================

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

function parseToolCall(response: string): ToolCall | null {
  const toolMatch = response.match(/<tool>(\w+)<\/tool>/);
  if (!toolMatch) return null;

  const tool = toolMatch[1];
  const params: Record<string, string> = {};

  const pathMatch = response.match(/<path>([\s\S]*?)<\/path>/);
  if (pathMatch) params.path = pathMatch[1].trim();

  const contentMatch = response.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) params.content = contentMatch[1];

  return { tool, params };
}

function executeTool(tool: ToolCall, sandboxDir: string): string {
  switch (tool.tool) {
    case 'read_file': {
      const filePath = path.join(sandboxDir, tool.params.path);
      if (!fs.existsSync(filePath)) {
        return `Error: File not found: ${tool.params.path}`;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return content.length > 8000 ? content.slice(0, 8000) + '\n...[truncated]' : content;
    }

    case 'write_file': {
      const filePath = path.join(sandboxDir, tool.params.path);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, tool.params.content);
      return `Written: ${tool.params.path}`;
    }

    case 'list_files': {
      const dir = tool.params.path ? path.join(sandboxDir, tool.params.path) : sandboxDir;
      if (!fs.existsSync(dir)) return `Error: Directory not found`;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      return entries
        .filter(e => !e.name.startsWith('.'))
        .map(e => e.isDirectory() ? `${e.name}/` : e.name)
        .join('\n');
    }

    case 'done':
      return 'DONE';

    default:
      return `Unknown tool: ${tool.tool}`;
  }
}

// ============================================
// AGENT LOOP
// ============================================

async function runAgent(
  task: Task,
  sandboxDir: string,
  model: string,
  contextType: 'typed' | 'dbt',
  maxTurns: number
): Promise<{ success: boolean; turns: number; error?: string }> {
  const systemPrompt = contextType === 'typed' ? TYPED_PROMPT : DBT_PROMPT;

  const taskPrompt = contextType === 'typed'
    ? `TASK: Add function "${task.functionName}" to typed/src/analytics/queries.ts

Signature: export function ${task.typedSignature}

${task.description}

Start by reading the existing code.`
    : `TASK: Create SQL model "${task.sqlFileName}" in warehouse/models/staging/

Output column: ${task.sqlOutputColumn}

${task.description}

Start by reading an existing staging model for reference.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: taskPrompt }
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await callLLM(messages, model, systemPrompt);
    messages.push({ role: 'assistant', content: response });

    const tool = parseToolCall(response);
    if (!tool) {
      console.log(`      Turn ${turn}: [no tool]`);
      messages.push({ role: 'user', content: 'Use a tool: read_file, write_file, list_files, or done' });
      continue;
    }

    const display = tool.params.path?.slice(0, 40) || '';
    console.log(`      Turn ${turn}: [${tool.tool}] ${display}`);

    if (tool.tool === 'done') {
      return { success: true, turns: turn };
    }

    const result = executeTool(tool, sandboxDir);
    messages.push({ role: 'user', content: result });

    // Rate limit for external APIs
    if (isOpenRouterModel(model)) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return { success: false, turns: maxTurns, error: 'Max turns exceeded' };
}

// ============================================
// MAIN
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const contextType = (args.find(a => a.startsWith('--context='))?.split('=')[1] ?? 'typed') as 'typed' | 'dbt';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const maxTurns = parseInt(args.find(a => a.startsWith('--max-turns='))?.split('=')[1] ?? '20');
  const taskFilter = args.find(a => a.startsWith('--task='))?.split('=')[1];

  const selectedTasks = taskFilter ? TASKS.filter(t => t.id === taskFilter) : TASKS;

  console.log('\n' + '='.repeat(70));
  console.log('CONSTRAINED BENCHMARK');
  console.log('='.repeat(70));
  console.log(`Context:  ${contextType === 'typed' ? 'TypeScript (function must import)' : 'DBT/SQL (must execute in DuckDB)'}`);
  console.log(`Model:    ${model}`);
  console.log(`Tasks:    ${selectedTasks.length}`);
  console.log('='.repeat(70));

  const results: Array<{ id: string; pass: boolean; expected: number; actual?: number; turns: number; error?: string }> = [];

  for (const task of selectedTasks) {
    console.log(`\n--- Task: ${task.id} ---`);

    const sandboxDir = path.join(PROJECT_DIR, 'sandbox-constrained', `${contextType}-${model.replace(/[/:]/g, '-')}-${Date.now()}`);
    setupSandbox(sandboxDir, contextType);

    const expected = task.expectedValue();
    console.log(`  Expected: ${expected}`);
    console.log(`  Running agent...`);

    const agentResult = await runAgent(task, sandboxDir, model, contextType, maxTurns);

    if (!agentResult.success) {
      console.log(`\n  ✗ FAIL: ${agentResult.error}`);
      results.push({ id: task.id, pass: false, expected, turns: agentResult.turns, error: agentResult.error });
      continue;
    }

    console.log(`  Validating...`);
    const validation = contextType === 'typed'
      ? validateTypedFunction(sandboxDir, task)
      : validateDbtSql(sandboxDir, task);

    if (!validation.valid) {
      console.log(`\n  ✗ FAIL: ${validation.error}`);
      results.push({ id: task.id, pass: false, expected, turns: agentResult.turns, error: validation.error });
      continue;
    }

    const diff = Math.abs((validation.actual ?? 0) - expected);
    const pass = diff <= task.tolerance;

    if (pass) {
      console.log(`\n  ✓ PASS (${agentResult.turns} turns)`);
      console.log(`    Result: ${validation.actual}`);
    } else {
      console.log(`\n  ✗ FAIL: Wrong value`);
      console.log(`    Expected: ${expected}, Got: ${validation.actual}`);
    }

    results.push({ id: task.id, pass, expected, actual: validation.actual, turns: agentResult.turns });
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));
  console.log(`Passed: ${passed}/${results.length} (${Math.round(passed / results.length * 100)}%)`);
  for (const r of results) {
    const status = r.pass ? '✓' : '✗';
    const detail = r.error || `expected=${r.expected}, actual=${r.actual}`;
    console.log(`  ${status} ${r.id} (${r.turns} turns) - ${detail}`);
  }
  console.log('='.repeat(70));
}

main().catch(console.error);
