#!/usr/bin/env npx ts-node
/**
 * Modular Benchmark Harness
 *
 * Run the same tasks across different data infrastructure sandboxes
 * to compare LLM performance on each architecture.
 *
 * Usage:
 *   node --experimental-strip-types scripts/modular-benchmark.ts --sandbox=typed --model=claude-sonnet-4-20250514
 *   node --experimental-strip-types scripts/modular-benchmark.ts --sandbox=all --model=claude-sonnet-4-20250514
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, SandboxConfig, BenchmarkResult, ValidationResult } from '../sandboxes/types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const SANDBOXES_DIR = path.join(PROJECT_DIR, 'sandboxes');

// ============================================
// TASKS (Same across all sandboxes)
// ============================================

const TASKS: Task[] = [
  {
    id: 'arpu',
    name: 'Average Revenue Per User',
    description: `Calculate ARPU (Average Revenue Per User).
Formula: total amount_paid from paid invoices / count of unique paying customer_ids
Return: number (rounded to nearest integer for TypeScript/Drizzle, raw for SQL/Cube)`,
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
  },
  {
    id: 'churn_rate',
    name: 'Subscription Churn Rate',
    description: `Calculate subscription churn rate.
Formula: (active subscriptions with cancel_at_period_end=true) / (total active subscriptions)
Return: decimal with 4 decimal places (e.g., 0.2168)`,
    dataFile: 'subscriptions.json',
    functionName: 'calculateChurnRate',
    sqlFile: 'stg_churn_rate.sql',
    measureName: 'churn_rate',
    signature: 'calculateChurnRate(subscriptions: StripeSubscription[]): number',
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
    name: 'Average Customer LTV',
    description: `Calculate average customer lifetime value (LTV).
Formula: average of (sum of amount_paid per customer from paid invoices)
Return: number (rounded to nearest integer for TypeScript/Drizzle, raw for SQL/Cube)`,
    dataFile: 'invoices.json',
    functionName: 'calculateAverageLTV',
    sqlFile: 'stg_ltv.sql',
    measureName: 'avg_ltv',
    signature: 'calculateAverageLTV(invoices: StripeInvoice[]): number',
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
// SANDBOX MANAGEMENT
// ============================================

const AVAILABLE_SANDBOXES = ['typed', 'dbt', 'drizzle', 'cube'];

async function loadSandboxConfig(sandboxId: string): Promise<SandboxConfig> {
  const configPath = path.join(SANDBOXES_DIR, sandboxId, 'sandbox.config.ts');
  const module = await import(configPath);
  return module.config;
}

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

function setupSandboxDir(sandboxId: string, model: string): string {
  const runId = `${sandboxId}-${model.replace(/[/:]/g, '-')}-${Date.now()}`;
  const sandboxDir = path.join(PROJECT_DIR, 'sandbox-runs', runId);

  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy sandbox template
  const templateDir = path.join(SANDBOXES_DIR, sandboxId);
  copyRecursive(templateDir, sandboxDir);

  // Copy data
  copyRecursive(path.join(PROJECT_DIR, 'data'), path.join(sandboxDir, 'data'));

  // Create package.json based on sandbox type
  const packageJson = sandboxId === 'typed' || sandboxId === 'drizzle' || sandboxId === 'cube'
    ? { type: 'module' }
    : {};
  fs.writeFileSync(
    path.join(sandboxDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  return sandboxDir;
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
      if (!tool.params.path) {
        return 'Error: read_file requires <path>...</path>';
      }
      const filePath = path.join(sandboxDir, tool.params.path);
      if (!fs.existsSync(filePath)) {
        return `Error: File not found: ${tool.params.path}`;
      }
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        return `Error: ${tool.params.path} is a directory. Use list_files instead.`;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      return content.length > 8000 ? content.slice(0, 8000) + '\n...[truncated]' : content;
    }

    case 'write_file': {
      if (!tool.params.path) {
        return 'Error: write_file requires <path>...</path>';
      }
      if (tool.params.content === undefined) {
        return 'Error: write_file requires <content>...</content>';
      }
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
  config: SandboxConfig,
  task: Task,
  sandboxDir: string,
  model: string,
  maxTurns: number
): Promise<{ success: boolean; turns: number; error?: string }> {
  const taskPrompt = config.taskPrompt(task);

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: taskPrompt }
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await callLLM(messages, model, config.systemPrompt);
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

    if (isOpenRouterModel(model)) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  return { success: false, turns: maxTurns, error: 'Max turns exceeded' };
}

// ============================================
// MAIN
// ============================================

async function runBenchmark(
  sandboxIds: string[],
  model: string,
  taskIds: string[],
  maxTurns: number
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const sandboxId of sandboxIds) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SANDBOX: ${sandboxId.toUpperCase()}`);
    console.log('='.repeat(70));

    const config = await loadSandboxConfig(sandboxId);
    console.log(`  Name: ${config.name}`);

    const selectedTasks = taskIds.length > 0
      ? TASKS.filter(t => taskIds.includes(t.id))
      : TASKS;

    for (const task of selectedTasks) {
      console.log(`\n--- Task: ${task.id} ---`);

      const sandboxDir = setupSandboxDir(sandboxId, model);
      console.log(`  Sandbox: ${sandboxDir}`);

      const expected = task.expectedValue();
      console.log(`  Expected: ${expected}`);

      const startTime = Date.now();

      // Run setup hook if defined
      if (config.setup) {
        await config.setup(sandboxDir);
      }

      console.log(`  Running agent...`);
      const agentResult = await runAgent(config, task, sandboxDir, model, maxTurns);

      if (!agentResult.success) {
        console.log(`\n  ✗ FAIL: ${agentResult.error}`);
        results.push({
          sandbox: sandboxId,
          model,
          task,
          pass: false,
          expected,
          turns: agentResult.turns,
          error: agentResult.error,
          durationMs: Date.now() - startTime,
        });
        continue;
      }

      console.log(`  Validating...`);
      const validation = await config.validate(sandboxDir, task);

      if (!validation.valid) {
        console.log(`\n  ✗ FAIL: ${validation.error}`);
        results.push({
          sandbox: sandboxId,
          model,
          task,
          pass: false,
          expected,
          turns: agentResult.turns,
          error: validation.error,
          durationMs: Date.now() - startTime,
        });
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

      results.push({
        sandbox: sandboxId,
        model,
        task,
        pass,
        expected,
        actual: validation.actual,
        turns: agentResult.turns,
        durationMs: Date.now() - startTime,
      });
    }
  }

  return results;
}

function printSummary(results: BenchmarkResult[]) {
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  // Group by sandbox
  const bySandbox = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    const list = bySandbox.get(r.sandbox) || [];
    list.push(r);
    bySandbox.set(r.sandbox, list);
  }

  // Print table header
  const tasks = [...new Set(results.map(r => r.task.id))];
  console.log(`\n| Sandbox | ${tasks.join(' | ')} | Total |`);
  console.log(`|---------|${tasks.map(() => '---').join('|')}|-------|`);

  for (const [sandbox, sandboxResults] of bySandbox) {
    const taskResults = tasks.map(taskId => {
      const r = sandboxResults.find(r => r.task.id === taskId);
      return r?.pass ? '✓' : '✗';
    });
    const total = sandboxResults.filter(r => r.pass).length;
    console.log(`| ${sandbox.padEnd(7)} | ${taskResults.join('   | ')}   | ${total}/${sandboxResults.length} |`);
  }

  console.log('='.repeat(70));
}

async function main() {
  const args = process.argv.slice(2);

  const sandboxArg = args.find(a => a.startsWith('--sandbox='))?.split('=')[1] ?? 'typed';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const maxTurns = parseInt(args.find(a => a.startsWith('--max-turns='))?.split('=')[1] ?? '20');
  const taskArg = args.find(a => a.startsWith('--task='))?.split('=')[1];

  const sandboxIds = sandboxArg === 'all' ? AVAILABLE_SANDBOXES : [sandboxArg];
  const taskIds = taskArg ? [taskArg] : [];

  console.log('\n' + '='.repeat(70));
  console.log('MODULAR BENCHMARK');
  console.log('='.repeat(70));
  console.log(`Model:     ${model}`);
  console.log(`Sandboxes: ${sandboxIds.join(', ')}`);
  console.log(`Tasks:     ${taskIds.length > 0 ? taskIds.join(', ') : 'all'}`);
  console.log(`Max turns: ${maxTurns}`);
  console.log('='.repeat(70));

  const results = await runBenchmark(sandboxIds, model, taskIds, maxTurns);

  printSummary(results);
}

main().catch(console.error);
