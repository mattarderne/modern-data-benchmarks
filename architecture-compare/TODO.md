# TODO

Validation depth
- Decide whether to upgrade syntax-only linting to typecheck/dbt compile (and keep parity across sandboxes).
- Test whether dbt compile / logical plans help agents. Reference: [The Power of a Plan: How Logical Plans Will Impact Modern Data Workflows](https://roundup.getdbt.com/p/the-power-of-a-plan-how-logical-plans). The post describes compiler-powered features for dbt: logical plans (intermediate SQL representations), column-level lineage propagation, cross-dialect validation, and catching errors before warehouse execution. These are essentially the dbt equivalent of what TypeScript's type system gives you for free — provably correct structure before runtime. Test whether giving the agent access to `dbt compile` output (resolved SQL with refs expanded, column lineage, validation errors) closes the gap against typed sandboxes. This is the strongest version of the "fair dbt" question from the blog: if you give dbt all its tooling, does the architecture disadvantage shrink?

Scoring
- Calibrate rubric weights and validate scoring on a small labeled set.

Robustness
- Add realistic drift scenarios (late Stripe invoices, missing stripe_customer_id mappings).

Harder queries / external benchmarks
- Adapt a subset of @matsonj's BIRD platinum set (https://github.com/matsonj/bird-bench) for each sandbox. 42 human-curated queries across 11 databases, complex joins, CTEs, NULL handling. Tests whether the architecture advantage holds as query difficulty scales.
- Review KramaBench (https://github.com/mitdbg/Kramabench) — MIT benchmark for end-to-end data science agents. 104 tasks across 6 domains, 1700+ tables, ~1.7GB raw data. Tests full pipeline: load, clean, transform, compute. Evaluates intermediate steps not just final answers. Interesting for multi-step analytical workflows that go beyond single-query metrics. Check if any tasks can be adapted to the sandbox format.
- Review Sphinx benchmarks (https://www.sphinx.ai/blog/sphinx-1-0-re-inventing-ai-for-data-science/) — references DABStep (Adyen/HuggingFace, real payments data) and KramaBench. Sphinx claims SOTA on both. Their SphinxBench (proprietary, 200+ scenarios) tests data intelligence, statistical reasoning, and workflow alignment. Worth tracking for methodology ideas even if the benchmark itself isn't open.

Richer data + schema architecture variants
- Integrate work from PR #55 (https://github.com/mattarderne/ai-research/pull/55): schema architecture evaluation framework with synthetic data generator across three business domains (Stripe billing, CRM sales pipeline, Support tickets). Generates identical data in three architectures:
  - Normalized (13 tables): canonical relational model
  - Star schema (8 tables): dimension + fact tables, classic BI pattern
  - One Big Table / OBT (3 tables): fully denormalized, pre-joined wide tables
  Hypothesis from PR: OBT should perform better for smaller LLMs due to reduced join reasoning. This adds a new axis to the current benchmark (architecture shape, not just typed vs SQL). Types already exist for CRM and Support domains. Data generator produces 500 customers, 3000 invoices, 300 accounts, 600 opportunities, 1500 tickets. Could run the existing benchmark harness against normalized vs star vs OBT variants to test whether denormalization helps agents the way types do.
- Plan was for 60 benchmark questions (20 per domain) at 4 complexity levels. These would significantly expand the current 3-task set.

New sandbox variants
- Create `warehouse-dbt-documented` sandbox: identical to `warehouse-dbt` but with comprehensive schema.yml documenting all columns, join keys, and relationships. Tests whether the gap is architecture or information density. See legacy/docs/INFORMATION_PARITY_ANALYSIS.md for the enhanced YAML spec (already written, just needs wiring).
- Add `app-drizzle-cube` sandbox using drizzle-cube (https://github.com/cliftonc/drizzle-cube), a Drizzle-native semantic layer. Since app-drizzle was the best-performing sandbox, this tests whether adding semantic abstractions (pre-defined measures, dimensions, joins) on top of the winning architecture helps or hurts agents. Also has MCP server support which is relevant if we move to tool-use agents.
- Add Cube sandbox to the architecture benchmark (currently only in the baseline benchmark). Compare Cube's declarative measure definitions against Drizzle's imperative queries and dbt's SQL. Tests whether pre-defined abstractions constrain or guide models.
- **Add Malloy sandbox** ([malloydata/malloy](https://github.com/malloydata/malloy)): Malloy is a semantic modeling language that compiles to SQL — sits in a similar space to Cube but with a more opinionated language design. Key properties: composable queries (queries are reusable building blocks, not strings), embedded semantic types (measures, dimensions, joins declared once), and a compiler that catches errors before hitting the warehouse. Tests the hypothesis that a purpose-built analytical language between compute and agent performs better than either raw SQL, SQL-scripting (dbt), ORM-hacking (Drizzle), or declarative YAML (Cube). This is the "Option 3" in the spectrum: raw SQL → dbt scripting → **semantic abstraction (Malloy/Cube)** → ORM → from-scratch codegen. The benchmark should help answer which layer is most optimal as the strict interface between columnar compute (Snowflake/Databricks/lakehouse) and an agent.

Does more scaffolding help? (Dash review)
- Review Dash (https://github.com/agno-agi/dash), a self-learning data agent inspired by OpenAI's internal data agent. Uses 6 layers of context: table usage, human annotations, query patterns, institutional knowledge, learned error fixes, and runtime schema detection. The interesting question: Dash's approach is to pile on more context and scaffolding around SQL to make agents succeed. Our results suggest the opposite, that reducing indirection (typed codebase) works better than adding layers. Test whether Dash-style layered context on top of the warehouse-dbt sandbox closes the gap, or whether it's just more complexity for the same result. Could be a sandbox variant that adds annotations, query patterns, and error learnings to the dbt environment.

Context layer / context graph review and POC
- The blog promises to test whether "context layers" and "context graphs" are meaningfully distinct from what we already have. Need to actually do this:
  1. Literature review: collect the best articulations of what a context layer/graph claims to be. Sources: OpenAI data stack post, Databricks Unity Catalog, dbt semantic layer docs, any "context engineering" posts that define it concretely.
  2. Define what "meaningfully distinct" means: identify 2-3 concrete capabilities that a context graph claims and that a typed codebase or dbt+semantic layer doesn't already provide.
  3. Build POC sandboxes: implement the best-case version of a context graph for the benchmark tasks. If it can't be made concrete for ARPU/churn/LTV, that itself is a finding.
  4. Run through the same benchmark and compare. The bar is: does it measurably outperform app-drizzle?
- This is the existence proof test. If we can't build a simple instance that performs differently, the concept doesn't meaningfully exist yet.

Troubleshooting RL gym
- Full plan: [plans/rl-gym-troubleshooting.md](../plans/rl-gym-troubleshooting.md)
- Extend the benchmark from metric computation to **debugging efficiency**. Two parallel sandboxes (ORM vs warehouse+dbt) with identical deliberately-introduced bugs (starting with idempotency/double-counting). Agent uses analyst-like actions (query_db, check_api, inspect_etl_log, submit_diagnosis) to find the root cause. Primary metric: steps and tokens to correct diagnosis, not just pass/fail. Builds on existing harness — new sandbox templates, bug injection via `applyBug()` (mirrors `applyDrift()`), mock API as ground truth, rubric-based diagnosis scoring.
- Key phases: bug injection → sandbox templates → expanded tool set → diagnosis scoring → smoke test → full multi-model evaluation → analysis.

Agent trace analysis
- Review agent-trace (https://agent-trace.dev/) — tool for visualising and analysing agent execution traces. Could be useful for turn-level analysis of benchmark runs: understanding where models go wrong, when they recover, and how exploration patterns differ across architectures. Currently we only track file-read counts; this could give sharper insight into the step-by-step reasoning.

Open research questions (from legacy plans, still unanswered)
- **What is the optimal interface between columnar compute and an agent?** The benchmark now spans enough of the spectrum to answer this directly. The candidates, from least to most abstraction:
  1. Raw SQL — no scaffolding, agent writes queries from scratch
  2. dbt / SQL scripting — consensus pick, refs + tests + docs but still string-based SQL
  3. Malloy / Cube — semantic abstraction with compiler, composable queries, declared measures
  4. ORM (Drizzle) hacked into analytics — typed, imperative, not designed for analytics but gives agents type safety
  5. From-scratch codegen (10x Codex in Rust/Go) — agent builds the layer itself, maximum flexibility, zero reuse
  Current results suggest option 4 outperforms option 2. Adding Malloy (option 3) and raw SQL (option 1) sandboxes would complete the picture. Option 5 is testable but expensive.
- Declarative vs imperative: SQL/Cube (declarative) vs TypeScript/Drizzle (imperative). Baseline benchmark has some signal but architecture benchmark doesn't include Cube.
- Does the semantic layer help or hurt? Cube in the baseline scored mixed results (some models 3/3, some 0/3). drizzle-cube could clarify this by testing a semantic layer on top of the architecture that already works best.
- Edit/extend tasks: current benchmark is write-from-scratch. What about tasks that require modifying existing analytics code? The legacy scripts (edit-benchmark.ts, simple-edit-benchmark.ts) had this direction but were never run in the architecture benchmark.
- Multi-step workflows: current tasks are single-query. KramaBench-style pipelines (load → clean → transform → compute) would test whether the architecture advantage compounds or diminishes over multi-step reasoning.
