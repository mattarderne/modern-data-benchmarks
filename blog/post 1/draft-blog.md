# I Benchmarked dbt Against What an LLM Would Build From Scratch

Since reading the OpenAI data stack post, I've suspected that using dbt for analytics might be getting in the way of LLMs. The code is underutilized as a source of meaning and structure. All the SQL + metadata might just be getting in the way of the actual runtime context required to find an approximation of the truth.

I felt this acutely maintaining SQL files in dbt: there was just so much surface area, and **so little logic**.

Reading the OpenAI post, I struggled to believe that the data team at the fastest-growing, most well-funded supercompany in recent memory is doing exactly what I would do. Same way, same tools, driven by the same FinOps need. But that's what path dependency does — the thing becomes the thing because it was the thing.

I don't expect dbt to go anywhere. Standards are set in times of disruption, and if dbt is the analytics standard then so be it. But I wanted to scratch the itch. So I built a benchmark.

I present *The Modern Data Benchmark*, a small experiment comparing how LLM agents perform across different data architectures, given the same data and the same questions.

**The result that surprised me: across 7 models, warehouse+dbt had a 5% pass rate. App-unified architectures had 38-48%.**

---

## A quick history of how we got here

The modern data stack came out of a specific organizational need. Marketing needs to track ad spend. Finance needs to reconcile Stripe revenue. These are important but non-core functions, so they get staffed by half-analyst, half-operator types who can write SQL but not Python.

dbt emerged to give those SQL queries just enough software engineering discipline, version control, modularity, templating, without forcing anyone to leave SQL. It was a rational solution to a real constraint: **these teams could not write code.**

The gravity of that constraint pulled everything towards raw SQL against a data warehouse. No types, no abstractions, nothing but SQL.

<details>
<summary><strong>OpenAI's data warehouse confirms the pattern</strong></summary>

What surprised me was looking at OpenAI's data warehouse. On the surface it looked sophisticated: context layers, embeddings, all the works. But at the core, two things stood out.

First, it was driven by FinOps. The canonical example was revenue reconciliation from Stripe. Even at frontier AI companies, FinOps drives the data warehouse.

Second, it gave a strong smell of dbt. The team had used dbt before, so they reached for it again. This isn't a criticism, it's how standards form. Not by systematic evaluation, but by repetition.

</details>

---

## The question worth asking

dbt's value was making SQL manageable for human analysts. But at scale there are now tens of thousands of lines of SQL that no human is ever going to read. The SQL is increasingly being consumed by agents.

If the consumer is an agent, "easiest for humans to read" stops being the primary design constraint. The relevant question becomes:

> For an agent answering business questions, which representation of the system is the most legible, robust, and correct?

That's not a philosophical question. It's a benchmarkable one.

<details>
<summary><strong>The split-brain problem that makes this interesting</strong></summary>

The modern data stack creates a structural split. Your app has your core business logic: users, statuses, transactions. Separately, you have a data warehouse that holds a lagging copy of that data, *plus* third-party data like Stripe that only exists in the warehouse.

To answer anything useful, you need to join app data onto Stripe data inside the warehouse, using SQL, with constrained logic. The "single source of truth" in the warehouse is never truly trustworthy. Your actual source of truth is the production database, and the warehouse is always behind.

The crux: what if you brought the data home? Loaded Stripe data into a structure your app understands, with proper types and constraints, and ran analytics against the unified codebase? If revenue is a key business capability and we're no longer as code-constrained as we were, why not model it as a first-class concept?

</details>

---

## The benchmark

Three sandbox environments, same data, same three analytical tasks: **ARPU**, **churn rate**, and **LTV**. Small data, known correct answers. The size of the data isn't the test. The architecture is.

| Sandbox | Architecture | How it works |
|---|---|---|
| **app-typed** | Unified app | TypeScript functions over app + Stripe data in one context |
| **app-drizzle** | Unified app (ORM) | Drizzle ORM over a unified SQLite DB with app + Stripe tables |
| **warehouse-dbt** | Traditional stack | SQL models in DuckDB with staging/marts layers |

