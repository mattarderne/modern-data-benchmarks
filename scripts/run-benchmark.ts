import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { calculateMrr, calculateMrrByPlan } from '../typed/src/analytics/queries.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const MISTRAL_API_URL = 'https://api.mistral.ai/v1/chat/completions';

type TableRow = Record<string, unknown>;

type QuerySpec = {
  select: string;
  joins?: Array<{
    leftTable: string;
    leftColumn: string;
    rightTable: string;
    rightColumn: string;
  }>;
  filters?: Array<{
    table: string;
    column: string;
    op: '=' | '!=' | 'in';
    value: string | number | boolean | Array<string | number | boolean>;
  }>;
  groupBy?: { table: string; column: string } | null;
  aggregate: { op: 'sum' | 'count'; table: string; column?: string };
};

type BenchmarkTask = {
  id: string;
  question: string;
  expectedType: 'scalar' | 'grouped';
};

type ExpectedResult = {
  scalar?: number;
  grouped?: Array<{ key: string; value: number }>;
};

type RubricScore = {
  score: number;
  max: number;
  normalized: number;
  components: Record<string, number>;
};

type LlmRunResult = {
  taskId: string;
  contextName: string;
  trial: number;
  ok: boolean;
  error?: string;
  expected: ExpectedResult;
  actual?: ExpectedResult;
  spec?: QuerySpec;
  validationErrors?: string[];
  rubric?: RubricScore;
  usage?: { input_tokens?: number; output_tokens?: number };
  durationMs?: number;
  rawText?: string;
};

function readJson<T>(fileName: string): T {
  const filePath = path.join(DATA_DIR, `${fileName}.json`);
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw) as T;
}

function ensureData(): void {
  if (!fs.existsSync(DATA_DIR)) {
    throw new Error(`Missing data directory at ${DATA_DIR}. Run: node data-architecture-comparison/scripts/generate-data.js`);
  }
}

function buildSchemaSummary(tables: Record<string, TableRow[]>): string {
  const lines: string[] = [];
  Object.entries(tables)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([name, rows]) => {
      const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
      lines.push(`- ${name}: ${columns.join(', ')}`);
    });
  return lines.join('\n');
}

type ForeignKeyMap = Record<string, Record<string, string>>;

const SHARED_FOREIGN_KEYS: ForeignKeyMap = {
  subscriptions: {
    customer_id: 'customers.id',
    price_id: 'prices.id',
  },
  invoices: {
    customer_id: 'customers.id',
    subscription_id: 'subscriptions.id',
  },
  payment_intents: {
    customer_id: 'customers.id',
  },
  prices: {
    product_id: 'products.id',
  },
  users: {
    organization_id: 'organizations.id',
    stripe_customer_id: 'customers.id',
  },
  api_usage: {
    user_id: 'users.id',
  },
  chat_sessions: {
    user_id: 'users.id',
  },
};

function buildJoinMapSummary(map: ForeignKeyMap): string {
  const lines: string[] = [];
  Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([table, fks]) => {
      Object.entries(fks).forEach(([column, target]) => {
        lines.push(`- ${table}.${column} -> ${target}`);
      });
    });
  return lines.join('\n');
}

function loadContext(files: string[]): string {
  return files
    .map((file) => {
      const filePath = path.join(PROJECT_DIR, file);
      const content = fs.readFileSync(filePath, 'utf8');
      return `--- ${file} ---\n${content}`;
    })
    .join('\n\n');
}

function parseArgs(): {
  context: 'typed' | 'dbt' | 'shared' | 'both' | 'all';
  provider: 'anthropic' | 'mistral';
  model: string;
  maxTokens: number;
  trials: number;
  temperature: number;
  retries: number;
  mode: 'spec' | 'code';
} {
  const args = process.argv.slice(2);
  const getArg = (flag: string): string | undefined => {
    const direct = args.find((arg) => arg.startsWith(`${flag}=`));
    if (direct) return direct.slice(flag.length + 1);
    const index = args.indexOf(flag);
    if (index >= 0 && index + 1 < args.length) return args[index + 1];
    return undefined;
  };

  const contextValue = getArg('--context') ?? 'both';
  const providerValue = getArg('--provider') ?? (process.env.MISTRAL_API_KEY ? 'mistral' : 'anthropic');
  const modelValue = getArg('--model') ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_MODEL;
  const maxTokensValue = Number(getArg('--max-tokens') ?? process.env.MAX_TOKENS ?? 512);
  const trialsValue = Number(getArg('--trials') ?? process.env.TRIALS ?? 1);
  const temperatureValue = Number(getArg('--temperature') ?? process.env.TEMPERATURE ?? 0);
  const retriesValue = Number(getArg('--retries') ?? process.env.RETRIES ?? 2);
  const modeValue = getArg('--mode') ?? 'spec';

  if (!['typed', 'dbt', 'shared', 'both', 'all'].includes(contextValue)) {
    throw new Error(`Invalid --context ${contextValue}. Use typed, dbt, shared, both, or all.`);
  }

  if (!['anthropic', 'mistral'].includes(providerValue)) {
    throw new Error(`Invalid --provider ${providerValue}. Use anthropic or mistral.`);
  }

  if (!['spec', 'code'].includes(modeValue)) {
    throw new Error(`Invalid --mode ${modeValue}. Use spec or code.`);
  }

  return {
    context: contextValue as 'typed' | 'dbt' | 'shared' | 'both' | 'all',
    provider: providerValue as 'anthropic' | 'mistral',
    model: modelValue,
    maxTokens: Number.isFinite(maxTokensValue) ? maxTokensValue : 512,
    trials: Number.isFinite(trialsValue) && trialsValue > 0 ? Math.floor(trialsValue) : 1,
    temperature: Number.isFinite(temperatureValue) ? Math.max(0, Math.min(temperatureValue, 1)) : 0,
    retries: Number.isFinite(retriesValue) && retriesValue >= 0 ? Math.floor(retriesValue) : 0,
    mode: modeValue as 'spec' | 'code',
  };
}

function extractJson(text: string): QuerySpec {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in response.');
  }
  const raw = text.slice(start, end + 1);
  return JSON.parse(raw) as QuerySpec;
}

function normalizeTableName(name: string): string {
  const trimmed = name.trim();
  const refMatch = trimmed.match(/\{\{\s*ref\(['"]([^'"]+)['"]\)\s*\}\}/);
  const resolved = refMatch ? refMatch[1] : trimmed;
  const withoutSchema = resolved.includes('.') ? resolved.split('.').pop() ?? resolved : resolved;
  return withoutSchema.toLowerCase();
}

function normalizeSpec(spec: QuerySpec): QuerySpec {
  return {
    ...spec,
    select: normalizeTableName(spec.select),
    joins: spec.joins?.map((join) => ({
      ...join,
      leftTable: normalizeTableName(join.leftTable),
      rightTable: normalizeTableName(join.rightTable),
    })),
    filters: spec.filters?.map((filter) => ({
      ...filter,
      table: normalizeTableName(filter.table),
    })),
    groupBy: spec.groupBy
      ? { ...spec.groupBy, table: normalizeTableName(spec.groupBy.table) }
      : spec.groupBy,
    aggregate: { ...spec.aggregate, table: normalizeTableName(spec.aggregate.table) },
  };
}

const TABLE_ALIASES: Record<string, string[]> = {
  subscriptions: ['stg_stripe_subscriptions'],
  invoices: ['stg_stripe_invoices'],
  customers: ['stg_stripe_customers'],
  users: ['stg_internal_users'],
  prices: ['stg_stripe_prices'],
  products: ['stg_stripe_products'],
  fct_mrr: ['fct_mrr'],
};

