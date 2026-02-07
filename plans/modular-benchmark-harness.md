# Modular Benchmark Harness Design

## Goal

Create a flexible harness where different data infrastructure approaches can be swapped in as "sandboxes" with equal information, enabling fair comparisons of LLM performance across architectures.

## Architecture Options to Compare

| ID | Approach | Style | LLM Task | Validation |
|----|----------|-------|----------|------------|
| `typed` | TypeScript Functions | Plain functions with types | Write function body | Import & call |
| `dbt` | DBT/SQL | SQL models | Write SQL query | Execute in DuckDB |
| `drizzle` | Drizzle ORM | Type-safe ORM | Write ORM query | Execute via Drizzle |
| `cube` | Drizzle Cube | Semantic layer | Define cube measure | Query cube API |

## Directory Structure

```
sandboxes/
├── _template/              # Shared template
│   └── data/              # Symlinked from root
│
├── typed/                 # TypeScript functions
│   ├── sandbox.config.ts  # Sandbox configuration
│   ├── src/
│   │   ├── types/        # Type definitions
│   │   └── analytics/    # Where functions go
│   └── README.md         # Context for LLM
│
├── dbt/                   # DBT/SQL
│   ├── sandbox.config.ts
│   ├── models/
│   │   └── staging/      # Where SQL models go
│   └── README.md
│
├── drizzle/               # Drizzle ORM
│   ├── sandbox.config.ts
│   ├── src/
│   │   ├── schema.ts     # Drizzle schema
│   │   └── queries/      # Where queries go
│   └── README.md
│
└── cube/                  # Drizzle Cube
    ├── sandbox.config.ts
    ├── src/
    │   ├── cubes/        # Cube definitions
    │   └── server.ts     # Cube API
    └── README.md
```

## Sandbox Configuration Interface

```typescript
// sandboxes/typed/sandbox.config.ts
import type { SandboxConfig } from '../types';

export const config: SandboxConfig = {
  id: 'typed',
  name: 'TypeScript Functions',

  // What context to show the LLM
  contextFiles: [
    'src/types/stripe.ts',
    'src/analytics/queries.ts',
    'README.md',
  ],

  // Where the LLM should write code
  targetFile: 'src/analytics/queries.ts',

  // System prompt for this architecture
  systemPrompt: `You are modifying a TypeScript analytics codebase.
Your function will be imported and called directly.
Requirements:
- Function MUST be exported
- Function MUST have correct TypeScript types
- Function MUST return a number`,

  // How to validate the result
  validate: async (sandboxDir: string, task: Task) => {
    // Import and call the function
    const script = `
      import { ${task.functionName} } from './src/analytics/queries.ts';
      import fs from 'fs';
      const data = JSON.parse(fs.readFileSync('./data/${task.dataFile}', 'utf8'));
      console.log(JSON.stringify({ result: ${task.functionName}(data) }));
    `;
    // Execute and parse result...
  },

  // Task-specific prompts
  taskPrompt: (task: Task) => `
Add function "${task.functionName}" to src/analytics/queries.ts

Signature: export function ${task.signature}

${task.description}
`,
};
```

## Tasks (Same Across All Sandboxes)

```typescript
interface Task {
  id: string;
  name: string;
  description: string;
  dataFile: string;  // invoices.json, subscriptions.json
  expectedValue: () => number;
  tolerance: number;

  // Architecture-specific
  functionName: string;      // for typed/drizzle
  sqlFile: string;          // for dbt
  measureName: string;      // for cube
  signature: string;        // for typed
}

const TASKS: Task[] = [
  {
    id: 'arpu',
    name: 'Average Revenue Per User',
    description: `Calculate ARPU.
Formula: total amount_paid from paid invoices / count of unique paying customers
Return: number (rounded to integer)`,
    dataFile: 'invoices.json',
    expectedValue: () => { /* ... */ },
    tolerance: 1,
    functionName: 'calculateARPU',
    sqlFile: 'stg_arpu.sql',
    measureName: 'arpu',
    signature: 'calculateARPU(invoices: StripeInvoice[]): number',
  },
  // ... more tasks
];
```

## Harness Runner

```typescript
// scripts/modular-benchmark.ts

interface RunOptions {
  sandbox: string;      // typed, dbt, drizzle, cube
  model: string;        // claude-sonnet-4-20250514, etc.
  tasks?: string[];     // specific tasks or all
  maxTurns?: number;
}

async function runBenchmark(options: RunOptions) {
  // 1. Load sandbox config
  const config = await import(`../sandboxes/${options.sandbox}/sandbox.config.ts`);

  // 2. Create isolated sandbox directory
  const sandboxDir = createSandbox(options.sandbox, options.model);

  // 3. For each task
  for (const task of selectedTasks) {
    // 4. Run agent with sandbox-specific prompt
    const result = await runAgent({
      systemPrompt: config.systemPrompt,
      taskPrompt: config.taskPrompt(task),
      sandboxDir,
      model: options.model,
    });

    // 5. Validate with sandbox-specific validator
    const validation = await config.validate(sandboxDir, task);

    // 6. Record result
    results.push({ task, validation, turns: result.turns });
  }

  // 7. Output summary
  printSummary(results);
}
```