In the app sandboxes, Stripe data is represented as internal data with types. In the dbt sandbox, it follows the traditional pattern: third-party data loaded and joined via SQL. The model must discover the schema and produce executable code that returns the correct number. No hints, no hand-holding.

<details>
<summary><strong>Architecture diagrams</strong></summary>

**App + Stripe (TypeScript / Drizzle)**
```
App Tables + Stripe Tables → Single typed context → Code → Metric
```

**Warehouse + DBT**
```
App DB + Stripe → Replication → DuckDB raw tables → Staging SQL → Marts SQL → Metric
```

The key difference: in app architectures, the model has one typed context. In the warehouse, it must navigate staging models, column naming conventions, and SQL casting to arrive at the same answer.

</details>

<details>
<summary><strong>How the evaluation works</strong></summary>

Each run works like this:

1. **Fresh sandbox.** A clean copy of the sandbox template is created with the synthetic data loaded. No prior work carries over between tasks.

2. **Agent loop.** The model gets a system prompt describing the architecture and four tools: `read_file`, `write_file`, `list_files`, and `done`. It has up to 10 turns (API round-trips) to explore the codebase, discover the schema, write its solution, and signal completion. Temperature is set to 0.

3. **No hints.** The model is told *what* to compute (e.g., "ARPU for active users") and given the function signature, but not *how*. It must figure out join keys (`users.stripe_customer_id → invoices.customer_id`), column names, and time anchoring on its own by reading files.

4. **Execution.** The model's code is actually run:
   - **app-typed**: the TypeScript function is imported and called with the data arrays
   - **app-drizzle**: the async function runs against a pre-loaded SQLite database via Drizzle ORM
   - **warehouse-dbt**: the SQL is executed in DuckDB with raw tables created from JSON (staging/mart views are built from any SQL files the model wrote)

5. **Scoring.** Pass/fail is purely numeric: does the output match the expected value within tolerance? (±1 for integers like ARPU/LTV, ±0.001 for rates like churn). No partial credit, no style points. If the code crashes, it's a fail. If it returns the wrong number, it's a fail.

6. **Flexible matching.** The validator accepts naming variations (`calculateARPU`, `computeArpu`, `getArpu`, etc.) and searches multiple directories for SQL files, so models aren't penalized for reasonable naming choices.

Expected values are computed from the same data by a reference implementation in the benchmark harness itself, not hand-coded, so they're guaranteed consistent.

</details>

---

## Results

### The headline

**Pass rate by sandbox across all models and runs:**

| | Pass Rate |
|---|---:|
| app-drizzle (ORM) | **48%** |
| app-typed (TypeScript) | **38%** |
| warehouse-dbt | **5%** |

![Total passes by sandbox — app architectures dominate, warehouse-dbt barely scores](../architecture-compare/artifacts/reports/architecture_benchmark_sandbox_totals_multi_2026-02-09-1pass-all.png)

That's not a marginal difference. I wasn't expecting it to be this stark.

![Pass Rate by Sandbox — the warehouse-dbt column barely registers](../architecture-compare/artifacts/reports/architecture_benchmark_summary_multi_2026-02-09-1pass-all.png)

### By model

| Model | app-typed | app-drizzle | warehouse-dbt | Total (/9) |
|---|---:|---:|---:|---:|
| Opus 4.5 | 2/3 | **3/3** | 1/3 | 6 |
| Kimi K2.5 | 1/3 | **3/3** | 0/3 | 4 |
| Grok Code Fast | 1/3 | **3/3** | 0/3 | 4 |
| Sonnet 4 | 2/3 | 0/3 | 0/3 | 2 |
| Qwen3 Coder | 1/3 | 1/3 | 0/3 | 2 |
| Haiku 3.5 | 1/3 | 0/3 | 0/3 | 1 |
| Trinity (free) | 0/3 | 0/3 | 0/3 | 0 |

![Heatmap: model x sandbox — Opus dominates app-drizzle, warehouse-dbt stays pale](../architecture-compare/artifacts/reports/architecture_benchmark_matrix_multi.png)

The warehouse-dbt column is almost entirely zeros. Only Opus managed a single pass, and even that was inconsistent across runs.

