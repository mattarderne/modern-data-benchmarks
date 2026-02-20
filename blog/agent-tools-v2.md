# Your Agent Tools Are Data Engineering Problems

Every company building internal agents hits the same wall. The agent scaffolding is easy — pick an SDK, wire up tool definitions, write a system prompt. The hard part is the tools themselves: connecting your agent to the internal data it needs to be useful.

That's data engineering. And the patterns you choose for it will determine whether your agents work or fail.

## The realization

When companies build agent tools — MCP servers, API wrappers, database connectors — they're not really building "AI features." They're building data access layers. The tool that lets an agent query revenue by customer is the same problem as the dashboard that shows revenue by customer. The data has to be found, joined, typed, and returned correctly.

The difference is that a human analyst can compensate for messy data architecture. They know that `org_id` in one table means `organization_id` in another. They remember that timestamps are stored as strings in the warehouse and need casting. They've memorized which staging file renames which column.

An agent doesn't have any of that context. It discovers schema by reading files. Every layer of indirection, every column rename, every type mismatch is a place where the agent can fail — and will.

## What the benchmarks show

We ran a controlled experiment: the same three analytics tasks (ARPU, churn rate, LTV), the same underlying data, but three different architectures for the agent to work with.

**The architectures:**
- **Warehouse + dbt** — the standard DE stack. Raw tables replicated via CDC, staging models that rename columns and cast types, mart models that join and aggregate. 12+ SQL files across multiple directories.
- **App + Drizzle ORM** — a unified schema. All 11 tables defined in one TypeScript file with typed columns. Existing query examples in one file. 3 files total.
- **App + TypeScript** — pure typed arrays with explicit foreign key declarations. No database. 5 files total.

**Results across models (multi-run, n=5):**

| Model | app-typed | app-drizzle | warehouse-dbt |
|---|---:|---:|---:|
| Haiku | 0.40/3 | 0.20/3 | 0.00/3 |
| Sonnet | 0.80/3 | 0.80/3 | 0.40/3 |
| Opus | 2.00/3 | 3.00/3 | 1.00/3 |

Opus achieves a **perfect 3/3 in app-drizzle** (consistent across all 5 runs) but drops to **1/3 in warehouse-dbt**. The same model, the same data, the same tasks. The only difference is how the data is organized.

This isn't a model capability gap. It's an architecture gap.

## Why traditional DE patterns hurt agents

The warehouse + dbt pattern was designed for human teams. Staging layers give analysts consistent naming conventions. Marts give business users pre-joined views. Schema documentation gives new team members orientation.

These are all good things — for humans. For agents, they create a gauntlet of failure modes:

**1. File scatter forces multi-step discovery**

In warehouse-dbt, the agent has to read 4-5 separate SQL files just to learn the column names. In app-drizzle, one file read gives it all 11 tables with types.

```
warehouse-dbt          app-drizzle
─────────────          ───────────
  12+ SQL files          3 files
  5 layers               2 layers
  0 type info            full types
```

**2. Column renames break join discovery**

The staging layer renames `id` to `user_id`, `created_at` to `user_created_at`. The agent has to read `stg_app_users.sql` to discover that `stripe_customer_id` exists, then read `stg_stripe_invoices.sql` to find `customer_id`, then figure out these are the join key — across separate files with renamed columns.

In app-drizzle, the agent reads `schema.ts` and sees `users.stripeCustomerId` and `invoices.customerId` in the same file.

**3. Untyped columns cause runtime failures**

Warehouse-dbt stores timestamps as VARCHAR. The agent writes interval arithmetic, and gets `cannot subtract INTERVAL from VARCHAR`. This was the single most common failure mode in our dbt runs.

The Drizzle schema has `integer('amount_paid')` and `text('created_at')` — the types are visible at read time, before the agent writes any code.

**4. Each layer multiplies the error surface**

```
warehouse-dbt: JSON → Raw Tables → Staging Views → Mart Models → Metric SQL
                                    (renames)       (joins)       (agent writes)

app-drizzle:   JSON → SQLite DB → Query Function
                      (typed)      (agent writes)
```