## Information Equality Checklist

Each sandbox MUST have equivalent access to:

| Information | How Provided |
|-------------|--------------|
| Data structure | README.md describes tables/columns |
| Data access | data/*.json symlinked or copied |
| Type information | Types/schema in context files |
| Example patterns | Existing code to reference |
| Task description | Same text across all sandboxes |

## Drizzle ORM Sandbox

```typescript
// sandboxes/drizzle/src/schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const invoices = sqliteTable('invoices', {
  id: text('id').primaryKey(),
  customerId: text('customer_id').notNull(),
  subscriptionId: text('subscription_id').notNull(),
  amountDue: integer('amount_due').notNull(),
  amountPaid: integer('amount_paid').notNull(),
  status: text('status').notNull(),
  createdAt: text('created_at').notNull(),
});

// ... other tables
```

```typescript
// sandboxes/drizzle/src/queries/analytics.ts
import { db } from '../db';
import { invoices } from '../schema';
import { eq, sum, countDistinct } from 'drizzle-orm';

export async function calculateARPU(): Promise<number> {
  // LLM writes this
  const result = await db
    .select({
      total: sum(invoices.amountPaid),
      customers: countDistinct(invoices.customerId),
    })
    .from(invoices)
    .where(eq(invoices.status, 'paid'));

  return Math.round(result[0].total / result[0].customers);
}
```

## Drizzle Cube Sandbox

```typescript
// sandboxes/cube/src/cubes/invoices.ts
import { defineCube } from 'drizzle-cube/server';
import { invoices } from '../schema';
import { eq } from 'drizzle-orm';

export const invoicesCube = defineCube('Invoices', {
  sql: () => ({
    from: invoices,
    where: eq(invoices.status, 'paid'),
  }),

  measures: {
    totalRevenue: { type: 'sum', sql: invoices.amountPaid },
    customerCount: { type: 'countDistinct', sql: invoices.customerId },
    // LLM adds new measures here
    arpu: {
      type: 'number',
      sql: `SUM(${invoices.amountPaid}) / COUNT(DISTINCT ${invoices.customerId})`,
    },
  },

  dimensions: {
    status: { type: 'string', sql: invoices.status },
    customerId: { type: 'string', sql: invoices.customerId },
  },
});
```

## Implementation Steps

### Phase 1: Refactor Existing

1. [ ] Create `sandboxes/` directory structure
2. [ ] Move `typed/` content to `sandboxes/typed/`
3. [ ] Move `warehouse/` content to `sandboxes/dbt/`
4. [ ] Create `sandbox.config.ts` for each
5. [ ] Extract common harness code to `scripts/lib/harness.ts`

### Phase 2: Add Drizzle

6. [ ] Install drizzle dependencies: `npm install drizzle-orm better-sqlite3`
7. [ ] Create `sandboxes/drizzle/` with schema and db setup
8. [ ] Create validator that runs Drizzle queries
9. [ ] Test with existing tasks

### Phase 3: Add Drizzle Cube

10. [ ] Install: `npm install drizzle-cube`
11. [ ] Create `sandboxes/cube/` with cube definitions
12. [ ] Create validator that queries cube API
13. [ ] Test with existing tasks

### Phase 4: Unified Benchmark

14. [ ] Create `scripts/modular-benchmark.ts`
15. [ ] Run same tasks across all 4 sandboxes
16. [ ] Generate comparison report

## Expected Output

```
======================================================================
MODULAR BENCHMARK: ARPU
======================================================================
Model: claude-sonnet-4-20250514
Expected: 170612

| Sandbox | Pass | Turns | Error |
|---------|------|-------|-------|
| typed   | ✓    | 4     | -     |
| dbt     | ✓    | 5     | -     |
| drizzle | ✓    | 6     | -     |
| cube    | ✗    | 8     | Wrong measure type |

======================================================================
SUMMARY BY ARCHITECTURE
======================================================================
| Sandbox | ARPU | Churn | LTV | Total |
|---------|------|-------|-----|-------|
| typed   | ✓    | ✓     | ✓   | 3/3   |
| dbt     | ✓    | ✓     | ✓   | 3/3   |
| drizzle | ✓    | ✓     | ✗   | 2/3   |
| cube    | ✗    | ✓     | ✗   | 1/3   |
======================================================================
```

## Research Questions

With this harness we can answer:

1. **Does architecture complexity matter?**
   - Do models struggle more with Drizzle ORM vs plain TypeScript?

2. **Is declarative vs imperative easier?**
   - SQL/Cube (declarative) vs TypeScript/Drizzle (imperative)

3. **Does type assistance help?**
   - Typed TypeScript vs DBT SQL (no types)

4. **Semantic layers: help or hindrance?**
   - Do pre-defined abstractions (Cube) constrain or guide models?

## Dependencies

```json
{
  "dependencies": {
    "duckdb": "^1.0.0",
    "drizzle-orm": "^0.30.0",
    "better-sqlite3": "^9.0.0",
    "drizzle-cube": "^0.1.0"
  }
}
```
