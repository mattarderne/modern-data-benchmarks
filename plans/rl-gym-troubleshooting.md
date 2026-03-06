# rl-gym-troubleshooting (refocused)

## Objective Hierarchy

1. Primary objective: produce a careful, accurate **Environment Comparison** (ORM vs DBT) aligned with `resources/rl-gym-ideas.md`.
2. Immediate objective: **confirm/validate post-1 findings first** with a more carefully constructed ORM vs DBT setup.
3. Only after that: extend into troubleshooting RL gym scenarios.

## What Existing Experiments Already Tell Us

Use these as starting signal, not final evidence:

- `architecture_sampling_summary_2026-02-09-1pass-all.json` (dated February 9, 2026):
  - `app-drizzle`: 10/21 passes (47.6%)
  - `app-typed`: 8/21 passes (38.1%)
  - `warehouse-dbt`: 1/21 passes (4.8%)
- `architecture_sampling_summary_warehouse-dbt-documented-2026-02-09.json`:
  - `warehouse-dbt-documented`: 10/51 passes (19.6%)
  - Improvement over bare `warehouse-dbt`, but not a paired ORM-vs-DBT rerun under identical settings.
- `architecture_sampling_summary_warehouse-dbt-cast-2026-02-09.json`:
  - `warehouse-dbt-cast`: 2/9 passes (22.2%), only 3 models x 1 run each.
- `linting-experiment-2026-02-08.md`:
  - Lint-helper improved some results, but it also added extra turns, so this is confounded.

Interpretation: post-1 directional claim is plausible, but we still need a tighter controlled comparison before adding troubleshooting complexity.

## Scope For This Plan (Now)

In scope now:
- Controlled ORM vs DBT comparison on the existing metric tasks (ARPU, churn, LTV).
- Fair DBT construction and parity checks.
- A **dbt-realistic** pre-troubleshooting check where DBT is evaluated with source app/ORM context included (as in real troubleshooting).
- Replication-quality reporting.

Out of scope until the validation gate passes:
- Additional architecture families (Cube/context layer/context graph).
- Harder benchmark imports (BIRD/KramaBench/Sphinx tasks).
- Multiple bug types in troubleshooting gym.

## Phase A: Controlled Post-1 Validation (Must Complete First)

### A1) Freeze the comparison pair

- ORM side: `app-drizzle` (keep as current best-performing unified ORM baseline).
- DBT side: create one explicit **fair DBT comparator**:
  - Start from `warehouse-dbt-documented`.
  - Include staging timestamp normalization (`CAST(created_at AS TIMESTAMP)` pattern from cast experiment).
  - Keep this as a single named sandbox (for example `warehouse-dbt-fair`) to avoid result fragmentation.
- DBT-realistic side (required before troubleshooting):
  - Add a `warehouse-dbt-realistic` comparator that preserves DBT layers **and** exposes source app/ORM artifacts as first-class context.
  - Intent: reflect realistic debugging where analysts/agents inspect both upstream app logic and downstream dbt/warehouse logic.

### A1a) `warehouse-dbt-realistic` spec (succinct)

- Base: `warehouse-dbt-fair`.
- Add source-app surface as auditable context (same data snapshot):
  - app ORM schema and query files (`app-drizzle` equivalents),
  - app DB tables/state as separate inspectable layer,
  - warehouse raw + dbt staging + dbt marts remain unchanged.
- Agent expectations:
  - Must be able to inspect both upstream app/ORM and downstream dbt/warehouse layers.
  - System prompt explicitly states both layers are part of the expected audit path.
- Fairness constraints:
  - No hidden hints unavailable to ORM baseline.
  - Same task statements, turn budget, model set, and validation rules as `app-drizzle`.
  - Keep dbt docs/cast improvements from `warehouse-dbt-fair`; do not add one-off task hints.
- Required telemetry tags for this sandbox:
  - `touched_app_surface` (bool/count),
  - `touched_dbt_surface` (bool/count),
  - `cross_layer_traversal` (bool: both touched in one task run).

### A2) Enforce strict parity

