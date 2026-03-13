# Follow-Up Ideas

Ideas for follow-up posts building on the original architecture benchmark blog.

---

## Idea 1: "Your Agent Tools Are Data Engineering Problems" — deeper experiments

A follow-up that takes the original benchmark results and adds more experimental depth. The v1 post established the comparison; this one digs into *why* with additional runs and analysis.

### Core thesis

When companies build agent tools — MCP servers, API wrappers, database connectors — they're not really building "AI features." They're building data access layers. And the patterns you choose for those layers determine whether your agents work or fail.

### Key additions beyond v1

- **Multi-run results (n=5)** showing consistency, not just single-run luck
- **Cost-per-pass analysis** — Opus at $0.10/pass in app-drizzle vs $0.62/pass in warehouse-dbt (6x)
- **Deeper failure mode taxonomy** — the specific ways agents fail in dbt (column renames, VARCHAR casting, file scatter, join key discovery)
- **Prescriptive guidance** — concrete "what to do about it" for teams building agent tools today

### References & orientation

- [dltHub: The Ontology Problem](https://dlthub.com/blog/ontology) — good framing on how schema/ontology choices affect downstream consumers. Relevant consideration for the "prescriptive guidance" section and how to think about data contracts for agent-facing layers.

### Draft

Full draft is in `blog/agent-tools-v2.md`.

---

## Idea 2: "The Mixed Model Artist" — why nobody owns the full picture

Inspired by [The Era of the Mixed Model Artist](https://practicaldatamodeling.substack.com/p/the-era-of-the-mixed-model-artist) (Practical Data Modeling).

### The story

A company models their product catalog as a massive JSON column in Postgres. For the application team — perfect: fast reads, flexible updates, no joins. Then:

- **Analytics team** needs a product revenue dashboard. They discover product categories stored inconsistently — sometimes arrays, sometimes nested objects, sometimes strings. Prices have different structures depending on when products were added. Review counts don't match between the embedded array and the reviews collection. The data engineering team spends **3 months** building a fragile ETL pipeline. The dashboard is perpetually wrong because every app schema change breaks the pipeline.

- **ML team** needs product embeddings for recommendations. They build their own extraction pipeline from the same JSON column, making different assumptions about "product category" than the analytics team. Recommendations don't match dashboard reports. Customers see recommendations for products categorized differently from what they browsed.

Three teams, three interpretations of the same data, three models that contradict each other.

### The business impact

- Delayed personalization engine launch by **4 months**
- Wasted thousands of engineering hours
- VP of Product had to explain to the CEO why their strategic AI initiative was held hostage by a database decision made two years ago

### The connection to our benchmarks

This is the same fundamental problem our benchmarks measure, but at the organizational level rather than the agent level:

- **Our benchmarks**: an agent fails because it can't navigate the indirection between staging layers, column renames, and untyped schemas. The architecture defeats the consumer.
- **The Mixed Model Artist story**: three human teams fail because no one can think across application modeling, analytics modeling, and ML modeling simultaneously. The organizational silos defeat the consumers.

The agent is a microcosm of the team. When we show that Opus drops from 3/3 to 1/3 because of architectural indirection, that's the same phenomenon as three teams building contradictory pipelines from the same JSON blob. The layers and silos that made sense for one consumer (the app) create a gauntlet for every other consumer (analytics, ML, agents).

### Possible angle

"You don't need three separate modeling experts. You need at least one person (or one well-designed schema) that can see the big picture." The Mixed Model Artist argument, but grounded in our benchmark data showing *quantitatively* what happens when the data architecture serves one consumer at the expense of others.

Could frame it as: the agent benchmark is a diagnostic tool for this problem. If your agent can't navigate your data architecture, your analytics and ML teams probably can't either — they're just compensating with tribal knowledge that the agent doesn't have.

---

## Idea 3: "dbt isn't the problem — indirection is" — steelmanning dbt for agents

Inspired by [Ten years late to the dbt party (DuckDB edition)](https://rmoff.net/2026/02/19/ten-years-late-to-the-dbt-party-duckdb-edition/) by rmoff ([HN discussion](https://news.ycombinator.com/item?id=47088464)), and [this tweet](https://x.com/rmoff/status/2024860235014226345).

### The tension

Our benchmark shows agents fail at dbt architectures. But dbt provides real value that our benchmarks don't measure — and a follow-up should engage with that honestly rather than letting readers conclude "dbt bad."

### What dbt actually gives you (from rmoff's post)

- **Lineage via `ref()`** — dbt understands model dependencies because you declare them. This is the same graph that makes agents *struggle* (more files to traverse), but it's also what makes dbt *powerful* for humans (automated dependency resolution, impact analysis, "where does this data come from?").
- **Auto-generated documentation** — static HTML docs from `dbt docs generate` that show table metadata, column descriptions, lineage graphs. No more tribal knowledge about column derivations.
- **Freshness monitoring** — dbt can track source freshness (`_latest_reading_at` pattern), showing which data is stale. rmoff's example shows per-station freshness for weather sensors.
- **Snapshot tables (SCD Type 2)** — dbt snapshots track changes over time, solving the problem rmoff hit in his earlier DuckDB-only pipeline where dimension changes were destructive (SCD Type 1 brute-force rebuilds losing history).
- **Orchestrator integration** — Dagster (and Airflow, Prefect, etc.) can introspect dbt's model graph, pulling in documentation and dependencies automatically.

### The argument to make

The features that make dbt hard for agents are the same features that make it valuable for teams. The question isn't "dbt vs. no dbt" — it's "how do you get dbt's governance benefits without creating an agent-hostile data layer?"

Possible angles:

1. **The indirection tax** — dbt's value comes from separation of concerns (staging, marts, docs). Our benchmarks measure the cost of that separation for a new consumer (the agent). The follow-up could quantify: what specific dbt features cause agent failures, and which are neutral or even helpful?

2. **dbt as documentation, not navigation** — an agent doesn't need to *traverse* staging layers. It needs to know the final schema and how columns are derived. dbt's `schema.yml` and generated docs *could* be the agent's entry point, bypassing the file-scatter problem. Our `warehouse-dbt-documented` experiment partially tested this — worth revisiting with a "give the agent the docs page" approach.

3. **The hybrid architecture** — what if the agent reads dbt's compiled SQL or manifest.json instead of traversing source files? dbt produces `target/compiled/` and `target/manifest.json` which contain the resolved, flattened versions of all models. This could give agents the benefits of dbt's transformation logic without the multi-file discovery problem.

4. **Benchmarking the specific dbt features** — run the benchmark against:
   - Agent given `manifest.json` (dbt's compiled dependency graph)
   - Agent given `dbt docs` output (the documentation site content)
   - Agent given only mart models (skip staging discovery)
   - Compare against the current "agent reads all source files" baseline

### Connection to existing benchmarks

Our `warehouse-dbt-fair` and `warehouse-dbt-documented` experiments already moved in this direction by adding `schema.yml` with column descriptions and join hints. The results improved but didn't close the gap. This follow-up would explore whether giving agents dbt's *output artifacts* (rather than its *source files*) changes the picture.

### Why this matters for the blog

The v1 post risks being read as "dbt is bad for AI." The more nuanced (and more useful) takeaway is: "dbt's transformation patterns create indirection that agents can't navigate, but dbt's metadata and documentation features could actually help agents — if you expose them correctly." This reframes the advice from "don't use dbt" to "use dbt, but think about your agent's entry point."

---

## Supporting materials

- Architecture diagrams: `blog/diagrams.md`
- V2 blog draft: `blog/agent-tools-v2.md`
- Benchmark data: `architecture-compare/artifacts/reports/`
- Experiment reports: `architecture-compare/artifacts/reports/experiments/`
