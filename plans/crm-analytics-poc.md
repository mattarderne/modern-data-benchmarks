# CRM Analytics PoC — Plan & PRD

**Status:** Draft  
**Branch:** `claude/crm-analytics-poc-xaZhn`  
**Date:** 2026-05-06

---

## 1. Purpose

This PoC extends the existing benchmark thesis into a richer, more realistic domain: a B2B SaaS company with a live CRM, product usage events, and Stripe billing. Where previous benchmarks used simple single-query tasks (ARPU, churn, LTV), this PoC targets the *hard* SQL primitives that historically forced teams to build complex dbt pipelines or brittle mediator layers:

- Window functions and running totals
- Rolling averages and time-series smoothing
- Cohort analysis and retention curves
- Slowly changing dimensions (SCD Type 2)
- Funnel analysis with multi-touch attribution
- Temporal comparisons (period-over-period, year-over-year)
- "Chat with your data" AI capability running against the architecture

The target architecture is a Cloudflare-native mini-stack. The goal is to demonstrate that a modern ORM + semantic layer (Drizzle + Cube) on a typed SQLite/D1 store can handle all of these patterns more cleanly than a traditional warehouse + dbt approach, and that an AI agent can query it more reliably and cheaply.

---

## 2. The Scenario: "Acme CRM"

A fictional B2B SaaS company called **Acme** sells a workspace product. Their data universe has three operational layers that need to be unified for analytics:

| Layer | System | What it captures |
|-------|--------|-----------------|
| **Product** | Internal app (D1/SQLite) | User signups, sessions, feature events, team activity |
| **CRM** | Close.com-style CRM | Leads, opportunities, pipeline stages, sales activities, reps |
| **Billing** | Stripe | Subscriptions, invoices, MRR events, churn, upgrades |

The insight driving the design: these three systems have always been siloed. dbt warehouses try to unify them with staging + mart layers, but join-key mismatches, timestamp type drift, and schema renames across layers cause agent failures. The PoC shows how Drizzle's unified typed schema solves this structurally.

---

## 3. Data Model

### 3.1 Core Entities

```
organizations          — the B2B account (tenant)
users                  — individual users inside an org, with stripe_customer_id
leads                  — inbound inquiries before becoming a customer (CRM)
opportunities          — qualified sales deals (CRM)
pipeline_stages        — current and historical stage per opportunity (SCD hook)
activities             — calls, emails, meetings logged by sales reps (CRM)
sales_reps             — the humans working the CRM
feature_events         — product telemetry (page views, feature uses, API calls)
sessions               — user sessions with device/geo context
stripe_customers       — billing entity (maps org → Stripe)
stripe_subscriptions   — plan + status + period
stripe_invoices        — individual charges / MRR events
stripe_mrr_events      — snapshot of MRR delta per event (upgrade, downgrade, churn, new)
```

### 3.2 Key Design Choices

**Unified join fabric:** `organizations.id` is the foreign key across all three layers. `leads.org_id`, `stripe_customers.org_id`, `users.org_id` — no cross-system ID remapping required. This is the architectural fix to the `stripe_customer_id` ↔ `customer_id` failure mode observed in prior benchmarks.

**Typed timestamps everywhere:** All `created_at`, `closed_at`, `trial_ends_at` are stored as ISO-8601 strings in SQLite (Drizzle maps them to `Date` in TypeScript). No implicit UNIX epoch integers, no VARCHAR ambiguity.

**Richer dimensions for analytics:** Each entity carries enough attributes to demonstrate complex queries without needing additional join tables:
- `users`: `plan_tier`, `signup_source`, `country`, `is_admin`
- `opportunities`: `arr_value`, `close_date`, `lost_reason`, `pipeline_stage_id`
- `feature_events`: `event_name`, `properties` (JSON), `session_id`
- `stripe_mrr_events`: `event_type` (new/expansion/contraction/churn), `mrr_delta`, `prev_mrr`

### 3.3 SCD Handling: `pipeline_stage_history`

