# rl-gym-troubleshooting (long term)

## Overview

An RL gym that tests **troubleshooting efficiency** across ORM-based and warehouse/dbt architectures. The existing benchmark proved that architecture affects whether an agent can compute the right metric (5% vs 48% pass rate). This experiment tests the next question: when something goes wrong, how efficiently can an agent find the root cause?

The core hypothesis: architecture determines the surface area an agent must audit. An ORM environment co-locates code and data in ~3 auditable components. A warehouse/dbt environment spreads the same information across ~5 components. More surface area = more steps/tokens to diagnose the same issue.

## Background & Motivation

From the user's spec:

> Troubleshooting a data issue requires auditing every single step in the pipeline: both the code and the data at each step. In an ORM-based architecture, the code and data are co-located. In a warehouse/dbt architecture, data is replicated from the application into a separate warehouse, and the dbt project adds a second layer of transformations. This increases the surface area without necessarily adding information.

The existing architecture benchmark (`architecture-compare/`) showed that agents struggle with dbt for **computation**. This experiment tests whether dbt also creates a structural disadvantage for **debugging** — a more realistic day-to-day task.

## What Already Exists (don't rebuild)

The `architecture-compare/` project has mature infrastructure:

- **5 sandbox templates** with `SandboxConfig` interface (id, contextFiles, targetFile, systemPrompt, taskPrompt, validate, lint, setup)
- **Agent loop** with XML-based tool calls: `read_file`, `write_file`, `list_files`, `done`
- **11 synthetic data tables** (users, orgs, invoices, subscriptions, customers, products, prices, payment_intents, api_usage, chat_sessions, features)
- **Multi-model support** (Anthropic + OpenRouter)
- **Token/cost tracking**, rubric scoring, tool usage recording
- **Drift injection** already built: `stripe-lag` (removes recent records) and `missing-mapping` (corrupts 5% of stripe_customer_id values)
- **406+ sandbox runs** with established reporting patterns

Key insight: the existing drift injection is already halfway to bug injection. `applyDrift()` mutates data in controlled ways. The troubleshooting gym extends this by making the mutation the thing the agent has to *find*, not just cope with.

## Technical Approach

### Architecture: extend, don't fork

Add new sandbox types and a new task type to the existing harness. The `SandboxConfig` interface and agent loop stay the same. New tools get added to the tool executor. New validation logic checks diagnosis instead of numeric output.

### Bug injection

**Primary bug: idempotency failure (partial ETL re-run)**

A subset of invoices (e.g., all invoices from a specific 3-day window) are duplicated with slightly different `id` values but identical `customer_id`, `amount_paid`, and `created_at`. This simulates a sync job that partially re-ran. The effect: ARPU and LTV are inflated because revenue is double-counted for affected customers.

Implementation: a new `applyBug()` function alongside the existing `applyDrift()`:

```typescript
function applyBug(data: DataBundle, bug: BugType): { data: DataBundle; diagnosis: Diagnosis } {
  if (bug === 'idempotency') {
    // Pick invoices from a 3-day window
    // Duplicate them with new IDs
    // Return mutated data + ground truth diagnosis
    return {
      data: buggedData,
      diagnosis: {
        rootCause: 'idempotency_failure',
        affectedTable: 'invoices',
        affectedWindow: { start: '...', end: '...' },
        duplicateCount: N,
        affectedMetric: 'arpu',
        inflationFactor: 1.XX,
      }
    };
  }
}
```

**Future bug types** (v2, not MVP):
- `missing_mapping` — 5% of `stripe_customer_id` values set to null, causing silent revenue undercounting
- `schema_drift` — a column renamed (`amount_paid` -> `total_amount`) mid-pipeline, old data has old name
- `stale_status` — subscription cancellations not propagated, churn rate underreported

### New sandbox variants

#### `troubleshoot-orm`

Based on existing `app-drizzle` sandbox. Additions:
- A `mock-api/` directory with a JSON file representing the "source of truth" Stripe API response (the clean data before bug injection)
- An `etl-log.json` file showing sync run history (timestamps, record counts, status)
- The SQLite DB is pre-loaded with the **bugged** data
- Agent can compare DB contents against mock API to find discrepancies

Auditable surface area: ORM code, database, mock API, ETL log (~4 components)

#### `troubleshoot-warehouse`

