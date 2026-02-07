#!/usr/bin/env npx ts-node
/**
 * Agent Benchmark: Real coding agent test for data infrastructure
 *
 * Tests whether an LLM agent can correctly modify existing data infrastructure
 * (typed TypeScript OR DBT/SQL) to answer new analytics questions.
 *
 * The sandbox is fully functional - the agent can:
 * - Read/edit any file
 * - Run shell commands (npm, node, etc.)
 * - Test their changes
 * - Iterate until correct
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const SANDBOX_BASE = path.join(PROJECT_DIR, 'sandbox');

// Generate unique sandbox ID for concurrent runs
function getSandboxId(model: string): string {
  const modelShort = model.replace(/[^a-zA-Z0-9]/g, '-').slice(0, 20);
  return `${modelShort}-${Date.now()}`;
}

interface Task {
  id: string;
  description: string;
  expectedValue: () => unknown;
  tolerance?: number; // For numeric comparisons
}

// Tasks that require modifying the infrastructure
const TYPED_TASKS: Task[] = [
  {
    id: 'arpu',
    description: `Add a function "calculateARPU" to typed/src/analytics/queries.ts that calculates Average Revenue Per User.

ARPU = total amount_paid from paid invoices / count of unique paying customer_ids

The function signature should be:
  export function calculateARPU(invoices: StripeInvoice[]): number

Return the value rounded to the nearest integer.

After implementing, create a test file and run it to verify. Then report the ARPU value.`,
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
    description: `Add a function "calculateChurnRate" to typed/src/analytics/queries.ts that calculates subscription churn rate.

Churn Rate = (active subscriptions with cancel_at_period_end=true) / (total active subscriptions)

The function signature should be:
  export function calculateChurnRate(subscriptions: StripeSubscription[]): number

Return as a decimal rounded to 4 decimal places (e.g., 0.1523).

After implementing, test it and report the churn rate value.`,
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
    description: `Add a function "calculateAverageLTV" to typed/src/analytics/queries.ts that calculates average customer lifetime value.

LTV = average of (sum of amount_paid per customer from paid invoices)

The function signature should be:
  export function calculateAverageLTV(invoices: StripeInvoice[]): number

Return the value rounded to the nearest integer.

After implementing, test it and report the average LTV value.`,
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

const DBT_TASKS: Task[] = [
  {
    id: 'arpu_model',
    description: `Create a new DBT model "stg_arpu.sql" in warehouse/models/staging/ that calculates ARPU.

The model should:
1. Select from the invoices data (you can reference stg_stripe_invoices pattern)
2. Filter for paid invoices (status = 'paid')
3. Calculate: total amount_paid / count of distinct customer_id
4. Output a single row with column "arpu"

Then create a Node.js test script that:
1. Loads invoices.json
2. Implements the same SQL logic in JavaScript
3. Outputs the ARPU value

Report the ARPU value (rounded to nearest integer).`,
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
    id: 'churn_model',
    description: `Create a new DBT model "stg_churn_rate.sql" in warehouse/models/staging/ that calculates churn rate.

The model should:
1. Select from subscriptions data
2. Calculate: count of (status='active' AND cancel_at_period_end=true) / count of (status='active')
3. Output a single row with column "churn_rate"

Then create a Node.js test script that implements and verifies this.

Report the churn rate (as decimal, 4 decimal places).`,
    expectedValue: () => {
      const subs = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'data/subscriptions.json'), 'utf8'));
      const active = subs.filter((s: any) => s.status === 'active');
      const churning = active.filter((s: any) => s.cancel_at_period_end).length;
      return Math.round((churning / active.length) * 10000) / 10000;
    },
    tolerance: 0.001,
  },
  {
    id: 'ltv_model',
    description: `Create a new DBT model "stg_ltv.sql" in warehouse/models/staging/ that calculates average customer lifetime value.

The model should:
1. Select from invoices data
2. Filter for paid invoices (status = 'paid')
3. Group by customer_id and sum amount_paid per customer
4. Calculate the average of those per-customer totals
5. Output a single row with column "avg_ltv"

Then create a Node.js test script that implements and verifies this.

Report the average LTV (rounded to nearest integer).`,
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

function setupTypedSandbox(sandboxDir: string): void {
  console.log('  Setting up typed TypeScript sandbox...');

  // Clean and create
  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy data
  copyRecursive(path.join(PROJECT_DIR, 'data'), path.join(sandboxDir, 'data'));

  // Copy typed infrastructure
  copyRecursive(path.join(PROJECT_DIR, 'typed'), path.join(sandboxDir, 'typed'));

  // Create a working package.json for the sandbox (CommonJS for simplicity)
  const packageJson = {
    name: 'typed-sandbox'
    // No "type": "module" - use CommonJS so test.js works with require()
  };
  fs.writeFileSync(
    path.join(sandboxDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  // Create a ready-to-use test template (plain JS, same as DBT)
  const testTemplate = `// Test template - edit and run with: node test.js
const fs = require('fs');

// Load data
const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
const subscriptions = JSON.parse(fs.readFileSync('./data/subscriptions.json', 'utf8'));
const customers = JSON.parse(fs.readFileSync('./data/customers.json', 'utf8'));

// Implement the calculation here and print the result
// Example for ARPU:
// const paid = invoices.filter(i => i.status === 'paid');
// const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
// const customers = new Set(paid.map(i => i.customer_id)).size;
// console.log(Math.round(total / customers));
`;
  fs.writeFileSync(path.join(sandboxDir, 'test.js'), testTemplate);

  console.log('  Sandbox ready at:', sandboxDir);
}

function setupDbtSandbox(sandboxDir: string): void {
  console.log('  Setting up DBT/SQL sandbox...');

  if (fs.existsSync(sandboxDir)) {
    fs.rmSync(sandboxDir, { recursive: true });
  }
  fs.mkdirSync(sandboxDir, { recursive: true });

  // Copy data
  copyRecursive(path.join(PROJECT_DIR, 'data'), path.join(sandboxDir, 'data'));

  // Copy warehouse infrastructure
  copyRecursive(path.join(PROJECT_DIR, 'warehouse'), path.join(sandboxDir, 'warehouse'));

  // Create package.json
  const packageJson = {
    name: 'dbt-sandbox',
    type: 'module'
  };
  fs.writeFileSync(
    path.join(sandboxDir, 'package.json'),
    JSON.stringify(packageJson, null, 2)
  );

  // Create a ready-to-use test template
  const testTemplate = `// Test template - edit and run with: node test.js
const fs = require('fs');

// Load data (same data that DBT would query)
const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
const subscriptions = JSON.parse(fs.readFileSync('./data/subscriptions.json', 'utf8'));
const customers = JSON.parse(fs.readFileSync('./data/customers.json', 'utf8'));

// Implement your SQL logic in JavaScript to verify
// Example for ARPU:
// const paid = invoices.filter(i => i.status === 'paid');
// const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
// const uniqueCustomers = new Set(paid.map(i => i.customer_id)).size;
// console.log('ARPU:', Math.round(total / uniqueCustomers));
`;
  fs.writeFileSync(path.join(sandboxDir, 'test.js'), testTemplate);

  console.log('  Sandbox ready at:', sandboxDir);
}

function isMistralModel(model: string): boolean {
  return model.includes('mistral') || model.includes('devstral') || model.includes('codestral');
}

function isOpenRouterModel(model: string): boolean {
  return model.includes('/'); // OpenRouter models have format "provider/model"
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callMistralLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY not set');

  // Mistral format: system message as first message with role 'system'
  const mistralMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  // Retry with exponential backoff for rate limits
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s, 16s
      console.log(`        Rate limited, waiting ${waitTime/1000}s...`);
      await sleep(waitTime);
    }

    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        messages: mistralMessages,
      }),
    });

    if (response.ok) {
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content || '';
    }

    if (response.status === 429) {
      lastError = new Error('Rate limited');
      continue;
    }

    const text = await response.text();
    throw new Error(`Mistral API error ${response.status}: ${text.slice(0, 200)}`);
  }

  throw lastError || new Error('Mistral API failed after retries');
}

async function callAnthropicLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
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
      system: systemPrompt,
      messages,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as { content: Array<{ text: string }> };
  return data.content.map(c => c.text).join('');
}

async function callOpenRouterLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY not set');

  // OpenRouter uses OpenAI-compatible format
  const openRouterMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  // Retry with exponential backoff for rate limits
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const waitTime = Math.pow(2, attempt) * 1000;
      console.log(`        Rate limited, waiting ${waitTime/1000}s...`);
      await sleep(waitTime);
    }

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': 'https://github.com/anthropics/claude-code',
        'X-Title': 'Agent Benchmark',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        temperature: 0,
        messages: openRouterMessages,
      }),
    });

    if (response.ok) {
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices[0]?.message?.content || '';
    }

    if (response.status === 429) {
      lastError = new Error('Rate limited');
      continue;
    }

    const text = await response.text();
    throw new Error(`OpenRouter API error ${response.status}: ${text.slice(0, 200)}`);
  }

  throw lastError || new Error('OpenRouter API failed after retries');
}

async function callLLM(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  systemPrompt: string
): Promise<string> {
  if (isMistralModel(model)) {
    return callMistralLLM(messages, model, systemPrompt);
  }
  if (isOpenRouterModel(model)) {
    return callOpenRouterLLM(messages, model, systemPrompt);
  }
  return callAnthropicLLM(messages, model, systemPrompt);
}

interface ToolCall {
  tool: string;
  params: Record<string, string>;
}

function parseToolCall(response: string): ToolCall | null {
  // Look for tool tags
  const toolMatch = response.match(/<tool>(\w+)<\/tool>/);
  if (!toolMatch) return null;

  const tool = toolMatch[1];
  const params: Record<string, string> = {};

  // Extract parameters
  const pathMatch = response.match(/<path>([\s\S]*?)<\/path>/);
  if (pathMatch) params.path = pathMatch[1].trim();

  const contentMatch = response.match(/<content>([\s\S]*?)<\/content>/);
  if (contentMatch) params.content = contentMatch[1];

  const commandMatch = response.match(/<command>([\s\S]*?)<\/command>/);
  if (commandMatch) params.command = commandMatch[1].trim();

  const answerMatch = response.match(/<answer>([\s\S]*?)<\/answer>/);
  if (answerMatch) params.answer = answerMatch[1].trim();

  return { tool, params };
}

function executeTool(tool: ToolCall, sandboxDir: string): string {
  try {
    switch (tool.tool) {
      case 'read_file': {
        const filePath = path.join(sandboxDir, tool.params.path);
        if (!fs.existsSync(filePath)) {
          return `Error: File not found: ${tool.params.path}`;
        }
        const content = fs.readFileSync(filePath, 'utf8');
        // Truncate very long files
        if (content.length > 8000) {
          return `File: ${tool.params.path}\n\`\`\`\n${content.slice(0, 8000)}\n... [truncated, ${content.length} total chars]\n\`\`\``;
        }
        return `File: ${tool.params.path}\n\`\`\`\n${content}\n\`\`\``;
      }

      case 'write_file':
      case 'edit_file': {
        const filePath = path.join(sandboxDir, tool.params.path);
        const dir = path.dirname(filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(filePath, tool.params.content);
        return `Successfully wrote ${tool.params.path} (${tool.params.content.length} chars)`;
      }

      case 'run':
      case 'run_command':
      case 'bash': {
        try {
          const output = execSync(tool.params.command, {
            cwd: sandboxDir,
            encoding: 'utf8',
            timeout: 30000,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_NO_WARNINGS: '1' },
          });
          const result = output.trim();
          if (result.length > 4000) {
            return `Output:\n${result.slice(0, 4000)}\n... [truncated]`;
          }
          return `Output:\n${result}`;
        } catch (error: any) {
          const stderr = error.stderr?.toString() || '';
          const stdout = error.stdout?.toString() || '';
          return `Command failed:\n${stderr || stdout || error.message}`.slice(0, 2000);
        }
      }

      case 'list_files':
      case 'ls': {
        const dir = tool.params.path ? path.join(sandboxDir, tool.params.path) : sandboxDir;
        if (!fs.existsSync(dir)) {
          return `Error: Directory not found: ${tool.params.path || '.'}`;
        }
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        const list = entries
          .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
          .map(e => e.isDirectory() ? `${e.name}/` : e.name)
          .join('\n');
        return `Contents of ${tool.params.path || '.'}:\n${list}`;
      }

      case 'done':
        return 'TASK_COMPLETE';

      default:
        return `Unknown tool: ${tool.tool}`;
    }
  } catch (error: any) {
    return `Tool error: ${error.message}`;
  }
}

const TOOLS_PROMPT = `Available tools (use exactly one per response):

1. READ FILE:
<tool>read_file</tool>
<path>relative/path/to/file</path>

2. WRITE/EDIT FILE:
<tool>write_file</tool>
<path>relative/path/to/file</path>
<content>
complete file content
</content>

3. RUN COMMAND:
<tool>run</tool>
<command>shell command here</command>

4. LIST FILES:
<tool>list_files</tool>
<path>optional/directory</path>

5. DONE (when task is complete):
<tool>done</tool>
<answer>ONLY the numeric value (e.g., 170612 or 0.2168)</answer>

CRITICAL: The <answer> must contain ONLY the number. No text, no explanation.`;

const TYPED_SYSTEM_PROMPT = `You are a coding agent that modifies TypeScript analytics code.

${TOOLS_PROMPT}

SANDBOX STRUCTURE:
- typed/src/analytics/queries.ts - Add your function here
- typed/src/types/stripe.ts - Type definitions
- data/*.json - Invoice, subscription, customer data
- test.js - Ready-to-use test file

HOW TO TEST:
1. Edit test.js to compute the answer (plain JavaScript)
2. Run: node test.js
3. The output is your answer

IMPORTANT: Use plain JavaScript in test.js, not TypeScript. Just load the JSON and compute directly.

EXAMPLE test.js:
\`\`\`javascript
const fs = require('fs');
const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
const paid = invoices.filter(i => i.status === 'paid');
const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
const uniqueCustomers = new Set(paid.map(i => i.customer_id)).size;
console.log(Math.round(total / uniqueCustomers));
\`\`\`

WORKFLOW:
1. Read queries.ts to understand the types
2. Add your new function to queries.ts
3. Write test.js to compute the same answer (plain JS)
4. Run: node test.js
5. Report the numeric result`;

const DBT_SYSTEM_PROMPT = `You are a coding agent that creates DBT SQL models.

${TOOLS_PROMPT}

SANDBOX STRUCTURE:
- warehouse/models/staging/*.sql - Existing DBT models (reference these)
- data/*.json - Invoice, subscription, customer data
- test.js - Ready-to-use test file

HOW TO TEST (since we can't run SQL directly):
1. Write your SQL model in warehouse/models/staging/
2. Edit test.js to implement the SAME logic in JavaScript
3. Run: node test.js
4. The output is your answer

EXAMPLE test.js for ARPU:
\`\`\`javascript
const fs = require('fs');
const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
const paid = invoices.filter(i => i.status === 'paid');
const total = paid.reduce((sum, i) => sum + i.amount_paid, 0);
const customers = new Set(paid.map(i => i.customer_id)).size;
console.log(Math.round(total / customers));
\`\`\`

WORKFLOW:
1. Read existing staging models to see SQL patterns
2. Create your new .sql model
3. Write test.js with equivalent JavaScript logic
4. Run test.js and report the numeric result`;

function getSystemPrompt(contextType: 'typed' | 'dbt'): string {
  return contextType === 'typed' ? TYPED_SYSTEM_PROMPT : DBT_SYSTEM_PROMPT;
}

async function runAgent(
  task: Task,
  sandboxDir: string,
  model: string,
  maxTurns: number,
  contextType: 'typed' | 'dbt'
): Promise<{ success: boolean; answer?: unknown; error?: string; turns: number }> {

  const systemPrompt = getSystemPrompt(contextType);

  const initialPrompt = `TASK: ${task.description}

Start by reading the relevant files, then implement and test your solution.`;

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: initialPrompt }
  ];

  let turns = 0;
  while (turns < maxTurns) {
    turns++;

    // Keep context manageable - only last N messages plus first
    let contextMessages = messages;
    if (messages.length > 12) {
      contextMessages = [
        messages[0],
        { role: 'user' as const, content: `[... ${messages.length - 10} earlier turns omitted ...]\n\nContinuing from recent context:` },
        ...messages.slice(-10)
      ];
    }

    const response = await callLLM(contextMessages, model, systemPrompt);
    messages.push({ role: 'assistant', content: response });

    // Add delay for external APIs to avoid rate limits
    if (isMistralModel(model) || isOpenRouterModel(model)) {
      await sleep(1000);
    }

    const tool = parseToolCall(response);
    if (!tool) {
      console.log(`      Turn ${turns}: [no tool parsed]`);
      messages.push({
        role: 'user',
        content: 'Please use one of the available tools. Remember to wrap tool calls in the proper tags.'
      });
      continue;
    }

    const toolDisplay = tool.params.path || tool.params.command?.slice(0, 50) || tool.params.answer?.slice(0, 30) || '';
    console.log(`      Turn ${turns}: [${tool.tool}] ${toolDisplay}`);

    if (tool.tool === 'done') {
      let answer: unknown = tool.params.answer;
      // Try to parse as number
      const num = parseFloat(tool.params.answer);
      if (!isNaN(num)) {
        answer = num;
      } else {
        // Try to extract a number from text (e.g., "result of $1,234" -> 1234)
        const numMatch = tool.params.answer.match(/[\d,]+\.?\d*/g);
        if (numMatch) {
          // Find the largest number (likely the answer, not a small incidental number)
          const numbers = numMatch.map(s => parseFloat(s.replace(/,/g, ''))).filter(n => !isNaN(n));
          if (numbers.length > 0) {
            answer = Math.max(...numbers);
          }
        }
      }
      return { success: true, answer, turns };
    }

    const result = executeTool(tool, sandboxDir);
    messages.push({ role: 'user', content: result });
  }

  return { success: false, error: 'Max turns exceeded', turns };
}