To demonstrate slowly changing dimensions without a full warehouse, we maintain a history table alongside the current-state table:

```
pipeline_stage_history
  id
  opportunity_id
  stage_name          -- e.g. "Prospecting" → "Qualified" → "Closed Won"
  entered_at
  exited_at           -- NULL if current
  days_in_stage       -- computed at write time
  rep_id
```

This lets us answer: "How long did deals spend in each stage before winning?", "Which reps move deals fastest through Qualification?", "What was the pipeline composition at any historical date?" — all without a warehouse SCD merge job. Drizzle's typed queries give agents a clear, discoverable schema for this.

---

## 4. Analytics Capabilities to Demonstrate

Each capability maps to a concrete query the AI agent must answer, and a corresponding Cube semantic definition. The goal is to show that the semantic layer + typed schema makes these tractable for agents that fail on equivalent dbt approaches.

### 4.1 Window Functions — Sales Rep Ranking

**Business question:** "Rank sales reps by closed ARR this quarter, show each rep's position and gap to #1."

**SQL primitive:** `RANK() OVER (ORDER BY sum_arr DESC)`, `FIRST_VALUE() OVER`

**Why this is hard in dbt:** Requires a mart model that pre-computes rep_performance, but agents must discover the correct staging file for reps (often `stg_crm__activities.sql`) and cross-reference with `stg_stripe__invoices.sql` — two files, two schemas, one join they must infer.

**In Drizzle:** Single schema file. The agent sees `activities.rep_id` → `sales_reps.id` and `stripe_invoices.org_id` → `organizations.id` in one place. Window query is composable directly.

**Cube definition:** A `SalesRep` cube with a `closedARR` measure and a `rankByClosedARR` calculated dimension using `RANK()` in the SQL dialect.

---

### 4.2 Rolling Averages — MRR Smoothing

**Business question:** "Show 30-day rolling average MRR for the last 12 months, broken down by plan tier."

**SQL primitive:** `AVG(mrr) OVER (PARTITION BY plan_tier ORDER BY snapshot_date ROWS BETWEEN 29 PRECEDING AND CURRENT ROW)`

**Why this is hard in dbt:** MRR events live in `stg_stripe__mrr_events.sql`; plan tier lives in `stg_app__subscriptions.sql`. Agents must join across staging files, discover the correct date spine approach, and handle the window frame syntax correctly for the DuckDB dialect. Type mismatches on `snapshot_date` cause failures in 40%+ of runs (per prior benchmark data).

**In Drizzle:** `stripe_mrr_events` and `stripe_subscriptions` share `org_id`. The rolling average query is a single Drizzle `.select()` with a typed window expression. Plan tier is a typed enum on the subscription row.

**Cube definition:** `MRRMetrics` cube with `rollingMRR30d` as a rolling window measure. Cube's `rollingWindow` measure type handles the frame automatically.

---

### 4.3 Cohort Retention — Month-0 to Month-6

**Business question:** "For each signup cohort (monthly), what % of organizations are still paying at month 1, 2, 3, 4, 5, 6?"

**SQL primitive:** Self-join on `stripe_subscriptions` with date truncation and cohort bucketing. Requires `DATE_TRUNC('month', signup_date)` as cohort key, `DATEDIFF('month', cohort_month, active_month)` as period offset.

**Why this is hard in dbt:** Classic "cohort grid" pattern requires either a date spine model or a self-join with complex interval math. Agents get confused by the multi-step CTE pattern; they also hit the VARCHAR timestamp casting failure (observed in prior benchmarks).

**In Drizzle:** Typed `Date` columns make the interval math straightforward. The cohort query is a single composable expression. Demonstrated as a reusable Drizzle query builder utility.

**Cube definition:** `CohortRetention` cube with `cohortMonth` dimension and `retentionRate` measure at each `cohortPeriod`. Cube's time dimension + `rollingWindow` handles the bucketing.

---

