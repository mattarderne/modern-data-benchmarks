# Post-1 Validation: Fair DBT vs App Drizzle (Stable OpenRouter Set)

Date: February 11, 2026

## Objective

Validate post-1 architecture findings with a more carefully constructed DBT comparator before adding troubleshooting complexity.

Comparison:
- `app-drizzle`
- `warehouse-dbt-fair` (documented schema + cast-normalized staging timestamp)

## What Changed in `warehouse-dbt-fair`

`warehouse-dbt-fair` combines two prior interventions:

1. Documented schema and join hints (`models/schema.yml`) from `warehouse-dbt-documented`.
2. Staging timestamp normalization from `warehouse-dbt-cast`:
   - `CAST(created_at AS TIMESTAMP) AS usage_created_at` in `stg_app_api_usage`.

## Run Design

- Tasks: `active_user_arpu`, `org_churn_rate`, `avg_org_ltv`
- Settings: `--max-turns=10 --no-lint`
- Runs: `n=5` per model per sandbox
- Stable model set (OpenRouter):  
  - `x-ai/grok-code-fast-1`  
  - `qwen/qwen3-coder-next`  
  - `minimax/minimax-m2.1`

Artifacts:
- Run files: `artifacts/reports/post1_validation_runs_2026-02-11-stable/`
- Summary JSON: `artifacts/reports/architecture_sampling_summary_post1-fair-2026-02-11-stable.json`
- Charts: `artifacts/reports/*post1-fair-2026-02-11-stable.png`

## Results

### Overall pass rate (3 models, 45 task attempts per sandbox)

- `app-drizzle`: **9/45 (20.0%)**
- `warehouse-dbt-fair`: **7/45 (15.6%)**

### By model

- `x-ai/grok-code-fast-1`:
  - `app-drizzle`: **7/15 (46.7%)**
  - `warehouse-dbt-fair`: **7/15 (46.7%)**
- `qwen/qwen3-coder-next`:
  - `app-drizzle`: **2/15 (13.3%)**
  - `warehouse-dbt-fair`: **0/15 (0.0%)**
- `minimax/minimax-m2.1`:
  - `app-drizzle`: **0/15 (0.0%)**
  - `warehouse-dbt-fair`: **0/15 (0.0%)**

### Task-level signal (all 3 models pooled)

- `active_user_arpu`:
  - `app-drizzle`: 1/15
  - `warehouse-dbt-fair`: 1/15
- `org_churn_rate`:
  - `app-drizzle`: 5/15
  - `warehouse-dbt-fair`: 5/15
- `avg_org_ltv`:
  - `app-drizzle`: 3/15
  - `warehouse-dbt-fair`: 1/15

## Is DBT Improvement Isolated to Grok?

Short answer: **yes, in this run set**.

Evidence:
- Only Grok reached non-zero pass rate in `warehouse-dbt-fair` (7/15).
- Qwen and Minimax had zero DBT-fair passes.
- Qwen still achieved some app-drizzle success (2/15), so DBT-fair did not generalize across models.

## Why DBT-fair Improved Relative to Earlier DBT Runs (Likely)

This is a hypothesis from traces/failure modes, not a causal proof.

1. Timestamp cast normalization reduced one major DBT failure mode.
   - Earlier DBT runs frequently failed with DuckDB `-(VARCHAR, INTERVAL)` style errors.
   - In this set, churn runs on DBT-fair were often executable (Grok got 5/5 on churn).

2. Documentation helps models that actually use it.
   - Grok read schema/staging and wrote SQL in DBT-fair.
   - Qwen/Minimax often failed by non-engagement (`Max turns exceeded`) rather than SQL semantics.

3. Remaining hard failures are logic/iteration, not just syntax.
   - ARPU and LTV remain weak in DBT-fair (especially LTV: 1/15 pooled).
   - This indicates DBT-fair removes some runtime friction but does not eliminate join/aggregation reasoning burden.

## Why the Gain Looks Grok-Specific

Likely because the DBT-fair improvements reward models that:
- perform schema exploration,
- execute multi-step SQL drafting,
- and recover from early query mistakes within turn budget.

Grok did this; Qwen/Minimax mostly did not in DBT-fair runs.

## Interpretation Against Post-1 Objective

- The careful DBT comparator (`warehouse-dbt-fair`) does improve DBT viability versus prior strict DBT variants for at least one model (Grok).
- But across the stable 3-model panel, app-drizzle still leads overall (20.0% vs 15.6%).
- So the post-1 direction is **not overturned** by this fair-DBT pass; the gap narrows in part, but mainly via one model.

## Constraints / Caveats

- Anthropic runs were blocked by API auth errors (`401`) during this session.
- `z-ai/glm-4.7` repeatedly hung/timed out in this environment and could not be completed as a full `n=5` pair.
- Confidence intervals are wide at this sample size; results are directional.

## Reproduction

Example single run:

```bash
node --experimental-strip-types scripts/architecture-benchmark.ts \
  --sandbox=warehouse-dbt-fair \
  --model=x-ai/grok-code-fast-1 \
  --max-turns=10 \
  --no-lint \
  --output=artifacts/reports/post1_validation_runs_2026-02-11/x-ai-grok-code-fast-1-warehouse-dbt-fair-run1.json
```

Aggregate:

```bash
python3 scripts/aggregate-architecture-sampling.py \
  --input=artifacts/reports/post1_validation_runs_2026-02-11-stable \
  --suffix=post1-fair-2026-02-11-stable
```
