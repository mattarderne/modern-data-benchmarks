# Data Architecture Comparison: Typed TypeScript vs DBT/SQL

## Question

**Does the choice of data infrastructure (typed TypeScript vs DBT/SQL) affect an LLM agent's ability to correctly implement analytics queries?**

## Results Summary

**No.** With properly configured sandboxes, there's no systematic difference. Failures are about analytical logic, not architecture.

| Model | Typed TS | DBT/SQL | Notes |
|-------|----------|---------|-------|
| Qwen3 Coder | 3/3 (100%) | 3/3 (100%) | Perfect on both |
| Trinity (free) | 3/3 (100%) | 2/3 (67%) | Slight Typed edge |
| Minimax M2.1 | 2/3 (67%) | 3/3 (100%) | Slight DBT edge |
| Kimi K2.5 | 2/3 (67%) | 2/3 (67%) | Same |
| Claude Haiku | 0/3 (0%) | 1/3 (33%) | Struggles on both |

## Methodology

### Test Design
- Agents given sandbox with existing data infrastructure
- Task: Add new analytics functions and compute correct values
- Three metrics: ARPU, Churn Rate, LTV
- Success = correct numeric answer (within tolerance)

### Sandbox Setup (Critical)
Both sandboxes use identical testing approach:
```javascript
// test.js - same in both
const fs = require('fs');
const invoices = JSON.parse(fs.readFileSync('./data/invoices.json'));
// ... compute answer ...
console.log(result);
```

**Important**: Early results showed TypeScript "failures" that were actually sandbox configuration bugs (ESM vs CommonJS). After fixing, no systematic difference.

## Task Difficulty

| Task | Pass Rate | Common Errors |
|------|-----------|---------------|
| ARPU | 80% | Wrong filter (amount_paid > 0) |
| Churn Rate | 85% | Formula errors |
| LTV | 60% | Grouping logic errors |

LTV is hardest - requires GROUP BY equivalent logic.

## Limitations of Current Test

**Models can bypass the infrastructure.** Currently they:
1. Add function to TypeScript/SQL file
2. But test with plain JavaScript

This tests "can you compute the answer" not "can you use TypeScript/SQL properly."

## Future Work: Constrained Test

To truly compare architectures, need to force models to USE the infrastructure:

### Typed Approach
- Must import and call the function from queries.ts
- Test validates TypeScript compiles and runs

### DBT Approach
- Must write valid SQL
- Test executes SQL against DuckDB or validates AST

This would test actual TypeScript vs SQL proficiency, not just JS computation.

---

## Running the Benchmark

```bash
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...

# Run both contexts
node --experimental-strip-types scripts/agent-benchmark.ts --context=typed --model=MODEL
node --experimental-strip-types scripts/agent-benchmark.ts --context=dbt --model=MODEL
```

### Supported Models
- Anthropic: `claude-sonnet-4-20250514`, `claude-3-5-haiku-20241022`
- OpenRouter: `qwen/qwen3-coder-next`, `moonshotai/kimi-k2.5`, etc.
