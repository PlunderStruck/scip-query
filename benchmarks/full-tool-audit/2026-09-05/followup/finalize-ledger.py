"""Publish command decisions with actual CLI and executed-test evidence.

Test files are linked evidence, not proof of universal correctness. The semantic
fixture assertions and the limits column must be read alongside the pass counts.
"""
import json
from pathlib import Path
import sys

base = Path(__file__).resolve().parent
suite = json.loads(Path(sys.argv[1]).read_text())
repo = Path.cwd()
tests = {str(Path(r['name']).relative_to(repo)): r for r in suite['testResults']}
ledger = json.loads((base / 'command-ledger.json').read_text())
runs = {r['command']:r for r in json.loads((base / 'final/runs.json').read_text())}
claims = json.loads((base / 'final/claims.json').read_text())['checks']
# Command-specific purpose/limit and focused regression-file selectors.
rows = '''
search|Exact literal positions and symbol identity, with current-text/freshness coverage.|search-cli-contract;source-search;lossless-source-sensor
outline|Indexed nesting in one file; omitted/unindexed definitions depend on index coverage.|navigation/outline;command-accuracy
entrypoints|Detected external roots and entry-surface candidates; exported names alone do not establish ingress.|entry-map;framework-entrypoints;exploration-topology
 evidence|Explicit typed graph projections; exact/candidate strengths and folds constrain every claim.|graph-provider-calibration;program-data-edges;evidence-command;causal-corridor
inspect|Batch source needed to explain behavior; source freshness and bounded units remain explicit.|source-evidence;causal-corridor;lossless-source-sensor
code|Exact source bytes and selectors; aligned compiler bindings are a separate fact.|code-cli-contract;exact-file-intent;lossless-source-sensor
files|Current project file inventory, respecting declared exclusions; not just the index.|exact-file-intent;command-accuracy
session|Inspect session receipts; requires an explicit session for suppression of repeated evidence.|source-emission-session
methods|Exactly resolved class methods; ambiguous and missing targets fail explicitly.|methods-cli-contract
refs|Reference occurrences, not executable calls; output pages and index coverage matter.|refs-pagination;queries-advanced;command-accuracy
trace|Definition plus references; callsite argument claims require their own complete support.|queries.test;claim-support;invocation-coverage
 deps|Outgoing static file dependencies including resolved imports; not runtime scheduling.|file-dep-graph;import-fallbacks;graph-provider-calibration
rdeps|Reverse static file dependencies; absence limited to indexed/resolved coverage.|file-dep-graph;exact-file-intent
system|Directory membership and one-hop dependencies; fixed exact directory resolution.|file-resolution;exact-file-intent;queries.test
surface|Symbols externally referenced through a file/module selection; no ownership verdict.|file-resolution;queries.test;queries-advanced
hotspots|Cross-file reference counts; does not measure runtime traffic or contention.|command-accuracy;queries.test
imports|Imported bindings resolved to files; source fallbacks disclose their basis.|import-fallbacks;queries.test
imported-by|Files importing the selected symbol; not every dynamic loader.|import-fallbacks;queries.test
members|Direct children, including occurrence-only indexed fields; declaration or identifier ranges.|command-identity-regressions;queries-advanced
fan-in|Number of reference files for exact symbol identities, not call frequency.|command-accuracy;queries.test
fan-out|External symbol count for files; module/type references are included.|command-accuracy;queries.test
coupling|Shared-symbol counts; candidates for coordination review, not conceptual similarity.|queries.test;queries-advanced
cycles|Every cyclic static file component with a witness; not every simple cycle or a runtime failure.|graph/cycles;graph-provider-calibration
architecture|Validate explicit project boundaries, allowances and limits; coverage exposes unmapped files.|graph/architecture;architecture-cli-contract
bottlenecks|Incoming evidence files times outgoing targets; ranking for inspection only.|graph-risk-output;command-accuracy
by-kind|Compiler-indexed symbol kinds; source-only symbols depend on provider coverage.|queries.test;queries-advanced
kind-counts|Counts of compiler symbol kinds; not a count of domain concepts.|queries.test;command-accuracy
dependency-depth|Longest paths after condensing cyclic file groups; not execution depth.|graph-risk-output;graph-provider-calibration
hierarchy|Actual indexed lexical ancestors; descriptor-only invented identities removed.|navigation/hierarchy
entry-map|Static call graph from a detected ingress; rejects ordinary non-entry callables.|graph/entry-map
call-graph|Static may-call evidence with candidate neighbors separate; nested owner and warm cache repaired.|function-complexity-contract;scip-occurrence-callees;member-call-targets
affected|Conservative reverse caller/reference closure; an affected consumer may need no edit.|graph-provider-calibration;graph-risk-output;command-accuracy
change-surface|Consumers, published API and operational roots before a change; explained risk signals.|change-surface-risk
co-change|Git co-change without a dependency edge; historical association is not causation.|co-change-tiers;co-change-accuracy
incomplete-migration|New helpers plus similar unwired sites; migration candidates need source confirmation.|incomplete-migration
reference-neighborhood|Definition/reference sites plus incoming/outgoing calls; deliberately no dataflow claims.|command-accuracy;graph-provider-calibration
value-flow|Proved argument/parameter and bounded value transfers; no general heap/effect proof.|program-data-edges;graph-provider-calibration
 dependence-slice|One occurrence through local value/control dependencies; alias/delete gaps now incomplete. No general interprocedural slice.|graph/dependence-slice
reference-reachability|Legacy caller/reference-owner reachability; retained for graph consumers, not a program slice.|command-accuracy;graph-provider-calibration
diff-impact|Changed symbols and downstream consumers from a Git base; coverage includes attribution gaps.|diff-impact-accuracy;context-consumer-reuse;newly-unreferenced-residue
dead|Repository-dead and file-local evidence with implicit-use counterevidence; no automatic deletion.|dead-output;dead-vue-script-setup
unused-imports|Unused local imported bindings; provider coverage limits absence claims.|drift-accuracy;import-fallbacks;queries.test
isolated|Zero discovered references; unindexed/dynamic consumers may still exist.|isolated-query
similar|Function callee-fingerprint candidates; shared calls do not prove equivalent behavior.|similarity-fingerprint-product;similar-accuracy
similar-files|Dependency-profile similarity; not duplicate source or equivalent modules.|similarity-fingerprint-product;similar-accuracy
react-component-duplicates|Heuristic JSX structure candidates; confirm behavior, state and binding differences.|react-frontend-rich-internals;react-profile-policy
react-hook-candidates|Shared React state/effect/request structure; extraction requires lifetime review.|react-frontend-rich-internals;react-profile-policy
react-large-component-pressure|Size, JSX and hooks pressure; not proof of too many responsibilities.|react-frontend-rich-internals
vue-component-duplicates|Heuristic template structure candidates; confirm scripts, directives and bindings.|vue-template-rich-internals
vue-composable-candidates|Shared Vue state/effect/request patterns; no automatic composable extraction.|vue-template-rich-internals
vue-large-view-pressure|Template/script/style size pressure, including external scripts; not a quality grade.|vue-large-view-pressure-delegation;vue-template-rich-internals
similar-chains|Dependency-flow fingerprint candidates; paths are not identical algorithms.|similarity-fingerprint-product;similar-chains
extract-candidates|Contiguous callee-isolated regions; not a proven safe extraction or local slice.|extract-candidates-output;extract-candidates-single-statement
locality-candidates|Consumer directory ancestry suggests placement; fixed symbol/file confusion. Business ownership needs review.|locality-candidates;command-identity-regressions
cleanup-plan|Orders dead-code candidates and possible cascades; each deletion still needs usage verification.|cleanup-plan;coverage-contracts
recent-duplicates|Recent-to-established duplication candidates; age and similarity do not justify substitution.|recent-duplicates-pruning;frontend-recent-duplicates
doc-drift|Code continued changing after related docs; candidate, not proof of false documentation.|doc-drift
unused-params|TS/JS trailing parameters unused in bodies; interface/callback contracts can require them.|unused-params
 drift|Unused import and explicit boundary violations; does not infer architectural intent.|drift-accuracy;graph/architecture
wrapper-candidates|Retain as optional exploration only: single-consumer wrappers can be intentional and useful.|wrapper-candidates
passthrough-candidates|Forwarding wrappers with signature checks; layering can justify keeping them.|passthrough-candidates-output
stale-abstractions|Retain as optional exploration only: few consumers do not establish a bad abstraction.|stale-abstractions-accuracy
complexity-hotspots|LOC times fan-in/out ranking; distinct from cyclomatic/cognitive measurement.|quality/complexity-hotspots
slice-cohesion|Disconnected local output computations; only covered local flow can support the candidate.|slice-cohesion;graph/dependence-slice
self-audit|Agreement between cheap and richer providers; they can share bugs. Diagnostic, not ground-truth accuracy.|graph-provider-calibration;source-backed-accuracy
complexity|Documented function-local branch/cyclomatic counts and exact/candidate callees; nested scopes repaired.|function-complexity-contract;quality/complexity.test;source/function-metrics
redundant-reexports|Unused barrel routing candidates; public/external API consumers require review.|redundant-reexports-fallback
 duplicate-bodies|Exact small-body token candidates; identical text can still reference different bindings.|duplicate-bodies
 twin-drift|Same/near-name divergent bodies; similarity of names does not establish common responsibility.|twin-drift
not-implemented|Reachable stub patterns; deliberate defaults/abstract hooks need confirmation.|not-implemented
 decorative-checkers|Checker-shaped functions lacking known failure exits; naming and external effects limit inference.|decorative-checkers
 test-quality|Assertion-free, skipped and mock-echo candidates; custom helpers can encode valid assertions.|test-quality
similar-signatures|Near-identical type shapes; many distinct operations legitimately share a signature.|similar-signatures
review|Current TS/JS diff metrics/findings, including untracked functions; CRAP requires source-matched measured coverage.|source-review;source-modules;function-metrics;maintenance-snapshot
reindex|Publish compiler index generations and SQLite; incremental refusal and explicit full fallback are intentional.|reindex-reliability;reindex-json;typescript-incremental-index;shared-worktree-cache.integration
augment-sources|Add missing source documents; does not manufacture compiler symbols.|augment-sources;post-index-augmentation
augment-vue|Add compiler-resolved Vue references through isolated workers; requires the Vue tooling/provider.|augment-vue-reference-task;augment-vue-workers
stats|Index statistics; they describe the indexed generation, not all current source.|queries.test;command-accuracy
context|Aggregate known symbol/file/module evidence with reusable consumer reads; no inferred task relevance.|context-consumer-reuse;context-decision-packet
health|First-use TS/JS source scan for measured complexity, token duplicates and imports; no general conceptual ownership verdict.|source-review;source-modules;maintenance-project;seeded-defect-recall
install-skills|Install owned guidance files; verify through temporary roots, never user-global audit mutation.|agent-setup;setup.test;project-setup
check-deps|Report executable/provider readiness; not semantic accuracy.|project-tool-execution;setup.test;project-setup
capabilities|Report provider support and coverage; available does not mean complete analysis.|health-capability-disclosure;graph-provider-calibration;project-setup
init|Write project configuration; existing configuration must be preserved.|project-setup;runtime-config
config-validate|Validate configuration, architecture and suppression structure; no proof of written justification.|project-config;runtime-config;suppression-store
suppress|Record reviewed exceptions with reason and target-content hashes; all target files required for automatic acceptance.|suppression-store;suppression-adjudication;source-review
 doctor|Diagnose configuration, tools and freshness; readiness diagnostics, not correctness certification.|project-setup;setup.test;health-capability-disclosure
setup|Compose install/guidance/index readiness; temporary-root regression coverage, not a global install trial.|setup.test;setup-wizard;project-setup
setup-agent|Write marked project guidance without replacing unrelated text.|agent-setup;project-setup
uninstall|Remove selected tool-owned guidance/installations; preserve unrelated user content.|agent-setup;setup.test;project-setup
watch|Foreground/background refresh lifecycle and cancellation; OS/process behavior remains environment-dependent.|watch.test;watch-service.test;watch-refresh-coordinator;worktree-watch-service.integration
status|Index generation/freshness status; not a repository quality summary.|project-setup;watch-service.test
 tla|Removed: model generation, TLA verification and trace conformance are outside exploration and change-quality scope.|cli-contract;command-panels;render-command-reference
continue|Immutable output cursor transport; expire/missing/page behavior covered independently.|output-pagination;result-pagination
hook-architecture-stop|Internal hook checks explicit architecture after source changes; no extra analytic capability.|architecture-stop-hook;architecture-hook-setup
__diff-impact-batch|Internal isolated impact worker protocol; not a user-facing analysis choice.|isolated-analysis-runner;precomputed-command;diff-impact-accuracy
__health-phase|Internal isolated health worker protocol; not a user-facing analysis choice.|isolated-analysis-runner;precomputed-command;health-full
__health-semantic-prewarm|Internal semantic cache prewarm protocol; not a separate detector.|isolated-analysis-runner;precomputed-command;health-report
'''
entries = {}
for line in rows.strip().splitlines():
    command,purpose,patterns = line.strip().split('|')
    entries[command] = (purpose, patterns.split(';'))