![Stacked passes by model — warehouse-dbt (lightest) barely contributes](../architecture-compare/artifacts/reports/architecture_benchmark_model_stacked_multi_2026-02-09-1pass-all.png)

The ORM sandbox was the clear winner: Opus got a perfect 3/3 every single run, and cheaper models like Kimi and Grok matched it.

<details>
<summary><strong>Multi-run stability (n=5 per Anthropic model)</strong></summary>

- **Opus**: 6, 6, 6, 6, 6 total passes. Zero variance.
- **Sonnet**: 3, 3, 1, 1, 2 total passes. High variance (~0.9 std).
- **Haiku**: fluctuates between 0-1 passes.

Opus has genuinely learned the patterns. Mid-tier models are at the edge, and the architecture is what pushes them over or pulls them back.

</details>

### Where dbt falls apart

The failure modes are telling:

- **Schema mismatch**: wrong column names (`created_at` vs `usage_created_at`, `org_id` vs `organization_id`). Staging conventions that the model has to guess.
- **Type mismatch**: interval math on VARCHAR timestamps without casting.
- **File naming**: incorrect output filenames or failure to write the metric model.

In the app sandboxes, failures were simpler (wrong join key, missing function) and more recoverable in typed code.

<details>
<summary><strong>Even thorough models struggle with dbt</strong></summary>

Average unique files read per task in warehouse-dbt:
- **Haiku**: 1.1 files (barely looks at the schema)
- **Sonnet**: 3.7 files (reads staging files but still gets column names wrong)
- **Opus**: 4.4 files (reads everything, still only 1/3 pass rate)

Even when the model does its homework, the warehouse architecture introduces enough indirection to trip it up. It's not a laziness problem, the representation has too many seams.

</details>

### The cost surprise

| Model | Cost/run | Passes (/9) | Cost/pass |
|---|---:|---:|---:|
| Grok Code Fast | $0.05 | 4 | **$0.01** |
| Kimi K2.5 | $0.08 | 4 | **$0.02** |
| Haiku 3.5 | $0.02 | 1 | $0.02 |
| Opus 4.5 | $0.62 | 6 | $0.10 |
| Sonnet 4 | $1.36 | 2 | $0.68 |

Mid-tier models in app-unified sandboxes outperform expensive frontier models working through dbt, at a fraction of the cost. Sonnet at \$1.36 gets 2 passes. Grok at \$0.05 gets 4.

![Cost vs Performance — Opus at $0.62 gets 6 passes, Sonnet at $1.36 gets 2](../architecture-compare/artifacts/reports/architecture_benchmark_cost_curve_2026-02-09-1pass.png)

**The architecture is doing more work than the model.**

---

## What I take from this

This benchmark tests a narrow but important thing: can an agent read a schema, write executable logic, and return the correct metric? It doesn't test full dbt workflows with Jinja, `ref`/`source`, or materializations. It tests the core analytical task that everything else is built to support.

A few observations (not conclusions, this is early and the sample is small):

1. **The architecture matters more than the model.** The same model that fails at dbt can succeed in a typed environment. Before throwing money at smarter models, it's worth asking whether the representation is the bottleneck.

2. **ORMs are surprisingly agent-friendly.** Drizzle over SQLite was the strongest sandbox, even mid-tier models could navigate it. Typed schema + query builder + unified context seems to hit a sweet spot.

3. **Indirection has a cost that compounds.** Each layer of staging, naming convention, and type casting is a place where an agent can silently go wrong. Types and co-location reduce that surface area.

---

## What's next

The current tasks (ARPU, churn, LTV) are intentionally simple, canonical SaaS metrics on synthetic data. The architecture signal is clear, but the questions need to get harder to be convincing. A few directions:

