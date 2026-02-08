# TODO

Next priority
- Add token usage logging for API calls and generate a Pareto cost curve for architecture runs.

Validation depth
- Evaluate lint/test options per sandbox (dbt compile/test with duckdb adapter, sqlfluff, TS typecheck/ESLint for typed, smoke/unit checks for drizzle, and a minimal validation check for cube measures).

Scoring
- Define and test a scoring rubric beyond binary pass/fail (code correctness vs numeric correctness, schema adherence, tool usage, and partial credit).