### 4.4 Funnel Analysis — Lead → Opportunity → Closed Won

**Business question:** "For leads created this quarter, how many converted to opportunities? Of those, how many closed won? What's the median time at each stage?"

**SQL primitive:** Funnel counts with `FILTER` clauses or conditional aggregation, `PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY days_to_stage)`.

**Why this is hard:** Multi-step pipeline where each stage requires a different join path: `leads` → `opportunities` (not always a 1:1 key), `opportunities` → `pipeline_stage_history` (for timing). Traditional dbt approach spreads this across `stg_crm__leads.sql`, `stg_crm__opportunities.sql`, `mart_sales__funnel.sql`.

**In Drizzle:** All four entities in one schema. `leads.opportunity_id` (nullable, set on conversion) provides the join. The funnel query is a single CTE chain that agents can compose from the schema alone.

**Cube definition:** `SalesFunnel` cube with `conversionRate`, `medianDaysToConvert`, `medianDaysToClose` measures and `quarterCreated` time dimension.

---

### 4.5 Slowly Changing Dimensions — Pipeline Snapshot Queries

**Business question:** "What did our open pipeline look like 60 days ago? Compare to today — which opportunities regressed in stage?"

**SQL primitive:** Point-in-time snapshot query on `pipeline_stage_history` using `entered_at <= target_date AND (exited_at IS NULL OR exited_at > target_date)`.

**Why this is hard:** True SCD Type 2 queries. In dbt, this requires a `snapshot` model + merge strategy + a separate query to reconstruct the historical state. Agents almost never get this right on the first pass.

**In Drizzle:** `pipeline_stage_history` with `entered_at`/`exited_at` makes this a typed, discoverable pattern. A `getPipelineSnapshot(date: Date)` utility function demonstrates the pattern for agents — and serves as a reusable component in the Cube semantic layer.

**Cube definition:** `PipelineHistory` cube with a `snapshotDate` filter dimension that parameterizes the `entered_at`/`exited_at` WHERE clause.

---

### 4.6 Multi-Touch Attribution — Which marketing source drives closed ARR?

**Business question:** "For deals closed this quarter, which lead source (organic, paid, referral, outbound) drove the most ARR? Show first-touch and last-touch models side by side."

**SQL primitive:** Conditional aggregation with `CASE WHEN` on `leads.signup_source`, joined through to `stripe_mrr_events.mrr_delta` via `org_id`.

**Why this is interesting:** Tests the agent's ability to traverse the full data lineage: marketing source (on `leads`) → product conversion (on `users`) → revenue event (on `stripe_mrr_events`). Three systems, unified by `org_id`. In a warehouse, these are three separate staging files with no explicit foreign key relationship visible to the agent.

**Cube definition:** `AttributionAnalysis` cube with `leadSource` dimension, `firstTouchARR` and `lastTouchARR` measures.

---

### 4.7 Period-over-Period Comparison — MoM and YoY

**Business question:** "Show MRR growth month-over-month and year-over-year, with absolute delta and % change."

**SQL primitive:** `LAG(mrr, 1) OVER (ORDER BY month)` for MoM, `LAG(mrr, 12) OVER (ORDER BY month)` for YoY.

**Cube definition:** `GrowthMetrics` cube with `mrrMoMDelta`, `mrrYoYDelta`, `mrrMoMPct`, `mrrYoYPct` as `sql`-type calculated measures using LAG expressions.

---

## 5. The Stack