Based on existing `warehouse-dbt` sandbox. Additions:
- Same `mock-api/` and `etl-log.json`
- SQLite app DB has bugged data
- DuckDB warehouse has bugged data replicated from the app DB
- dbt staging/marts models transform the (bugged) warehouse data
- Agent must trace through: API -> app DB -> warehouse raw -> staging -> marts

Auditable surface area: ORM code, app DB, mock API, ETL log, warehouse, dbt staging, dbt marts (~7 components)

### New task type: diagnosis

Extend the `Task` interface:

```typescript
interface DiagnosisTask extends Task {
  type: 'diagnosis';
  symptom: string;           // "ARPU is showing $847 but should be ~$712"
  expectedDiagnosis: Diagnosis;
  scoreDiagnosis: (submitted: string) => DiagnosisScore;
}
```

The agent sees:
1. A symptom: "The ARPU metric is reporting $847. Based on the API source data, the expected value is approximately $712. Something is wrong in the pipeline. Find the root cause."
2. The sandbox files (same as computation benchmark)
3. Additional tools (see below)

### Expanded tool set

Add to the existing `executeTool()` switch:

```typescript
case 'query_db': {
  // Execute a SQL query against the app SQLite DB
  // Returns result rows as formatted table
}

case 'check_api': {
  // Read from mock-api/ JSON files
  // Returns the "source of truth" data
}

case 'inspect_etl_log': {
  // Read etl-log.json
  // Returns sync run history
}

case 'submit_diagnosis': {
  // Terminal action — agent submits root cause
  // Params: root_cause (free text), affected_table, affected_records
}
```

For the warehouse sandbox, `query_db` also works against the DuckDB warehouse (the agent specifies which DB).

### Diagnosis scoring

Rubric-based, not exact match. A `scoreDiagnosis()` function checks:

| Criterion | Points | Example |
|---|---|---|
| Identified correct table | 1 | "invoices" |
| Identified duplication | 1 | "duplicate records" or "double-counting" |
| Identified time window | 1 | mentions the correct date range |
| Identified ETL as source | 1 | "partial re-run" or "sync" or "idempotency" |
| **Total** | **/4** | |

Pass threshold: 3/4 (must get the table + duplication + at least one of window/ETL).

Implementation: keyword matching on the submitted diagnosis text, with synonyms. Keep it simple for MVP; can add LLM-as-judge later if needed.

### Efficiency metrics

The existing harness already tracks:
- `turns` (API round-trips)
- `tokenUsage` (input/output/total)
- `toolUsage` (which files read/written)
- `durationMs`

For troubleshooting, additionally track:
- `actionsBeforeDiagnosis` — count of query_db + check_api + read_file + inspect_etl_log calls
- `tablesQueried` — which tables the agent examined
- `componentsAudited` — which architectural layers the agent touched (app code, DB, warehouse, staging, marts, API, ETL log)
- `unnecessaryExploration` — files/tables examined that aren't relevant to the bug

The key comparison metric: **steps to correct diagnosis** across the two sandboxes, holding the model constant.

## Implementation Steps

### Phase 1: Bug injection & data setup

1. [ ] Add `BugType` and `Diagnosis` types to `sandboxes/types.ts`
2. [ ] Implement `applyBug('idempotency')` in `architecture-benchmark.ts` alongside `applyDrift()`
3. [ ] Generate the ground truth diagnosis object (affected table, window, duplicate count, expected vs actual metric value)
4. [ ] Create `mock-api/` data files — the clean pre-bug data, representing what the Stripe API "actually" returned
5. [ ] Create `etl-log.json` template — 3-5 sync runs, one of which is the partial re-run that introduced duplicates

### Phase 2: New sandbox templates

6. [ ] Create `sandboxes/troubleshoot-orm/` — fork of `app-drizzle` with mock-api, etl-log, bugged DB
7. [ ] Create `sandboxes/troubleshoot-orm/sandbox.config.ts` — system prompt explaining the troubleshooting task, expanded tool set, diagnosis submission
8. [ ] Create `sandboxes/troubleshoot-warehouse/` — fork of `warehouse-dbt` with mock-api, etl-log, bugged app DB + warehouse
9. [ ] Create `sandboxes/troubleshoot-warehouse/sandbox.config.ts` — same structure, warehouse-specific system prompt
10. [ ] Add both to `AVAILABLE_SANDBOXES` array

