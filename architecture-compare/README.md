# Modern Data Benchmark (Architecture Compare)

This repository contains multiple benchmark experiments for assessing LLM performance across data architectures.

## Experiments

1. Baseline Architecture Benchmark (Typed/DBT/Drizzle/Cube)
See `artifacts/reports/modular-benchmark-writeup.md`.

2. App + Stripe vs Warehouse + DBT Architecture Benchmark
See `artifacts/reports/architecture-benchmark-2026-02-07.md`.

## Cost Curve

**Pareto Performance / Cost Curve**
![Pareto Performance / Cost Curve](artifacts/benchmark_cost_curve.png)

Cost is plotted as **USD per 1M input + 1M output tokens** using the provided price list (log scale on the x‑axis). Claude Haiku 4.5 uses Anthropic’s published pricing.

## Project Structure

```
architecture-compare/
├── README.md
├── _summary.md
├── artifacts/                 # Reports + charts
├── data/                      # Synthetic JSON datasets
├── sandboxes/                 # Typed/DBT/Drizzle/Cube + architecture sandboxes
├── scripts/                   # Benchmarks + smoke tests
└── legacy/                    # Archived scaffolds + older benchmarks
```