**Harder queries.** I'm looking at [@matsonj's platinum set](https://github.com/matsonj/bird-bench) from the BIRD text-to-SQL benchmark, 42 human-curated queries across 11 databases covering complex joins, CTEs, NULL handling, and conditional aggregation. These are queries where the gold-standard answers in the original benchmark were *wrong* and a human had to correct them. Also worth pulling from [KramaBench](https://github.com/mitdbg/Kramabench) (MIT, 104 tasks across 6 domains, 1700+ tables), which tests full data pipelines, not just single queries, and from the benchmarks referenced by [Sphinx](https://www.sphinx.ai/blog/sphinx-1-0-re-inventing-ai-for-data-science/) including DABStep (real Adyen payments data). If agents struggle with simple ARPU in a warehouse, what happens with real analytical complexity?

**Realistic drift.** The current benchmark is static, the data is clean and complete. Real analytics is messier: late-arriving Stripe invoices, missing `stripe_customer_id` mappings, schema changes mid-pipeline. Adding sync delay scenarios would test whether the split-brain problem is as bad in practice as it is in theory.

**Does the "context layer" exist?** There's a lot of hand-waving right now about "context layers" and "context graphs." When you boil these down, they often look like a data warehouse or semantic layer in new language. My position: **if you can't demonstrate a simple instance of a complex idea, it doesn't meaningfully exist yet.** Next step is to build sandboxes for the best-case context graph examples and run them through the same benchmark. Existence proofs, not vibes.

**What is a "fair" dbt project?** After the initial results I started adding hints to the dbt sandbox, things like cast annotations in staging models so the model doesn't trip on DuckDB timestamp arithmetic. It helped: adding a single cast hint let Sonnet pass org_churn_rate where it previously crashed on a runtime error ([details](https://github.com/mattarderne/modern-data-benchmarks/blob/main/architecture-compare/artifacts/reports/warehouse-dbt-documented-experiment-2026-02-09.md)). But then you're on a slippery slope. How much documentation and scaffolding do you add before the dbt sandbox stops being representative and starts being hand-tuned? A real dbt project lives somewhere on this spectrum, and where exactly is an open question. But maybe that's the point. You can keep adding scaffolding to SQL, cast hints, schema docs, Jinja templating, `ref()` pointers, semantic YAML, and each one closes a small piece of the gap. At some point you have to ask: is the SQL architecture, with all the scaffolding you need to make it work for agents, converging on the thing you'd build if you just started with types and a unified codebase? If the answer is yes, then maybe the scaffolding is the tell.

<details>
<summary><strong>More directions from the research backlog</strong></summary>

- **Linting as agent feedback.** Early experiments with TypeScript typecheck + SQLFluff showed that giving agents lint feedback and extra fix attempts improved ORM scores specifically. But the improvement might just be from extra turns, not the lint signal. Need a control run with extra turns and no lint to isolate the effect.
- **Information parity.** A typed codebase inherently carries more structural information (types, constraints, relationships) than raw SQL with YAML docs. You could argue that's the confound, not the finding. But that's also the point: the architecture *is* the information density. Still, enriching the dbt sandbox with comprehensive YAML schema docs would test how much of the gap is "types help" vs "unified context helps."
- **Turn-level analysis.** Currently only tracking file-read counts. Understanding the step-by-step reasoning, where models go wrong, when they recover, would give sharper insight into why architecture matters.
- **Schema-only lint for dbt.** SQLFluff style rules add noise that distracts smaller models. A schema-only mode that only surfaces missing tables/columns would be a cleaner signal.
- **Semantic layer sandbox (Cube).** The baseline benchmark included Cube but the architecture benchmark didn't. Adding it would test whether pre-defined measures help or constrain agents.

</details>

---

## A request

I'm no longer that close to dbt. Things may have moved on. If you're actively working in dbt and you look at the warehouse sandbox and think "that's not how we'd set it up," I genuinely want to hear that. Is this a realistic task? Is this a fair test? The benchmark is [open source](https://github.com/mattarderne/modern-data-benchmarks/tree/main/architecture-compare), you can replicate it, fork it, set up the dbt sandbox the way you think it should be, and run the same evaluation. If a well-configured dbt project closes the gap, that's a finding worth publishing too.

---

**Caveats**: Small n, synthetic data, single-pass runs for some models, no full dbt compilation. This is directional, not definitive. Run it yourself, add harder tasks, prove me wrong.

---

*[Link to benchmark repo](https://github.com/mattarderne/modern-data-benchmarks/tree/main/architecture-compare) · [Link to OpenAI data stack post]*
