# Constrained Benchmark Implementation Plan

## Goal

Create a benchmark that **forces models to use the infrastructure** rather than escaping to plain JavaScript. This tests actual TypeScript vs SQL proficiency.

## Background

The current `agent-benchmark.ts` has a design flaw:
- Models write a function to `queries.ts` or a SQL file
- But then test with plain JavaScript in `test.js`
- Both architectures end up testing the same thing: "can you compute in JS?"

We need to constrain models so:
- **TypeScript**: Their function must compile and be importable
- **DBT/SQL**: Their SQL must execute against a real database

## Implementation Steps

### Phase 1: Setup

- [ ] Create `scripts/constrained-benchmark.ts`
- [ ] Add DuckDB dependency: `npm install duckdb`
- [ ] Create sandbox setup functions for both contexts

### Phase 2: TypeScript Validation

The validation must:
1. Check function exists in `queries.ts`
2. Check function is exported
3. Create a test file that imports the function
4. Execute with `node --experimental-strip-types`
5. Capture the returned value

```typescript
// validate.ts (generated)
import { calculateARPU } from './typed/src/analytics/queries.ts';
import fs from 'node:fs';

const invoices = JSON.parse(fs.readFileSync('./data/invoices.json', 'utf8'));
const result = calculateARPU(invoices);
console.log(JSON.stringify({ result }));
```

**Success criteria:**
- No TypeScript compilation errors
- Function returns a number
- Number matches expected value (within tolerance)

### Phase 3: SQL Validation with DuckDB

The validation must:
1. Check SQL file exists
2. Load JSON data into DuckDB as tables
3. Execute the model's SQL
4. Extract the result

```javascript
// DuckDB execution
const duckdb = require('duckdb');
const db = new duckdb.Database(':memory:');

// Load JSON as tables
db.exec(`CREATE TABLE invoices AS SELECT * FROM read_json_auto('./data/invoices.json')`);
db.exec(`CREATE TABLE subscriptions AS SELECT * FROM read_json_auto('./data/subscriptions.json')`);

// Execute model's SQL
const sql = fs.readFileSync('warehouse/models/staging/stg_arpu.sql', 'utf8');
db.all(sql, (err, rows) => {
  console.log(JSON.stringify({ result: rows[0] }));
});
```

**Success criteria:**
- SQL parses without errors
- SQL executes without runtime errors
- Query returns correct value (within tolerance)

### Phase 4: Agent Loop

Reuse the agent loop from `agent-benchmark.ts`:
1. Send task + system prompt to model
2. Parse tool calls (read_file, write_file, done)
3. Execute tools in sandbox
4. On `done`: run validation
5. Report pass/fail

**Key difference:** No `run` tool. Models cannot execute arbitrary commands.

### Phase 5: System Prompts

#### TypeScript Prompt
```
You are modifying a TypeScript analytics codebase.

CONSTRAINT: Your function will be imported and called directly.
We will run: import { yourFunction } from './typed/src/analytics/queries.ts'

Tools: read_file, write_file, done

Requirements:
- Function must be EXPORTED
- Function must have correct TypeScript types
- Function must accept the data array and return a number

When done, use <tool>done</tool> - we will import and test your function.
```

#### DBT/SQL Prompt
```
You are creating a DBT SQL model.

CONSTRAINT: Your SQL will be executed against DuckDB.
Tables: invoices, subscriptions (columns match JSON structure)

Tools: read_file, write_file, done

Requirements:
- Write valid SQL that executes in DuckDB
- Query should return a single row with the metric
- Use standard SQL syntax

When done, use <tool>done</tool> - we will execute your SQL.
```

### Phase 6: Tasks

Same three tasks as current benchmark:

| Task | TypeScript Signature | SQL Output |
|------|---------------------|------------|
| ARPU | `calculateARPU(invoices: StripeInvoice[]): number` | Single row with `arpu` column |
| Churn | `calculateChurnRate(subs: StripeSubscription[]): number` | Single row with `churn_rate` column |
| LTV | `calculateAverageLTV(invoices: StripeInvoice[]): number` | Single row with `avg_ltv` column |

### Phase 7: Validation Functions

```typescript
interface ValidationResult {
  valid: boolean;
  actual?: number;
  error?: string;
  compilationError?: string;
  executionError?: string;
}

function validateTypedFunction(sandboxDir: string, task: Task): ValidationResult
function validateDbtSql(sandboxDir: string, task: Task): ValidationResult
```

### Phase 8: Output Format

```
======================================================================
CONSTRAINED BENCHMARK
======================================================================
Context:    TypeScript (function must be importable)
Model:      claude-sonnet-4-20250514
======================================================================

--- Task: arpu ---
  Writing function...
  Turn 1: [read_file] typed/src/analytics/queries.ts
  Turn 2: [read_file] typed/src/types/stripe.ts
  Turn 3: [write_file] typed/src/analytics/queries.ts
  Turn 4: [done]

  Validating...
  ✓ Function exported
  ✓ TypeScript compiles
  ✓ Returns correct value: 170612

  PASS (4 turns)

======================================================================
SUMMARY
======================================================================
Passed: 3/3 (100%)
```

## File Structure

```
scripts/
├── agent-benchmark.ts          # Current (allows JS escape)
├── constrained-benchmark.ts    # New (forces infrastructure use)
└── lib/
    ├── duckdb-validator.ts     # SQL execution
    └── typescript-validator.ts # TS import/call
```

## Dependencies

```json
{
  "dependencies": {
    "duckdb": "^1.0.0"
  }
}
```

## Testing the Implementation

1. Run with a known-good model (Sonnet) on both contexts
2. Verify TypeScript compilation errors are caught
3. Verify SQL syntax errors are caught
4. Compare results to unconstrained benchmark

## Expected Findings

With constrained testing, we expect:

1. **TypeScript-specific failures:**
   - Missing exports
   - Wrong parameter types
   - Return type mismatches

2. **SQL-specific failures:**
   - Syntax errors
   - Wrong column names
   - Invalid aggregations

3. **Model preferences:**
   - Some models better at TypeScript (more TS in training)
   - Some models better at SQL (more SQL in training)

## Success Metrics

The benchmark is successful if:
- [ ] It catches TypeScript compilation errors
- [ ] It catches SQL syntax/execution errors
- [ ] Results differ from unconstrained benchmark
- [ ] We see model-specific architecture preferences
