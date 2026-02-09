#!/usr/bin/env python3
import json
import math
import os
import sys
from pathlib import Path
from collections import defaultdict, Counter

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

OUTPUT_DIR = Path('artifacts/reports')

PRICE_USD_PER_M = {
    'claude-3-5-haiku-20241022': {'input': 0.07, 'output': 0.30},
    'claude-sonnet-4-20250514': {'input': 3.00, 'output': 15.00},
    'claude-opus-4-5': {'input': 5.00, 'output': 25.00},
    'moonshotai/kimi-k2.5': {'input': 0.45, 'output': 2.25},
    'minimax/minimax-m2.1': {'input': 0.27, 'output': 0.95},
    'z-ai/glm-4.7': {'input': 0.40, 'output': 1.50},
    'x-ai/grok-code-fast-1': {'input': 0.20, 'output': 1.50},
    'arcee-ai/trinity-large-preview:free': {'input': 0.00, 'output': 0.00},
}

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


def parse_args():
    input_dir = None
    suffix = None
    for arg in sys.argv[1:]:
        if arg.startswith('--input='):
            input_dir = Path(arg.split('=', 1)[1])
        elif arg.startswith('--suffix='):
            suffix = arg.split('=', 1)[1]
    return input_dir, suffix


def latest_runs_dir():
    candidates = sorted(Path('artifacts/reports').glob('architecture_runs_*'))
    return candidates[-1] if candidates else None


def apply_suffix(name, suffix):
    if not suffix:
        return name
    stem, ext = os.path.splitext(name)
    return f'{stem}_{suffix}{ext}'


def load_runs(input_dir):
    runs = []
    if not input_dir.exists():
        return runs
    for path in sorted(input_dir.glob('*.json')):
        with path.open() as f:
            payload = json.load(f)
        runs.append(payload)
    return runs


def extract_run_usage(payload):
    usage = payload.get('metadata', {}).get('tokenUsage')
    if usage and isinstance(usage, dict):
        return {
            'inputTokens': usage.get('inputTokens', 0) or 0,
            'outputTokens': usage.get('outputTokens', 0) or 0,
            'totalTokens': usage.get('totalTokens', 0) or 0,
        }

    input_tokens = 0
    output_tokens = 0
    total_tokens = 0
    for r in payload.get('results', []):
        usage = r.get('tokenUsage') or {}
        input_tokens += usage.get('inputTokens', 0) or 0
        output_tokens += usage.get('outputTokens', 0) or 0
        total_tokens += usage.get('totalTokens', 0) or 0

    if input_tokens or output_tokens or total_tokens:
        return {
            'inputTokens': input_tokens,
            'outputTokens': output_tokens,
            'totalTokens': total_tokens,
        }
    return None


def summarize_runs(runs):
    # data structures
    pass_counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    run_counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))
    run_totals = defaultdict(list)  # model -> list of total passes per run
    run_token_usage = defaultdict(list)

    tool_reads = defaultdict(lambda: defaultdict(lambda: defaultdict(list)))
    rubric_sums = defaultdict(lambda: defaultdict(lambda: defaultdict(float)))
    rubric_counts = defaultdict(lambda: defaultdict(lambda: defaultdict(int)))

    for payload in runs:
        model = payload['metadata']['model']
        results = payload['results']

        # total passes per run (out of 9)
        total_pass = sum(1 for r in results if r.get('pass'))
        run_totals[model].append(total_pass)

        run_token_usage[model].append(extract_run_usage(payload))

        for r in results:
            sandbox = r['sandbox']
            task = r['task']['id']
            passed = 1 if r.get('pass') else 0

            pass_counts[model][sandbox][task] += passed
            run_counts[model][sandbox][task] += 1

            usage = r.get('toolUsage') or {}
            reads = usage.get('readFiles') or []
            tool_reads[model][sandbox][task].append(reads)

            rubric = r.get('rubric') or {}
            if rubric:
                rubric_sums[model][sandbox][task] += rubric.get('total', 0.0) or 0.0
                rubric_counts[model][sandbox][task] += 1

    return pass_counts, run_counts, run_totals, tool_reads, run_token_usage, rubric_sums, rubric_counts


def binom_ci(p, n, z=1.96):
    if n == 0:
        return (0.0, 0.0)
    se = math.sqrt(max(p * (1 - p) / n, 0.0))
    lo = max(0.0, p - z * se)
    hi = min(1.0, p + z * se)
    return (lo, hi)