function tableMatches(table: string, canonical: string): boolean {
  const normalized = normalizeTableName(table);
  const target = canonical.toLowerCase();
  if (normalized === target) return true;
  const aliases = TABLE_ALIASES[target] ?? [];
  return aliases.includes(normalized);
}

function hasFilter(spec: QuerySpec | undefined, table: string, column: string, value: string | number | boolean): boolean {
  if (!spec?.filters || spec.filters.length === 0) return false;
  return spec.filters.some(
    (filter) =>
      tableMatches(filter.table, table) &&
      filter.column === column &&
      filter.op === '=' &&
      filter.value === value
  );
}

function hasJoinBetween(spec: QuerySpec | undefined, leftTable: string, rightTable: string): boolean {
  if (!spec?.joins || spec.joins.length === 0) return false;
  return spec.joins.some(
    (join) =>
      (tableMatches(join.leftTable, leftTable) && tableMatches(join.rightTable, rightTable)) ||
      (tableMatches(join.leftTable, rightTable) && tableMatches(join.rightTable, leftTable))
  );
}

function groupByMatches(spec: QuerySpec | undefined, table: string, column: string): boolean {
  if (!spec?.groupBy) return false;
  return tableMatches(spec.groupBy.table, table) && spec.groupBy.column === column;
}

function aggregateMatches(
  spec: QuerySpec | undefined,
  op: 'sum' | 'count',
  table: string,
  column?: string
): boolean {
  if (!spec?.aggregate) return false;
  if (spec.aggregate.op !== op) return false;
  if (!tableMatches(spec.aggregate.table, table)) return false;
  if (op === 'sum' && column) {
    return spec.aggregate.column === column;
  }
  return true;
}

function validateSpec(spec: QuerySpec, schema: Record<string, string[]>): string[] {
  const errors: string[] = [];
  if (!schema[spec.select]) {
    errors.push(`Unknown select table: ${spec.select}`);
  }
  const checkColumn = (table: string, column: string): void => {
    if (!schema[table]) {
      errors.push(`Unknown table: ${table}`);
      return;
    }
    if (!schema[table].includes(column)) {
      errors.push(`Unknown column: ${table}.${column}`);
    }
  };

  spec.joins?.forEach((join) => {
    checkColumn(join.leftTable, join.leftColumn);
    checkColumn(join.rightTable, join.rightColumn);
  });

  spec.filters?.forEach((filter) => {
    checkColumn(filter.table, filter.column);
  });

  if (spec.groupBy) {
    checkColumn(spec.groupBy.table, spec.groupBy.column);
  }

  if (spec.aggregate.op === 'sum') {
    if (!spec.aggregate.column) {
      errors.push('aggregate.column is required for sum');
    } else {
      checkColumn(spec.aggregate.table, spec.aggregate.column);
    }
  } else if (spec.aggregate.op === 'count') {
    if (!schema[spec.aggregate.table]) {
      errors.push(`Unknown aggregate table: ${spec.aggregate.table}`);
    }
  }

  return errors;
}

function prefixRow(table: string, row: TableRow): TableRow {
  const prefixed: TableRow = {};
  Object.entries(row).forEach(([key, value]) => {
    prefixed[`${table}.${key}`] = value;
  });
  return prefixed;
}

function applyFilters(rows: TableRow[], filters: QuerySpec['filters']): TableRow[] {
  if (!filters || filters.length === 0) return rows;
  return rows.filter((row) => {
    return filters.every((filter) => {
      const value = row[`${filter.table}.${filter.column}`];
      if (filter.op === '=') return value === filter.value;
      if (filter.op === '!=') return value !== filter.value;
      if (filter.op === 'in' && Array.isArray(filter.value)) return filter.value.includes(value as never);
      return false;
    });
  });
}

function applyJoins(rows: TableRow[], joins: QuerySpec['joins'], tables: Record<string, TableRow[]>): TableRow[] {
  if (!joins || joins.length === 0) return rows;

  return joins.reduce<TableRow[]>((currentRows, join) => {
    const rightRows = tables[join.rightTable] ?? [];
    const index = new Map<unknown, TableRow[]>();

    rightRows.forEach((row) => {
      const key = row[join.rightColumn];
      const bucket = index.get(key);
      const prefixed = prefixRow(join.rightTable, row);
      if (bucket) {
        bucket.push(prefixed);
      } else {
        index.set(key, [prefixed]);
      }
    });

    const nextRows: TableRow[] = [];
    currentRows.forEach((row) => {
      const leftValue = row[`${join.leftTable}.${join.leftColumn}`];
      const matches = index.get(leftValue) ?? [];
      matches.forEach((match) => {
        nextRows.push({ ...row, ...match });
      });
    });

    return nextRows;
  }, rows);
}

