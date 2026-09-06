"""Exercise local integration lifecycle and negative inputs on the disposable fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time

repo = Path(__file__).resolve().parents[3]
project = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)
env = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
env.update(SCIP_QUERY_PROJECT_ROOT=str(project), SCIP_QUERY_CACHE_DIR=str(project / '.cache'))
runs = []

def run(name, args, timeout=45):
    start = time.monotonic()
    result = subprocess.run(['node', str(repo / 'dist/cli.js'), *args], cwd=project, env=env, text=True, capture_output=True, timeout=timeout)
    (out / (name + '.stdout')).write_text(result.stdout)
    (out / (name + '.stderr')).write_text(result.stderr)
    row = {'name': name, 'args': args, 'exit': result.returncode, 'seconds': round(time.monotonic()-start, 3)}
    runs.append(row)
    (out / 'runs.json').write_text(json.dumps(runs, indent=2)+'\n')
    print(name, result.returncode, flush=True)
    return result

def machine(name, args, timeout=45):
    return run(name, args+['--json','--json-output', str(out/(name+'.json'))], timeout)

config = {'schemaVersion': 2, 'watch': {'enabled': False, 'autoStart': False}}
(project / '.scipquery.json').write_text(json.dumps(config))
(project / 'AGENTS.md').write_text('User-authored instruction: preserve this sentence.\n')
machine('setup', ['setup', '--yes', '--no-skills', '--no-parsers', '--health'], 90)
machine('uninstall-dry', ['uninstall', '--project', '--dry-run'])
machine('uninstall', ['uninstall', '--project'])
assert (project / 'AGENTS.md').read_text().strip() == 'User-authored instruction: preserve this sentence.'
machine('watch-disabled', ['watch', '--daemon'])
machine('invalid-suppression', ['suppress', 'audit-finding'])
(project / '.scipquery.json').write_text('{ broken json')
machine('invalid-config', ['config-validate'])
(project / '.scipquery.json').write_text(json.dumps(config))
machine('missing-scope', ['health', '--scope', 'does-not-exist', '--check'])
(project / 'bad-coverage.json').write_text('{"schemaVersion":1,"files":{}}')
machine('missing-coverage', ['health', '--coverage', 'bad-coverage.json', '--check'])
machine('file-cap', ['health', '--max-files', '1', '--check'])
machine('invalid-base', ['review', '--base', 'does-not-exist', '--check'])
(project / 'Empty.tla').write_text('---- MODULE Empty ----\nInit == TRUE\nNext == TRUE\n====\n')
(project / 'Empty.scip-tla.json').write_text(json.dumps({'module':'Empty.tla','variables':{},'actions':{},'traces':['missing-trace.json']}))
machine('tla-contract-missing-trace', ['tla', 'verify', 'Empty.tla', '--checker', 'none', '--allow-unknown'])
machine('tla-explicit-missing-trace', ['tla', 'verify', 'Empty.tla', '--checker', 'none', '--allow-unknown', '--trace', 'missing-trace.json'])
machine('tla-missing-spec', ['tla', 'verify', 'missing.tla', '--checker', 'none'])
machine('tla-no-checker', ['tla', 'verify', 'Empty.tla', '--checker', 'none'])
# Explicitly start and stop only the watcher owned by this disposable fixture.
config['watch'] = {'enabled': True, 'autoStart': False, 'autoRefresh': True, 'allowExpensiveRebuild': True, 'debounceMs': 100, 'cooldownMs': 100, 'idleTimeoutMs': 60000}
(project / '.scipquery.json').write_text(json.dumps(config))
try:
    machine('watch-start', ['watch', '--daemon'])
    machine('watch-status', ['watch', '--status'])
    with (project / 'src/main.ts').open('a') as target:
        target.write('\nexport function freshAuditSymbol() { return 42; }\n')
    time.sleep(3)
    machine('status-after-edit', ['status'])
    machine('read-after-edit', ['code', 'src/main.ts'])
finally:
    machine('watch-stop', ['watch', '--stop'])
