# Lint/Test Options per Sandbox (Design Note)

Goal: define minimal lint/test steps per architecture without changing outcome-based scoring.

## Options by Sandbox

App-typed (TypeScript)
- `tsc --noEmit` to verify type correctness and exported function signatures.
- Optional: `eslint` for style and unused imports.

App-drizzle (TypeScript + ORM)
- `tsc --noEmit` for type correctness.
- Optional: a lightweight query compile check by running the generated file against SQLite with no data writes.

Warehouse-dbt (DuckDB SQL)
- Option A: `sqlfluff lint` on model SQL files to catch syntax and column reference issues.
- Option B: adopt a minimal dbt project with `dbt compile` using the DuckDB adapter to align with “real” dbt.
- Current harness does not run dbt compile; SQL is executed directly in DuckDB for parity with TypeScript execution.

Cube (if included in a run)
- Option A: “compile only” step that extracts measures and validates SQL fragments.
- Option B: run a minimal Cube compile/lint command if available in the runtime environment.

## Recommended Minimum Set (Parity-Preserving)

- Keep validation outcome-based for all sandboxes.
- Add only lightweight checks that exist across stacks:
- `tsc --noEmit` for app-typed and app-drizzle.
- `sqlfluff lint` for warehouse-dbt only if it is treated as informational, not as a hard fail.

Rationale: full dbt compile/test introduces extra project scaffolding and drifts from parity unless TypeScript and Drizzle receive comparable compile checks. If we adopt dbt compile, we should also enforce TypeScript typecheck as a hard gate to keep the evaluation balanced.
