#!/usr/bin/env python3
import json
import math
import os
from pathlib import Path
from collections import defaultdict, Counter

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

INPUT_DIR = Path('artifacts/reports/architecture_runs_2026-02-07')
OUTPUT_DIR = Path('artifacts/reports')

MODELS = [
    'claude-3-5-haiku-20241022',
    'claude-sonnet-4-20250514',
    'claude-opus-4-5',
]
SANDboxes = ['app-typed', 'app-drizzle', 'warehouse-dbt']
TASKS = ['active_user_arpu', 'org_churn_rate', 'avg_org_ltv']

KEY_FILES = {
    'app-typed': [
        'src/analytics/queries.ts',
        'src/types/internal.ts',
        'src/types/stripe.ts',
        'src/analytics/derived.ts',
    ],
    'app-drizzle': [
        'src/schema.ts',
        'src/queries.ts',
        'src/db.ts',
    ],
    'warehouse-dbt': [
        'models/staging/stg_app_api_usage.sql',
        'models/staging/stg_app_users.sql',
        'models/staging/stg_app_organizations.sql',
        'models/staging/stg_stripe_invoices.sql',
        'models/staging/stg_stripe_subscriptions.sql',
    ],
}


def load_runs():
    runs = []
    if not INPUT_DIR.exists():
        return runs
    for path in sorted(INPUT_DIR.glob('*.json')):
        with path.open() as f:
            payload = json.load(f)
        runs.append(payload)
    return runs


def summarize_runs(runs):
    # data structures
    pass_counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    run_counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    run_totals = defaultdict(list)  # model -> list of total passes per run

    tool_reads = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))

    for payload in runs:
        model = payload['metadata']['model']
        results = payload['results']

        # total passes per run (out of 9)
        total_pass = sum(1 for r in results if r.get('pass'))
        run_totals[model].append(total_pass)

        for r in results:
            sandbox = r['sandbox']
            task = r['task']['id']
            passed = 1 if r.get('pass') else 0

            pass_counts[model][sandbox][task] += passed
            run_counts[model][sandbox][task] += 1

            usage = r.get('toolUsage') or {}
            reads = usage.get('readFiles') or []
            tool_reads[model][sandbox][task].append(reads)

    return pass_counts, run_counts, run_totals, tool_reads


