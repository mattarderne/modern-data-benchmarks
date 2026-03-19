#!/usr/bin/env npx ts-node
/**
 * Bash Agent Eval Benchmark Harness
 *
 * Replicates the methodology from braintrustdata/bash-agent-evals:
 * Instead of asking agents to write code, agents use live tools (bash or SQL)
 * to explore data and answer analytics questions in natural language.
 *
 * Compares:
 *   - bash agent: shell commands (ls, cat, grep, jq, wc, head, find) on JSON files
 *   - sql agent: SQL queries against a SQLite database
 *
 * Tests the same 3 analytics questions as the architecture benchmark
 * (ARPU, churn rate, LTV) to see if the data-access-method gap mirrors
 * the architecture gap found in warehouse-dbt vs ORM.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bash-agent-eval-benchmark.ts --agent=bash
 *   node --experimental-strip-types scripts/bash-agent-eval-benchmark.ts --agent=sql
 *   node --experimental-strip-types scripts/bash-agent-eval-benchmark.ts --agent=all
 *   node --experimental-strip-types scripts/bash-agent-eval-benchmark.ts --agent=all --model=claude-sonnet-4-20250514 --output=results.json
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

// ============================================
// DATA & EXPECTED VALUES
// ============================================

const DATA_FILES = [
  'api_usage', 'chat_sessions', 'customers', 'features',
  'invoices', 'organizations', 'payment_intents', 'prices',
  'products', 'subscriptions', 'users',
];

type DataBundle = Record<string, Array<Record<string, any>>>;

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

interface Question {
  id: string;
  question: string;
  category: string;
  difficulty: string;
  expectedValue: number;
  tolerance: number;
}

function buildQuestions(data: DataBundle): Question[] {
  const anchor = getAnchorDate(data.api_usage || []);
  const since = anchor - 30 * 24 * 60 * 60 * 1000;

  const users = data.users || [];
  const invoices = data.invoices || [];
  const subscriptions = data.subscriptions || [];
  const organizations = data.organizations || [];
  const apiUsage = data.api_usage || [];

  // Active User ARPU
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

  // Org Churn Rate
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

  // Avg Org LTV
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

  return [
    {
      id: 'active_user_arpu',
      question: 'What is the ARPU (Average Revenue Per User) for active users? Active users are those with API usage in the last 30 days (relative to the latest api_usage created_at timestamp). Revenue is the sum of amount_paid from paid invoices. Users are linked to invoices via stripe_customer_id → customer_id. Return a single integer (rounded to nearest whole number).',
      category: 'aggregation',
      difficulty: 'hard',
      expectedValue: activeUserArpu,
      tolerance: 1,
    },
    {
      id: 'org_churn_rate',
      question: 'What is the organization churn rate? A churned organization has no active subscriptions AND no API usage in the last 30 days (relative to latest api_usage created_at). The denominator is organizations that have at least one user. Return a decimal with 4 decimal places (e.g., 0.2168).',
      category: 'aggregation',
      difficulty: 'hard',
      expectedValue: orgChurnRate,
      tolerance: 0.001,
    },
    {
      id: 'avg_org_ltv',
      question: 'What is the average organization lifetime value (LTV)? For each organization with at least one user, sum the amount_paid from all paid invoices for all users in that org (joined via users.stripe_customer_id → invoices.customer_id). Then take the average across all qualifying orgs. Return a single integer (rounded to nearest whole number).',
      category: 'aggregation',
      difficulty: 'medium',
      expectedValue: avgOrgLtv,
      tolerance: 1,
    },
  ];
}

// ============================================
// LLM INTERFACE
// ============================================

type TokenUsage = { inputTokens: number; outputTokens: number; totalTokens: number };
type LlmResponse = { content: string; usage?: TokenUsage };

function isOpenRouterModel(model: string): boolean {
  return model.includes('/');
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
    const body = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${body.slice(0, 200)}`);
  }

  const data = await response.json() as {
    content: Array<{ text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  return {
    content: data.content.map(c => c.text).join(''),
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0, totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0) }
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
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
    }),
  });

  if (!response.ok) throw new Error(`OpenRouter API error: ${response.status}`);

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  return {
    content: data.choices[0]?.message?.content || '',
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0, totalTokens: data.usage.total_tokens ?? 0 }
      : undefined,
  };
}

// ============================================
// TOOL DEFINITIONS
// ============================================

// --- Bash Agent Tools ---

const BASH_ALLOWED_COMMANDS = ['ls', 'cat', 'grep', 'find', 'head', 'tail', 'wc', 'jq', 'sort', 'uniq', 'awk', 'cut', 'tr', 'echo', 'expr', 'bc'];

const BASH_SYSTEM_PROMPT = `You are a data analyst exploring JSON data files using bash commands.
You have access to a directory of JSON data files containing SaaS billing and usage data.

Available tool:
<tool>bash</tool><command>your shell command here</command>

When you have the final answer, respond with:
<tool>answer</tool><value>your numeric answer here</value>

CONSTRAINTS:
- You can ONLY use these commands: ${BASH_ALLOWED_COMMANDS.join(', ')}
- Data is in the ./data/ directory as JSON files
- Each file contains an array of JSON objects
- Use jq for JSON parsing and aggregation
- Output will be truncated at 30000 characters
- You have a maximum of 25 tool calls

AVAILABLE DATA FILES:
- data/users.json — users with id, organization_id, stripe_customer_id, email, role, created_at, last_login_at
- data/organizations.json — organizations with id, name, created_at
- data/api_usage.json — API usage records with id, user_id, model, tokens, latency_ms, created_at
- data/invoices.json — Stripe invoices with id, customer_id, subscription_id, amount_due, amount_paid, status, created_at
- data/subscriptions.json — Stripe subscriptions with id, customer_id, price_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at
- data/customers.json — Stripe customers with id, name, email, created_at
- data/chat_sessions.json — chat sessions with id, user_id, created_at, duration_ms
- data/prices.json — Stripe prices with id, product_id, unit_amount, interval, created_at
- data/products.json — Stripe products with id, name, created_at
- data/payment_intents.json — payment intents with id, customer_id, amount, status, created_at
- data/features.json — features with id, name, created_at

IMPORTANT: The key join between app data and Stripe data is:
  users.stripe_customer_id → invoices.customer_id (and subscriptions.customer_id)

WORKFLOW:
1. First explore the data structure (ls, head, jq keys)
2. Understand field names and relationships
3. Compute the answer using jq or shell arithmetic
4. Return your answer with <tool>answer</tool><value>NUMBER</value>`;

const SQL_SYSTEM_PROMPT = `You are a data analyst querying a SQLite database containing SaaS billing and usage data.

Available tools:
<tool>query</tool><sql>your SQL query here</sql>
<tool>schema</tool><table>table_name</table>
<tool>tables</tool>
<tool>sample</tool><table>table_name</table>

When you have the final answer, respond with:
<tool>answer</tool><value>your numeric answer here</value>

CONSTRAINTS:
- All queries are read-only (SELECT only)
- Output will be truncated at 30000 characters
- You have a maximum of 25 tool calls
- All columns are stored as TEXT — use CAST for numeric operations

AVAILABLE TABLES:
- users (id, organization_id, stripe_customer_id, email, role, created_at, last_login_at)
- organizations (id, name, created_at)
- api_usage (id, user_id, model, tokens, latency_ms, created_at)
- invoices (id, customer_id, subscription_id, amount_due, amount_paid, status, created_at)
- subscriptions (id, customer_id, price_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at)
- customers (id, name, email, created_at)
- chat_sessions (id, user_id, created_at, duration_ms)
- prices (id, product_id, unit_amount, interval, created_at)
- products (id, name, created_at)
- payment_intents (id, customer_id, amount, status, created_at)
- features (id, name, created_at)

IMPORTANT: The key join between app data and Stripe data is:
  users.stripe_customer_id → invoices.customer_id (and subscriptions.customer_id)

NOTE: All values are stored as TEXT. You must CAST numeric fields:
  CAST(amount_paid AS REAL), CAST(tokens AS INTEGER), etc.

WORKFLOW:
1. List tables and inspect schema
2. Sample a few rows to understand the data
3. Write your aggregation query
4. Return your answer with <tool>answer</tool><value>NUMBER</value>`;

// ============================================
// TOOL EXECUTION
// ============================================

function truncateOutput(output: string, limit = 30000): string {
  if (output.length <= limit) return output;
  return output.slice(0, limit) + '\n... [truncated at 30000 chars. Use more specific queries.]';
}

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

interface ToolUsage {
  calls: Array<{ tool: string; param: string }>;
  totalCalls: number;
}

function parseToolCall(response: string): ToolCall | null {
  const toolMatch = response.match(/<tool>(\w+)<\/tool>/);
  if (!toolMatch) return null;

  const tool = toolMatch[1];
  const params: Record<string, string> = {};

  const commandMatch = response.match(/<command>([\s\S]*?)<\/command>/);
  if (commandMatch) params.command = commandMatch[1].trim();

  const sqlMatch = response.match(/<sql>([\s\S]*?)<\/sql>/);
  if (sqlMatch) params.sql = sqlMatch[1].trim();

  const tableMatch = response.match(/<table>([\s\S]*?)<\/table>/);
  if (tableMatch) params.table = tableMatch[1].trim();

  const valueMatch = response.match(/<value>([\s\S]*?)<\/value>/);
  if (valueMatch) params.value = valueMatch[1].trim();

  return { tool, params };
}

function executeBashTool(tool: ToolCall, sandboxDir: string): string {
  if (tool.tool === 'answer') {
    return `ANSWER:${tool.params.value}`;
  }

  if (tool.tool !== 'bash') {
    return `Unknown tool: ${tool.tool}. Use <tool>bash</tool><command>...</command> or <tool>answer</tool><value>...</value>`;
  }

  const command = tool.params.command;
  if (!command) return 'Error: bash requires <command>...</command>';

  // Security: check command starts with an allowed command
  const firstWord = command.trim().split(/[\s|;&]/)[0];
  if (!BASH_ALLOWED_COMMANDS.includes(firstWord)) {
    return `Error: Command "${firstWord}" is not allowed. Allowed: ${BASH_ALLOWED_COMMANDS.join(', ')}`;
  }

  try {
    const output = execSync(command, {
      cwd: sandboxDir,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 50 * 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH },
    });
    return truncateOutput(output);
  } catch (error: any) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    return truncateOutput(`Error (exit ${error.status}): ${stderr}\n${stdout}`);
  }
}

function executeSqlTool(tool: ToolCall, db: any): string {
  if (tool.tool === 'answer') {
    return `ANSWER:${tool.params.value}`;
  }

  switch (tool.tool) {
    case 'tables': {
      const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
      return rows.map((r: any) => r.name).join('\n');
    }

    case 'schema': {
      const table = tool.params.table;
      if (!table) return 'Error: schema requires <table>table_name</table>';
      try {
        const info = db.prepare(`PRAGMA table_info("${table}")`).all();
        return info.map((col: any) => `${col.name} ${col.type}`).join('\n');
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'sample': {
      const table = tool.params.table;
      if (!table) return 'Error: sample requires <table>table_name</table>';
      try {
        const rows = db.prepare(`SELECT * FROM "${table}" LIMIT 5`).all();
        return JSON.stringify(rows, null, 2);
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    case 'query': {
      const sql = tool.params.sql;
      if (!sql) return 'Error: query requires <sql>...</sql>';
      if (!/^\s*(SELECT|WITH)\b/i.test(sql)) {
        return 'Error: Only SELECT or WITH statements are allowed';
      }
      try {
        const rows = db.prepare(sql).all();
        return truncateOutput(JSON.stringify(rows, null, 2));
      } catch (e: any) {
        return `Error: ${e.message}`;
      }
    }

    default:
      return `Unknown tool: ${tool.tool}. Use query, schema, tables, sample, or answer.`;
  }
}

// ============================================
// ANSWER EXTRACTION
// ============================================

function extractNumericAnswer(answerStr: string): number | null {
  if (!answerStr) return null;
  // Try to parse the value directly
  const cleaned = answerStr.replace(/,/g, '').trim();
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

// ============================================
// AGENT LOOP
// ============================================

type AgentType = 'bash' | 'sql';

interface AgentResult {
  agent: AgentType;
  questionId: string;
  question: string;
  answer: number | null;
  expected: number;
  tolerance: number;
  pass: boolean;
  turns: number;
  error?: string;
  durationMs: number;
  tokenUsage: TokenUsage;
  toolUsage: ToolUsage;
}

async function runAgent(
  agentType: AgentType,
  question: Question,
  sandboxDir: string,
  dbPath: string,
  model: string,
  maxTurns: number,
): Promise<AgentResult> {
  const systemPrompt = agentType === 'bash' ? BASH_SYSTEM_PROMPT : SQL_SYSTEM_PROMPT;
  const toolUsage: ToolUsage = { calls: [], totalCalls: 0 };
  const tokenUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const startTime = Date.now();

  let db: any = null;
  if (agentType === 'sql') {
    const Database = require('better-sqlite3');
    db = new Database(dbPath, { readonly: true });
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: question.question },
  ];

  let answer: number | null = null;
  let error: string | undefined;
  let turns = 0;

  try {
    for (let turn = 1; turn <= maxTurns; turn++) {
      turns = turn;
      const response = await callLLM(messages, model, systemPrompt);
      messages.push({ role: 'assistant', content: response.content });

      if (response.usage) {
        tokenUsage.inputTokens += response.usage.inputTokens;
        tokenUsage.outputTokens += response.usage.outputTokens;
        tokenUsage.totalTokens += response.usage.totalTokens;
      }

      const tool = parseToolCall(response.content);
      if (!tool) {
        console.log(`      Turn ${turn}: [no tool detected]`);
        messages.push({ role: 'user', content: 'Please use a tool. For bash: <tool>bash</tool><command>...</command>. For your final answer: <tool>answer</tool><value>NUMBER</value>' });
        continue;
      }

      toolUsage.calls.push({ tool: tool.tool, param: Object.values(tool.params)[0]?.slice(0, 80) || '' });
      toolUsage.totalCalls++;

      if (tool.tool === 'answer') {
        const answerStr = tool.params.value;
        console.log(`      Turn ${turn}: [answer] ${answerStr}`);
        answer = extractNumericAnswer(answerStr);
        break;
      }

      const paramPreview = Object.values(tool.params)[0]?.slice(0, 60) || '';
      console.log(`      Turn ${turn}: [${tool.tool}] ${paramPreview}`);

      let result: string;
      if (agentType === 'bash') {
        result = executeBashTool(tool, sandboxDir);
      } else {
        result = executeSqlTool(tool, db);
      }

      messages.push({ role: 'user', content: result });

      if (isOpenRouterModel(model)) {
        await new Promise(r => setTimeout(r, 1000));
      }
    }

    if (answer === null && turns >= maxTurns) {
      error = 'Max turns exceeded without answer';
    }
  } catch (e: any) {
    error = e.message;
  } finally {
    if (db) db.close();
  }

  const pass = answer !== null && Math.abs(answer - question.expectedValue) <= question.tolerance;

  return {
    agent: agentType,
    questionId: question.id,
    question: question.question,
    answer,
    expected: question.expectedValue,
    tolerance: question.tolerance,
    pass,
    turns,
    error,
    durationMs: Date.now() - startTime,
    tokenUsage,
    toolUsage,
  };
}

// ============================================
// MAIN
// ============================================

function printSummary(results: AgentResult[]) {
  console.log('\n' + '='.repeat(70));
  console.log('SUMMARY');
  console.log('='.repeat(70));

  const byAgent = new Map<string, AgentResult[]>();
  for (const r of results) {
    const list = byAgent.get(r.agent) || [];
    list.push(r);
    byAgent.set(r.agent, list);
  }

  const questions = [...new Set(results.map(r => r.questionId))];
  console.log(`\n| Agent | ${questions.map(q => q.slice(0, 16)).join(' | ')} | Total |`);
  console.log(`|-------|${questions.map(() => '---').join('|')}|-------|`);

  for (const [agent, agentResults] of byAgent) {
    const taskResults = questions.map(qId => {
      const r = agentResults.find(r => r.questionId === qId);
      return r?.pass ? '✓' : '✗';
    });
    const total = agentResults.filter(r => r.pass).length;
    console.log(`| ${agent.padEnd(8)} | ${taskResults.join('   | ')}   | ${total}/${agentResults.length} |`);
  }

  console.log('\nDetailed Results:');
  for (const r of results) {
    const status = r.pass ? '✓ PASS' : '✗ FAIL';
    console.log(`  [${r.agent}] ${r.questionId}: ${status} (expected=${r.expected}, got=${r.answer}, turns=${r.turns}, tokens=${r.tokenUsage.totalTokens})`);
    if (r.error) console.log(`    Error: ${r.error}`);
  }

  console.log('='.repeat(70));
}

async function main() {
  const args = process.argv.slice(2);

  const agentArg = args.find(a => a.startsWith('--agent='))?.split('=')[1] ?? 'all';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const maxTurns = parseInt(args.find(a => a.startsWith('--max-turns='))?.split('=')[1] ?? '25');
  const questionArg = args.find(a => a.startsWith('--question='))?.split('=')[1];
  const outputPath = args.find(a => a.startsWith('--output='))?.split('=')[1];

  const agents: AgentType[] = agentArg === 'all' ? ['bash', 'sql'] : [agentArg as AgentType];

  // Setup sandbox directory
  const runId = `bash-agent-eval-${model.replace(/[/:]/g, '-')}-${Date.now()}`;
  const sandboxDir = path.join(PROJECT_DIR, 'sandbox-runs', runId);
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy data to sandbox
  const dataDestDir = path.join(sandboxDir, 'data');
  fs.mkdirSync(dataDestDir, { recursive: true });
  for (const file of DATA_FILES) {
    const src = path.join(DATA_DIR, `${file}.json`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(dataDestDir, `${file}.json`));
    }
  }

  // Load data and build questions
  const data = loadData();
  const allQuestions = buildQuestions(data);
  const questions = questionArg
    ? allQuestions.filter(q => q.id === questionArg)
    : allQuestions;

  // Setup SQLite database if SQL agent is used
  const dbPath = path.join(sandboxDir, 'data.sqlite');
  if (agents.includes('sql')) {
    console.log('Setting up SQLite database...');
    const { setupDatabase } = await import(path.join(HARNESS_DIR, 'setup-db.ts'));
    setupDatabase(dataDestDir, dbPath);
    console.log('Database ready.');
  }

  const startedAt = new Date().toISOString();

  console.log('\n' + '='.repeat(70));
  console.log('BASH AGENT EVAL BENCHMARK');
  console.log('='.repeat(70));
  console.log(`Model:     ${model}`);
  console.log(`Agents:    ${agents.join(', ')}`);
  console.log(`Questions: ${questions.map(q => q.id).join(', ')}`);
  console.log(`Max turns: ${maxTurns}`);
  console.log(`Sandbox:   ${sandboxDir}`);

  for (const q of questions) {
    console.log(`  [${q.id}] expected=${q.expectedValue}`);
  }
  console.log('='.repeat(70));

  const results: AgentResult[] = [];

  for (const agent of agents) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`AGENT: ${agent.toUpperCase()}`);
    console.log('='.repeat(60));

    for (const question of questions) {
      console.log(`\n--- Question: ${question.id} ---`);
      console.log(`  "${question.question.slice(0, 80)}..."`);
      console.log(`  Expected: ${question.expectedValue}`);
      console.log(`  Running ${agent} agent...`);

      const result = await runAgent(agent, question, sandboxDir, dbPath, model, maxTurns);

      if (result.pass) {
        console.log(`\n  ✓ PASS (${result.turns} turns, ${result.tokenUsage.totalTokens} tokens)`);
        console.log(`    Answer: ${result.answer}`);
      } else {
        console.log(`\n  ✗ FAIL (${result.turns} turns)`);
        console.log(`    Expected: ${result.expected}, Got: ${result.answer}`);
        if (result.error) console.log(`    Error: ${result.error}`);
      }

      results.push(result);
    }
  }

  printSummary(results);

  if (outputPath) {
    const payload = {
      metadata: {
        harness: 'bash-agent-eval',
        model,
        agents,
        questions: questions.map(q => q.id),
        maxTurns,
        startedAt,
        endedAt: new Date().toISOString(),
        tokenUsage: results.reduce((acc, r) => ({
          inputTokens: acc.inputTokens + r.tokenUsage.inputTokens,
          outputTokens: acc.outputTokens + r.tokenUsage.outputTokens,
          totalTokens: acc.totalTokens + r.tokenUsage.totalTokens,
        }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      },
      results,
    };
    const absPath = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, JSON.stringify(payload, null, 2));
    console.log(`\nSaved results to ${absPath}`);
  }
}

main().catch(console.error);
