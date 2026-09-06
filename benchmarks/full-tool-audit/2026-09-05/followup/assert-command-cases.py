"""Check CLI claims against the hand-written compiler fixture, not CLI-derived expectations.

Run after command-cases.py ROOT PACKETS. This is a bounded TypeScript fixture;
passing it is not an estimate of precision/recall on arbitrary repositories.
"""
import json
from pathlib import Path
import sys

root, packets = map(Path, sys.argv[1:3])
checks = []

def result(command):
    return json.loads((packets / (command + '.json')).read_text())['result']

def check(command, claim, actual, expected):
    checks.append({'command': command, 'claim': claim, 'passed': actual == expected,
                   'actual': actual, 'expected': expected})

runs = json.loads((packets / 'runs.json').read_text())
check('inventory', '82 read commands ran successfully', len([r for r in runs if r['exitCode'] == 0]), 82)
check('inventory', 'all read invocations passed', [r['command'] for r in runs if r['exitCode']], [])
check('code', 'exact current source bytes excluding terminal newline', result('code')['code']['source'],
      (root / 'src/service/runner.ts').read_text().rstrip('\n'))
check('files', 'complete TS file inventory', sorted(r['relativePath'] for r in result('files')),
      sorted(str(p.relative_to(root)) for p in (root / 'src').rglob('*.ts')))