def build_summary(pass_counts, run_counts, run_totals, tool_reads, run_token_usage,
                  rubric_sums, rubric_counts, models, sandboxes, tasks):
    summary = {
        'models': models,
        'sandboxes': sandboxes,
        'tasks': tasks,
        'pricing_usd_per_m_tokens': PRICE_USD_PER_M,
        'per_model': {},
    }

    def cost_from_usage(model, usage):
        if not usage or model not in PRICE_USD_PER_M:
            return None
        rate = PRICE_USD_PER_M[model]
        input_cost = (usage.get('inputTokens', 0) / 1_000_000) * rate['input']
        output_cost = (usage.get('outputTokens', 0) / 1_000_000) * rate['output']
        return input_cost + output_cost

    for model in models:
        model_entry = {
            'sandbox_task_pass_rate': {},
            'sandbox_passes_mean': {},
            'sandbox_passes_ci': {},
            'overall_passes_mean': 0.0,
            'overall_passes_ci': (0.0, 0.0),
            'runs': run_totals.get(model, []),
            'tool_usage': {},
            'rubric': {},
            'cost': {},
        }

        overall_total = 0
        overall_n = 0

        for sandbox in sandboxes:
            # per task pass rate + rubric
            task_rates = {}
            task_counts = 0
            task_passes = 0
            task_rubric_total = 0.0
            task_rubric_n = 0
            for task in tasks:
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

                rubric_n = rubric_counts[model][sandbox][task]
                rubric_total = rubric_sums[model][sandbox][task]
                task_rubric_total += rubric_total
                task_rubric_n += rubric_n

            model_entry['sandbox_task_pass_rate'][sandbox] = task_rates

            # mean passes per sandbox (out of 3)
            n_runs = run_counts[model][sandbox][tasks[0]]
            passes_mean = task_passes / n_runs if n_runs else 0.0
            model_entry['sandbox_passes_mean'][sandbox] = passes_mean

            # CI on average pass rate across tasks
            total_trials = n_runs * len(tasks)
            p_total = task_passes / total_trials if total_trials else 0.0
            ci = binom_ci(p_total, total_trials)
            model_entry['sandbox_passes_ci'][sandbox] = ci

            overall_total += task_passes
            overall_n += total_trials

            rubric_mean = (task_rubric_total / task_rubric_n) if task_rubric_n else 0.0
            model_entry['rubric'][sandbox] = {
                'mean': rubric_mean,
                'runs': task_rubric_n,
            }

        overall_p = overall_total / overall_n if overall_n else 0.0
        model_entry['overall_passes_mean'] = overall_p * len(sandboxes) * len(tasks)
        model_entry['overall_passes_ci'] = binom_ci(overall_p, overall_n)

        # tool usage summary
        tool_summary = {}
        for sandbox in sandboxes:
            file_hits = Counter()
            total_reads = 0
            total_unique_reads = 0
            total_tasks = 0

            for task in tasks:
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

        # cost summary
        costs = []
        tokens = []
        for usage in run_token_usage.get(model, []):
            tokens.append(usage)
            cost = cost_from_usage(model, usage) if usage else None
            costs.append(cost)

        known_costs = [c for c in costs if c is not None]
        cost_mean = sum(known_costs) / len(known_costs) if known_costs else None
        overall_passes = model_entry['overall_passes_mean']
        cost_per_pass = (cost_mean / overall_passes) if cost_mean is not None and overall_passes else None

        model_entry['cost'] = {
            'per_run': costs,
            'mean_usd': cost_mean,
            'mean_usd_per_pass': cost_per_pass,
            'token_usage': tokens,
        }

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


def write_summary(summary, suffix=None):
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    out_path = OUTPUT_DIR / apply_suffix('architecture_sampling_summary.json', suffix)
    with out_path.open('w') as f:
        json.dump(summary, f, indent=2)
    return out_path


