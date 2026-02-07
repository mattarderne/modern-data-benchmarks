# Constrained Test Design: True TypeScript vs SQL Comparison

## Problem with Current Test

The current `agent-benchmark.ts` allows models to **bypass the infrastructure**:

```
Current flow:
1. Model adds function to queries.ts (or SQL file)
2. Model writes test.js with PLAIN JAVASCRIPT
3. Model computes answer in JS
4. We validate the number

Both architectures → same test method (plain JS)
```

This tests "can you compute in JavaScript" not "can you write TypeScript vs SQL."

## Constrained Test Design

Force models to **actually use** the infrastructure:

### TypeScript Constrained

```typescript
// Model writes this to queries.ts:
export function calculateARPU(invoices: StripeInvoice[]): number {
  // their implementation
}

// WE validate by importing and calling:
import { calculateARPU } from './typed/src/analytics/queries.ts';
const result = calculateARPU(invoices);
```

**Validation:**
- TypeScript must compile
- Function must be exported
- Function must accept correct types
- Function must return correct value

### DBT/SQL Constrained

```sql
-- Model writes this to stg_arpu.sql:
SELECT
  SUM(amount_paid) / COUNT(DISTINCT customer_id) as arpu
FROM invoices
WHERE status = 'paid'
```

**Validation:**
- SQL must parse
- SQL must execute against DuckDB
- Query must return correct value

## Key Differences

| Aspect | Current Test | Constrained Test |
|--------|--------------|------------------|
| TypeScript types | Ignored | Must compile |
| SQL syntax | Ignored | Must execute |
| Freedom | High (plain JS escape) | Low (must use infra) |
| What it tests | JS computation | TS vs SQL proficiency |

## Expected Outcomes

With constrained testing, we expect to see:

1. **TypeScript failures from**:
   - Wrong parameter types
   - Missing exports
   - Compilation errors

2. **SQL failures from**:
   - Syntax errors
   - Wrong table/column names
   - Invalid aggregations

3. **True architecture comparison**:
   - Some models better at TypeScript
   - Some models better at SQL
   - Different failure modes

## Implementation Requirements

### TypeScript Validation
```bash
node --experimental-strip-types validate.ts
# Where validate.ts imports and calls the function
```

### SQL Validation
```bash
# Option 1: DuckDB CLI
duckdb -c ".read model.sql"

# Option 2: Node DuckDB
npm install duckdb
# Load JSON as tables, execute SQL
```

## Hypothesis

Models trained on more TypeScript code will do better on Typed.
Models trained on more SQL will do better on DBT.

This would finally answer: **Does architecture choice matter for LLM compatibility?**
