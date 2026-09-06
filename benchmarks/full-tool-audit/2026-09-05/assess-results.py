"""Assert desired behavior against captured CLI and library results.

Usage: python3 assess-results.py ARTIFACT_DIRECTORY
Returns 1 while confirmed defects reproduce. This is intentionally outside the
normal test suite; it records failures rather than treating current bugs as expected behavior.
"""
import json
from pathlib import Path
import sys
import tarfile

root = Path(sys.argv[1])
checks = []

def read_artifact(name):
    path = root / name
    if path.exists():
        return path.read_text()
    with tarfile.open(root / 'raw-results.tar.gz', 'r:gz') as archive:
        return archive.extractfile(name).read().decode()

def result(group, name):
    data = json.loads(read_artifact(group + '/' + name + '.json'))
    return data.get('result', data)

def check(name, expected, actual):
    checks.append({'name': name, 'expected': expected, 'actual': actual, 'passed': expected == actual})

library = json.loads(read_artifact('library.json'))
checks.extend(library['checks'])
choose = result('cli', 'complexity-choose')['complexity']
check('F05: call-free choose has zero callees', 0, choose['calleeCount'])
weak_tests = result('cli', 'test-quality')['assertionFree']
check('F08: declaration is not a test invocation', [1], [row['startLine'] for row in weak_tests])
check('F04: mapping-declared missing trace fails', 1, result('lifecycle', 'tla-contract-missing-trace')['exitCode'])
check('TLA explicit missing trace fails', 1, result('lifecycle', 'tla-explicit-missing-trace')['exitCode'])
setup = result('lifecycle', 'setup')
obsolete_smoke = next(row for row in setup['smokeTests'] if row['id'] == 'capability-matrix')
check('F03: nonexistent command is not marked passed', False, obsolete_smoke['status'] == 'pass')
check('F07: suppressions are acknowledged by source health', True,
      'suppressions' in result('suppression', 'flat-after'))
after = result('suppression', 'flat-after')
check('F07: accepted suppression does not remain an undisclosed gate blocker', False,
      any(row['id'] == 'complexity:root-complex.ts:classify' for row in after['findings']))
check('F10: ordinary help shows current-source health', True,
      any(line.startswith('  health ') for line in read_artifact('ordinary-help.txt').splitlines()))
check('F10: ordinary help shows change review', True,
      any(line.startswith('  review ') for line in read_artifact('ordinary-help.txt').splitlines()))

for name, expected in [('coverage-full', 2), ('coverage-half', 2.5), ('coverage-none', 6)]:
    check(name + ': recomputed CRAP', expected, library[name]['crap'])
for name in ['coverage-malformed', 'coverage-stale']:
    check(name + ': unavailable rather than invented score', 'unavailable', library[name]['status'])
check('compiler entry map has one actual call edge', 1, result('cli', 'entry-map')['coverage']['exactSymbolEdgeCount'])
check('actual stub detected', ['throw-stub'], [row['stubKind'] for row in result('cli', 'not-implemented')])
check('always-true checker detected', ['direct'], [row['resolvedVia'] for row in result('cli', 'decorative-checkers')])

(root / 'assertions.json').write_text(json.dumps(checks, indent=2)+'\n')
failures = [row for row in checks if not row['passed']]
print(f'{len(checks)-len(failures)}/{len(checks)} audit assertions pass; {len(failures)} fail.')
for row in failures:
    print(row['name'])
sys.exit(1 if failures else 0)