function aggregateRows(rows: TableRow[], spec: QuerySpec): ExpectedResult {
  const groupBy = spec.groupBy;
  const aggregate = spec.aggregate;

  const getValue = (row: TableRow, table: string, column: string | undefined): number => {
    if (!column) return 0;
    const raw = row[`${table}.${column}`];
    if (typeof raw === 'number') return raw;
    return Number(raw ?? 0);
  };

  if (!groupBy) {
    if (aggregate.op === 'count') {
      return { scalar: rows.length };
    }
    const total = rows.reduce((sum, row) => sum + getValue(row, aggregate.table, aggregate.column), 0);
    return { scalar: total };
  }

  const groups = new Map<string, number>();
  rows.forEach((row) => {
    const key = String(row[`${groupBy.table}.${groupBy.column}`]);
    const current = groups.get(key) ?? 0;
    if (aggregate.op === 'count') {
      groups.set(key, current + 1);
      return;
    }
    groups.set(key, current + getValue(row, aggregate.table, aggregate.column));
  });

  const grouped = Array.from(groups.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { grouped };
}

function executeSpec(spec: QuerySpec, tables: Record<string, TableRow[]>): ExpectedResult {
  const baseRows = tables[spec.select] ?? [];
  let rows = baseRows.map((row) => prefixRow(spec.select, row));
  rows = applyJoins(rows, spec.joins, tables);
  rows = applyFilters(rows, spec.filters);
  return aggregateRows(rows, spec);
}

function compareResults(actual: ExpectedResult, expected: ExpectedResult): { ok: boolean; error?: string } {
  if (expected.scalar !== undefined) {
    const actualValue = actual.scalar;
    if (typeof actualValue !== 'number') {
      return { ok: false, error: 'Expected scalar result but got grouped output.' };
    }
    if (actualValue !== expected.scalar) {
      return { ok: false, error: `Scalar mismatch. expected=${expected.scalar} actual=${actualValue}` };
    }
    return { ok: true };
  }

  if (expected.grouped) {
    if (!actual.grouped) {
      return { ok: false, error: 'Expected grouped result but got scalar output.' };
    }
    const expectedMap = new Map(expected.grouped.map((item) => [item.key, item.value]));
    const actualMap = new Map(actual.grouped.map((item) => [item.key, item.value]));
    for (const [key, value] of expectedMap.entries()) {
      if (!actualMap.has(key)) {
        return { ok: false, error: `Missing group ${key}` };
      }
      if (actualMap.get(key) !== value) {
        return { ok: false, error: `Group mismatch for ${key}. expected=${value} actual=${actualMap.get(key)}` };
      }
    }
    return { ok: true };
  }

  return { ok: false, error: 'No expected result provided.' };
}

function buildPrompt(contextName: string, contextText: string, schemaText: string, task: BenchmarkTask): string {
  return [
    `You are helping run a benchmark for ${contextName} context.`,
    '',
    'Task:',
    task.question,
    '',
    'Return ONLY a JSON query specification that follows this schema:',
    '{',
    '  "select": "<base table>",',
    '  "joins": [',
    '    {"leftTable": "<table>", "leftColumn": "<column>", "rightTable": "<table>", "rightColumn": "<column>"}',
    '  ],',
    '  "filters": [',
    '    {"table": "<table>", "column": "<column>", "op": "=", "value": "<value>"}',
    '  ],',
    '  "groupBy": {"table": "<table>", "column": "<column>"} | null,',
    '  "aggregate": {"op": "sum" | "count", "table": "<table>", "column": "<column>"}',
    '}',
    '',
    'Rules:',
    '- Use only "=" in filters.',
    '- Use exact table and column names from the schema.',
    '- You may use base tables or DBT model names (stg_*, fct_*) listed in the schema.',
    '- If you use ref() macros, write the resolved table name (e.g. fct_mrr).',
    '- If no joins/filters, use empty arrays. If no groupBy, use null.',
    '- Do not add extra keys or commentary.',
    '',
    'Schema:',
    schemaText,
    '',
    'Context:',
    contextText,
  ].join('\n');
}

function buildCodePrompt(contextName: string, contextText: string, schemaText: string, task: BenchmarkTask): string {
  if (contextName === 'typed') {
    return [
      'You are helping run a benchmark. Generate plain JavaScript code (NOT TypeScript) to answer the following question.',
      '',
      'Task:',
      task.question,
      '',
      'You have access to these typed arrays (already loaded):',
      '- subscriptions: Array<{id, customer_id, price_id, status, ...}>',
      '- invoices: Array<{id, customer_id, subscription_id, amount_due, amount_paid, status, ...}>',
      '- customers: Array<{id, name, email, metadata: {segment, source}, ...}>',
      '- prices: Array<{id, product_id, nickname, unit_amount, ...}>',
      '- products: Array<{id, name, active, ...}>',
      '- users: Array<{id, organization_id, stripe_customer_id, email, role, ...}>',
      '- organizations: Array<{id, name, ...}>',
      '',
      'Return JavaScript code that computes and returns the result.',
      'The result must be either:',
      '- A number (for scalar results)',
      '- An array of {key: string, value: number} sorted by key (for grouped results)',
      '',
      'You can write multi-line code with const/let declarations. Use "return <result>" at the end.',
      '',
      'Example for scalar:',
      'const active = subscriptions.filter(s => s.status === "active");',
      'return active.length;',
      '',
      'Example for grouped:',
      'const m = new Map();',
      'invoices.filter(i => i.status === "paid").forEach(i => {',
      '  m.set(i.customer_id, (m.get(i.customer_id) || 0) + i.amount_paid);',
      '});',
      'return [...m].map(([k, v]) => ({ key: k, value: v })).sort((a, b) => a.key.localeCompare(b.key));',
      '',
      'Do NOT include any markdown code blocks, comments, or explanation. Just the executable code.',
      '',
      'Schema details:',
      schemaText,
      '',
      'Context:',
      contextText,
    ].join('\n');
  }

  // DBT context - generate SQL
  return [
    'You are helping run a benchmark. Generate a SQL query to answer the following question.',
    '',
    'Task:',
    task.question,
    '',
    'Available tables (use these exact names):',
    '- subscriptions (id, customer_id, price_id, status, current_period_start, current_period_end, cancel_at_period_end, created_at)',
    '- invoices (id, customer_id, subscription_id, amount_due, amount_paid, status, created_at)',
    '- customers (id, name, email, metadata, created_at) -- metadata is JSON with segment, source',
    '- prices (id, product_id, nickname, unit_amount, currency, billing_interval, created_at)',
    '- products (id, name, active, created_at)',
    '- users (id, organization_id, stripe_customer_id, email, role, created_at, last_login_at)',
    '- organizations (id, name, created_at)',
    '',
    'Return ONLY a single SQL SELECT statement.',
    'For scalar results: SELECT <aggregate> as value',
    'For grouped results: SELECT <group_col> as key, <aggregate> as value GROUP BY <group_col> ORDER BY key',
    '',
    'Do NOT include any markdown, comments, or explanation. Just the SQL.',
    '',
    'Schema details:',
    schemaText,
    '',
    'Context:',
    contextText,
  ].join('\n');
}

function extractCode(text: string): string {
  // Remove markdown code blocks if present
  let code = text.trim();
  if (code.startsWith('```')) {
    const lines = code.split('\n');
    lines.shift(); // remove opening ```
    while (lines.length && lines[lines.length - 1].startsWith('```')) {
      lines.pop();
    }
    code = lines.join('\n');
  }
  return code.trim();
}

function stripTypeAnnotations(code: string): string {
  // Remove TypeScript type annotations from variable declarations
  // const x: Type = ... -> const x = ...
  // let x: Type = ... -> let x = ...
  let stripped = code;
  // Remove type annotations from const/let declarations: const x: SomeType<T> =
  // Be careful to match the type properly (word optionally followed by generics)
  stripped = stripped.replace(/\b(const|let)\s+(\w+)\s*:\s*\w+(?:<[^>]*>)?\s*=/g, '$1 $2 =');
  return stripped;
}

function executeTypeScriptCode(
  code: string,
  tables: Record<string, TableRow[]>
): ExpectedResult {
  // Strip TypeScript type annotations for JS execution
  const jsCode = stripTypeAnnotations(code);

  // Try as expression first, then as block with return
  let wrappedCode: string;
  if (jsCode.includes('return ') || jsCode.includes('const ') || jsCode.includes('let ') || jsCode.includes('function ')) {
    // Multi-statement code - wrap in block
    wrappedCode = `"use strict"; ${jsCode}`;
    // If no explicit return, add one for the last expression
    if (!jsCode.includes('return ')) {
      const lines = jsCode.trim().split('\n');
      const lastLine = lines[lines.length - 1].trim();
      if (lastLine && !lastLine.endsWith(';')) {
        wrappedCode = `"use strict"; ${lines.slice(0, -1).join('\n')}\nreturn ${lastLine}`;
      }
    }
  } else {
    // Simple expression
    wrappedCode = `"use strict"; return (${jsCode});`;
  }

  const fn = new Function(
    'subscriptions', 'invoices', 'customers', 'prices', 'products', 'users', 'organizations',
    wrappedCode
  );
  const result = fn(
    tables.subscriptions,
    tables.invoices,
    tables.customers,
    tables.prices,
    tables.products,
    tables.users,
    tables.organizations
  );
  if (typeof result === 'number') {
    return { scalar: result };
  }
  if (Array.isArray(result)) {
    return { grouped: result as Array<{ key: string; value: number }> };
  }
  throw new Error(`Unexpected result type: ${typeof result}`);
}

function executeSqlCode(
  sql: string,
  tables: Record<string, TableRow[]>
): ExpectedResult {
  // Simple SQL parser for SELECT queries
  const normalized = sql.trim().replace(/\s+/g, ' ').toLowerCase();

  // Parse FROM clause to get base table
  const fromMatch = normalized.match(/from\s+(\w+)/);
  if (!fromMatch) throw new Error('No FROM clause found');
  const baseTable = fromMatch[1];

  let rows = [...(tables[baseTable] ?? [])];

  // Parse JOINs
  const joinRegex = /join\s+(\w+)\s+(?:\w+\s+)?on\s+(\w+)\.(\w+)\s*=\s*(\w+)\.(\w+)/gi;
  let joinMatch;
  while ((joinMatch = joinRegex.exec(sql)) !== null) {
    const [, joinTable, leftTable, leftCol, rightTable, rightCol] = joinMatch;
    const joinRows = tables[joinTable.toLowerCase()] ?? [];
    const joinIndex = new Map<unknown, TableRow[]>();
    const isLeftBase = leftTable.toLowerCase() === joinTable.toLowerCase();
    const indexCol = isLeftBase ? leftCol : rightCol;
    const lookupCol = isLeftBase ? rightCol : leftCol;

    joinRows.forEach((row) => {
      const key = row[indexCol];
      const bucket = joinIndex.get(key) ?? [];
      bucket.push(row);
      joinIndex.set(key, bucket);
    });

    const newRows: TableRow[] = [];
    rows.forEach((row) => {
      const key = row[lookupCol];
      const matches = joinIndex.get(key) ?? [];
      matches.forEach((match) => {
        newRows.push({ ...row, ...match });
      });
    });
    rows = newRows;
  }

  // Parse WHERE clause
  const whereMatch = sql.match(/where\s+(.+?)(?:group|order|$)/i);
  if (whereMatch) {
    const conditions = whereMatch[1].split(/\s+and\s+/i);
    conditions.forEach((cond) => {
      const eqMatch = cond.match(/(\w+)\.?(\w+)?\s*=\s*['"]?([^'"]+)['"]?/);
      if (eqMatch) {
        const col = eqMatch[2] || eqMatch[1];
        const val = eqMatch[3].trim();
        rows = rows.filter((row) => String(row[col]) === val);
      }
    });
  }

  // Parse GROUP BY
  const groupMatch = sql.match(/group\s+by\s+(\w+)/i);

  // Parse SELECT to determine aggregation
  const selectMatch = sql.match(/select\s+(.+?)\s+from/i);
  if (!selectMatch) throw new Error('No SELECT clause found');
  const selectClause = selectMatch[1];

  const sumMatch = selectClause.match(/sum\s*\(\s*(\w+)\s*\)/i);
  const countMatch = selectClause.match(/count\s*\(\s*\*?\s*\)/i) || selectClause.match(/count\s*\(\s*distinct\s+(\w+)\s*\)/i);
  const avgMatch = selectClause.match(/avg\s*\(\s*(\w+)\s*\)/i);

  if (!groupMatch) {
    // Scalar result
    if (sumMatch) {
      const col = sumMatch[1];
      const total = rows.reduce((sum, row) => sum + (Number(row[col]) || 0), 0);
      return { scalar: total };
    }
    if (countMatch) {
      return { scalar: rows.length };
    }
    if (avgMatch) {
      const col = avgMatch[1];
      const total = rows.reduce((sum, row) => sum + (Number(row[col]) || 0), 0);
      return { scalar: rows.length > 0 ? Math.round(total / rows.length) : 0 };
    }
    throw new Error('Unknown aggregation in SELECT');
  }

  // Grouped result
  const groupCol = groupMatch[1];
  const groups = new Map<string, number>();
  const groupCounts = new Map<string, number>();

  rows.forEach((row) => {
    const key = String(row[groupCol] ?? 'unknown');
    if (sumMatch) {
      const col = sumMatch[1];
      groups.set(key, (groups.get(key) ?? 0) + (Number(row[col]) || 0));
    } else if (countMatch) {
      groups.set(key, (groups.get(key) ?? 0) + 1);
    } else if (avgMatch) {
      const col = avgMatch[1];
      groups.set(key, (groups.get(key) ?? 0) + (Number(row[col]) || 0));
      groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1);
    }
  });

  if (avgMatch) {
    groups.forEach((sum, key) => {
      const count = groupCounts.get(key) ?? 1;
      groups.set(key, Math.round(sum / count));
    });
  }

  const grouped = Array.from(groups.entries())
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => a.key.localeCompare(b.key));

  return { grouped };
}