s = result('search')
check('search', 'literal match counts', [s['matchingLines'], s['matchingFiles']], [1, 1])
check('search', 'literal occurrence position', [(m['relativePath'], m['focusLine']) for m in s['identities']], [('src/service/runner.ts', 4)])
check('methods', 'method names and lines exclude field', [(m['name'],m['startLine']) for m in result('methods')['methods']], [('read', 2), ('write', 3)])
check('members', 'field and methods with exact identifier/declaration lines', [(m['symbol'].split('#')[-1],m['startLine']) for m in result('members')['members']], [('value.', 1), ('read().', 2), ('write().', 3)])
h = result('hierarchy')['hierarchy']
check('hierarchy', 'all ancestry identities are full indexed symbols', all(m['symbol'].startswith('scip-typescript npm accuracy-followup 1.0.0 ') for m in h), True)
check('hierarchy', 'indexed owner order', [m['symbol'].split('`store.ts`/')[-1] for m in h], ['Store#read().', 'Store#', ''])
check('system', 'exact directory membership', result('system')['files'], ['src/core/math.ts', 'src/core/store.ts'])
check('system', 'external consumer direction', result('system')['dependedOnBy'], ['src/service/runner.ts'])
check('system', 'no outgoing internal-repository dependency from core', result('system')['dependsOn'], [])
check('surface', 'only observed external consumer', sorted(set(r['consumer'] for r in result('surface'))), ['src/service/runner.ts'])
check('surface', 'unused read method absent; used write method present', [any(r['symbol'].endswith('#'+m+'().') for r in result('surface')) for m in ['read','write']], [False,True])
check('locality-candidates', 'sum symbol not consumer filename substring', [(r['sourceUnit']['kind'],r['sourceUnit']['file']) for r in result('locality-candidates')], [('symbol','src/core/math.ts')])
check('deps', 'outgoing files', sorted(r['relativePath'] for r in result('deps')), ['src/core/math.ts', 'src/core/store.ts'])
check('rdeps', 'incoming files', [r['relativePath'] for r in result('rdeps')], ['src/service/runner.ts'])
check('imports', 'imported bindings', sorted((r['symbol'],r['fromFile']) for r in result('imports')), [('Store','src/core/store.ts'),('sum','src/core/math.ts')])
check('refs', 'import and call references remain distinct', [(r['relativePath'],r['line']) for r in result('refs')['references']], [('src/service/runner.ts',0),('src/service/runner.ts',4)])
check('fan-in', 'one reference file, not two occurrences', [r['count'] for r in result('fan-in')['rows']], [1])
check('cycles', 'one real component, closed witness', [(r['component'],r['path']) for r in result('cycles')['cycles']], [(['src/cycle/a.ts','src/cycle/b.ts'],['src/cycle/a.ts','src/cycle/b.ts','src/cycle/a.ts'])])
a = result('architecture')
check('architecture', 'declared service to core edge', [(e['from'],e['to'],e['policyStatus'],e['fileEdgeCount']) for e in a['edges']], [('service','core','allowed',2)])
check('architecture', 'partial policy file coverage is disclosed', [a['coverage']['totalFiles'],a['coverage']['mappedFiles'],len(a['coverage']['unmappedFiles'])], [13,5,8])
check('entrypoints', 'export named main alone is not an external entrypoint', result('entrypoints'), [])
check('entry-map', 'non-entry callable explicitly refused', result('entry-map')['kind'], 'not-entry')
c = result('call-graph')['callGraph']
check('call-graph', 'three exact direct targets, no unused read', sorted((r['shortName'],r['evidenceStrength']) for r in c['calleeEvidence']), [('src:core:math:sum()','exact'),('src:core:store:Store','exact'),('src:core:store:Store:write()','exact')])
check('affected', 'two downstream levels', [(r['file'],r['depth']) for r in result('affected')['affected']], [('src/service/runner.ts',1),('src/consumer.ts',2)])
check('complexity', 'one conditional and three actual call targets', [result('complexity')['complexity'][k] for k in ['branches','cyclomaticEstimate','calleeCount','candidateCalleeCount']], [1,2,3,0])
d = result('diff-impact')
check('diff-impact', 'modified and untracked symbols', sorted(r['shortName'] for r in d['changedSymbols']), ['src:new:newFunction()','src:service:runner:runJob()'])
check('diff-impact', 'downstream consumer', [r['file'] for r in d['affectedConsumers']], ['src/consumer.ts'])
r = result('review')
check('review', 'changed function status', [(f['after']['name'],f['status']) for f in r['functions']], [('newFunction','added'),('runJob','modified')])
check('review', 'modified complexity deltas', r['functions'][1]['delta'], {'cyclomatic':1,'cognitive':1})
check('review', 'missing measured coverage remains unavailable', [f['after']['coverage']['status'] for f in r['functions']], ['unavailable','unavailable'])
check('review', 'missing coverage does not produce CRAP numbers', any('crap' in f['after'] for f in r['functions']), False)
h = result('health')
check('health', 'cycle detected without an index-dependent graph call', [f.get('rule',f.get('kind')) for f in h['findings']], ['dependency-cycle'])
check('health', 'all TS files/functions analyzed', [h['coverage']['analyzedFiles'],h['coverage']['analyzedFunctions'],h['coverage']['problems']], [13,28,[]])
check('duplicate-bodies', 'exact small body pair', [[f['shortName'] for f in group['functions']] for group in result('duplicate-bodies')], [['src:duplicate:a:formatOne()','src:duplicate:b:formatTwo()']])
check('evidence', 'requested family and direction', [result('evidence')['graph']['families'],result('evidence')['graph']['selection']['direction']], [['execution'],'outgoing'])
check('value-flow', 'data relationships only', sorted(set(e['family'] for e in result('value-flow')['edges'])), ['dataflow'])
check('value-flow', 'return value transfer exists', any(e['subtype']=='return-to-call-result' for e in result('value-flow')['edges']), True)
s = result('dependence-slice')
check('dependence-slice', 'exact occurrence is selected', s['resolution'], 'matched')
check('dependence-slice', 'slice excludes unrelated store state', sorted(set(p['name'] for p in s['points'])), ['sum','total'])
check('config-validate', 'valid architecture config accepted', result('config-validate')['diagnostics'], [])
report = {'scope':'hand-written 13-file TypeScript compiler fixture', 'passed':sum(c['passed'] for c in checks), 'total':len(checks), 'checks':checks}
(packets / 'claims.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='checks'}))
for c in checks:
    if not c['passed']:print(json.dumps(c))
sys.exit(0 if report['passed']==report['total'] else 1)