def binom_ci(p, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    se = math.sqrt(max(p * (1 - p) / n, 0.0))
    lo = max(0.0, p - z * se)
    hi = min(1.0, p + z * se)
    return (lo, hi)


def build_summary(pass_counts, run_counts, run_totals, tool_reads):
    summary = {
        'models': MODELS,
        'sandboxes': SANDboxes,
        'tasks': TASKS,
        'per_model': {},
    }

    for model in MODELS:
        model_entry = {
            'sandbox_task_pass_rate': {},
            'sandbox_passes_mean': {},
            'sandbox_passes_ci': {},
            'overall_passes_mean': 0.0,
            'overall_passes_ci': (0.0, 0.0),
            'runs': run_totals.get(model, []),
            'tool_usage': {},
        }

        overall_total = 0
        overall_n = 0

        for sandbox in SANDboxes:
            # per task pass rate
            task_rates = {}
            task_counts = 0
            task_passes = 0
            for task in TASKS:
                n = run_counts[model][sandbox][task]
                c = pass_counts[model][sandbox][task]
                p = c / n if n else 0.0
                task_rates[task] = {
                    'pass_rate': p,
                    'passes': c,
                    'runs': n,
                    'ci95': binom_ci(p, n),
                }
                task_counts += n
                task_passes += c

            model_entry['sandbox_task_pass_rate'][sandbox] = task_rates

            # mean passes per sandbox (out of 3)
            n_runs = run_counts[model][sandbox][TASKS[0]]
            passes_mean = task_passes / n_runs if n_runs else 0.0
            model_entry['sandbox_passes_mean'][sandbox] = passes_mean

            # CI on average pass rate across tasks
            total_trials = n_runs * len(TASKS)
            p_total = task_passes / total_trials if total_trials else 0.0
            ci = binom_ci(p_total, total_trials)
            model_entry['sandbox_passes_ci'][sandbox] = ci

            overall_total += task_passes
            overall_n += total_trials

        overall_p = overall_total / overall_n if overall_n else 0.0
        model_entry['overall_passes_mean'] = overall_p * len(SANDboxes) * len(TASKS)
        model_entry['overall_passes_ci'] = binom_ci(overall_p, overall_n)

        # tool usage summary
        tool_summary = {}
        for sandbox in SANDboxes:
            file_hits = Counter()
            total_reads = 0
            total_unique_reads = 0
            total_tasks = 0

            for task in TASKS:
                for reads in tool_reads[model][sandbox][task]:
                    total_tasks += 1
                    total_reads += len(reads)
                    unique_reads = set(reads)
                    total_unique_reads += len(unique_reads)
                    for file in unique_reads:
                        file_hits[file] += 1

            key_file_rates = {}
            for key in KEY_FILES.get(sandbox, []):
                key_file_rates[key] = (file_hits.get(key, 0) / total_tasks) if total_tasks else 0.0

            tool_summary[sandbox] = {
                'avg_reads_per_task': total_reads / total_tasks if total_tasks else 0.0,
                'avg_unique_reads_per_task': total_unique_reads / total_tasks if total_tasks else 0.0,
                'key_file_read_rate': key_file_rates,
            }

        model_entry['tool_usage'] = tool_summary
        summary['per_model'][model] = model_entry

    # plateau analysis
    plateau = {}
    for model, totals in run_totals.items():
        running_std = []
        for i in range(1, len(totals) + 1):
            vals = totals[:i]
            mean = sum(vals) / i
            var = sum((v - mean) ** 2 for v in vals) / i
            running_std.append(math.sqrt(var))
        plateau[model] = {
            'run_totals': totals,
            'running_std': running_std,
        }
    summary['plateau'] = plateau

    return summary


def write_summary(summary):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / 'architecture_sampling_summary.json'
    with out_path.open('w') as f:
        json.dump(summary, f, indent=2)
    return out_path


def plot_charts(summary):
    out_dir = OUTPUT_DIR
    models = MODELS
    sandboxes = SANDboxes
    tasks = TASKS

    # matrix: mean passes per sandbox (out of 3)
    matrix = np.zeros((len(models), len(sandboxes)), dtype=float)
    for i, model in enumerate(models):
        for j, sandbox in enumerate(sandboxes):
            matrix[i, j] = summary['per_model'][model]['sandbox_passes_mean'][sandbox]

    fig, ax = plt.subplots(figsize=(7.5, 3.2))
    img = ax.imshow(matrix, cmap='Blues', vmin=0, vmax=len(tasks))
    ax.set_xticks(range(len(sandboxes)))
    ax.set_xticklabels(sandboxes)
    ax.set_yticks(range(len(models)))
    ax.set_yticklabels(models)
    ax.set_title('Architecture Benchmark (Multi-Run): Mean Passes per Sandbox (out of 3)')

    for i in range(matrix.shape[0]):
        for j in range(matrix.shape[1]):
            ax.text(j, i, f"{matrix[i, j]:.2f}/3", ha='center', va='center', color='black')

    cbar = fig.colorbar(img, ax=ax, fraction=0.046, pad=0.04)
    cbar.set_label('Mean Passes (0-3)')
    fig.tight_layout()
    fig.savefig(out_dir / 'architecture_benchmark_matrix_multi.png', dpi=200)
    plt.close(fig)

    # model totals (mean passes out of 9)
    model_totals = matrix.sum(axis=1)
    model_max = len(sandboxes) * len(tasks)
    fig, ax = plt.subplots(figsize=(6.5, 3.6))
    ax.bar(range(len(models)), model_totals, color=['#7aa6c2', '#4f7fa3', '#2b5c84'])
    ax.set_xticks(range(len(models)))
    ax.set_xticklabels(models, rotation=20, ha='right')
    ax.set_ylim(0, model_max)
    ax.set_ylabel('Mean Passes (out of 9)')
    ax.set_title('Architecture Benchmark (Multi-Run): Mean Passes by Model')
    for i, v in enumerate(model_totals):
        ax.text(i, v + 0.1, f"{v:.2f}", ha='center', va='bottom')
    fig.tight_layout()
    fig.savefig(out_dir / 'architecture_benchmark_model_totals_multi.png', dpi=200)
    plt.close(fig)

    # model stacked by sandbox
    fig, ax = plt.subplots(figsize=(6.5, 3.6))
    colors = ['#5e8aa8', '#7aa6c2', '#9bbbd0']
    stack_bottom = np.zeros(len(models))
    for idx, sandbox in enumerate(sandboxes):
        values = matrix[:, idx]
        ax.bar(range(len(models)), values, bottom=stack_bottom, label=sandbox, color=colors[idx])
        stack_bottom += values
    ax.set_xticks(range(len(models)))
    ax.set_xticklabels(models, rotation=20, ha='right')
    ax.set_ylim(0, model_max)
    ax.set_ylabel('Mean Passes (out of 9)')
    ax.set_title('Architecture Benchmark (Multi-Run): Passes by Model and Sandbox')
    ax.legend(frameon=False)
    fig.tight_layout()
    fig.savefig(out_dir / 'architecture_benchmark_model_stacked_multi.png', dpi=200)
    plt.close(fig)

    # sandbox totals
    sandbox_totals = matrix.sum(axis=0)
    sandbox_max = len(models) * len(tasks)
    fig, ax = plt.subplots(figsize=(5.2, 3.6))
    ax.bar(range(len(sandboxes)), sandbox_totals, color=['#7aa6c2', '#4f7fa3', '#2b5c84'])
    ax.set_xticks(range(len(sandboxes)))
    ax.set_xticklabels(sandboxes)
    ax.set_ylim(0, sandbox_max)
    ax.set_ylabel('Mean Passes (out of 9)')
    ax.set_title('Architecture Benchmark (Multi-Run): Mean Passes by Sandbox')
    for i, v in enumerate(sandbox_totals):
        ax.text(i, v + 0.1, f"{v:.2f}", ha='center', va='bottom')
    fig.tight_layout()
    fig.savefig(out_dir / 'architecture_benchmark_sandbox_totals_multi.png', dpi=200)
    plt.close(fig)

    # summary pass rates
    fig, axes = plt.subplots(1, 2, figsize=(8.8, 3.2))
    model_rates = model_totals / model_max
    sandbox_rates = sandbox_totals / sandbox_max

    axes[0].bar(range(len(models)), model_rates, color=['#7aa6c2', '#4f7fa3', '#2b5c84'])
    axes[0].set_xticks(range(len(models)))
    axes[0].set_xticklabels(models, rotation=20, ha='right')
    axes[0].set_ylim(0, 1)
    axes[0].set_title('Pass Rate by Model (Multi-Run)')
    axes[0].set_ylabel('Pass Rate')
    for i, v in enumerate(model_rates):
        axes[0].text(i, v + 0.02, f"{v:.2f}", ha='center', va='bottom', fontsize=9)

    axes[1].bar(range(len(sandboxes)), sandbox_rates, color=['#7aa6c2', '#4f7fa3', '#2b5c84'])
    axes[1].set_xticks(range(len(sandboxes)))
    axes[1].set_xticklabels(sandboxes)
    axes[1].set_ylim(0, 1)
    axes[1].set_title('Pass Rate by Sandbox (Multi-Run)')
    axes[1].set_ylabel('Pass Rate')
    for i, v in enumerate(sandbox_rates):
        axes[1].text(i, v + 0.02, f"{v:.2f}", ha='center', va='bottom', fontsize=9)

    fig.tight_layout()
    fig.savefig(out_dir / 'architecture_benchmark_summary_multi.png', dpi=200)
    plt.close(fig)


def main():
    runs = load_runs()
    if not runs:
        print('No runs found in', INPUT_DIR)
        return

    pass_counts, run_counts, run_totals, tool_reads = summarize_runs(runs)
    summary = build_summary(pass_counts, run_counts, run_totals, tool_reads)

    out_path = write_summary(summary)
    print('Wrote summary to', out_path)

    plot_charts(summary)
    print('Charts written to', OUTPUT_DIR)


if __name__ == '__main__':
    main()
