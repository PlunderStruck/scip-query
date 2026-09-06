"""Run Volar-backed augmentation against the real TypeScript control index.

Pass an isolated dependency directory containing @vue/language-core 3.3.11,
@volar/typescript 2.4.28 and typescript 5.9.3. No dependencies are installed
or changed in the audited repository.
"""
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import shutil
import sys

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'vue'
OUT.mkdir(exist_ok=True)
ROOT = Path((OUT.parent / 'controls/project.txt').read_text())
DEPENDENCIES = Path(sys.argv[1]).resolve()
ENV = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
ENV.update(SCIP_QUERY_PROJECT_ROOT=str(ROOT), SCIP_QUERY_CACHE_DIR=str(ROOT / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1')
link = ROOT / 'node_modules'
assert link.is_symlink()
prior = os.readlink(link)
link.unlink()
link.mkdir()
for package in (REPO / 'node_modules').iterdir():
    if package.name in ['@vue', '@volar', 'typescript']: continue
    (link / package.name).symlink_to(package, target_is_directory=package.is_dir())
(link / '@vue').mkdir()
for package in (REPO / 'node_modules/@vue').iterdir():
    if package.name != 'language-core':
        (link / '@vue' / package.name).symlink_to(package, target_is_directory=True)
(link / '@vue/language-core').symlink_to(DEPENDENCIES / 'node_modules/@vue/language-core', target_is_directory=True)
for package in ['@volar', 'typescript']:
    (link / package).symlink_to(DEPENDENCIES / 'node_modules' / package, target_is_directory=True)
claims = []


def invoke(name):
    p = subprocess.run(['node', str(REPO / 'dist/cli.js'), 'augment-vue', '--project', 'tsconfig.json'], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=120)
    (OUT / (name + '.stdout')).write_text(p.stdout)
    (OUT / (name + '.stderr')).write_text(p.stderr)
    claims.append({'case': name, 'passed': p.returncode == 0, 'exit': p.returncode})
    return p.stdout


def sum_references():
    with sqlite3.connect(ROOT / '.cache/index.db') as db:
        return db.execute("SELECT c.start_line, c.end_line FROM mentions m JOIN global_symbols g ON g.id=m.symbol_id JOIN chunks c ON c.id=m.chunk_id JOIN documents d ON d.id=c.document_id WHERE d.relative_path = 'src/Demo.vue' AND g.symbol LIKE '%/sum().' AND m.role != 1 ORDER BY c.start_line").fetchall()


try:
    config = json.loads((ROOT / 'tsconfig.json').read_text())
    config['include'] = ['src/**/*.ts', 'src/**/*.vue']
    (ROOT / 'tsconfig.json').write_text(json.dumps(config))
    demo = ROOT / 'src/Demo.vue'
    demo.write_text('<script setup lang="ts">\nimport { sum } from "./math";\nconst total = sum(1, 2);\n</script>\n<template>{{ total }}</template>\n')
    reindex = subprocess.run(['node', str(REPO / 'dist/cli.js'), 'reindex', '--language', 'typescript', '--force', '--trust-project-tools'], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=120)
    (OUT / 'reindex.log').write_text(reindex.stdout + reindex.stderr)
    claims.append({'case': 'index-with-vue-provider', 'passed': reindex.returncode == 0, 'exit': reindex.returncode})
    invoke('import-and-call')
    references = sum_references()
    claims.append({'claim': 'Vue import and invocation both bind to actual indexed sum', 'passed': references == [(1, 1), (2, 2)], 'rows': references})
    cached = invoke('unchanged')
    claims.append({'claim': 'repeated augmentation preserves reference identities without duplicates', 'passed': sum_references() == references})
    demo.write_text('<script setup lang="ts">\nconst sum = (a: number, b: number) => a - b;\nconst total = sum(1, 2);\n</script>\n<template>{{ total }}</template>\n')
    invoke('local-shadow')
    claims.append({'claim': 'local same-name function cannot retain foreign references', 'passed': sum_references() == []})
finally:
    shutil.rmtree(link)
    link.symlink_to(prior, target_is_directory=True)
    (OUT / 'results.json').write_text(json.dumps(claims, indent=2) + '\n')
print(json.dumps({'cases': len(claims), 'failed': [c for c in claims if not c['passed']]}, indent=2))
raise SystemExit(int(any(not c['passed'] for c in claims)))
