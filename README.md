# Data Architecture Comparison

An experiment to compare a **strongly-typed TypeScript monolith** against a **DBT + warehouse** approach for LLM-driven analytics. The goal is to measure whether smaller models can deliver higher success rates and lower token usage when context is encoded in typed code rather than SQL + YAML metadata.

## Status

Phase 1 (Foundation) is in progress. This repo contains the initial schema definitions, synthetic data generator, and DBT scaffolding needed to establish data parity between architectures.

## Project Structure

```
data-architecture-comparison/
├── README.md
├── _summary.md
├── data/                      # Generated datasets (JSON)
├── scripts/                   # Data generation utilities
├── typed/                     # TypeScript monolith scaffolding
│   └── src/
│       ├── analytics/
│       ├── data/
│       ├── db/
│       └── types/
└── warehouse/                 # DBT + DuckDB scaffolding
    ├── dbt_project.yml
    └── models/
        ├── marts/
        ├── staging/
        └── schema.yml
```

## Getting Started

1. Generate synthetic data (JSON) for both architectures:
   ```bash
   node data-architecture-comparison/scripts/generate-data.js
   ```
2. Review the typed schema in `typed/src/db/schema.ts` and the DBT models in `warehouse/models/`.

## Benchmark (Theory Check)

The benchmark asks an LLM to emit a small JSON query specification for each task, then evaluates it against the generated data.

1. Ensure data exists:
   ```bash
   node data-architecture-comparison/scripts/generate-data.js
   ```
2. Run the benchmark (requires `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY`):
   ```bash
   ANTHROPIC_API_KEY=... node --experimental-strip-types data-architecture-comparison/scripts/run-benchmark.ts
   ```

Optional flags:
- `--context typed|dbt|both`
- `--model <anthropic-model-name>`
- `--max-tokens <number>`

## Next Steps

- Add a Drizzle schema + migrations for the typed architecture.
- Load generated JSON into SQLite and DuckDB.
- Implement benchmark tasks and validators.
- Build a context provider to supply LLM prompts for each architecture.

## Notes

The goal is to keep both architectures data-equivalent so the LLM evaluation compares context representation, not data quality.
