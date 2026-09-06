"""Exercise immutable CLI continuations and explicit session receipts."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'transport'
OUT.mkdir(exist_ok=True)
ROOT = Path((OUT.parent / 'controls/project.txt').read_text())
ENV = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
ENV.update(SCIP_QUERY_PROJECT_ROOT=str(ROOT), SCIP_QUERY_CACHE_DIR=str(ROOT / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1', SCIP_QUERY_SESSION='command-contract-transport')
CLI = ['node', str(REPO / 'dist/cli.js')]
claims = []

def invoke(name, argv):
    p = subprocess.run(argv, cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=60)
    (OUT / (name + '.stdout')).write_text(p.stdout)
    (OUT / (name + '.stderr')).write_text(p.stderr)
    claims.append({'case': name, 'passed': p.returncode == 0, 'exit': p.returncode})
    return p.stdout

def claim(name, value):
    claims.append({'claim': name, 'passed': bool(value)})

large = ROOT / 'large.txt'
large.write_text(''.join(f'ORIGINAL_TOKEN_{i:04d} immutable source content value\n' for i in range(3000)))
first = invoke('cursor-first', CLI + ['code', 'large.txt:1-3000', '--output-page-size', '4000'])
large.write_text('REPLACED_AFTER_FIRST_PAGE\n')
page = first
pages = [page]
page_number = 1
while True:
    match = re.search(r'Continue exactly:\s*([^\n]+)', page)
    if not match:
        break
    argv = shlex.split(match.group(1).strip())
    page = invoke(f'cursor-{page_number}', argv)
    pages.append(page)
    page_number += 1
    if page_number > 100:
        raise RuntimeError('Unexpected cursor cycle')
claim('oversized source emits a continuation', len(pages) > 1)
claim('continuation drains immutable original output', 'ORIGINAL_TOKEN_2999' in ''.join(pages) and 'REPLACED_AFTER_FIRST_PAGE' not in ''.join(pages))
claim('last page has no remaining cursor', 'Continue exactly:' not in pages[-1])
invoke('session-reset', CLI + ['session', '--reset'])
source = invoke('source-first', CLI + ['code', 'src/math.ts:1-1'])
repeated = invoke('source-second', CLI + ['code', 'src/math.ts:1-1'])
summary = invoke('session', CLI + ['session'])
claim('session reports delivered source', '1 unique source line(s)' in summary)
claim('first source invocation emits actual function', 'return a + b' in source)
claim('repeated source emits a receipt', 'return a + b' not in repeated and 'source previously emitted:' in repeated.lower())
invoke('session-reset-again', CLI + ['session', '--reset'])
reemit = invoke('source-after-reset', CLI + ['code', 'src/math.ts:1-1'])
claim('session reset restores source emission', 'return a + b' in reemit)
(OUT / 'results.json').write_text(json.dumps(claims, indent=2) + '\n')
print(json.dumps({'cases': len(claims), 'failed': [x for x in claims if not x['passed']]}, indent=2))
raise SystemExit(int(any(not x['passed'] for x in claims)))
