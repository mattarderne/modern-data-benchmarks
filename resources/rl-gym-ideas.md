**RL Gym for Data Engineering Troubleshooting**

*Project Specification* | February 2026

# **Overview**

An RL gym that evaluates the efficiency of troubleshooting data issues across two competing architectures: ORM-based applications versus data warehouse/dbt pipelines. The core hypothesis is that architecture determines the surface area an agent (or analyst) must audit to find the root cause of a data issue, and that this surface area directly affects troubleshooting efficiency.

The gym provides two parallel environments with identical business logic and identical deliberately-introduced bugs. An RL agent navigates each environment using actions that mirror real analyst behaviour: querying tables, inspecting code, checking API responses, tracing data lineage. The environment with a smaller, more direct observation/action space should require fewer steps to reach the root cause.

# **Core Hypothesis**

Troubleshooting a data issue requires auditing every single step in the pipeline: both the code and the data at each step. In an ORM-based architecture, the code and data are co-located. In a warehouse/dbt architecture, data is replicated from the application into a separate warehouse, and the dbt project adds a second layer of transformations. This increases the surface area without necessarily adding information.

As reasoning capabilities of LLMs continue to improve, analytical performance across architectures will likely converge. But context window efficiency will remain a constraint because it is structural: more surface area means more tokens consumed to audit the same underlying issue. The question is whether a strongly typed ORM system is fundamentally more auditable than a SQL-based warehouse where validation is discovered rather than declared.

# **Environment Architecture**

## **Shared Components**

Both environments share the following:

* A running TypeScript application with ORM  
* An accessible API layer  
* A database with application data  
* A mock external API that serves as a data source  
* Preloaded simulator data (ETL'd approximately 15 minutes prior to the scenario start)  
* Existing metrics/KPIs that the analyst can explore  
* The same deliberately-introduced bug

## **Environment Comparison**

|  | Environment A: ORM | Environment B: Warehouse/dbt |
| :---- | :---- | :---- |
| **Data location** | Application database only | Application database \+ replicated data warehouse |
| **Transformation layer** | ORM models and application code | ORM models \+ dbt project with SQL transformations |
| **ETL from mock API** | Directly into application via ORM | Into application via ORM, then replicated into warehouse |
| **Auditable surface area** | ORM code, API, database (3 components) | ORM code, API, database, warehouse, dbt project (5 components) |
| **Type system** | Strongly typed (TypeScript \+ ORM) | Mixed: strongly typed app layer, loosely typed SQL layer |

# **Bug Design**

## **Primary Bug: Idempotency Failure**

The deliberately-introduced bug is a partial rerun / idempotency failure rather than simple duplicate rows. This is realistic and subtle: a sync from the external API partially re-executes, creating overlapping aggregations that manifest as a double-counting error in downstream metrics. The root cause can only be confirmed by tracing all the way back to the source data and comparing it against the API response.

This bug type is chosen because it requires the agent to understand pipeline state, not just data shape. A simple row count or deduplication check will not surface the issue. The agent must reason about when data was loaded, what the expected state should be, and where the discrepancy was introduced.

## **Bug Requirements**

* Must be identical in both environments (same root cause, same observable symptoms in metrics)  
* Must require tracing through multiple pipeline stages to diagnose  
* Must not be discoverable through a single query or simple row count  
* Should be representative of real production data issues in financial/business applications

# **RL Formulation**

## **Observation Space**

The agent observes the outputs of its actions: query results, code files, API responses, schema definitions, and dbt model definitions (in Environment B). The observation space is intentionally larger in Environment B because the same underlying data exists in more places with more transformation layers.

## **Action Space**

Actions mirror what a human analyst would do when troubleshooting:

* Query a table (application DB or warehouse)  
* Inspect ORM model code  
* Inspect a dbt model definition (Environment B only)  
* Check the API response from the mock external API  
* View schema definitions  
* Compare data between source and destination (Environment B only)  
* Submit diagnosis (root cause identification)

## **Reward**

The reward is the same across both environments: correctly identify the root cause. The metric of interest is not whether the agent can solve it, but how many steps (actions / tokens consumed) it takes to get there. Fewer steps with the same reward indicates a more efficient architecture for troubleshooting.

# **Research Question: Strong Typing and Data Integrity**

An additional angle worth exploring: does a strongly typed system (TypeScript \+ ORM with defined schemas and relationships) extend its guarantees to the data within the system, or can you still have bad data inside a strongly typed system? In a SQL-based warehouse, validation is discovered: you write tests and assertions after the fact. In an ORM, constraints are declared: foreign keys, types, and validations are part of the schema definition.

The hypothesis is that strongly typed systems make certain classes of bugs impossible (schema violations, type mismatches) while SQL-based systems allow anything and rely on downstream testing to catch issues. This has implications for the total effort required to audit and trust data at any given point in the pipeline.

# **Task Breakdown**

## **Task 1: Build the Two Environments**

Construct the parallel environments with shared components. Build the TypeScript application with ORM, mock external API, and database. For Environment B, add the data warehouse and dbt project with ETL replication from the application. Preload both with simulator data. Introduce the idempotency failure bug identically in both. Define existing metrics/KPIs that surface the symptoms.

## **Task 2: Run the Evaluation**

Deploy an RL agent (or LLM-based agent) against both environments with the same task: troubleshoot what has gone wrong with the metrics. Measure steps taken, tokens consumed, and whether the root cause is correctly identified. Run multiple episodes to account for variance.

## **Task 3: Architecture Diagrams and Write-up**

Diagram both architectures with their surface areas clearly marked. Create a single-slide summary of findings. Document the comparison and results as a write-up suitable for the blog. The diagrams should make the surface area difference visually obvious.

# **Stretch: Open Benchmark Simulator**

Extend the gym into a continuously running, publicly accessible benchmark. The simulator would run scheduled deployments (daily or weekly scripts that make random changes to the application and data), maintain a legacy data warehouse with operational complexity and noise, and define KPIs tied to the simulated business. The code and database would be open, allowing others to test their own analytics models and agent capabilities against a living, changing system. This could serve both as a testing harness for this specific comparison and as a standalone open-source RL gym for data engineering troubleshooting.

# **Open Questions**

1. How do we represent the pipeline state (sync history, ETL run logs) in a way that is fair to both architectures? The ORM environment should not get an unfair advantage from having less surface area if in practice that surface area contains useful debugging information.  
2. Should the agent have access to dbt test results in Environment B, or should it have to discover issues from raw data? Including test results might compensate for the larger surface area.  
3. What does a more realistic architecture look like beyond this initial comparison? The current setup may give dbt more of a hand than it deserves by keeping the architecture relatively simple. More realistic enterprise setups (multiple data sources, staging layers, incremental models) would increase the surface area gap further.  
4. Can the strongly typed system question be evaluated quantitatively, or is it better treated as a qualitative observation from the troubleshooting traces?