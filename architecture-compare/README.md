# Modern Data Benchmark (Architecture Compare)

This repository benchmarks how well LLMs implement analytics tasks across four data architectures:

- **Typed TypeScript** (direct function execution)
- **DBT/SQL** (DuckDB execution)
- **Drizzle ORM** (SQLite + query builder)
- **Cube semantic layer** (measure definitions extracted to SQL)

The harness evaluates **ARPU**, **churn rate**, and **LTV** against the same synthetic dataset and compares pass rates across sandboxes.

## Status

Active. The modular benchmark harness, sandboxes, reports, and charts are in place. Legacy scaffolding and older benchmarks have been moved under `legacy/`.

## Project Structure

```
architecture-compare/
├── README.md
├── _summary.md
├── artifacts/                 # Reports + charts
├── data/                      # Synthetic JSON datasets
├── sandboxes/                 # Typed/DBT/Drizzle/Cube sandbox templates
├── scripts/                   # Current benchmark + smoke test scripts
└── legacy/                    # Archived scaffolds + older benchmarks
```

## Quick Start

1. (Optional) Regenerate data:
   ```bash
   node scripts/generate-data.js
   ```

2. Run the modular benchmark:
   ```bash
   # Anthropic
   ANTHROPIC_API_KEY=... node --experimental-strip-types scripts/modular-benchmark.ts --sandbox=all --model=claude-3-5-haiku-20241022

   # OpenRouter
   OPENROUTER_API_KEY=... node --experimental-strip-types scripts/modular-benchmark.ts --sandbox=all --model=qwen/qwen3-coder-next
   ```

3. Validate the harness without any API keys:
   ```bash
   node --experimental-strip-types scripts/smoke-test.ts
   ```

## Results Snapshot (Single Run per Model)

Pass counts below are **out of 3 tasks** per sandbox (ARPU, churn, LTV). This is a single-run snapshot; see `artifacts/` for charts and the detailed report.

| Model | typed | dbt | drizzle | cube |
|---|---:|---:|---:|---:|
| google/gemini-3-flash-preview | 0/3 | 1/3 | 0/3 | 0/3 |
| moonshotai/kimi-k2.5 | 2/3 | 0/3 | 3/3 | 3/3 |
| z-ai/glm-4.7 | 3/3 | 2/3 | 0/3 | 1/3 |
| minimax/minimax-m2.1 | 0/3 | 0/3 | 0/3 | 0/3 |
| x-ai/grok-code-fast-1 | 3/3 | 1/3 | 3/3 | 1/3 |
| arcee-ai/trinity-large-preview:free | 3/3 | 0/3 | 0/3 | 0/3 |
| qwen/qwen3-coder-next | 3/3 | 0/3 | 1/3 | 1/3 |

## Charts

The following images are generated from the current benchmark snapshot:

**Pass Rate Matrix (x/3 tasks)**  
![Pass Rate Matrix](artifacts/benchmark_matrix.png)

**Total Passes per Model (out of 12)**  
![Total Passes per Model](artifacts/benchmark_model_totals.png)

**Total Passes per Sandbox (out of 21)**  
![Total Passes per Sandbox](artifacts/benchmark_sandbox_totals.png)

**Pass Breakdown per Model by Sandbox**  
![Pass Breakdown per Model](artifacts/benchmark_model_stacked.png)

## Detailed Write‑Up

For a fuller narrative (methodology, critique points, and limitations), see:
- `artifacts/benchmark_report_detailed.docx`

**Method Summary**
- Tasks: ARPU, churn rate, LTV on a shared synthetic dataset in `data/`.
- Typed: model writes a function in `sandboxes/typed` and it is imported/executed.
- DBT: model writes SQL executed in DuckDB.
- Drizzle: model writes an async query executed against SQLite.
- Cube: model defines a measure; SQL is extracted and executed in DuckDB.

**Fairness Adjustments**
- Cube validator no longer injects default filters (status=paid/active).
- DBT validator accepts common filename variants.
- Drizzle native module rebuilt for current Node version.

**Limitations / Critique Points**
- Single-run snapshots are high variance; repeat runs needed for confidence.
- Some models fail to use tools, causing max-turn failures.
- Cube validation extracts SQL heuristically; non-standard measure definitions can fail.
- DBT validation executes SQL directly in DuckDB (not full dbt compilation).
- Typed validation runs TS via type-stripping (not strict type-checking).

## Related Projects

- DBT Core: https://github.com/dbt-labs/dbt-core
- Drizzle ORM: https://github.com/drizzle-team/drizzle-orm
- Drizzle Cube: https://github.com/cliftonc/drizzle-cube
- DuckDB: https://github.com/duckdb/duckdb

## How Validation Works (High Level)

- **Typed**: imports and executes the model’s TypeScript function.
- **DBT**: executes the model’s SQL in DuckDB.
- **Drizzle**: executes the model’s ORM query in SQLite.
- **Cube**: extracts the model’s measure SQL and executes it in DuckDB.

## Reports and Charts

See `artifacts/` for:
- `benchmark_report_detailed.docx` (full write‑up)
- `benchmark_matrix.png` and additional charts

## Legacy

Older scaffolding, plans, and legacy benchmarks are kept under `legacy/` for reference. They are not used by the current harness.
