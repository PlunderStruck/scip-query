"""Recreate the independently specified compiler fixture and its uncommitted diff."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[3]
spec = json.loads(Path(__file__).with_name('cli-fixture.json').read_text())
root = Path(tempfile.mkdtemp(prefix='scip-command-contract-'))
for relative, text in spec['base'].items():
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
for args in [['init', '-b', 'main'], ['config', 'user.name', 'Command contract fixture'], ['config', 'user.email', 'fixture@example.invalid'], ['add', '.'], ['commit', '-qm', 'Fixture baseline']]:
    subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
for relative, text in spec['workingTree'].items():
    (root / relative).write_text(text)
(root / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
env = {key: value for key, value in os.environ.items() if not key.startswith('SCIP_QUERY_')}
env.update(SCIP_QUERY_PROJECT_ROOT=str(root), SCIP_QUERY_CACHE_DIR=str(root / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1')
result = subprocess.run(['node', str(repo / 'dist/cli.js'), 'reindex', '--language', 'typescript', '--force', '--trust-project-tools'], cwd=root, env=env, capture_output=True, text=True)
(root / 'indexing.log').write_text(result.stdout + result.stderr)
if result.returncode:
    raise SystemExit(f'Fixture indexing failed; inspect {root / "indexing.log"}')
print(root)
