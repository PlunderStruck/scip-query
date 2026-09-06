"""Real CLI architecture and Stop-hook assertions in an isolated Git checkout."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'architecture'
OUT.mkdir(exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix='scip-architecture-contract-')).resolve()
(ROOT / 'src/ui').mkdir(parents=True)
(ROOT / 'src/core').mkdir()
(ROOT / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
(ROOT / 'package.json').write_text(json.dumps({'name': 'architecture-contract', 'version': '1.0.0', 'private': True}))
(ROOT / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'target': 'ES2022', 'module': 'commonjs', 'skipLibCheck': True}, 'include': ['src/**/*.ts']}))
config = {'architecture': {'boundaries': [{'name': 'ui', 'paths': ['src/ui/**']}, {'name': 'core', 'paths': ['src/core/**']}], 'allowedDependencies': {'ui': [], 'core': []}}}
(ROOT / '.scipquery.json').write_text(json.dumps(config))
(ROOT / '.gitignore').write_text('node_modules/\n.cache/\n')
(ROOT / 'src/core/math.ts').write_text('export function sum(a: number, b: number) { return a + b; }\n')
view = ROOT / 'src/ui/Café".ts'
view.write_text('export const view = 0;\n')
for args in [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']]:
    subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
ENV.update(SCIP_QUERY_PROJECT_ROOT=str(ROOT), SCIP_QUERY_CACHE_DIR=str(ROOT / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1', SCIP_QUERY_SKIP_AUTO_INSTALL='1')
claims = []
def run(name, args):
    p = subprocess.run(['node', str(REPO / 'dist/cli.js'), *args], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=180)
    (OUT / (name + '.stdout')).write_text(p.stdout)
    (OUT / (name + '.stderr')).write_text(p.stderr)
    claims.append({'case': name, 'passed': p.returncode == 0, 'exit': p.returncode})
    return p
try:
    run('index-clean', ['reindex', '--language', 'typescript', '--force', '--trust-project-tools'])
    clean = run('hook-clean', ['hook-architecture-stop'])
    claims.append({'claim': 'clean committed architecture allows stop', 'passed': json.loads(clean.stdout) == {}})
    view.write_text('import { sum } from "../core/math";\nexport const view = sum(1, 2);\n')
    run('index-violation', ['reindex', '--language', 'typescript', '--force', '--trust-project-tools'])
    blocked = run('hook-forbidden-edge', ['hook-architecture-stop'])
    payload = json.loads(blocked.stdout)
    claims.append({'claim': 'quoted Unicode changed path triggers declared forbidden-edge enforcement', 'passed': payload.get('decision') == 'block' and 'forbidden-edge' in payload.get('reason', '')})
    architecture = OUT / 'architecture.json'
    run('architecture', ['architecture', '--json', '--json-output', str(architecture)])
    report = json.loads(architecture.read_text())['result']
    claims.append({'claim': 'architecture reports actual ui to core policy violation', 'passed': any(v.get('from') == 'ui' and v.get('to') == 'core' for v in report.get('forbiddenEdges', []))})
finally:
    (OUT / 'results.json').write_text(json.dumps(claims, indent=2) + '\n')
    (OUT / 'project.txt').write_text(str(ROOT))
print(json.dumps({'cases': len(claims), 'failed': [c for c in claims if not c['passed']]}, indent=2))
raise SystemExit(int(any(not c['passed'] for c in claims)))
