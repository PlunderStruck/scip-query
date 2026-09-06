"""Add known owners, calls, cycles, duplication and a diff to the isolated audit fixture."""
import json
import os
from pathlib import Path
import subprocess
import sys

root = Path(sys.argv[1]).resolve()
assert root.name.startswith('scip-followup-audit-')
(root / 'src/new.ts').unlink(missing_ok=True)
files = {
    'src/core/math.ts': 'export function sum(left: number, right: number) { return left + right; }\n',
    'src/core/store.ts': 'export class Store {\n  value = 0;\n  read() { return this.value; }\n  write(value: number) { this.value = value; }\n}\n',
    'src/service/runner.ts': "import { sum } from '../core/math';\nimport { Store } from '../core/store';\nexport function runJob() {\n  const store = new Store();\n  const total = sum(1, 2);\n  store.write(total);\n  return total;\n}\n",
    'src/consumer.ts': "import { runJob } from './service/runner';\nexport function main() { return runJob(); }\n",
    'src/cycle/a.ts': "import { readB } from './b';\nexport function readA(depth: number): number { return depth > 0 ? readB(depth - 1) : 0; }\n",
    'src/cycle/b.ts': "import { readA } from './a';\nexport function readB(depth: number): number { return depth > 0 ? readA(depth - 1) : 0; }\n",
    'src/duplicate/a.ts': 'export function formatOne(value: number) {\n  const rounded = Math.round(value);\n  const label = rounded.toString();\n  return label.padStart(4, "0");\n}\n',
    'src/duplicate/b.ts': 'export function formatTwo(value: number) {\n  const rounded = Math.round(value);\n  const label = rounded.toString();\n  return label.padStart(4, "0");\n}\n',
    'README.md': 'Fixture: `src/service/runner.ts` calls the core modules.\n',
}
for file, source in files.items():
    path = root / file
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source)
config = json.loads((root / '.scipquery.json').read_text())
config['architecture'] = {'boundaries': [{'name': 'core', 'paths': ['src/core/**']}, {'name': 'service', 'paths': ['src/service/**']}, {'name': 'cycle', 'paths': ['src/cycle/**']}], 'allowedDependencies': {'core': [], 'service': ['core'], 'cycle': []}}
(root / '.scipquery.json').write_text(json.dumps(config, indent=2) + '\n')
subprocess.run(['git', 'add', 'src', 'README.md', '.scipquery.json'], cwd=root, check=True)
subprocess.run(['git', '-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'Known command referents'], cwd=root, check=True)
runner = root / 'src/service/runner.ts'
runner.write_text(runner.read_text().replace('return total;', 'return total > 0 ? total : 0;'))
(root / 'src/new.ts').write_text('export function newFunction(value: number) { return value > 0 ? value : 0; }\n')
env = {key: value for key, value in os.environ.items() if not key.startswith('SCIP_QUERY_')}
env.update(SCIP_QUERY_PROJECT_ROOT=str(root), SCIP_QUERY_CACHE_DIR=str(root / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1')
subprocess.run(['node', str(Path('dist/cli.js').resolve()), 'reindex', '--allow-expensive-rebuild'], cwd=root, env=env, check=True)