function compareValues(actual: unknown, expected: unknown, tolerance: number = 0): boolean {
  if (typeof expected === 'number' && typeof actual === 'number') {
    return Math.abs(actual - expected) <= tolerance;
  }
  return actual === expected;
}

async function runBenchmark(): Promise<void> {
  const args = process.argv.slice(2);
  const contextType = (args.find(a => a.startsWith('--context='))?.split('=')[1] ?? 'typed') as 'typed' | 'dbt';
  const model = args.find(a => a.startsWith('--model='))?.split('=')[1] ?? 'claude-sonnet-4-20250514';
  const maxTurns = parseInt(args.find(a => a.startsWith('--max-turns='))?.split('=')[1] ?? '25');
  const taskFilter = args.find(a => a.startsWith('--task='))?.split('=')[1];

  const tasks = contextType === 'typed' ? TYPED_TASKS : DBT_TASKS;
  const selectedTasks = taskFilter ? tasks.filter(t => t.id === taskFilter) : tasks;
  const contextLabel = contextType === 'typed' ? 'Typed TypeScript' : 'DBT/SQL';
  const sandboxId = getSandboxId(model);
  const sandboxDir = path.join(SANDBOX_BASE, `${contextType}-${sandboxId}`);

  console.log('\n' + '='.repeat(70));
  console.log('AGENT BENCHMARK: Data Infrastructure Modification');
  console.log('='.repeat(70));
  console.log(`Context:    ${contextLabel}`);
  console.log(`Model:      ${model}`);
  console.log(`Max turns:  ${maxTurns}`);
  console.log(`Tasks:      ${selectedTasks.length}`);
  console.log('='.repeat(70) + '\n');

  // Setup sandbox once
  if (contextType === 'typed') {
    setupTypedSandbox(sandboxDir);
  } else {
    setupDbtSandbox(sandboxDir);
  }

  const results: Array<{ id: string; pass: boolean; expected: unknown; actual: unknown; turns: number; error?: string }> = [];

  for (const task of selectedTasks) {
    console.log(`\n--- Task: ${task.id} ---`);
    console.log(`${task.description.split('\n')[0]}...\n`);

    // Reset sandbox for each task (fresh copy)
    if (contextType === 'typed') {
      setupTypedSandbox(sandboxDir);
    } else {
      setupDbtSandbox(sandboxDir);
    }

    const expected = task.expectedValue();
    console.log(`    Expected answer: ${expected}`);
    console.log(`    Running agent...`);

    const startTime = Date.now();
    const result = await runAgent(task, sandboxDir, model, maxTurns, contextType);
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    if (result.success && result.answer !== undefined) {
      const pass = compareValues(result.answer, expected, task.tolerance ?? 0);

      if (pass) {
        console.log(`\n    ✓ PASS (${result.turns} turns, ${duration}s)`);
        console.log(`      Answer: ${result.answer}`);
      } else {
        console.log(`\n    ✗ FAIL - Wrong answer (${result.turns} turns, ${duration}s)`);
        console.log(`      Expected: ${expected}`);
        console.log(`      Actual:   ${result.answer}`);
      }
      results.push({ id: task.id, pass, expected, actual: result.answer, turns: result.turns });
    } else {
      console.log(`\n    ✗ FAIL - ${result.error} (${result.turns} turns, ${duration}s)`);
      results.push({ id: task.id, pass: false, expected, actual: undefined, turns: result.turns, error: result.error });
    }
  }

  // Summary
  const passed = results.filter(r => r.pass).length;
  const avgTurns = results.reduce((sum, r) => sum + r.turns, 0) / results.length;

  console.log('\n' + '='.repeat(70));
  console.log(`SUMMARY: ${contextLabel}`);
  console.log('='.repeat(70));
  console.log(`Passed:       ${passed}/${results.length} (${((passed / results.length) * 100).toFixed(0)}%)`);
  console.log(`Avg turns:    ${avgTurns.toFixed(1)}`);
  console.log('\nResults:');
  for (const r of results) {
    const status = r.pass ? '✓' : '✗';
    const detail = r.error ? r.error : `expected=${r.expected}, actual=${r.actual}`;
    console.log(`  ${status} ${r.id} (${r.turns} turns) - ${detail}`);
  }
  console.log('='.repeat(70) + '\n');
}

runBenchmark().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