assert set(entries)=={r['command'] for r in ledger}, (set(entries)-{r['command'] for r in ledger},{r['command'] for r in ledger}-set(entries))
for row in ledger:
    command=row['command']; purpose,patterns=entries[command]
    evidence=[]
    for file,result in tests.items():
        if any(pattern in file for pattern in patterns):
            assertions=result.get('assertionResults',[])
            evidence.append({'file':file,'status':result['status'], 'passed':sum(a['status']=='passed' for a in assertions), 'failed':sum(a['status']=='failed' for a in assertions), 'skipped':sum(a['status']=='pending' for a in assertions)})
    assert evidence, (command,patterns)
    row['decision'] = 'remove' if command=='tla' else 'retain-internal' if command.startswith('__') or command=='hook-architecture-stop' else 'retain'
    row['purposeAndLimits']=purpose
    row['regressionEvidence']=evidence
    row['cliRun']=runs.get(command)
    row['semanticFixtureChecks']=[c for c in claims if c['command']==command]
    row['accuracy']='retired' if command=='tla' else 'fixture-claims-and-regressions' if row['semanticFixtureChecks'] else 'regression-covered; general accuracy unmeasured'
    row['evidence']=['final/claims.json','final/test-summary.json'] + (['final/'+command+'.json'] if command in runs and not runs[command]['humanOnly'] else ['final/'+command+'.log'] if command in runs else [])