### Phase 3: Agent loop & tools

11. [ ] Add `query_db` tool — SQLite for ORM sandbox, SQLite + DuckDB for warehouse sandbox
12. [ ] Add `check_api` tool — reads from mock-api/ directory
13. [ ] Add `inspect_etl_log` tool — reads etl-log.json
14. [ ] Add `submit_diagnosis` tool — terminal action, captures free-text diagnosis + structured fields
15. [ ] Wire new tools into `executeTool()` and `recordToolUsage()`

### Phase 4: Diagnosis task & scoring

16. [ ] Add `DiagnosisTask` type extending `Task`
17. [ ] Implement `buildDiagnosisTasks()` — generates tasks from bugged data with symptom descriptions
18. [ ] Implement `scoreDiagnosis()` — rubric-based keyword matching (table + duplication + window + ETL)
19. [ ] Add diagnosis validation path in the benchmark runner (separate from numeric validation)

### Phase 5: Smoke test

20. [ ] Write smoke test with known-correct diagnosis to validate scoring
21. [ ] Run single model (Opus) against both sandboxes to verify end-to-end flow
22. [ ] Verify token/step tracking captures the new tool types

### Phase 6: Full evaluation

23. [ ] Run Opus, Sonnet, Haiku across both sandboxes (3 runs each = 18 runs minimum)
24. [ ] Run 2-3 OpenRouter models (Grok, Kimi, Qwen) for cost comparison
25. [ ] Aggregate results: steps-to-diagnosis, tokens consumed, components audited, pass rate

### Phase 7: Analysis & reporting

26. [ ] Generate comparison charts: steps by architecture, tokens by architecture, audit path visualization
27. [ ] Analyze failure modes: where do agents go wrong in each architecture?
28. [ ] Compare surface area explored: do warehouse agents examine more components but still fail?
29. [ ] Write up results as extension to existing blog post or standalone follow-up

### Phase 8: Stretch — additional bug types

30. [ ] Add `missing_mapping` bug type (null stripe_customer_ids causing undercounting)
31. [ ] Add `schema_drift` bug type (renamed column)
32. [ ] Re-run evaluation across bug types to confirm pattern holds

## Success Criteria

- [ ] Both sandboxes produce correct symptoms (bugged metric value vs clean expected value)
- [ ] At least one model can correctly diagnose the bug in each sandbox
- [ ] Measurable difference in steps-to-diagnosis between ORM and warehouse (hypothesis: 2-3x fewer steps in ORM)
- [ ] Measurable difference in tokens consumed (hypothesis: significantly fewer tokens in ORM)
- [ ] Results are consistent across 3+ runs per model
- [ ] Clear failure mode analysis showing *why* the warehouse takes more steps

## Open Questions

1. **How to handle `query_db` fairly?** In the ORM sandbox the agent queries SQLite directly. In the warehouse sandbox it could query either the app DB or the warehouse. Should the agent be told which DBs exist, or discover them? Lean towards: tell them in the system prompt, since a real analyst would know what systems exist.

2. **Should the warehouse agent get dbt test results?** Run it both ways as a sub-experiment. With test results = the "well-configured dbt" scenario. Without = the "raw warehouse" scenario. This parallels the documented vs undocumented experiment already done.

3. **Is keyword matching good enough for scoring?** For MVP, yes. If results are ambiguous, add an LLM-as-judge step where a separate model scores the diagnosis against the rubric. But keep it deterministic for v1.

4. **How many turns for troubleshooting?** The computation benchmark uses 10 turns. Troubleshooting likely needs more since the agent is exploring rather than writing. Start with 15-20 turns and see where agents converge.

5. **Strong typing as data integrity?** The spec raises whether typed systems make certain bug classes impossible. This is worth tracking observationally — do ORM agents ever submit a diagnosis that references a nonexistent column? — but hard to test as a standalone hypothesis in v1.

## References

- Existing benchmark: `architecture-compare/` (this repo)
- Blog writeup: `blog/draft-blog.md`
- Existing drift injection: `applyDrift()` in `scripts/architecture-benchmark.ts`
- Sandbox config pattern: `sandboxes/types.ts`
- User's original spec: "RL Gym for Data Engineering Troubleshooting" (February 2026)