### 5.1 Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Cloudflare Edge                    │
│                                                     │
│  ┌──────────────┐   ┌──────────────────────────┐   │
│  │  Worker      │   │  Worker                  │   │
│  │  (API)       │   │  (AI Chat Gateway)       │   │
│  │              │   │                          │   │
│  │  Hono        │   │  Hono + Anthropic SDK    │   │
│  │  Drizzle     │   │  Tool calls → Drizzle    │   │
│  │  Cube SDK    │   │  Cube SDK                │   │
│  └──────┬───────┘   └────────────┬─────────────┘   │
│         │                        │                  │
│  ┌──────▼────────────────────────▼─────────────┐   │
│  │              Cloudflare D1                  │   │
│  │         (SQLite — typed schema)             │   │
│  └─────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────┐
│         Cube Cloud (semantic layer)     │
│                                         │
│  Cube schema definitions (.yml)         │
│  Pre-aggregations (materialized)        │
│  REST + GraphQL API                     │
│  Caching layer                          │
└─────────────────────────────────────────┘
```

### 5.2 Component Roles

| Component | Role | Why |
|-----------|------|-----|
| **Cloudflare D1** | Persistence — SQLite at the edge | No server to manage; Drizzle ORM gives typed access |
| **Drizzle ORM** | Schema definition + query builder | Unified typed schema; single source of truth for all join keys and column types |
| **Cube Cloud** | Semantic layer — pre-aggregations + REST API | Handles rollups, caching, and provides a stable query interface for AI agents |
| **Hono** | HTTP framework for Workers | Lightweight, TypeScript-native, ideal for CF Workers |
| **Anthropic SDK** | AI chat capability | Claude as the query engine; tool calls invoke Drizzle or Cube endpoints |
| **Cloudflare Pages** | Frontend (optional) | Simple React/Svelte dashboard for the PoC demo |

### 5.3 Why Cloudflare D1 + Drizzle over a Warehouse

The prior benchmarks showed that the number of layers between raw data and the query is the primary determinant of agent success. D1 + Drizzle collapses the stack to two layers: raw data in SQLite, typed ORM query. No ETL pipeline, no staging models, no column renaming across files.

D1 has one constraint relevant to the PoC: it's SQLite, so some DuckDB-specific window functions (e.g. `PERCENTILE_CONT`) aren't available directly. The plan is to handle these in two ways:
1. Implement them in TypeScript post-query (sort + interpolate for percentiles)
2. Use Cube's pre-aggregation layer which runs on a separate compute layer with full SQL support

---

## 6. The AI "Chat With Your Data" Capability

### 6.1 Architecture

The AI chat worker exposes a streaming POST endpoint that accepts a natural language question and returns an answer with supporting data.

```
User question
     ↓
Claude (claude-sonnet-4-6)
  + system prompt describing the Drizzle schema
  + tool definitions:
    - query_cube(cubeQuery: CubeQuery) → JSON data
    - query_drizzle(sqlFragment: string) → typed rows
    - get_schema() → schema.ts contents
     ↓
Claude selects tool, calls it
     ↓
Worker executes against D1 via Drizzle / Cube SDK
     ↓
Result returned to Claude
     ↓
Claude synthesizes natural language answer + chart spec
     ↓
Streamed back to user
```

### 6.2 Why This Works Better Than "Chat with Warehouse"

The key insight from prior benchmarks: agents fail on warehouse architectures primarily because of **schema discovery cost** — they must read multiple files to understand join keys, column names, and types before they can write a query.

With Drizzle:
- One `schema.ts` file = complete schema, all relationships, all types
- Agent reads ~200 tokens to understand the full data model
- `get_schema()` tool returns this in one call

With a warehouse:
- 12+ SQL files = schema discovery requires reading all of them
- Column renames between staging and mart files cause join failures
- VARCHAR timestamps cause type errors at runtime

**Expected result:** Agent success rate on complex CRM questions should mirror the `app-drizzle` benchmark results (Claude Opus: 3/3, cost $0.10/pass) rather than `warehouse-dbt` results (Claude Opus: 1/3, cost $0.62/pass).

### 6.3 Example Interactions to Demo

```
"What's our 30-day rolling MRR trend by plan tier?"
→ Agent calls query_cube({ measures: ['MRRMetrics.rollingMRR30d'], dimensions: ['Subscriptions.planTier'], timeDimensions: [...] })
→ Returns chart-ready time series