def plot_charts(summary, suffix=None):
    out_dir = OUTPUT_DIR
    models = summary['models']
    sandboxes = summary['sandboxes']
    tasks = summary['tasks']

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
    fig.savefig(out_dir / apply_suffix('architecture_benchmark_matrix_multi.png', suffix), dpi=200)
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
    fig.savefig(out_dir / apply_suffix('architecture_benchmark_model_totals_multi.png', suffix), dpi=200)
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
    fig.savefig(out_dir / apply_suffix('architecture_benchmark_model_stacked_multi.png', suffix), dpi=200)
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
    fig.savefig(out_dir / apply_suffix('architecture_benchmark_sandbox_totals_multi.png', suffix), dpi=200)
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
    fig.savefig(out_dir / apply_suffix('architecture_benchmark_summary_multi.png', suffix), dpi=200)
    plt.close(fig)

    # rubric summary (mean total score by model)
    rubric_scores = []
    for model in models:
        sandbox_scores = []
        for sandbox in sandboxes:
            entry = summary['per_model'][model]['rubric'].get(sandbox, {})
            sandbox_scores.append(entry.get('mean', 0.0))
        rubric_scores.append(sum(sandbox_scores) / len(sandbox_scores) if sandbox_scores else 0.0)

    fig, ax = plt.subplots(figsize=(6.2, 3.4))
    ax.bar(range(len(models)), rubric_scores, color=['#7aa6c2', '#4f7fa3', '#2b5c84'][:len(models)])
    ax.set_xticks(range(len(models)))
    ax.set_xticklabels(models, rotation=20, ha='right')
    ax.set_ylim(0, 1)
    ax.set_ylabel('Mean Rubric Score (0-1)')
    ax.set_title('Architecture Benchmark: Rubric Score by Model')
    for i, v in enumerate(rubric_scores):
        ax.text(i, v + 0.02, f"{v:.2f}", ha='center', va='bottom', fontsize=9)
    fig.tight_layout()
    fig.savefig(out_dir / apply_suffix('architecture_benchmark_rubric_model.png', suffix), dpi=200)
    plt.close(fig)

    # cost curve (Pareto)
    cost_points = []
    for model in models:
        cost_mean = summary['per_model'][model]['cost'].get('mean_usd')
        performance = summary['per_model'][model].get('overall_passes_mean', 0.0)
        if cost_mean is None:
            continue
        cost_points.append((cost_mean, performance, model))

    if cost_points:
        fig, ax = plt.subplots(figsize=(6.2, 3.6))
        xs = [p[0] for p in cost_points]
        ys = [p[1] for p in cost_points]
        ax.scatter(xs, ys, color='#2b5c84')
        for x, y, label in cost_points:
            ax.text(x, y + 0.05, label, ha='center', va='bottom', fontsize=8)
        ax.set_xlabel('Mean Cost per Run (USD)')
        ax.set_ylabel('Mean Passes (out of 9)')
        ax.set_title('Architecture Benchmark: Cost vs Performance')
        ax.set_ylim(0, len(sandboxes) * len(tasks))
        fig.tight_layout()
        fig.savefig(out_dir / apply_suffix('architecture_benchmark_cost_curve.png', suffix), dpi=200)
        plt.close(fig)


def main():
    input_dir_arg, suffix = parse_args()
    input_dir = input_dir_arg or Path(os.environ.get('ARCH_RUN_DIR', ''))
    if not input_dir or str(input_dir) == '.':
        input_dir = latest_runs_dir()

    if not input_dir:
        print('No run directory found', file=sys.stderr)
        return

    runs = load_runs(input_dir)
    if not runs:
        print('No runs found in', input_dir)
        return

    def collect_dimensions(runs):
        first_meta = runs[0].get('metadata', {})
        models = [payload['metadata']['model'] for payload in runs]
        models_unique = list(dict.fromkeys(models))

        sandboxes = first_meta.get('sandboxes')
        if not sandboxes:
            sandboxes = sorted({r['sandbox'] for payload in runs for r in payload.get('results', [])})

        tasks = first_meta.get('tasks')
        if not tasks:
            tasks = sorted({r['task']['id'] for payload in runs for r in payload.get('results', [])})

        return models_unique, sandboxes, tasks

    models, sandboxes, tasks = collect_dimensions(runs)

    pass_counts, run_counts, run_totals, tool_reads, run_token_usage, rubric_sums, rubric_counts = summarize_runs(runs)
    summary = build_summary(
        pass_counts,
        run_counts,
        run_totals,
        tool_reads,
        run_token_usage,
        rubric_sums,
        rubric_counts,
        models,
        sandboxes,
        tasks,
    )

    out_path = write_summary(summary, suffix)
    print('Wrote summary to', out_path)

    plot_charts(summary, suffix)
    print('Charts written to', OUTPUT_DIR)


if __name__ == '__main__':
    main()