Every arrow is a place where information can be lost or misinterpreted. The warehouse path has 5 layers. The app path has 2.

## The human-led DE mistakes to avoid

Traditional data engineering accumulated these patterns for good reasons — governance, documentation, team scalability. But when the consumer of your data layer is an agent, not a human, the calculus changes.

Here are the patterns that hurt:

**Staging layers that only rename columns.** If the only transformation is `id AS user_id`, you're adding a layer of indirection with zero information gain. The agent has to read two files instead of one to learn the same thing. Put the canonical names in the schema definition itself.

**Warehouse-first architecture when the data originates in your app.** If your agent needs to query your own application data, routing it through CDC → warehouse → staging → marts adds latency and indirection that serves no one. Query the source directly with a typed schema.

**Untyped storage with implicit casting conventions.** If your team "just knows" that `created_at` is a timestamp stored as VARCHAR, that tribal knowledge doesn't transfer to an agent. Use typed schemas where the column definition tells you the type.

**Documentation as a separate artifact.** Schema docs in `schema.yml` help if the agent reads them. But typed column definitions in code are documentation that the agent *can't avoid reading*. Inline the semantics.

## What works for agents

The benchmark data points to a clear set of principles:

**1. Minimize layers between source and consumption.** Every transformation layer the agent has to traverse is a layer where it can lose track of column names, types, and join keys. Two layers beats five.

**2. Co-locate schema and relationships.** All tables in one file means one read gives the agent the full picture. The join path from `users.stripeCustomerId` to `invoices.customerId` is visible without cross-referencing files.

**3. Use typed schemas.** TypeScript types, ORM column definitions, or any system where the schema carries type information at read time. The agent shouldn't have to guess whether a column is a string or a timestamp.

**4. Provide working examples.** In app-drizzle, `queries.ts` contains a working `calculateTotalRevenue()` function. The agent reads it and knows the pattern: import from schema, use `db.select()`, join with `eq()`. Pattern matching is where LLMs excel.

**5. Prefer append-to-file over create-new-file.** The agent appends a function to `queries.ts` in app-drizzle. In warehouse-dbt, it has to create a new SQL file with the correct name in the correct directory. Fewer decisions = fewer failure points.

## The efficiency argument

This isn't just about making agents work. It's about making them work *efficiently*.

Opus costs ~$0.10 per successful task in app-drizzle. In warehouse-dbt, it costs ~$0.62 per successful task — 6x more — and still fails 2 out of 3 times. The agent spends more tokens reading staging files, more turns recovering from type errors, and still produces worse results.

| Architecture | Opus pass rate | Cost per pass |
|---|---|---|
| app-drizzle | 100% | ~$0.10 |
| app-typed | 67% | ~$0.16 |
| warehouse-dbt | 33% | ~$0.62 |

The most efficient data architecture for agents is also the most successful one. Fewer files to read means fewer tokens consumed. Typed schemas mean fewer retry loops. Co-located tables mean fewer wrong joins.

When you frame agent tools as data engineering problems — which they are — the conclusion is straightforward: the best agent tools will be the ones backed by the most efficient data access patterns. And the traditional DE stack, designed for human workflows and organizational governance, is not that.

## What this means for your stack

If you're building internal agent tools today:

1. **Don't replicate data you already own.** If the agent is querying your app's database, give it a typed schema over that database. Don't route it through a warehouse.

2. **Collapse your staging layers.** If a staging model only renames columns, delete it and put the canonical names in the schema definition.

3. **Type everything.** VARCHAR columns with implicit type conventions are the #1 failure mode for agents working with warehouse data.

4. **Put related schemas in one file.** The agent reads files. Minimize the number of reads needed to understand the full data model.

5. **Include working examples.** One reference implementation is worth a thousand lines of documentation.

The irony is that these are also good engineering practices for humans. The patterns that make data accessible to agents — typed schemas, minimal indirection, co-located definitions — are the same patterns that make data accessible to any new team member. The agent just has less patience for the workarounds.

---

*Data from the [Modern Data Benchmark](https://github.com/mattarderne/modern-data-benchmarks/tree/main/architecture-compare), testing LLM performance across data architectures on identical analytics tasks.*
