"""Exercise each retained read command on one real, compiler-indexed repository.

Exit/payload results are smoke evidence only. Claim assertions live in the
separate validation pass and the per-command ledger names semantic test cases.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

if len(sys.argv) < 3:
    raise SystemExit('Usage: run-cli-cases.py <compiler-fixture-root> <output-directory> [commands...]')
root = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
cli = Path('dist/cli.js').resolve()
ledger = json.loads(Path('benchmarks/command-contracts/2026-09-05/ledger.json').read_text())
env = {key: value for key, value in os.environ.items() if not key.startswith('SCIP_QUERY_')}
env.update(SCIP_QUERY_PROJECT_ROOT=str(root), SCIP_QUERY_CACHE_DIR=str(root / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1')
special = {
    'search': ['sum(1, 2)'],
    'outline': ['src/service/runner.ts'],
    'entrypoints': ['main'],
    'evidence': ['--at', 'src/service/runner.ts:3', '--edge', 'execution', '--direction', 'outgoing', '--depth', '1', '--max-edges', '20'],
    'inspect': ['--symbol', 'runJob', '--symbol', 'sum', '--view', 'behavior'],
    'code': ['src/service/runner.ts:1-8'],
    'files': ['src/**/*.ts'],
    'methods': ['Store'],
    'refs': ['sum'],
    'deps': ['src/service/runner.ts'],
    'rdeps': ['src/core/math.ts'],
    'system': ['src/core'],
    'surface': ['src/core'],
    'imports': ['src/service/runner.ts'],
    'imported-by': ['sum'],
    'members': ['Store'],
    'fan-in': ['sum'],
    'fan-out': ['src/service/runner.ts'],
    'coupling': ['src/service/runner.ts', 'src/consumer.ts'],
    'by-kind': ['function'],
    'hierarchy': ['Store#read().'],
    'entry-map': ['main'],
    'call-graph': ['runJob'],
    'affected': ['sum'],
    'change-surface': ['src/core/math.ts'],
    'co-change': ['src/service/runner.ts'],
    'dependence-slice': ['src/service/runner.ts:7', '--variable', 'total', '--column', '22'],
    'diff-impact': ['--base', 'HEAD'],
    'unused-imports': ['src/service/runner.ts'],
    'similar': ['runJob'],
    'similar-files': ['src/service/runner.ts'],
    'locality-candidates': ['sum'],
    'slice-cohesion': ['runJob'],
    'complexity': ['runJob'],
    'review': ['--base', 'HEAD'],
    'context': ['runJob'],
}
isolated_contracts = {'__health-semantic-prewarm', 'init', 'suppress', 'watch', 'reindex', 'hook-architecture-stop', 'install-skills', 'augment-sources', 'setup-agent', 'augment-vue', '__diff-impact-batch', 'uninstall', 'continue', '__health-phase', 'setup'}
records = []
selected = set(sys.argv[3:])
eligible = {row['command'] for row in ledger if row['status'] != 'removed'} - isolated_contracts
if selected - eligible:
    raise SystemExit(f'Unknown or separately tested command selection: {sorted(selected - eligible)}')
for row in ledger:
    command = row['command']
    if row['status'] == 'removed' or command in isolated_contracts:
        continue
    if selected and command not in selected:
        continue
    args = [command, *special.get(command, [])]
    packet = out / (command + '.json')
    human = command in {'session', 'check-deps'}
    packet.unlink(missing_ok=True)
    output_args = [] if human else ['--json', '--json-output', str(packet)]
    run = subprocess.run(['node', str(cli), *args, *output_args], cwd=root, env=env, capture_output=True, text=True, timeout=90)
    (out / (command + '.log')).write_text(run.stdout + run.stderr)
    payload = json.loads(packet.read_text()) if packet.exists() else None
    # main is deliberately an ordinary internal callable in this fixture.
    expected_exit = 1 if command == 'entry-map' else 0
    contract_result = command != 'entry-map' or (payload or {}).get('result', {}).get('kind') == 'not-entry'
    passed = run.returncode == expected_exit and (human or payload is not None) and contract_result
    record = {'command': command, 'args': args, 'exitCode': run.returncode, 'expectedExitCode': expected_exit, 'passed': passed, 'hasPacket': payload is not None, 'humanOnly': human}
    records.append(record)
    (out / 'runs.json').write_text(json.dumps(records, indent=2) + '\n')
    print(json.dumps(record), flush=True)

if any(not row['passed'] for row in records):
    raise SystemExit('Unexpected command exit or missing result packet; inspect runs.json.')