"Which sales rep closed the most ARR last quarter and how does that compare to their pipeline?"
→ Agent calls query_drizzle() with window function over opportunities + pipeline_stage_history
→ Returns ranked table with pipeline context

"Show me the cohort retention grid for Q1 2026 signups"
→ Agent calls query_cube({ measures: ['CohortRetention.retentionRate'], dimensions: ['CohortRetention.cohortMonth', 'CohortRetention.cohortPeriod'] })
→ Returns cohort matrix

"What did our pipeline look like 90 days ago vs today? Which deals regressed?"
→ Agent calls query_drizzle() with SCD snapshot pattern on pipeline_stage_history
→ Returns comparison table with regression flags
```

---

## 7. Benchmark Integration

This PoC extends the existing benchmark framework. The CRM domain becomes a new set of sandbox configs that run through the same harness:

| Sandbox | Architecture | Complexity Level |
|---------|--------------|-----------------|
| `crm-drizzle` | Drizzle + D1, unified schema | Baseline (like `app-drizzle`) |
| `crm-cube` | Cube semantic layer on top of `crm-drizzle` | Semantic layer variant |
| `crm-dbt` | dbt + DuckDB, warehouse pattern | Baseline for comparison |
| `crm-chat` | AI chat via tool calls against `crm-drizzle` | End-to-end demo |

**New benchmark tasks** (harder than prior ARPU/Churn/LTV):

| Task | Primary SQL Primitive | Expected Failure Mode in dbt |
|------|-----------------------|------------------------------|
| `rep_ranking` | RANK() window | File scatter across stg_crm + stg_stripe |
| `rolling_mrr` | Rolling AVG window | Timestamp type + date spine join |
| `cohort_retention` | Self-join + date truncation | Multi-CTE confusion |
| `funnel_conversion` | Conditional aggregation | Join path inference across 3 staging files |
| `pipeline_snapshot` | SCD Type 2 point-in-time | Snapshot model discovery |
| `attribution` | Multi-system lineage join | Cross-domain FK inference |
| `period_comparison` | LAG() window | Column rename (invoice_date vs created_at) |

---

## 8. Demo Scenario: The Acme Dashboard

The PoC ships with a minimal frontend (Cloudflare Pages + React) that shows:

1. **Live CRM Dashboard** — KPI cards (MRR, pipeline ARR, conversion rate, churn rate) powered by Cube pre-aggregations
2. **Sales Rep Leaderboard** — window function query rendered as a ranked table
3. **Cohort Retention Grid** — the classic SaaS retention heatmap
4. **MRR Waterfall** — breakdown of new/expansion/contraction/churn by month
5. **Pipeline Snapshot Diff** — "What changed in the last 90 days?" view using SCD query
6. **AI Chat Panel** — natural language interface for ad-hoc questions

---

## 9. Data Generation

Extend `scripts/generate-data.js` to produce the CRM dataset:

```
organizations     ~200 rows  (mix of SMB, mid-market, enterprise)
users             ~1500 rows (3-20 per org, with signup_source, country, plan)
leads             ~800 rows  (inbound + outbound, with conversion tracking)
opportunities     ~400 rows  (50% of leads convert to opp, 40% close won)
pipeline_stage_history  ~1200 rows (3 avg stages per opp, historical transitions)
activities        ~3000 rows (calls, emails, meetings per rep per week)
sales_reps        ~15 rows   (with quota, territory, hire_date)
feature_events    ~50000 rows (product telemetry — sparse but realistic)
sessions          ~20000 rows
stripe_customers  ~200 rows
stripe_subscriptions ~250 rows (some with upgrades/downgrades over time)
stripe_invoices   ~1200 rows  (monthly cadence, 18 months of history)
stripe_mrr_events ~800 rows  (new, expansion, contraction, churn events)
```

Time range: 18 months of history ending today. Generates realistic cohort patterns (early cohorts have higher retention, recent cohorts show growth trend).

---

## 10. What We Are NOT Building (Scope Limits)

- No real Stripe integration (synthetic data only)
- No real Close.com integration
- No auth / multi-tenant security
- No production deployment
- No mobile app
- The AI chat is a demo endpoint, not a production-hardened feature
- No comparison to vector DB / RAG approaches (separate PoC)

---

## 11. Phased Build Plan

### Phase 1 — Data Layer (Week 1)
- [ ] Extend data generator for CRM entities
- [ ] Define Drizzle schema (`schema.ts` with all 12 tables)
- [ ] Seed D1 database (Wrangler D1 + migration)
- [ ] Validate schema with smoke-test queries for each analytics pattern

### Phase 2 — Semantic Layer (Week 1-2)
- [ ] Define 7 Cube cubes (MRRMetrics, CohortRetention, SalesFunnel, SalesRep, AttributionAnalysis, GrowthMetrics, PipelineHistory)
- [ ] Wire Cube to D1 via SQLite adapter
- [ ] Validate each cube against known-correct answers from Phase 1

### Phase 3 — API Worker (Week 2)
- [ ] Hono API worker with Drizzle client
- [ ] Implement 7 analytics endpoints (one per capability)
- [ ] Expose Cube REST API via proxy endpoint
- [ ] Deploy to Cloudflare Workers

### Phase 4 — AI Chat (Week 2-3)
- [ ] Chat worker with Anthropic SDK (claude-sonnet-4-6)
- [ ] System prompt with schema context
- [ ] `query_cube` and `query_drizzle` tool definitions
- [ ] Stream responses back to client
- [ ] Test against the 4 demo interactions

### Phase 5 — Benchmark Integration (Week 3)
- [ ] Add `crm-drizzle`, `crm-dbt`, `crm-cube` sandbox configs
- [ ] Define 7 benchmark tasks with validation functions
- [ ] Run full benchmark suite (Haiku / Sonnet / Opus × 3 tasks × 3 sandboxes)
- [ ] Document results, compare to prior ARPU/Churn/LTV benchmarks

### Phase 6 — Frontend Demo (Week 3-4)
- [ ] Cloudflare Pages app (React + shadcn/ui)
- [ ] 5 dashboard views + AI chat panel
- [ ] Wire to API worker

---

## 12. Success Criteria

| Metric | Target |
|--------|--------|
| All 7 analytics queries return correct results against known-correct synthetic data | 100% |
| Claude Opus success rate on `crm-drizzle` benchmark tasks | ≥ 5/7 |
| Claude Opus success rate on `crm-dbt` benchmark tasks | ≤ 3/7 (to show the gap) |
| Cost-per-pass ratio (dbt vs drizzle) | ≥ 3x (consistent with prior benchmarks) |
| AI chat correctly answers all 4 demo questions | 4/4 |
| End-to-end demo runs without manual intervention | Yes |

---

## 13. Open Questions

1. **D1 window function support:** SQLite's window function support is solid (RANK, LAG, ROW_NUMBER, SUM OVER) but `PERCENTILE_CONT` is missing. Do we implement this in TypeScript post-query, or route percentile queries through Cube's compute layer?

2. **Cube + D1 adapter:** Cube has a SQLite driver. Does it work with D1's HTTP-based SQLite API (via Wrangler bindings)? May need a shim or need to run Cube on a separate compute layer with direct SQLite file access.

3. **SCD approach:** The `pipeline_stage_history` approach is clean for queries but requires the application to maintain the history table on every stage update. For the PoC, this is fine (we generate the history synthetically). But for a production note: this is the same pattern as dbt snapshots, just done at the application layer where type safety is enforced.

4. **Benchmark fairness:** The `crm-dbt` sandbox needs to be "fair" — well-documented, with correct CASTs, matching the `warehouse-dbt-fair` pattern from prior benchmarks. Otherwise we're comparing best-case Drizzle to worst-case dbt.

5. **Close.com field mapping:** The opportunity and activity schemas are modeled after Close's API. If a future phase integrates real Close data, the field names should align. Worth checking Close's API docs during schema design.