- Same tasks: `active_user_arpu`, `org_churn_rate`, `avg_org_ltv`.
- Same data snapshot for both sandboxes.
- Same model set.
- Same `max-turns`.
- Same tool budget and stopping rules.
- Same lint policy (recommended: `--no-lint` for primary run; optional lint sensitivity as a separate appendix).
- Same number of runs per model per sandbox.

### A3) Evaluation design

- Minimum run plan: `n=5` runs per model per sandbox.
- Suggested model panel (balanced quality/cost): Opus, Sonnet, Haiku, Kimi, Grok, Qwen.
- Primary metrics:
  - Pass rate (overall + per task)
  - Tokens/run and cost/run
  - Cost per successful pass
  - Turn count to completion
- Secondary diagnostics:
  - Failure mode taxonomy (schema mismatch, type/cast, join logic, file/path, max-turn).
  - File-read/tool-usage patterns by sandbox.
  - For `warehouse-dbt-realistic`, split tool usage into:
    - app/ORM surface touched
    - warehouse/dbt surface touched
    - cross-layer traversal rate (did the agent actually connect source and warehouse layers?)

### A4) Realistic DBT pre-gate (mandatory)

Before troubleshooting, run a dedicated realism check:

- Compare `app-drizzle` vs `warehouse-dbt-realistic` under matched settings.
- Require explicit access to source app + warehouse/dbt context in the DBT condition.
- Confirm the DBT result is not being driven by an unrealistic "DBT-only" debugging setup.

Deliverable from this step:
- A short note in the post-1 report: whether adding realistic source-app surface materially changes ORM-vs-DBT results.

### A5) Decision gate

Proceed to troubleshooting gym only if all are true:

- Re-run reproduces a meaningful ORM advantage under matched settings.
- Result is stable across runs (not single-run artifact).
- DBT comparator is documented and defensible as "carefully constructed", not a strawman.
- `warehouse-dbt-realistic` result is measured and interpreted (not skipped).

If gate fails:
- Iterate on fairness setup first (do not add troubleshooting complexity yet).

## Phase B: Minimal Troubleshooting Gym (After Gate)

Implementation note (when Phase B starts):
- Review `https://github.com/withmartian/ares` for inspiration on RL environment patterns, async rollout structure, and trace/eval ergonomics; adapt ideas only where they preserve our controlled ORM-vs-DBT comparability.

### B1) Keep MVP small

- Two sandboxes only:
  - `troubleshoot-orm` (based on validated ORM baseline).
  - `troubleshoot-warehouse` (based on validated fair DBT baseline).
- One bug only: idempotency failure / partial rerun duplicate window.
- One task type: diagnosis (no extra bug families yet).

### B2) Tools and scoring

- Tools:
  - `query_db`
  - `check_api`
  - `inspect_etl_log`
  - `submit_diagnosis`
- Diagnosis rubric (deterministic):
  - correct table
  - duplication/double-counting identified
  - time window identified
  - ETL/idempotency source identified
- Pass threshold: 3/4.

### B3) Troubleshooting metrics

- Diagnosis accuracy/pass rate.
- Steps/actions before correct diagnosis.
- Tokens to correct diagnosis.
- Components audited per run.
- Unnecessary exploration rate.

## Deliverables

1. **Post-1 validation report** (first deliverable):
   - Controlled ORM vs DBT results with exact run settings.
   - Clear statement on whether the original direction (roughly 48% vs 5%) holds after fair DBT construction.
2. **Troubleshooting gym spec update** (second deliverable, only after gate):
   - Finalized MVP sandbox/task/tool definitions.
   - Run plan for diagnosis efficiency comparison.

## References

- Core objective: `resources/rl-gym-ideas.md`
- Previous draft plan: `plans/rl-gym-troubleshooting.md` (this file, now refocused)
- Blog direction:
  - `blog/post 1/draft-blog.md`
  - `blog/post 2/notes.md`
- Experiment backlog/directions: `architecture-compare/TODO.md`
- Existing benchmark reports:
  - `architecture-compare/artifacts/reports/architecture-benchmark-2026-02-07.md`
  - `architecture-compare/artifacts/reports/linting-experiment-2026-02-08.md`
  - `architecture-compare/artifacts/reports/warehouse-dbt-documented-experiment-2026-02-09.md`
  - `architecture-compare/artifacts/reports/warehouse-dbt-cast-experiment-2026-02-09.md`
