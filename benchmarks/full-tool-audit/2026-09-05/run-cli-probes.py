"""Read-only command-family probes against a disposable, actually indexed TS repository.

Usage: python3 run-cli-probes.py PROJECT_ROOT OUTPUT_DIRECTORY
The fixture is created by the companion fixture script. JSON reports are saved,
never printed in full. Exit status alone is not a semantic correctness assertion.
"""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
CLI = ROOT / 'dist/cli.js'
PROJECT = Path(sys.argv[1]).resolve()
OUT = Path(sys.argv[2]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
ENV.update(SCIP_QUERY_PROJECT_ROOT=str(PROJECT), SCIP_QUERY_CACHE_DIR=str(PROJECT / '.cache'))

def run(name, args):
    started = time.monotonic()
    command = ['node', str(CLI), *args]
    try:
        result = subprocess.run(command, cwd=PROJECT, env=ENV, text=True, capture_output=True, timeout=45)
        (OUT / (name + '.stdout')).write_text(result.stdout)
        (OUT / (name + '.stderr')).write_text(result.stderr)
        return {'name': name, 'args': args, 'exit': result.returncode, 'seconds': round(time.monotonic()-started, 3)}
    except subprocess.TimeoutExpired as error:
        return {'name': name, 'args': args, 'exit': None, 'error': str(error), 'seconds': round(time.monotonic()-started, 3)}

help_text = subprocess.check_output(['node', str(CLI), '--help-all'], cwd=ROOT, text=True)
(OUT / 'help-all.txt').write_text(help_text)
commands = list(dict.fromkeys(re.findall(r'^  ([a-z][a-z-]*)\s', help_text, re.M)))
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    help_results = list(pool.map(lambda name: run('help-' + name, [name, '--help']), commands))

probes = {
    'stats': ['stats'], 'files': ['files', 'src/**'], 'outline': ['outline', 'src/math.ts'],
    'search': ['search', 'choose'], 'entrypoints': ['entrypoints'],
    'evidence': ['evidence', '--at', 'src/main.ts:2', '--edge', 'execution', '--direction', 'outgoing', '--depth', '2', '--max-edges', '20'],
    'evidence-missing': ['evidence', '--at', 'absent.ts:2', '--edge', 'execution', '--direction', 'both', '--depth', '1', '--max-edges', '10'],
    'code': ['code', 'src/main.ts:1-2'], 'code-missing': ['code', 'src/nonexistent/choose.ts'],
    'inspect': ['inspect', '--at', 'src/main.ts:2', '--view', 'behavior'],
    'methods-missing': ['methods', 'MissingClass'], 'refs': ['refs', 'choose'], 'trace': ['trace', 'choose'],
    'deps': ['deps', 'src/main.ts'], 'rdeps': ['rdeps', 'src/math.ts'], 'system': ['system', 'src'],
    'surface': ['surface', 'src'], 'hotspots': ['hotspots'], 'imports': ['imports', 'src/main.ts'],
    'imported-by': ['imported-by', 'choose'], 'members': ['members', 'choose'],
    'fan-in': ['fan-in', 'choose'], 'fan-out': ['fan-out', 'src/main.ts'],
    'coupling': ['coupling', 'src/main.ts', 'src/math.ts'], 'cycles': ['cycles'],
    'architecture': ['architecture'], 'bottlenecks': ['bottlenecks'], 'by-kind': ['by-kind', 'function'],
    'kind-counts': ['kind-counts'], 'dependency-depth': ['dependency-depth'], 'hierarchy': ['hierarchy', 'choose'],
    'entry-map': ['entry-map', 'run'], 'call-graph': ['call-graph', 'run'], 'affected': ['affected', 'choose'],
    'change-surface': ['change-surface', 'src/math.ts'], 'co-change': ['co-change'],
    'incomplete-migration': ['incomplete-migration'], 'context': ['context', 'run'],
    'reference-neighborhood': ['reference-neighborhood', 'choose'], 'value-flow': ['value-flow', 'choose'],
    'dependence-slice': ['dependence-slice', 'src/flow.ts:5', '--variable', 'value'],
    'reference-reachability': ['reference-reachability', 'choose'], 'diff-impact': ['diff-impact'],
    'review': ['review'], 'health': ['health'], 'health-indexed': ['health', '--indexed'],
    'dead': ['dead'], 'unused-imports': ['unused-imports', 'src/main.ts'], 'isolated': ['isolated'],
    'similar': ['similar'], 'similar-files': ['similar-files'], 'similar-chains': ['similar-chains'],
    'extract-candidates': ['extract-candidates'], 'locality-candidates': ['locality-candidates'],
    'cleanup-plan': ['cleanup-plan'], 'recent-duplicates': ['recent-duplicates'], 'doc-drift': ['doc-drift'],
    'unused-params': ['unused-params'], 'drift': ['drift'], 'wrapper-candidates': ['wrapper-candidates'],
    'passthrough-candidates': ['passthrough-candidates'], 'stale-abstractions': ['stale-abstractions'],
    'complexity-hotspots': ['complexity-hotspots'], 'slice-cohesion': ['slice-cohesion', 'calculate'],
    'self-audit': ['self-audit', '--samples', '5'], 'complexity-choose': ['complexity', 'choose'],
    'complexity-outer': ['complexity', 'outer'], 'complexity-nullable': ['complexity', 'nullable'],
    'redundant-reexports': ['redundant-reexports'], 'duplicate-bodies': ['duplicate-bodies'],
    'twin-drift': ['twin-drift'], 'not-implemented': ['not-implemented'],
    'decorative-checkers': ['decorative-checkers'], 'test-quality': ['test-quality'],
    'similar-signatures': ['similar-signatures'], 'doctor': ['doctor'], 'config-validate': ['config-validate'],
}
for name in ['react-component-duplicates', 'react-hook-candidates', 'react-large-component-pressure',
             'vue-component-duplicates', 'vue-composable-candidates', 'vue-large-view-pressure']:
    probes[name] = [name]
results = []
for name, args in probes.items():
    result = run(name, args + ['--json', '--json-output', str(OUT / (name + '.json'))])
    results.append(result)
    print(name, result['exit'], result['seconds'], flush=True)
    (OUT / 'runs.json').write_text(json.dumps({'project': str(PROJECT), 'help': help_results, 'probes': results}, indent=2)+'\n')
