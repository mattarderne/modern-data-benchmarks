#!/usr/bin/env npx ts-node
/**
 * Architecture Benchmark Harness
 *
 * Compare unified app+Stripe analytics vs warehouse+DBT unification.
 *
 * Usage:
 *   node --experimental-strip-types scripts/architecture-benchmark.ts --sandbox=app-typed --model=claude-sonnet-4-20250514
 *   node --experimental-strip-types scripts/architecture-benchmark.ts --sandbox=all --model=qwen/qwen3-coder-next
 *   node --experimental-strip-types scripts/architecture-benchmark.ts --sandbox=all --model=qwen/qwen3-coder-next --drift=stripe-lag
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Task, SandboxConfig, BenchmarkResult, ValidationResult } from '../sandboxes/types';

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

type DriftMode = 'none' | 'stripe-lag' | 'missing-mapping';

type DataBundle = Record<string, Array<Record<string, any>>>;

function loadBaseData(): DataBundle {
  const data: DataBundle = {};
  for (const file of DATA_FILES) {
    const filePath = path.join(PROJECT_DIR, 'data', `${file}.json`);
    data[file] = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  }
  return data;
}

function cloneData(data: DataBundle): DataBundle {
  return JSON.parse(JSON.stringify(data)) as DataBundle;
}

function applyDrift(data: DataBundle, drift: DriftMode): DataBundle {
  if (drift === 'none') return data;
  const drifted = cloneData(data);

  if (drift === 'stripe-lag') {
    const invoices = drifted.invoices || [];
    if (invoices.length > 0) {
      const maxDate = Math.max(...invoices.map(i => new Date(i.created_at).getTime()));
      const cutoff = maxDate - 7 * 24 * 60 * 60 * 1000;
      drifted.invoices = invoices.filter(i => new Date(i.created_at).getTime() < cutoff);
    }
    const subs = drifted.subscriptions || [];
    if (subs.length > 0) {
      const maxDate = Math.max(...subs.map(s => new Date(s.created_at).getTime()));
      const cutoff = maxDate - 7 * 24 * 60 * 60 * 1000;
      drifted.subscriptions = subs.filter(s => new Date(s.created_at).getTime() < cutoff);
    }
  }

  if (drift === 'missing-mapping') {
    const users = drifted.users || [];
    drifted.users = users.map((user, index) => {
      if (index % 20 === 0) {
        return { ...user, stripe_customer_id: `missing_${user.id}` };
      }
      return user;
    });
  }

  return drifted;
}

function writeData(destDir: string, data: DataBundle) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const file of DATA_FILES) {
    const rows = data[file] || [];
    fs.writeFileSync(path.join(destDir, `${file}.json`), JSON.stringify(rows, null, 2));
  }
}

function getAnchorDate(apiUsage: Array<Record<string, any>>): number {
  if (apiUsage.length === 0) return Date.now();
  return Math.max(...apiUsage.map(u => new Date(u.created_at).getTime()));
}

function buildTasks(data: DataBundle): Task[] {
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

  return [
    {
      id: 'active_user_arpu',
      name: 'Active User ARPU',
      description: `Calculate ARPU for active users.
Formula: total paid invoice amount for active users / count of active users
Active users: users with API usage in the last 30 days (relative to latest api_usage.created_at).
Return: number (rounded to nearest integer for TypeScript/Drizzle, raw for SQL)`,
      dataFile: 'invoices',
      dataFiles: ['users', 'api_usage', 'invoices'],
      functionName: 'calculateActiveUserARPU',
      sqlFile: 'fct_active_user_arpu.sql',
      measureName: 'active_user_arpu',
      signature: 'calculateActiveUserARPU(users: User[], apiUsage: ApiUsage[], invoices: StripeInvoice[]): number',
      expectedValue: () => activeUserArpu,
      tolerance: 1,
    },
    {
      id: 'org_churn_rate',
      name: 'Organization Churn Rate',
      description: `Calculate organization churn rate.
Churned orgs: organizations with no active subscriptions AND no API usage in last 30 days (relative to latest api_usage.created_at).
Denominator: organizations with at least one user.
Return: decimal with 4 decimal places (e.g., 0.2168)`,
      dataFile: 'subscriptions',
      dataFiles: ['organizations', 'users', 'subscriptions', 'api_usage'],
      functionName: 'calculateOrgChurnRate',
      sqlFile: 'fct_org_churn_rate.sql',
      measureName: 'org_churn_rate',
      signature: 'calculateOrgChurnRate(organizations: Organization[], users: User[], subscriptions: StripeSubscription[], apiUsage: ApiUsage[]): number',
      expectedValue: () => orgChurnRate,
      tolerance: 0.001,
    },
    {
      id: 'avg_org_ltv',
      name: 'Average Org LTV',
      description: `Calculate average organization lifetime value (LTV).
Formula: average of (sum of paid invoice amount per organization), across orgs with at least one user.
Join users -> stripe_customer_id -> invoices.
Return: number (rounded to nearest integer for TypeScript/Drizzle, raw for SQL)`,
      dataFile: 'invoices',
      dataFiles: ['organizations', 'users', 'invoices'],
      functionName: 'calculateAvgOrgLTV',
      sqlFile: 'fct_avg_org_ltv.sql',
      measureName: 'avg_org_ltv',
      signature: 'calculateAvgOrgLTV(organizations: Organization[], users: User[], invoices: StripeInvoice[]): number',
      expectedValue: () => avgOrgLtv,
      tolerance: 1,
    },
  ];
}

// ============================================
// SANDBOX MANAGEMENT
// ============================================

const AVAILABLE_SANDBOXES = ['app-typed', 'app-drizzle', 'warehouse-dbt'];

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

function setupSandboxDir(sandboxId: string, model: string, data: DataBundle): string {
  const runId = `${sandboxId}-${model.replace(/[/:]/g, '-')}-${Date.now()}`;
  const sandboxDir = path.join(PROJECT_DIR, 'sandbox-runs', runId);

  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy sandbox template
  const templateDir = path.join(SANDBOXES_DIR, sandboxId);
  copyRecursive(templateDir, sandboxDir);

  // Write data bundle
  writeData(path.join(sandboxDir, 'data'), data);

  // Create package.json based on sandbox type
  const packageJson = sandboxId === 'app-typed' || sandboxId === 'app-drizzle'
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

type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

type LlmResponse = {
  content: string;
  usage?: TokenUsage;
};

function normalizeTokenUsage(inputTokens?: number, outputTokens?: number, totalTokens?: number): TokenUsage {
  const input = Number.isFinite(inputTokens) ? inputTokens! : 0;
  const output = Number.isFinite(outputTokens) ? outputTokens! : 0;
  const total = Number.isFinite(totalTokens) ? totalTokens! : input + output;
  return { inputTokens: input, outputTokens: output, totalTokens: total };
}

function addTokenUsage(target: TokenUsage | undefined, delta?: TokenUsage): void {
  if (!target || !delta) return;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.totalTokens += delta.totalTokens;
}

async function callLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<LlmResponse> {
  if (isOpenRouterModel(model)) {
    return callOpenRouter(messages, model, systemPrompt);
  }
  return callAnthropic(messages, model, systemPrompt);
}

async function callAnthropic(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<LlmResponse> {
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

  const data = await response.json() as {
    content: Array<{ text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    content: data.content.map(c => c.text).join(''),
    usage: data.usage
      ? normalizeTokenUsage(data.usage.input_tokens, data.usage.output_tokens)
      : undefined,
  };
}

async function callOpenRouter(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<LlmResponse> {
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

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  return {
    content: data.choices[0]?.message?.content || '',
    usage: data.usage
      ? normalizeTokenUsage(data.usage.prompt_tokens, data.usage.completion_tokens, data.usage.total_tokens)
      : undefined,
  };
}

// ============================================
// TOOL PARSING & EXECUTION
// ============================================

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

type ToolUsage = {
  readFiles: string[];
  listFiles: string[];
  writeFiles: string[];
};

type RubricScore = {
  runtime: number;
  output: number;
  schema: number;
  toolUsage: number;
  total: number;
};

function normalizePath(value: string): string {
  return value.trim().replace(/^\.\/+/, '');
}

function isSchemaError(error?: string): boolean {
  if (!error) return false;
  return /column|table|relation|no such|unknown|does not exist|invalid identifier/i.test(error);
}

function computeToolUsageScore(toolUsage: ToolUsage | undefined, config: SandboxConfig): number {
  if (!toolUsage || toolUsage.readFiles.length === 0) return 0;
  const keyFiles = config.contextFiles.map(normalizePath);
  if (keyFiles.length === 0) return 0;
  const reads = new Set(toolUsage.readFiles.map(normalizePath));
  let hits = 0;
  for (const file of keyFiles) {
    if (reads.has(file)) hits += 1;
  }
  return hits / keyFiles.length;
}

function computeRubric(
  config: SandboxConfig,
  pass: boolean,
  validationOk: boolean,
  error: string | undefined,
  toolUsage: ToolUsage | undefined
): RubricScore {
  const runtime = validationOk ? 1 : 0;
  const output = pass ? 1 : 0;
  const schema = validationOk && !isSchemaError(error) ? 1 : 0;
  const toolUsageScore = computeToolUsageScore(toolUsage, config);
  const total = (runtime + output + schema + toolUsageScore) / 4;
  return {
    runtime,
    output,
    schema,
    toolUsage: toolUsageScore,
    total,
  };
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

function recordToolUsage(usage: ToolUsage | undefined, tool: ToolCall) {
  if (!usage) return;
  const path = tool.params.path ? tool.params.path.trim() : '';
  if (tool.tool === 'read_file') usage.readFiles.push(path);
  if (tool.tool === 'list_files') usage.listFiles.push(path);
  if (tool.tool === 'write_file') usage.writeFiles.push(path);
}

function executeTool(tool: ToolCall, sandboxDir: string, usage?: ToolUsage): string {
  recordToolUsage(usage, tool);
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
  maxTurns: number,
  toolUsage?: ToolUsage,
  tokenUsage?: TokenUsage
): Promise<{ success: boolean; turns: number; error?: string }> {
  const taskPrompt = config.taskPrompt(task);

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: taskPrompt }
  ];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await callLLM(messages, model, config.systemPrompt);
    messages.push({ role: 'assistant', content: response.content });
    addTokenUsage(tokenUsage, response.usage);

    const tool = parseToolCall(response.content);
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

    const result = executeTool(tool, sandboxDir, toolUsage);
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
  maxTurns: number,
  data: DataBundle,
  tasks: Task[]
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  for (const sandboxId of sandboxIds) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`SANDBOX: ${sandboxId.toUpperCase()}`);
    console.log('='.repeat(70));

    const config = await loadSandboxConfig(sandboxId);
    console.log(`  Name: ${config.name}`);

    const selectedTasks = taskIds.length > 0
      ? tasks.filter(t => taskIds.includes(t.id))
      : tasks;

    for (const task of selectedTasks) {
      console.log(`\n--- Task: ${task.id} ---`);

      const sandboxDir = setupSandboxDir(sandboxId, model, data);
      console.log(`  Sandbox: ${sandboxDir}`);

      const expected = task.expectedValue();
      console.log(`  Expected: ${expected}`);

      const startTime = Date.now();
      const toolUsage: ToolUsage = { readFiles: [], listFiles: [], writeFiles: [] };
      const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

      if (config.setup) {
        await config.setup(sandboxDir);
      }

      console.log(`  Running agent...`);
      const agentResult = await runAgent(
        config,
        task,
        sandboxDir,
        model,
        maxTurns,
        toolUsage,
        tokenUsage
      );

      if (!agentResult.success) {
        console.log(`\n  ✗ FAIL: ${agentResult.error}`);
        const rubric = computeRubric(config, false, false, agentResult.error, toolUsage);
        results.push({
          sandbox: sandboxId,
          model,
          task,
          pass: false,
          expected,
          turns: agentResult.turns,
          error: agentResult.error,
          durationMs: Date.now() - startTime,
          toolUsage,
          tokenUsage,
          rubric,
        });
        continue;
      }

      console.log(`  Validating...`);
      const validation = await config.validate(sandboxDir, task);

      if (!validation.valid) {
        console.log(`\n  ✗ FAIL: ${validation.error}`);
        const rubric = computeRubric(config, false, false, validation.error, toolUsage);
        results.push({
          sandbox: sandboxId,
          model,
          task,
          pass: false,
          expected,
          turns: agentResult.turns,
          error: validation.error,
          durationMs: Date.now() - startTime,
          toolUsage,
          tokenUsage,
          rubric,
        });
        continue;
      }

      const diff = Math.abs((validation.actual ?? 0) - expected);
      const pass = diff <= task.tolerance;
      const rubric = computeRubric(config, pass, true, undefined, toolUsage);

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
        toolUsage,
        tokenUsage,
        rubric,
      });
    }
  }

  return results;
}

function printSummary(results: BenchmarkResult[]) {
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const bySandbox = new Map<string, BenchmarkResult[]>();
  for (const r of results) {
    const list = bySandbox.get(r.sandbox) || [];
    list.push(r);
    bySandbox.set(r.sandbox, list);
  }

  const tasks = [...new Set(results.map(r => r.task.id))];
  console.log(`\n| Sandbox | ${tasks.join(' | ')} | Total |`);
  console.log(`|---------|${tasks.map(() => '---').join('|')}|-------|`);

  for (const [sandbox, sandboxResults] of bySandbox) {
    const taskResults = tasks.map(taskId => {
      const r = sandboxResults.find(r => r.task.id === taskId);
      return r?.pass ? '✓' : '✗';
    });
    const total = sandboxResults.filter(r => r.pass).length;
    console.log(`| ${sandbox.padEnd(12)} | ${taskResults.join('   | ')}   | ${total}/${sandboxResults.length} |`);
  }

  console.log('='.repeat(70));
}

function sumTokenUsage(results: BenchmarkResult[]): TokenUsage {
  const total: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  for (const r of results) {
    if (!r.tokenUsage) continue;
    total.inputTokens += r.tokenUsage.inputTokens;
    total.outputTokens += r.tokenUsage.outputTokens;
    total.totalTokens += r.tokenUsage.totalTokens;
  }
  return total;
}

async function main() {
  const args = process.argv.slice(2);

  const sandboxArg = args.find(a => a.startsWith('--sandbox='))?.split('=')[1] ?? 'app-typed';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const maxTurns = parseInt(args.find(a => a.startsWith('--max-turns='))?.split('=')[1] ?? '20');
  const taskArg = args.find(a => a.startsWith('--task='))?.split('=')[1];
  const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1];
  const driftArg = args.find(a => a.startsWith('--drift='))?.split('=')[1] as DriftMode | undefined;

  const drift: DriftMode = driftArg || 'none';

  const sandboxIds = sandboxArg === 'all' ? AVAILABLE_SANDBOXES : [sandboxArg];
  const taskIds = taskArg ? [taskArg] : [];

  const baseData = loadBaseData();
  const driftedData = applyDrift(baseData, drift);
  const tasks = buildTasks(driftedData);
  const startedAt = new Date().toISOString();

  console.log('\n' + '='.repeat(70));
  console.log('ARCHITECTURE BENCHMARK');
  console.log('='.repeat(70));
  console.log(`Model:     ${model}`);
  console.log(`Sandboxes: ${sandboxIds.join(', ')}`);
  console.log(`Tasks:     ${taskIds.length > 0 ? taskIds.join(', ') : 'all'}`);
  console.log(`Max turns: ${maxTurns}`);
  console.log(`Drift:     ${drift}`);
  console.log('='.repeat(70));

  const results = await runBenchmark(sandboxIds, model, taskIds, maxTurns, driftedData, tasks);

  printSummary(results);

  if (outputPath) {
    const tokenTotals = sumTokenUsage(results);
    const payload = {
      metadata: {
        model,
        sandboxes: sandboxIds,
        tasks: taskIds.length > 0 ? taskIds : tasks.map(t => t.id),
        maxTurns,
        drift,
        startedAt,
        endedAt: new Date().toISOString(),
        tokenUsage: tokenTotals,
      },
      results,
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(payload, null, 2));
    console.log(`\nSaved results to ${outputPath}`);
  }
}

main().catch(console.error);