(base / 'command-ledger.json').write_text(json.dumps(ledger,indent=2)+'\n')
summary={k:suite[k] for k in ['numTotalTests','numPassedTests','numFailedTests','numPendingTests','success']}
summary['testFiles']=len(tests)
summary['files']=[{'file':file,'status':r['status'], 'tests':[{'name':a['fullName'],'status':a['status']} for a in r.get('assertionResults',[])]} for file,r in tests.items()]
(base / 'final/test-summary.json').write_text(json.dumps(summary,indent=2)+'\n')
md=['# Command decisions — 2026-09-05','', 'The original 98-command inventory becomes 97 after removing TLA. Each row records the retained purpose and its limits. Test passes establish the listed cases, not a global accuracy percentage. Exact CLI assertions use a hand-written 13-file TypeScript fixture. Framework and lifecycle positive cases use isolated regression fixtures; an empty scanner response is not recall evidence.','', '| Command | Decision | Evidence in this sweep | Purpose and limits |','| --- | --- | --- | --- |']
for r in ledger:
    checked=len(r['semanticFixtureChecks']); files=len(r['regressionEvidence'])
    ev=f'{checked} fixture claims; {files} regression files' if checked else f'{files} regression files'
    if r['cliRun']:ev+='; CLI passed' if r['cliRun']['exitCode']==0 else '; CLI FAILED'
    md.append(f"| `{r['command']}` | {r['decision']} | {ev} | {r['purposeAndLimits']} |")
(base / 'COMMAND_DECISIONS.md').write_text('\n'.join(md)+'\n')
print(json.dumps({'commands':len(ledger),'removed':sum(r['decision']=='remove' for r in ledger),'retained':sum(r['decision']!='remove' for r in ledger),'cliRuns':len(runs),'testFiles':len(tests)}))
