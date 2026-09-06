"""Verify removed controls reject ordinary execution, independently of help output."""
import json
from pathlib import Path
import subprocess

OUT = Path(__file__).resolve().parent
REPO = OUT.parents[2]
rows = json.loads((OUT / 'ledger.json').read_text())
results = []
for row in rows:
    if row['status'] != 'removed': continue
    run = subprocess.run(['node', str(REPO / 'dist/cli.js'), row['command']], cwd=REPO, capture_output=True, text=True, timeout=30)
    results.append({'command': row['command'], 'exitCode': run.returncode, 'stderr': run.stderr, 'passed': run.returncode == 1 and 'unknown command' in run.stderr})
(OUT / 'retired-cli.json').write_text(json.dumps(results, indent=2) + '\n')
print(json.dumps({'removed': len(results), 'passed': sum(row['passed'] for row in results)}))
raise SystemExit(int(any(not row['passed'] for row in results)))
