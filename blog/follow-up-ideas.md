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

## Supporting materials

- Architecture diagrams: `blog/diagrams.md`
- V2 blog draft: `blog/agent-tools-v2.md`
- Benchmark data: `architecture-compare/artifacts/reports/`
- Experiment reports: `architecture-compare/artifacts/reports/experiments/`
