#!/usr/bin/env npx ts-node
/**
 * Infrastructure Edit Benchmark
 *
 * Tests: Can an LLM agent correctly EDIT existing data infrastructure files
 * to answer new analytics questions?
 *
 * The agent can:
 * - Read any file in the project
 * - Edit .ts and .sql files
 * - Run commands to test their changes
 *
 * This simulates a real coding agent workflow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const SANDBOX_DIR = path.join(PROJECT_DIR, 'sandbox-edit');

interface ToolCall {
  name: 'read_file' | 'edit_file' | 'run_command' | 'done';
  params: Record<string, string>;
}

interface Question {
  id: string;
  question: string;
  validation: string; // Code that returns expected answer
}

const QUESTIONS: Question[] = [
  {
    id: 'arpu',
    question: `Add a new function called "calculateARPU" to the analytics module.
ARPU (Average Revenue Per User) = total paid invoice amount / count of unique paying customers.
Export the function. It should load data internally and return a number.
After editing, use the done tool with the ARPU value.`,
    validation: `
      const invs = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
      const paid = invs.filter(i => i.status === 'paid');
      const customers = new Set(paid.map(i => i.customer_id));
      const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
      return customers.size > 0 ? Math.round(total / customers.size) : 0;
    `,
  },
  {
    id: 'churn_rate',
    question: `Add a new function called "calculateChurnRate" to the analytics module.
Churn rate = (active subscriptions with cancel_at_period_end=true) / (total active subscriptions).
Export the function. It should load data internally and return a decimal.
After editing, use the done tool with the churn rate value.`,
    validation: `
      const subs = JSON.parse(fs.readFileSync('./data/subscriptions.json', 'utf8'));
      const active = subs.filter(s => s.status === 'active');
      const churning = active.filter(s => s.cancel_at_period_end).length;
      return active.length > 0 ? Math.round((churning / active.length) * 10000) / 10000 : 0;
    `,
  },
  {
    id: 'revenue_concentration',
    question: `Add a new function called "calculateRevenueConcentration" to the analytics module.
This calculates what percentage of total revenue comes from the top 10% of customers.
Return as a decimal (e.g., 0.45 means top 10% contribute 45% of revenue).
After editing, use the done tool with the concentration value.`,
    validation: `
      const invs = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
      const paid = invs.filter(i => i.status === 'paid');
      const byCustomer = {};
      paid.forEach(i => { byCustomer[i.customer_id] = (byCustomer[i.customer_id] || 0) + i.amount_paid; });
      const sorted = Object.values(byCustomer).sort((a, b) => b - a);
      const total = sorted.reduce((a, b) => a + b, 0);
      const top10Count = Math.ceil(sorted.length * 0.1);
      const top10Revenue = sorted.slice(0, top10Count).reduce((a, b) => a + b, 0);
      return total > 0 ? Math.round((top10Revenue / total) * 10000) / 10000 : 0;
    `,
  },
];

function copyDirectory(src: string, dest: string): void {
  if (fs.existsSync(dest)) {
    fs.rmSync(dest, { recursive: true });
  }
  fs.mkdirSync(dest, { recursive: true });

  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function setupSandbox(contextType: 'typed' | 'dbt'): void {
  // Clean sandbox
  if (fs.existsSync(SANDBOX_DIR)) {
    fs.rmSync(SANDBOX_DIR, { recursive: true });
  }
  fs.mkdirSync(SANDBOX_DIR, { recursive: true });

  // Copy data
  copyDirectory(path.join(PROJECT_DIR, 'data'), path.join(SANDBOX_DIR, 'data'));

  // Copy relevant infrastructure
  if (contextType === 'typed') {
    copyDirectory(path.join(PROJECT_DIR, 'typed'), path.join(SANDBOX_DIR, 'typed'));
  } else {
    copyDirectory(path.join(PROJECT_DIR, 'warehouse'), path.join(SANDBOX_DIR, 'warehouse'));
  }

  // Create a simple package.json and install minimal deps for execution
  const packageJson = {
    name: 'sandbox',
    type: 'module',
    dependencies: {}
  };
  fs.writeFileSync(path.join(SANDBOX_DIR, 'package.json'), JSON.stringify(packageJson, null, 2));

  // Create a simple runner script that doesn't need ts-node
  const runnerScript = `
import fs from 'fs';
import path from 'path';
const dataDir = './data';
function loadJson(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, name + '.json'), 'utf8'));
}
globalThis.loadJson = loadJson;
`;
  fs.writeFileSync(path.join(SANDBOX_DIR, 'runner-setup.js'), runnerScript);
}

function listFiles(dir: string, prefix = ''): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(prefix, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        results.push(...listFiles(path.join(dir, entry.name), fullPath));
      }
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

async function callLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string
): Promise<string> {
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
      system: `You are a coding agent that edits data infrastructure files.

You have these tools available:

1. READ FILE: To read a file, respond with:
   <tool>read_file</tool>
   <path>relative/path/to/file</path>

2. EDIT FILE: To edit a file, respond with:
   <tool>edit_file</tool>
   <path>relative/path/to/file</path>
   <content>
   entire new file content here
   </content>

3. RUN COMMAND: To run a shell command, respond with:
   <tool>run_command</tool>
   <command>your command here</command>

4. DONE: When you've completed the task, respond with:
   <tool>done</tool>
   <answer>the computed answer or result</answer>

Always use exactly one tool per response. Think step by step:
1. First read the existing files to understand the structure
2. Edit files to add/modify functionality
3. Run commands to test your changes
4. Report done when complete

Working directory contains:
- data/ (JSON data files)
- typed/ or warehouse/ (infrastructure to edit)`,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`API error ${response.status}: ${text}`);
  }

  const data = await response.json() as { content: Array<{ text: string }> };
  return data.content.map(c => c.text).join('');
}

function parseToolCall(response: string): ToolCall | null {
  const toolMatch = response.match(/<tool>(\w+)<\/tool>/);
  if (!toolMatch) return null;

  const name = toolMatch[1] as ToolCall['name'];
  const params: Record<string, string> = {};

  const pathMatch = response.match(/<path>([\s\S]*?)<\/path>/);
  if (pathMatch) params.path = pathMatch[1].trim();

  const contentMatch = response.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) params.content = contentMatch[1];

  const commandMatch = response.match(/<command>([\s\S]*?)<\/command>/);
  if (commandMatch) params.command = commandMatch[1].trim();

  const answerMatch = response.match(/<answer>([\s\S]*?)<\/answer>/);
  if (answerMatch) params.answer = answerMatch[1].trim();

  return { name, params };
}

function executeToolCall(tool: ToolCall): string {
  try {
    switch (tool.name) {
      case 'read_file': {
        const filePath = path.join(SANDBOX_DIR, tool.params.path);
        if (!fs.existsSync(filePath)) {
          return `Error: File not found: ${tool.params.path}`;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        return `File contents of ${tool.params.path}:\n\`\`\`\n${content}\n\`\`\``;
      }

      case 'edit_file': {
        const filePath = path.join(SANDBOX_DIR, tool.params.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, tool.params.content);
        return `Successfully wrote ${tool.params.path}`;
      }

      case 'run_command': {
        try {
          const output = execSync(tool.params.command, {
            cwd: SANDBOX_DIR,
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          return `Command output:\n${output}`;
        } catch (error: unknown) {
          const e = error as { stderr?: string; stdout?: string; message?: string };
          return `Command error:\n${e.stderr || e.stdout || e.message}`;
        }
      }

      case 'done':
        return 'DONE';

      default:
        return `Unknown tool: ${tool.name}`;
    }
  } catch (error) {
    return `Tool error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function computeExpected(validation: string): unknown {
  const fn = new Function('fs', 'path', validation);
  return fn(fs, path);
}

function trimMessages(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxMessages: number
): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (messages.length <= maxMessages) return messages;

  // Keep first message (task) and last N messages
  const first = messages[0];
  const recent = messages.slice(-(maxMessages - 1));

  return [
    first,
    { role: 'user' as const, content: `[... ${messages.length - maxMessages} earlier turns summarized ...]\n\nContinue from where you left off.` },
    ...recent
  ];
}

async function runAgentLoop(
  question: Question,
  contextType: 'typed' | 'dbt',
  model: string,
  maxTurns: number
): Promise<{ success: boolean; answer?: string; error?: string; turns: number }> {
  const files = listFiles(SANDBOX_DIR);
  const contextLabel = contextType === 'typed' ? 'typed/' : 'warehouse/';

  const initialPrompt = `Task: ${question.question}

Available files in the project:
${files.map(f => `- ${f}`).join('\n')}

The data infrastructure is in ${contextLabel}. Edit the files to implement this functionality.

After implementing, test that it works, then use the "done" tool with the computed answer.

IMPORTANT: Keep file reads/edits minimal. Only read files you need to understand, then make targeted edits.

Start by reading the main analytics file to understand the current structure.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: initialPrompt }
  ];

  let turns = 0;
  while (turns < maxTurns) {
    turns++;
    console.log(`    Turn ${turns}...`);

    // Trim messages to avoid context overflow
    const trimmedMessages = trimMessages(messages, 8);

    const response = await callLLM(trimmedMessages, model);
    messages.push({ role: 'assistant', content: response });

    const tool = parseToolCall(response);
    if (!tool) {
      console.log(`      [No tool found in response]`);
      messages.push({ role: 'user', content: 'Please use one of the available tools (read_file, edit_file, run_command, or done).' });
      continue;
    }

    console.log(`      [${tool.name}] ${tool.params.path || tool.params.command || tool.params.answer?.slice(0, 50) || ''}`);

    if (tool.name === 'done') {
      return { success: true, answer: tool.params.answer, turns };
    }

    let result = executeToolCall(tool);

    // Truncate long results
    if (result.length > 3000) {
      result = result.slice(0, 3000) + '\n... [truncated]';
    }

    messages.push({ role: 'user', content: result });
  }

  return { success: false, error: 'Max turns exceeded', turns };
}

async function runBenchmark(): Promise<void> {
  const args = process.argv.slice(2);
  const contextType = (args.find(a => a.startsWith('--context='))?.split('=')[1] ?? 'typed') as 'typed' | 'dbt';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const maxTurns = parseInt(args.find(a => a.startsWith('--max-turns='))?.split('=')[1] ?? '15');
  const questionId = args.find(a => a.startsWith('--question='))?.split('=')[1];

  const contextLabel = contextType === 'typed' ? 'Typed TypeScript' : 'DBT/SQL';

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Infrastructure EDIT Benchmark`);
  console.log(`Context: ${contextLabel}`);
  console.log(`Model: ${model}`);
  console.log(`Max turns per question: ${maxTurns}`);
  console.log(`${'='.repeat(60)}\n`);

  const selectedQuestions = questionId
    ? QUESTIONS.filter(q => q.id === questionId)
    : QUESTIONS;

  const results: Array<{ id: string; pass: boolean; turns: number; error?: string }> = [];

  for (const q of selectedQuestions) {
    console.log(`\n--- ${q.id} ---`);
    console.log(`Task: ${q.question.split('\n')[0]}...\n`);

    // Fresh sandbox for each question
    setupSandbox(contextType);

    const start = Date.now();
    const result = await runAgentLoop(q, contextType, model, maxTurns);
    const duration = Date.now() - start;

    if (result.success && result.answer) {
      // Validate the answer
      const expected = computeExpected(q.validation);
      let actual: unknown;

      try {
        actual = JSON.parse(result.answer);
      } catch {
        actual = parseFloat(result.answer) || result.answer;
      }

      const tolerance = typeof expected === 'number' ? Math.abs(expected) * 0.01 || 1 : 0;
      const pass = typeof expected === 'number' && typeof actual === 'number'
        ? Math.abs(actual - expected) <= tolerance
        : JSON.stringify(actual) === JSON.stringify(expected);

      if (pass) {
        console.log(`  ✓ PASS (${result.turns} turns, ${(duration/1000).toFixed(1)}s)`);
        results.push({ id: q.id, pass: true, turns: result.turns });
      } else {
        console.log(`  ✗ FAIL - Wrong answer`);
        console.log(`    Expected: ${JSON.stringify(expected)}`);
        console.log(`    Actual: ${JSON.stringify(actual)}`);
        results.push({ id: q.id, pass: false, turns: result.turns, error: 'Wrong answer' });
      }
    } else {
      console.log(`  ✗ FAIL - ${result.error}`);
      results.push({ id: q.id, pass: false, turns: result.turns, error: result.error });
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const avgTurns = results.reduce((sum, r) => sum + r.turns, 0) / results.length;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY: ${contextLabel}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Passed: ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(1)}%)`);
  console.log(`Average turns: ${avgTurns.toFixed(1)}`);
  console.log(`\nResults:`);
  results.forEach(r => {
    const status = r.pass ? '✓' : '✗';
    const error = r.error ? ` - ${r.error}` : '';
    console.log(`  ${status} ${r.id} (${r.turns} turns)${error}`);
  });
}

runBenchmark().catch(console.error);
