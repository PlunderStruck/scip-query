"""Run repository-mutating CLI contracts only in a disposable project."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sqlite3

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'controls'
OUT.mkdir(exist_ok=True)
ROOT = Path(tempfile.mkdtemp(prefix='scip-control-contract-')).resolve()
(OUT / 'project.txt').write_text(str(ROOT))
SKILLS = ROOT / 'skill-home'
for name in ['.claude', '.codex', '.agents']:
    (SKILLS / name / 'skills').mkdir(parents=True)
foreign = ROOT / 'user-owned-skill'
foreign.mkdir()
foreign_link = SKILLS / '.codex/skills/scip-query'
foreign_link.symlink_to(foreign, target_is_directory=True)
(ROOT / 'node_modules').symlink_to(REPO / 'node_modules', target_is_directory=True)
(ROOT / 'package.json').write_text(json.dumps({'name': 'control-contract', 'version': '1.0.0', 'private': True}))
(ROOT / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'target': 'ES2022', 'module': 'commonjs', 'strict': True, 'skipLibCheck': True}, 'include': ['src/**/*.ts']}))
(ROOT / 'src').mkdir()
(ROOT / 'src/math.ts').write_text('export function sum(a: number, b: number) { return a + b; }\n')
(ROOT / 'src/main.ts').write_text("import { sum } from './math';\nexport function main() { return sum(1, 2); }\n")
(ROOT / 'AGENTS.md').write_text('User-owned instructions.\n')
(ROOT / '.gitignore').write_text('node_modules/\n.cache/\nskill-home/\n')
for args in [['init', '-q'], ['add', '.'], ['-c', 'user.name=Contract', '-c', 'user.email=contract@example.invalid', 'commit', '-qm', 'fixture']]:
    subprocess.run(['git', *args], cwd=ROOT, check=True, capture_output=True)
ENV = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
ENV.update(SCIP_QUERY_PROJECT_ROOT=str(ROOT), SCIP_QUERY_CACHE_DIR=str(ROOT / '.cache'), SCIP_QUERY_SKILLS_HOME=str(SKILLS), SCIP_QUERY_SKIP_WATCH_SERVICE='1', SCIP_QUERY_SKIP_AUTO_INSTALL='1')
results = []


def run(name, args, expected=0, extra_env=None, parse=False):
    p = subprocess.run(['node', str(REPO / 'dist/cli.js'), *args], cwd=ROOT, env={**ENV, **(extra_env or {})}, capture_output=True, text=True, timeout=180)
    (OUT / (name + '.stdout')).write_text(p.stdout)
    (OUT / (name + '.stderr')).write_text(p.stderr)
    row = {'case': name, 'args': args, 'exit': p.returncode, 'expectedExit': expected, 'passed': p.returncode == expected}
    results.append(row)
    if parse:
        try:
            payload = json.loads(p.stdout)
            row['validJson'] = True
        except ValueError:
            payload = None
            row.update(validJson=False, passed=False)
        save()
        return payload
    save()
    return p


def claim(name, condition):
    results.append({'claim': name, 'passed': bool(condition)})
    save()


def save():
    (OUT / 'results.json').write_text(json.dumps(results, indent=2) + '\n')


try:
    run('init', ['init'])
    config = ROOT / '.scipquery.json'
    config_bytes = config.read_bytes()
    run('init-repeat', ['init'])
    claim('init preserves existing configuration bytes', config.read_bytes() == config_bytes)
    run('setup-agent', ['setup-agent'])
    agent_bytes = (ROOT / 'AGENTS.md').read_bytes()
    run('setup-agent-repeat', ['setup-agent'])
    claim('setup-agent preserves user text and is idempotent', (ROOT / 'AGENTS.md').read_bytes() == agent_bytes and b'User-owned instructions.' in agent_bytes)
    run('skills', ['install-skills', '--all'])
    claim('install-skills preserves foreign symlinks', foreign_link.is_symlink() and foreign_link.resolve() == foreign)
    claim('install-skills installs owned links', (SKILLS / '.claude/skills/scip-query').resolve() == REPO / 'skills/scip-query')
    run('uninstall-conflict', ['uninstall', '--global', '--project'], expected=1)
    run('uninstall-global-dry', ['uninstall', '--global', '--dry-run', '--json'], parse=True)
    run('uninstall-project-dry', ['uninstall', '--project', '--dry-run', '--json'], parse=True)
    claim('uninstall dry-run does not remove integration', (ROOT / 'AGENTS.md').read_bytes() == agent_bytes and (SKILLS / '.claude/skills/scip-query').is_symlink())
    run('reindex-invalid-language', ['reindex', '--language', 'typecript'], expected=1)
    run('reindex', ['reindex', '--language', 'typescript', '--force', '--trust-project-tools', '--json'], parse=True)
    run('worker-phase', ['__health-phase', 'overview'], parse=True)
    run('worker-invalid-phase', ['__health-phase', 'bogus'], expected=1)
    run('worker-empty-phase', ['__health-phase', ''], expected=1)
    run('worker-diff-wrong-shape', ['__diff-impact-batch'], extra_env={'SCIP_QUERY_DIFF_IMPACT_FILES': '"src/math.ts"'}, expected=1)
    run('worker-diff', ['__diff-impact-batch'], extra_env={'SCIP_QUERY_DIFF_IMPACT_FILES': '["src/math.ts"]'}, parse=True)
    run('worker-prewarm', ['__health-semantic-prewarm', '--shard-index', '0', '--shard-count', '1'], parse=True)
    run('worker-invalid-shard', ['__health-semantic-prewarm', '--shard-index', '0junk', '--shard-count', '1'], expected=1)
    run('worker-incomplete-shard', ['__health-semantic-prewarm', '--shard-count', '2'], expected=1)
    run('baseline-write', ['health', '--write-baseline', '--json'], parse=True)
    run('baseline-compare', ['health', '--baseline', '--json'], parse=True)
    run('baseline-conflict', ['health', '--baseline', '--write-baseline'], expected=1)
    vue_path = 'src/Quoted\"Café.vue'
    (ROOT / vue_path).write_text('<template>Auxiliary document</template>\n')
    run('augment-sources', ['augment-sources'])
    with sqlite3.connect(ROOT / '.cache/index.db') as connection:
        present = connection.execute('SELECT text FROM documents WHERE relative_path = ?', (vue_path,)).fetchone()
    claim('augment-sources inserts exact auxiliary file bytes', present == ('<template>Auxiliary document</template>\n',))
    vue = run('augment-vue-unavailable', ['augment-vue', '--project', 'tsconfig.json'], expected=1)
    claim('augment-vue states missing provider dependency', 'requires @vue/language-core' in vue.stderr)
    run('suppress-invalid', ['suppress', 'fixture-finding'], expected=1)
    run('suppress', ['suppress', 'fixture-finding', '--reason', 'This forwarding function maintains the public compatibility contract.', '--reason-code', 'compatibility-shim', '--evidence', 'source:src/math.ts', '--json'], parse=True)
    claim('suppress writes a decision record', bool(list((ROOT / '.scipquery/suppressions').glob('*.json'))))
    run('hook', ['hook-architecture-stop'])
    run('setup', ['setup', '--yes', '--no-skills', '--no-parsers', '--json'], parse=True)
    run('watch-start', ['watch', '--daemon', '--json'], extra_env={'SCIP_QUERY_SKIP_WATCH_SERVICE': '0'}, parse=True)
    watching = run('watch-status', ['watch', '--status', '--json'], parse=True)
    claim('watch status observes running daemon', watching is not None and watching['result']['state'] == 'running')
    run('watch-conflict', ['watch', '--status', '--stop'], expected=1)
    run('watch-stop', ['watch', '--stop', '--json'], parse=True)
    stopped = run('watch-stopped-status', ['watch', '--status', '--json'], parse=True)
    claim('watch stop terminates daemon', stopped is not None and stopped['result']['state'] == 'stopped')
    run('uninstall-global', ['uninstall', '--global', '--json'], parse=True)
    run('uninstall-project', ['uninstall', '--project', '--json'], parse=True)
    claim('uninstall preserves user instructions', 'User-owned instructions.' in (ROOT / 'AGENTS.md').read_text())
    claim('uninstall removes managed guidance', 'scip-query:agent-setup:begin' not in (ROOT / 'AGENTS.md').read_text())
    claim('uninstall removes only owned skill links', not (SKILLS / '.claude/skills/scip-query').is_symlink() and foreign_link.is_symlink() and foreign_link.resolve() == foreign)
finally:
    run('cleanup-watch', ['watch', '--stop', '--json'], parse=True)
    save()
print(json.dumps({'project': str(ROOT), 'cases': len(results), 'failures': [r for r in results if not r['passed']]}, indent=2))
raise SystemExit(int(any(not r['passed'] for r in results)))