type TaskRubric = {
  requiredFilters: Array<{ table: string; column: string; value: string | number | boolean }>;
  requiredJoins: Array<{ leftTable: string; rightTable: string }>;
  groupBy: { table: string; column: string } | null;
  aggregate: { op: 'sum' | 'count'; table: string; column?: string };
};

function scoreRubric(
  spec: QuerySpec | undefined,
  validationErrors: string[] | undefined,
  rubric: TaskRubric,
  resultOk: boolean
): RubricScore {
  const components: Record<string, number> = {
    schema_valid: 0,
    filters_ok: 0,
    joins_ok: 0,
    group_by_ok: 0,
    aggregate_ok: 0,
    result_ok: 0,
  };

  if (!spec) {
    return { score: 0, max: Object.keys(components).length, normalized: 0, components };
  }

  components.schema_valid = validationErrors && validationErrors.length === 0 ? 1 : 0;
  components.filters_ok =
    rubric.requiredFilters.length === 0
      ? 1
      : rubric.requiredFilters.every((filter) =>
          hasFilter(spec, filter.table, filter.column, filter.value)
        )
        ? 1
        : 0;
  components.joins_ok =
    rubric.requiredJoins.length === 0
      ? 1
      : rubric.requiredJoins.every((join) => hasJoinBetween(spec, join.leftTable, join.rightTable))
        ? 1
        : 0;
  components.group_by_ok = rubric.groupBy
    ? groupByMatches(spec, rubric.groupBy.table, rubric.groupBy.column)
      ? 1
      : 0
    : spec.groupBy
      ? 0
      : 1;
  components.aggregate_ok = aggregateMatches(
    spec,
    rubric.aggregate.op,
    rubric.aggregate.table,
    rubric.aggregate.column
  )
    ? 1
    : 0;
  components.result_ok = resultOk ? 1 : 0;

  const max = Object.keys(components).length;
  const score = Object.values(components).reduce((sum, value) => sum + value, 0);
  return {
    score,
    max,
    normalized: max > 0 ? score / max : 0,
    components,
  };
}

async function callAnthropic(
  prompt: string,
  model: string,
  maxTokens: number,
  temperature: number
): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const apiKey =
    process.env.ANTHROPIC_API_KEY ??
    process.env.CLAUDE_API_KEY ??
    process.env.ANTHROPIC_KEY ??
    process.env.ANTHROPIC_TOKEN;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY (or CLAUDE_API_KEY) is not set.');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
  }

  const payload = (await response.json()) as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = payload.content?.map((item) => item.text ?? '').join('') ?? '';
  return { text, usage: payload.usage };
}

async function callMistral(
  prompt: string,
  model: string,
  maxTokens: number,
  temperature: number
): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } }> {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) {
    throw new Error('MISTRAL_API_KEY is not set.');
  }

  const response = await fetch(MISTRAL_API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Mistral API error ${response.status}: ${errorBody}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const text = payload.choices?.[0]?.message?.content ?? '';
  const usage = payload.usage
    ? { input_tokens: payload.usage.prompt_tokens, output_tokens: payload.usage.completion_tokens }
    : undefined;
  return { text, usage };
}

async function callModel(
  provider: 'anthropic' | 'mistral',
  prompt: string,
  model: string,
  maxTokens: number,
  temperature: number
): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } }> {
  if (provider === 'anthropic') {
    return callAnthropic(prompt, model, maxTokens, temperature);
  }
  return callMistral(prompt, model, maxTokens, temperature);
}

