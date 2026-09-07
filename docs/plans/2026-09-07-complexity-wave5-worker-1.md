# Complexity wave 5 — worker 1

Baseline: `07d24068`. Exclusive ownership is the files in `/tmp/complexity-wave5-worker-1-targets.json`; other workers are editing separate files.

## Targets

- src/semantic/typescript/local-flow.ts: buildTryStatement
- src/semantic/typescript/local-flow.ts: collectNodeAccesses.visit
- src/source/facts/clojure-facts.ts: buildClojureSourceFacts
- src/source/facts/source-calls.ts: callTargetForNode
- src/source/react-profile.ts: reactCandidateForNode
- src/symbols/graph/member-call-targets.ts: importedMemberCallTargets
- src/symbols/graph/static-value-flow.ts: resolveMember
- src/source/primitives/source-identifier-prefilter.ts: sourceMayContainCandidateName
- src/symbols/references/reference-callers.ts: addRustAttrCallers
- src/queries/graph/cycles.ts: classifyCycle
- src/queries/internal/consumer-evidence.ts: nativeConsumerClassifyEntry
- src/queries/internal/exploration-topology.ts: shortestDirectedAnchorPath

## Plan recorded before edits

Extract concrete responsibilities for try/catch CFG assembly and AST access dispatch; Clojure scanning; language-specific call targets and React candidates; ordered imported member resolution and static member evaluation; identifier prefilter strategies; Rust attribute attribution; cycle classification; consumer cache validation; and deterministic path adjacency/traversal. Preserve acceptance, sparse-array behavior, resolution tier ordering, source ranges, warnings, identifiers, returned fields, fallback patterns, and traversal order. No new argument-size bounds.

Run focused source tests for affected behavior, changed-file lint/format, and scoped current-source complexity; require every target and introduced helper/callback <=10 cyclomatic and <=15 cognitive. Review diffs, record actual results, then freeze with no processes. No build/reindex/commit or shared policy edits.

## Results and preserved contracts

All twelve targets implemented across eleven exclusively owned source files; exact diffs reviewed against `07d24068`. No shared test edits or new regression file needed.

- TypeScript local flow retains finally-before-catch-before-try node construction, binding nodes, raise edges, original abrupt-finally warning, nested-function exclusion, conditional-use handling before assignment dispatch, and use deduplication.
- Clojure scanning retains whitespace/newline/comment/string precedence, permissive mismatched-close behavior, frame completion order, token columns and reader prefixes, and identifier row deduplication. Call target and React candidate helpers retain language/kind dispatch, field fallbacks, wrapper handling, uppercase/hook rules and JSX requirements.
- Imported member resolution retains range filtering, indexed-target exclusion, constructed/service/factory/direct tier order, invocation-local callable cache, unresolved count and target ordering. Cache values derive from the actual callable collection type.
- Static member evaluation retains namespace property slicing before symbolic error naming, unique-definition requirements, proof identity, first missing-property error, depth increment and shared seen set.
- Identifier prefilter retains the 512-name strategy boundary, exact identifier boundaries, non-identifier substring matching, empty-name acceptance and regex cursor reset. Rust attribute callers retain document/reference/candidate ordering, target-leaf/ID filtering and self-reference exclusion.
- Cycle classification retains bookkeeping-file classification before two-file hierarchy checks. Native consumer validation keeps original check order and numeric acceptance, sparse-array behavior, source array identity, and freshly assembled file records; header typing leaves unvalidated files as unknown[].
- Directed path search retains sorted duplicate starts, shared-anchor result, edge exclusions and candidate-only policy, adjacency tie order, BFS visited timing, and the existing returned path fields. No new argument-size bound introduced.

## Checks

219 tests passed across 15 focused source test files: TypeScript local flow (14), Clojure accuracy (7), Clojure reader primitives (4), source facts (12), identifier prefilter (5), source reference scan (4), source-backed accuracy (14), cycles (4), consumer evidence (1), exploration topology (20), source evidence (35), system map (63), React rich internals (5), runtime boundaries (30), runtime object members (1).

After the final three complexity corrections, all 144 affected tests across six files passed again; log `/tmp/complexity-wave5-worker1-affected-tests.log`. All owned files pass installed ESLint, Prettier check and `git diff --check`. Source health/review exports: `/tmp/complexity-wave5-worker1-health-final.json`, `/tmp/complexity-wave5-worker1-review-final.json`; selected numeric metrics `/tmp/complexity-wave5-worker1-metrics.json`. All 51 changed target/helper/callback records are <=10 cyclomatic and <=15 cognitive. Other pre-existing findings in these files remain outside this target set; concurrent lane scans do not establish aggregate completeness. No source-matched coverage artifact supplied.

Target metrics (cyclomatic/cognitive):

- buildTryStatement: 10/6
- collectNodeAccesses.visit: 10/10
- buildClojureSourceFacts: 6/9
- callTargetForNode: 8/6
- reactCandidateForNode: 6/6
- importedMemberCallTargets: 9/11
- resolveMember: 7/12
- sourceMayContainCandidateName: 5/4
- addRustAttrCallers: 7/11
- classifyCycle: 6/6
- nativeConsumerClassifyEntry: 4/4
- shortestDirectedAnchorPath: 2/1

Final review delta: `isNativeConsumerClassifyHeader` (consumer-evidence.ts:669, 8/4) validates only the header and unknown[] files; `createImportedMemberResolutionContext` (member-call-targets.ts:159, 4/1) preserves setup order before leaf-index lookup; `resolveObjectPropertyPath` (static-value-flow.ts:269, 3/3) preserves first missing-property reporting, leaving `evaluateResolvedMember` at 10/5.

## Freeze and limits

Source/tests frozen; all worker test, lint and scan processes exited. Root owns combined type checking/build/API/full-suite/impact and final aggregate health. This worker did not build, reindex, commit, modify policy/suppressions or run VM/agent benchmarks. Worker 3 read-only cross-review follows separately.

## Worker 3 read-only cross-review

Read all ten manifest file diffs covering twelve targets and the new `tests/scripts/complexity-wave5-worker-3.test.ts` regression file. No concrete correctness or maintainability findings. Checked export change ordering, configured-project ownership/symlink/missing-entry handling, process identity/deadline/error behavior, dependency drift ordering, evidence laziness, locality/search output, capture completeness predicates, capability member fallback, and calibration sampling/summary distinctions with JSON-before-Markdown/console ordering. No worker 3 edits or checks performed. Source remains frozen and no worker processes remain.
