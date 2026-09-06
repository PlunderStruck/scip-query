"""Capture complete CLI packets; interpret only independently checked claims."""
import json
import os
import pathlib
import subprocess
import sys

root = pathlib.Path(sys.argv[1]).resolve()
out = pathlib.Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
cli = pathlib.Path('dist/cli.js').resolve()
env = {key: value for key, value in os.environ.items() if not key.startswith('SCIP_QUERY_')}
env.update(SCIP_QUERY_PROJECT_ROOT=str(root), SCIP_QUERY_CACHE_DIR=str(root / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1')
cases = []
for name in ['returnedReference', 'arrayReference', 'actualCall', 'nestedOwner', 'nestedMetric', 'nullish', 'sameLineBranches', 'sharedName']:
    cases.append(('complexity-' + name, ['complexity', name]))
for name in ['returnedReference', 'actualCall', 'nestedOwner']:
    cases.append(('calls-' + name, ['call-graph', name]))
cases += [
    ('code-missing', ['code', './src/never.ts']),
    ('code-ambiguous', ['code', 'sharedName']),
    ('code-range', ['code', 'src/calls.ts:2-2']),
    ('slice-aggregate', ['dependence-slice', 'src/flow.ts:4', '--variable', 'state.value']),
    ('slice-array', ['dependence-slice', 'src/flow.ts:9', '--variable', 'state.value']),
    ('slice-delete', ['dependence-slice', 'src/flow.ts:14', '--variable', 'state.value']),
    ('slice-logical', ['dependence-slice', 'src/flow.ts:19', '--variable', 'value']),
    ('slice-call', ['dependence-slice', 'src/flow.ts:24', '--variable', 'state.value']),
    ('refs-helper', ['refs', 'helper']),
    ('files', ['files', 'src/*.ts']),
    ('outline', ['outline', 'src/calls.ts']),
    ('health', ['health']),
    ('review-unchanged', ['review', '--base', 'HEAD', '--check']),
    ('architecture', ['architecture']),
    ('cycles', ['cycles']),
    ('value-flow', ['value-flow', 'helper']),
    ('methods-missing', ['methods', 'NonexistentClass']),
]
records = []
for name, args in cases:
    path = out / (name + '.json')
    run = subprocess.run(['node', str(cli), *args, '--json', '--json-output', str(path)], cwd=root, env=env, capture_output=True, text=True, timeout=60)
    (out / (name + '.log')).write_text(run.stdout + run.stderr)
    payload = json.loads(path.read_text()) if path.exists() else None
    result = payload.get('result', payload) if isinstance(payload, dict) else payload
    records.append({'name': name, 'args': args, 'exitCode': run.returncode, 'result': result})
(out / 'packets.json').write_text(json.dumps(records, indent=2) + '\n')
for record in records:
    result = record['result']
    if isinstance(result, dict):
        if 'complexity' in result: result = result['complexity']
        elif 'coverage' in result and 'points' in result:
            result = {'resolution': result.get('resolution'), 'coverage': result['coverage'], 'points': [(p.get('name'), p.get('line')) for p in result['points']]}
        elif 'callees' in result: result = {key: result.get(key) for key in ['symbol', 'callees', 'coverage']}
        else: result = {'keys': list(result)}
    print(record['name'], record['exitCode'], json.dumps(result)[:2200])
