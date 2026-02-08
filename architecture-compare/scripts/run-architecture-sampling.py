#!/usr/bin/env python3
import os
import sys
import time
import subprocess
from pathlib import Path

MODELS = [
    'claude-3-5-haiku-20241022',
    'claude-sonnet-4-20250514',
    'claude-opus-4-5',
]

RUNS = 5

OUT_DIR = Path('artifacts/reports/architecture_runs_2026-02-07')


def main():
    api_key = os.environ.get('ANTHROPIC_API_KEY')
    if not api_key:
        print('ANTHROPIC_API_KEY not set', file=sys.stderr)
        sys.exit(1)

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    for model in MODELS:
        print(f'\n=== Model: {model} ===')
        safe_model = model.replace('/', '-')
        for run_idx in range(1, RUNS + 1):
            output_path = OUT_DIR / f'{safe_model}-run{run_idx}.json'
            if output_path.exists():
                print(f'  Run {run_idx}: exists, skipping')
                continue

            cmd = [
                'node',
                '--experimental-strip-types',
                'scripts/architecture-benchmark.ts',
                '--sandbox=all',
                f'--model={model}',
                f'--output={output_path.as_posix()}',
            ]

            print(f'  Run {run_idx}: starting')
            start = time.time()
            try:
                subprocess.run(cmd, check=True, timeout=600)
                elapsed = time.time() - start
                print(f'  Run {run_idx}: complete in {elapsed:.1f}s')
            except subprocess.TimeoutExpired:
                print(f'  Run {run_idx}: TIMEOUT', file=sys.stderr)
            except subprocess.CalledProcessError as exc:
                print(f'  Run {run_idx}: FAILED (exit {exc.returncode})', file=sys.stderr)


if __name__ == '__main__':
    main()