async function callModelWithRetry(
  provider: 'anthropic' | 'mistral',
  prompt: string,
  model: string,
  maxTokens: number,
  temperature: number,
  retries: number
): Promise<{ text: string; usage?: { input_tokens?: number; output_tokens?: number } }> {
  let attempt = 0;
  while (true) {
    try {
      return await callModel(provider, prompt, model, maxTokens, temperature);
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      const isNetworkError =
        message.includes('fetch failed') ||
        message.includes('ENOTFOUND') ||
        message.includes('ECONNRESET') ||
        message.includes('EAI_AGAIN');
      if (!isNetworkError || attempt > retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

type StripeSubscriptionRow = {
  id: string;
  customer_id: string;
  price_id: string;
  status: string;
  current_period_start: string;
  current_period_end: string;
  cancel_at_period_end: boolean;
  created_at: string;
};

type StripeInvoiceRow = {
  id: string;
  customer_id: string;
  subscription_id: string;
  amount_due: number;
  amount_paid: number;
  status: string;
  created_at: string;
};

type StripePriceRow = {
  id: string;
  product_id: string;
  nickname: string;
  unit_amount: number;
  currency: string;
  billing_interval: string;
  created_at: string;
};

type StripeProductRow = {
  id: string;
  name: string;
  active: boolean;
  created_at: string;
};

type StripeCustomerRow = {
  id: string;
  name: string;
  email: string;
  metadata: Record<string, unknown>;
  created_at: string;
};

type InternalUserRow = {
  id: string;
  organization_id: string;
  stripe_customer_id: string;
  email: string;
  role: string;
  created_at: string;
  last_login_at: string;
};

function buildTables(baseTables: Record<string, TableRow[]>): Record<string, TableRow[]> {
  const subscriptions = baseTables.subscriptions as StripeSubscriptionRow[];
  const invoices = baseTables.invoices as StripeInvoiceRow[];
  const prices = baseTables.prices as StripePriceRow[];
  const products = baseTables.products as StripeProductRow[];
  const customers = baseTables.customers as StripeCustomerRow[];
  const users = baseTables.users as InternalUserRow[];

  const stg_stripe_customers = customers.map((row) => ({
    customer_id: row.id,
    name: row.name,
    email: row.email,
    metadata: row.metadata,
    created_at: row.created_at,
  }));

  const stg_stripe_subscriptions = subscriptions.map((row) => ({
    subscription_id: row.id,
    customer_id: row.customer_id,
    price_id: row.price_id,
    status: row.status,
    current_period_start: row.current_period_start,
    current_period_end: row.current_period_end,
    cancel_at_period_end: row.cancel_at_period_end,
    created_at: row.created_at,
  }));

  const stg_stripe_invoices = invoices.map((row) => ({
    invoice_id: row.id,
    customer_id: row.customer_id,
    subscription_id: row.subscription_id,
    amount_due: row.amount_due,
    amount_paid: row.amount_paid,
    status: row.status,
    created_at: row.created_at,
  }));

  const stg_internal_users = users.map((row) => ({
    user_id: row.id,
    organization_id: row.organization_id,
    stripe_customer_id: row.stripe_customer_id,
    email: row.email,
    role: row.role,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  }));

  const stg_stripe_prices = prices.map((row) => ({
    id: row.id,
    price_id: row.id,
    product_id: row.product_id,
    nickname: row.nickname,
    unit_amount: row.unit_amount,
    currency: row.currency,
    billing_interval: row.billing_interval,
    created_at: row.created_at,
  }));

  const stg_stripe_products = products.map((row) => ({
    id: row.id,
    product_id: row.id,
    name: row.name,
    active: row.active,
    created_at: row.created_at,
  }));

  const activeSubscriptionKeys = new Set(
    subscriptions.filter((row) => row.status === 'active').map((row) => `${row.id}:${row.customer_id}`)
  );

  const fctBuckets = new Map<string, { customer_id: string; invoice_month: string; mrr_amount: number }>();
  invoices
    .filter((row) => row.status === 'paid')
    .forEach((invoice) => {
      const key = `${invoice.subscription_id}:${invoice.customer_id}`;
      if (!activeSubscriptionKeys.has(key)) return;
      const invoiceMonth = `${invoice.created_at.slice(0, 7)}-01`;
      const bucketKey = `${invoice.customer_id}:${invoiceMonth}`;
      const current = fctBuckets.get(bucketKey);
      if (current) {
        current.mrr_amount += invoice.amount_paid;
        return;
      }
      fctBuckets.set(bucketKey, {
        customer_id: invoice.customer_id,
        invoice_month: invoiceMonth,
        mrr_amount: invoice.amount_paid,
      });
    });

  const fct_mrr = Array.from(fctBuckets.values());

  return {
    ...baseTables,
    stg_stripe_customers,
    stg_stripe_subscriptions,
    stg_stripe_invoices,
    stg_internal_users,
    stg_stripe_prices,
    stg_stripe_products,
    fct_mrr,
  };
}

async function run(): Promise<void> {
  const { context, provider, model, maxTokens, trials, temperature, retries, mode } = parseArgs();

  ensureData();

  const baseTables: Record<string, TableRow[]> = {
    products: readJson('products'),
    prices: readJson('prices'),
    customers: readJson('customers'),
    organizations: readJson('organizations'),
    users: readJson('users'),
    subscriptions: readJson('subscriptions'),
    invoices: readJson('invoices'),
    payment_intents: readJson('payment_intents'),
    features: readJson('features'),
    api_usage: readJson('api_usage'),
    chat_sessions: readJson('chat_sessions'),
  };

  const tables = buildTables(baseTables);

  const schema: Record<string, string[]> = Object.fromEntries(
    Object.entries(tables).map(([name, rows]) => [name, rows.length > 0 ? Object.keys(rows[0]) : []])
  );

  const schemaText = buildSchemaSummary(tables);

  const tasks: BenchmarkTask[] = [
    {
      id: 'total_mrr',
      question:
        'Compute total MRR as the sum of amount_paid on paid invoices for subscriptions that are active.',
      expectedType: 'scalar',
    },
    {
      id: 'mrr_by_plan',
      question:
        'Compute MRR by plan nickname using paid invoices for subscriptions that are active. Return one group per plan nickname.',
      expectedType: 'grouped',
    },
    {
      id: 'active_subscriptions',
      question: 'Count the number of subscriptions with status = "active".',
      expectedType: 'scalar',
    },
    {
      id: 'paid_invoices',
      question: 'Count the number of invoices with status = "paid".',
      expectedType: 'scalar',
    },
    {
      id: 'mrr_by_customer',
      question:
        'Compute MRR by customer_id using paid invoices for subscriptions that are active. Return one group per customer_id.',
      expectedType: 'grouped',
    },
    {
      id: 'revenue_by_product',
      question:
        'Compute total revenue by product name using paid invoices for subscriptions that are active. Return one group per product name.',
      expectedType: 'grouped',
    },
    {
      id: 'total_revenue',
      question: 'Compute total revenue as the sum of amount_paid on paid invoices (no active subscription filter).',
      expectedType: 'scalar',
    },
    {
      id: 'paid_invoices_by_customer',
      question: 'Count paid invoices by customer_id. Return one group per customer_id.',
      expectedType: 'grouped',
    },
    {
      id: 'active_subscriptions_by_plan',
      question: 'Count active subscriptions by plan nickname. Return one group per plan nickname.',
      expectedType: 'grouped',
    },
    {
      id: 'paid_revenue_by_plan',
      question:
        'Compute revenue by plan nickname using paid invoices (no active subscription filter). Return one group per plan nickname.',
      expectedType: 'grouped',
    },
    // Harder tasks (3+ table joins)
    {
      id: 'mrr_by_org',
      question:
        'Compute MRR by organization name. Join invoices to subscriptions (on subscription_id), subscriptions to customers (on customer_id), customers to users (on stripe_customer_id), and users to organizations (on organization_id). Filter for paid invoices and active subscriptions. Return one group per organization name.',
      expectedType: 'grouped',
    },
    {
      id: 'revenue_by_customer_segment',
      question:
        'Compute total revenue by customer segment (from customers.metadata.segment). Join invoices to customers on customer_id. Filter for paid invoices. Return one group per segment.',
      expectedType: 'grouped',
    },
    {
      id: 'active_users_by_product',
      question:
        'Count distinct users who have active subscriptions, grouped by product name. Join users to customers (on stripe_customer_id), customers to subscriptions (on customer_id), subscriptions to prices (on price_id), prices to products (on product_id). Filter for active subscriptions. Return one group per product name.',
      expectedType: 'grouped',
    },
    {
      id: 'avg_invoice_by_plan',
      question:
        'Compute average invoice amount_paid by plan nickname. Join invoices to subscriptions (on subscription_id), subscriptions to prices (on price_id). Filter for paid invoices. Return one group per plan nickname with the average amount.',
      expectedType: 'grouped',
    },
  ];

  const subscriptions = baseTables.subscriptions as StripeSubscriptionRow[];
  const invoices = baseTables.invoices as StripeInvoiceRow[];
  const prices = baseTables.prices as StripePriceRow[];
  const products = baseTables.products as StripeProductRow[];
  const priceLookup = Object.fromEntries(prices.map((price) => [price.id, { nickname: price.nickname, unit_amount: price.unit_amount }]));
  const priceMetaLookup = Object.fromEntries(
    prices.map((price) => [price.id, { nickname: price.nickname, unit_amount: price.unit_amount, product_id: price.product_id }])
  );
  const productLookup = Object.fromEntries(products.map((product) => [product.id, { name: product.name }]));
  const subscriptionLookup = Object.fromEntries(subscriptions.map((subscription) => [subscription.id, subscription]));
  const getPlanNickname = (subscription: StripeSubscriptionRow): string =>
    priceLookup[subscription.price_id]?.nickname ?? 'unknown';

  const activeSubscriptions = subscriptions.filter((subscription) => subscription.status === 'active');
  const activeSubscriptionIds = new Set(activeSubscriptions.map((subscription) => subscription.id));
  const paidInvoices = invoices.filter((invoice) => invoice.status === 'paid');
  const paidInvoicesForActive = paidInvoices.filter((invoice) => activeSubscriptionIds.has(invoice.subscription_id));
  const totalRevenue = paidInvoices.reduce((sum, invoice) => sum + invoice.amount_paid, 0);

  const mrrByCustomerMap = new Map<string, number>();
  paidInvoicesForActive.forEach((invoice) => {
    const current = mrrByCustomerMap.get(invoice.customer_id) ?? 0;
    mrrByCustomerMap.set(invoice.customer_id, current + invoice.amount_paid);
  });

  const revenueByProductMap = new Map<string, number>();
  paidInvoicesForActive.forEach((invoice) => {
    const subscription = subscriptionLookup[invoice.subscription_id];
    if (!subscription) return;
    const priceMeta = priceMetaLookup[subscription.price_id];
    const productName = priceMeta ? productLookup[priceMeta.product_id]?.name ?? 'unknown' : 'unknown';
    const current = revenueByProductMap.get(productName) ?? 0;
    revenueByProductMap.set(productName, current + invoice.amount_paid);
  });

  const paidInvoicesByCustomerMap = new Map<string, number>();
  paidInvoices.forEach((invoice) => {
    const current = paidInvoicesByCustomerMap.get(invoice.customer_id) ?? 0;
    paidInvoicesByCustomerMap.set(invoice.customer_id, current + 1);
  });

  const activeSubscriptionsByPlanMap = new Map<string, number>();
  activeSubscriptions.forEach((subscription) => {
    const plan = getPlanNickname(subscription);
    const current = activeSubscriptionsByPlanMap.get(plan) ?? 0;
    activeSubscriptionsByPlanMap.set(plan, current + 1);
  });

  const paidRevenueByPlanMap = new Map<string, number>();
  paidInvoices.forEach((invoice) => {
    const subscription = subscriptionLookup[invoice.subscription_id];
    if (!subscription) return;
    const plan = getPlanNickname(subscription);
    const current = paidRevenueByPlanMap.get(plan) ?? 0;
    paidRevenueByPlanMap.set(plan, current + invoice.amount_paid);
  });

  // Harder task calculations
  const customers = baseTables.customers as StripeCustomerRow[];
  const users = baseTables.users as InternalUserRow[];
  const organizations = baseTables.organizations as { id: string; name: string }[];
  const customerLookup = Object.fromEntries(customers.map((c) => [c.id, c]));
  const usersByCustomer = new Map<string, InternalUserRow[]>();
  users.forEach((user) => {
    const list = usersByCustomer.get(user.stripe_customer_id) ?? [];
    list.push(user);
    usersByCustomer.set(user.stripe_customer_id, list);
  });
  const orgLookup = Object.fromEntries(organizations.map((o) => [o.id, o]));

  // mrr_by_org: invoices → subscriptions → customers → users → organizations
  const mrrByOrgMap = new Map<string, number>();
  paidInvoicesForActive.forEach((invoice) => {
    const userList = usersByCustomer.get(invoice.customer_id) ?? [];
    userList.forEach((user) => {
      const org = orgLookup[user.organization_id];
      if (!org) return;
      const current = mrrByOrgMap.get(org.name) ?? 0;
      mrrByOrgMap.set(org.name, current + invoice.amount_paid);
    });
  });

  // revenue_by_customer_segment
  const revenueBySegmentMap = new Map<string, number>();
  paidInvoices.forEach((invoice) => {
    const customer = customerLookup[invoice.customer_id];
    const segment = (customer?.metadata as { segment?: string })?.segment ?? 'unknown';
    const current = revenueBySegmentMap.get(segment) ?? 0;
    revenueBySegmentMap.set(segment, current + invoice.amount_paid);
  });

  // active_users_by_product: users with active subscriptions grouped by product
  const activeUsersByProductMap = new Map<string, Set<string>>();
  activeSubscriptions.forEach((subscription) => {
    const priceMeta = priceMetaLookup[subscription.price_id];
    const productName = priceMeta ? productLookup[priceMeta.product_id]?.name ?? 'unknown' : 'unknown';
    const userList = usersByCustomer.get(subscription.customer_id) ?? [];
    userList.forEach((user) => {
      const userSet = activeUsersByProductMap.get(productName) ?? new Set();
      userSet.add(user.id);
      activeUsersByProductMap.set(productName, userSet);
    });
  });
  const activeUsersByProductCount = new Map<string, number>();
  activeUsersByProductMap.forEach((users, product) => {
    activeUsersByProductCount.set(product, users.size);
  });

  // avg_invoice_by_plan
  const invoiceSumByPlan = new Map<string, number>();
  const invoiceCountByPlan = new Map<string, number>();
  paidInvoices.forEach((invoice) => {
    const subscription = subscriptionLookup[invoice.subscription_id];
    if (!subscription) return;
    const plan = getPlanNickname(subscription);
    invoiceSumByPlan.set(plan, (invoiceSumByPlan.get(plan) ?? 0) + invoice.amount_paid);
    invoiceCountByPlan.set(plan, (invoiceCountByPlan.get(plan) ?? 0) + 1);
  });
  const avgInvoiceByPlanMap = new Map<string, number>();
  invoiceSumByPlan.forEach((sum, plan) => {
    const count = invoiceCountByPlan.get(plan) ?? 1;
    avgInvoiceByPlanMap.set(plan, Math.round(sum / count));
  });

  const toGrouped = (map: Map<string, number>): Array<{ key: string; value: number }> =>
    Array.from(map.entries())
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => a.key.localeCompare(b.key));

  const expectedResults: Record<string, ExpectedResult> = {
    total_mrr: { scalar: calculateMrr(subscriptions as never, invoices as never) },
    mrr_by_plan: { grouped: toGrouped(new Map(calculateMrrByPlan(subscriptions as never, invoices as never, priceLookup).map((row) => [row.plan, row.mrr]))) },
    active_subscriptions: { scalar: activeSubscriptions.length },
    paid_invoices: { scalar: paidInvoices.length },
    mrr_by_customer: { grouped: toGrouped(mrrByCustomerMap) },
    revenue_by_product: { grouped: toGrouped(revenueByProductMap) },
    total_revenue: { scalar: totalRevenue },
    paid_invoices_by_customer: { grouped: toGrouped(paidInvoicesByCustomerMap) },
    active_subscriptions_by_plan: { grouped: toGrouped(activeSubscriptionsByPlanMap) },
    paid_revenue_by_plan: { grouped: toGrouped(paidRevenueByPlanMap) },
    // Harder tasks
    mrr_by_org: { grouped: toGrouped(mrrByOrgMap) },
    revenue_by_customer_segment: { grouped: toGrouped(revenueBySegmentMap) },
    active_users_by_product: { grouped: toGrouped(activeUsersByProductCount) },
    avg_invoice_by_plan: { grouped: toGrouped(avgInvoiceByPlanMap) },
  };

  const taskRubrics: Record<string, TaskRubric> = {
    total_mrr: {
      requiredFilters: [
        { table: 'invoices', column: 'status', value: 'paid' },
        { table: 'subscriptions', column: 'status', value: 'active' },
      ],
      requiredJoins: [{ leftTable: 'invoices', rightTable: 'subscriptions' }],
      groupBy: null,
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    mrr_by_plan: {
      requiredFilters: [
        { table: 'invoices', column: 'status', value: 'paid' },
        { table: 'subscriptions', column: 'status', value: 'active' },
      ],
      requiredJoins: [
        { leftTable: 'invoices', rightTable: 'subscriptions' },
        { leftTable: 'subscriptions', rightTable: 'prices' },
      ],
      groupBy: { table: 'prices', column: 'nickname' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    active_subscriptions: {
      requiredFilters: [{ table: 'subscriptions', column: 'status', value: 'active' }],
      requiredJoins: [],
      groupBy: null,
      aggregate: { op: 'count', table: 'subscriptions' },
    },
    paid_invoices: {
      requiredFilters: [{ table: 'invoices', column: 'status', value: 'paid' }],
      requiredJoins: [],
      groupBy: null,
      aggregate: { op: 'count', table: 'invoices' },
    },
    mrr_by_customer: {
      requiredFilters: [
        { table: 'invoices', column: 'status', value: 'paid' },
        { table: 'subscriptions', column: 'status', value: 'active' },
      ],
      requiredJoins: [{ leftTable: 'invoices', rightTable: 'subscriptions' }],
      groupBy: { table: 'invoices', column: 'customer_id' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    revenue_by_product: {
      requiredFilters: [
        { table: 'invoices', column: 'status', value: 'paid' },
        { table: 'subscriptions', column: 'status', value: 'active' },
      ],
      requiredJoins: [
        { leftTable: 'invoices', rightTable: 'subscriptions' },
        { leftTable: 'subscriptions', rightTable: 'prices' },
        { leftTable: 'prices', rightTable: 'products' },
      ],
      groupBy: { table: 'products', column: 'name' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    total_revenue: {
      requiredFilters: [{ table: 'invoices', column: 'status', value: 'paid' }],
      requiredJoins: [],
      groupBy: null,
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    paid_invoices_by_customer: {
      requiredFilters: [{ table: 'invoices', column: 'status', value: 'paid' }],
      requiredJoins: [],
      groupBy: { table: 'invoices', column: 'customer_id' },
      aggregate: { op: 'count', table: 'invoices' },
    },
    active_subscriptions_by_plan: {
      requiredFilters: [{ table: 'subscriptions', column: 'status', value: 'active' }],
      requiredJoins: [{ leftTable: 'subscriptions', rightTable: 'prices' }],
      groupBy: { table: 'prices', column: 'nickname' },
      aggregate: { op: 'count', table: 'subscriptions' },
    },
    paid_revenue_by_plan: {
      requiredFilters: [{ table: 'invoices', column: 'status', value: 'paid' }],
      requiredJoins: [
        { leftTable: 'invoices', rightTable: 'subscriptions' },
        { leftTable: 'subscriptions', rightTable: 'prices' },
      ],
      groupBy: { table: 'prices', column: 'nickname' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    // Harder tasks (3+ joins)
    mrr_by_org: {
      requiredFilters: [
        { table: 'invoices', column: 'status', value: 'paid' },
        { table: 'subscriptions', column: 'status', value: 'active' },
      ],
      requiredJoins: [
        { leftTable: 'invoices', rightTable: 'subscriptions' },
        { leftTable: 'invoices', rightTable: 'customers' },
        { leftTable: 'customers', rightTable: 'users' },
        { leftTable: 'users', rightTable: 'organizations' },
      ],
      groupBy: { table: 'organizations', column: 'name' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    revenue_by_customer_segment: {
      requiredFilters: [{ table: 'invoices', column: 'status', value: 'paid' }],
      requiredJoins: [{ leftTable: 'invoices', rightTable: 'customers' }],
      groupBy: { table: 'customers', column: 'segment' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
    active_users_by_product: {
      requiredFilters: [{ table: 'subscriptions', column: 'status', value: 'active' }],
      requiredJoins: [
        { leftTable: 'users', rightTable: 'customers' },
        { leftTable: 'customers', rightTable: 'subscriptions' },
        { leftTable: 'subscriptions', rightTable: 'prices' },
        { leftTable: 'prices', rightTable: 'products' },
      ],
      groupBy: { table: 'products', column: 'name' },
      aggregate: { op: 'count', table: 'users' },
    },
    avg_invoice_by_plan: {
      requiredFilters: [{ table: 'invoices', column: 'status', value: 'paid' }],
      requiredJoins: [
        { leftTable: 'invoices', rightTable: 'subscriptions' },
        { leftTable: 'subscriptions', rightTable: 'prices' },
      ],
      groupBy: { table: 'prices', column: 'nickname' },
      aggregate: { op: 'sum', table: 'invoices', column: 'amount_paid' },
    },
  };

  const typedContext = loadContext([
    'typed/src/db/schema.ts',
    'typed/src/types/stripe.ts',
    'typed/src/types/internal.ts',
  ]);
  const dbtContext = loadContext([
    'warehouse/dbt_project.yml',
    'warehouse/models/schema.yml',
    'warehouse/models/staging/stg_stripe_customers.sql',
    'warehouse/models/staging/stg_stripe_subscriptions.sql',
    'warehouse/models/staging/stg_stripe_invoices.sql',
    'warehouse/models/staging/stg_stripe_prices.sql',
    'warehouse/models/staging/stg_stripe_products.sql',
    'warehouse/models/staging/stg_internal_users.sql',
  ]);
  const sharedContext = [
    'Shared context: join map across base tables.',
    buildJoinMapSummary(SHARED_FOREIGN_KEYS),
    '',
    'Note: DBT staging models mirror base tables with renamed id columns (id -> *_id).',
  ].join('\n');

  const contexts = [
    { name: 'typed', text: typedContext },
    { name: 'dbt', text: dbtContext },
    { name: 'shared', text: sharedContext },
  ].filter((entry) => {
    if (context === 'all') return true;
    if (context === 'both') return entry.name === 'typed' || entry.name === 'dbt';
    return entry.name === context;
  });

  const results: LlmRunResult[] = [];

  console.log(
    `Benchmark starting with provider=${provider}, model=${model}, context=${context}, mode=${mode}, tasks=${tasks.length}, trials=${trials}, temperature=${temperature}.`
  );

  for (let trial = 1; trial <= trials; trial += 1) {
    for (const ctx of contexts) {
      for (const task of tasks) {
        const prompt = mode === 'code'
          ? buildCodePrompt(ctx.name, ctx.text, schemaText, task)
          : buildPrompt(ctx.name, ctx.text, schemaText, task);
        const start = Date.now();
        try {
          const { text, usage } = await callModelWithRetry(provider, prompt, model, maxTokens, temperature, retries);

          if (mode === 'code') {
            // Code mode: execute TypeScript or SQL
            const code = extractCode(text);
            const actual = ctx.name === 'typed'
              ? executeTypeScriptCode(code, baseTables)
              : executeSqlCode(code, baseTables);
            const comparison = compareResults(actual, expectedResults[task.id]);
            results.push({
              taskId: task.id,
              contextName: ctx.name,
              trial,
              ok: comparison.ok,
              error: comparison.error,
              expected: expectedResults[task.id],
              actual,
              usage,
              durationMs: Date.now() - start,
              rawText: text,
            });
          } else {
            // Spec mode: parse and execute JSON spec
            const spec = normalizeSpec(extractJson(text));
            const validationErrors = validateSpec(spec, schema);
            if (validationErrors.length > 0) {
              const rubric = scoreRubric(spec, validationErrors, taskRubrics[task.id], false);
              results.push({
                taskId: task.id,
                contextName: ctx.name,
                trial,
                ok: false,
                error: validationErrors.join('; '),
                expected: expectedResults[task.id],
                spec,
                validationErrors,
                rubric,
                usage,
                durationMs: Date.now() - start,
                rawText: text,
              });
              continue;
            }
            const actual = executeSpec(spec, tables);
            const comparison = compareResults(actual, expectedResults[task.id]);
            const rubric = scoreRubric(spec, validationErrors, taskRubrics[task.id], comparison.ok);
            results.push({
              taskId: task.id,
              contextName: ctx.name,
              trial,
              ok: comparison.ok,
              error: comparison.error,
              expected: expectedResults[task.id],
              actual,
              spec,
              validationErrors,
              rubric,
              usage,
              durationMs: Date.now() - start,
              rawText: text,
            });
          }
        } catch (error) {
          const rubric = mode === 'spec' ? scoreRubric(undefined, ['error'], taskRubrics[task.id], false) : undefined;
          results.push({
            taskId: task.id,
            contextName: ctx.name,
            trial,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            expected: expectedResults[task.id],
            rubric,
            durationMs: Date.now() - start,
          });
        }
    }
  }
  }

  console.log('');
  console.log('Results:');
  results.forEach((result) => {
    const usage = result.usage ? `tokens(in=${result.usage.input_tokens ?? 0}, out=${result.usage.output_tokens ?? 0})` : 'tokens(n/a)';
    const duration = result.durationMs ? `${result.durationMs}ms` : 'n/a';
    const status = result.ok ? 'PASS' : 'FAIL';
    const rubric = result.rubric ? `rubric=${result.rubric.normalized.toFixed(2)}` : 'rubric=n/a';
    console.log(`- t${result.trial} :: ${result.contextName} :: ${result.taskId} :: ${status} :: ${usage} :: ${rubric} :: ${duration}`);
    if (!result.ok && result.error) {
      console.log(`  error: ${result.error}`);
    }
  });

  const summary = new Map<string, { pass: number; total: number; inputTokens: number; outputTokens: number }>();
  const taskSummary = new Map<string, { pass: number; total: number }>();
  const rubricSummary = new Map<string, { score: number; max: number; count: number }>();
  const rubricTaskSummary = new Map<string, { score: number; max: number; count: number }>();
  results.forEach((result) => {
    const entry = summary.get(result.contextName) ?? { pass: 0, total: 0, inputTokens: 0, outputTokens: 0 };
    entry.total += 1;
    if (result.ok) entry.pass += 1;
    entry.inputTokens += result.usage?.input_tokens ?? 0;
    entry.outputTokens += result.usage?.output_tokens ?? 0;
    summary.set(result.contextName, entry);

    const taskKey = `${result.contextName}::${result.taskId}`;
    const taskEntry = taskSummary.get(taskKey) ?? { pass: 0, total: 0 };
    taskEntry.total += 1;
    if (result.ok) taskEntry.pass += 1;
    taskSummary.set(taskKey, taskEntry);

    if (result.rubric) {
      const rubricEntry = rubricSummary.get(result.contextName) ?? { score: 0, max: 0, count: 0 };
      rubricEntry.score += result.rubric.score;
      rubricEntry.max += result.rubric.max;
      rubricEntry.count += 1;
      rubricSummary.set(result.contextName, rubricEntry);

      const rubricTaskEntry = rubricTaskSummary.get(taskKey) ?? { score: 0, max: 0, count: 0 };
      rubricTaskEntry.score += result.rubric.score;
      rubricTaskEntry.max += result.rubric.max;
      rubricTaskEntry.count += 1;
      rubricTaskSummary.set(taskKey, rubricTaskEntry);
    }
  });

  console.log('');
  console.log('Summary:');
  summary.forEach((entry, name) => {
    const passRate = entry.total > 0 ? ((entry.pass / entry.total) * 100).toFixed(1) : '0.0';
    const avgIn = entry.total > 0 ? Math.round(entry.inputTokens / entry.total) : 0;
    const avgOut = entry.total > 0 ? Math.round(entry.outputTokens / entry.total) : 0;
    console.log(`- ${name}: pass ${entry.pass}/${entry.total} (${passRate}%), avg tokens in=${avgIn} out=${avgOut}`);
  });

  console.log('');
  console.log('Rubric Summary:');
  rubricSummary.forEach((entry, name) => {
    const max = entry.max > 0 ? entry.max : 1;
    const avg = entry.count > 0 ? entry.score / max : 0;
    console.log(`- ${name}: avg rubric ${(avg * 100).toFixed(1)}%`);
  });

  console.log('');
  console.log('Task Summary:');
  Array.from(taskSummary.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, entry]) => {
      const [ctx, taskId] = key.split('::');
      const passRate = entry.total > 0 ? ((entry.pass / entry.total) * 100).toFixed(1) : '0.0';
      console.log(`- ${ctx} :: ${taskId}: pass ${entry.pass}/${entry.total} (${passRate}%)`);
    });

  console.log('');
  console.log('Rubric Task Summary:');
  Array.from(rubricTaskSummary.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([key, entry]) => {
      const [ctx, taskId] = key.split('::');
      const max = entry.max > 0 ? entry.max : 1;
      const avg = entry.count > 0 ? entry.score / max : 0;
      console.log(`- ${ctx} :: ${taskId}: avg rubric ${(avg * 100).toFixed(1)}%`);
    });
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
