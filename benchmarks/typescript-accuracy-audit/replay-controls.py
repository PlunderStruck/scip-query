"""Replay historical control checks with new output directories; preserve old evidence."""
import os
from pathlib import Path
import sys

name = sys.argv[1]
if name not in {'controls', 'transport', 'architecture', 'frontend'}:
    raise SystemExit('Expected controls, transport, architecture or frontend')
repo = Path(__file__).resolve().parents[2]
script = repo / 'benchmarks/command-contracts/2026-09-05' / f'run-{name if name != "controls" else "control"}-cases.py'
source = script.read_text()
old = f"OUT = Path(__file__).resolve().parent / '{name}'"
out = Path(os.environ.get('SCIP_QUERY_BREADTH_OUTPUT', '/tmp/scip-query-breadth-audit')) / name
out.parent.mkdir(parents=True, exist_ok=True)
if old not in source:
    raise SystemExit('Historical runner output declaration changed')
source = source.replace(old, f'OUT = Path({str(out)!r})', 1)
if name == 'frontend' and os.environ.get('SCIP_QUERY_BREADTH_INTEGRITY') == '1':
    marker = '    (OUT / (name + \'.log\')).write_text(p.stdout + p.stderr)'
    extra = '''
    import sqlite3, shutil
    db_path = ROOT / '.cache/index.db'
    try:
        with sqlite3.connect(f'file:{db_path}?mode=ro', uri=True) as connection:
            integrity = connection.execute('pragma integrity_check').fetchall()
    except Exception as error:
        integrity = {'error': str(error)}
        snapshot = OUT / 'corrupt-snapshot'
        snapshot.mkdir(exist_ok=True)
        for candidate in db_path.parent.glob('index.db*'):
            if not (snapshot / candidate.name).exists(): shutil.copy2(candidate, snapshot / candidate.name)
    with (OUT / 'integrity.jsonl').open('a') as log:
        log.write(json.dumps({'after': name, 'integrity': integrity}) + '\\n')
'''
    if marker not in source:
        raise SystemExit('Historical frontend invocation changed')
    source = source.replace(marker, marker + '\n' + extra, 1)
exec(compile(source, str(script), 'exec'), {'__file__': str(script), '__name__': '__main__'})
