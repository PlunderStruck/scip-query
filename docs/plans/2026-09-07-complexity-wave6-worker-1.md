# Complexity wave 6 — worker 1

Baseline `20ba96c7`. Exclusive whole-file ownership from `/tmp/complexity-wave6-worker-1-targets.json`; peers own other files.

## Targets

- src/semantic/rust/import-usage.ts: flattenRustUseTreePositions
- src/source/facts/behavior-skeleton.ts: buildBehaviorOutline.emitNode
- src/source/facts/behavior-skeleton.ts: addSwitchControlFacts
- src/source/facts/behavior-skeleton.ts: behaviorSkeleton
- src/source/facts/source-callables.ts: namedCallableNode
- src/source/facts/source-callables.ts: directForwardedCall
- src/symbols/graph/file-dep-graph.ts: fileDependencyPaths
- src/symbols/graph/file-dep-graph.ts: isFileDependencyGraphPayload
- src/symbols/references/reference-callers.ts: addAstCallsiteCallers
- src/source/react-profile.ts: recordJsxElement
- src/symbols/references/source-reference-scan.ts: scanSourceReferences
- src/queries/internal/exploration-topology.ts: addAdjacentJunctions
- src/queries/internal/next-anchor-candidates.ts: enrichResultCallbackControlSemantics
- src/queries/quality/slice-cohesion.ts: sliceCohesionForDefinition
- src/queries/quality/slice-cohesion.ts: projectFlowDependencies
- src/semantic/typescript/local-flow.ts: addCrossCallableCandidates
- src/semantic/typescript/local-flow.ts: isUseNode
- src/semantic/typescript/local-flow.ts: addReachingDefinitionEdges
- src/semantic/typescript/local-flow.ts: computePostdominators
- src/source/facts/state-temporal-analysis.ts: mutationFact
- src/source/vue/vue-profile.ts: buildBehaviorTokens
- src/symbols/graph/member-call-targets.ts: resolveCallableTargetDefinitions
- src/symbols/graph/member-call-targets.ts: serviceDeclarationFilesForImplementation
- src/queries/impact/context.ts: discoverAffectedConsumerReuse
- src/queries/internal/causal-corridor.ts: isSelectedCorridorEvidence.<callback:(edge.semantics ?? []).some:0>

## Plan recorded before edits

All 25 complete implementations and relevant adjacent contracts read using scip-query; every cursor drained. Extract concrete responsibilities for parser forms and JSX/Vue facts, source reference attribution, dependency paths/payload validation, outline/control emission, topology junctions/callback semantics, slice reporting/dependencies, bitset convergence and cross-callable flow, mutation facts, callable resolution, consumer reuse and causal evidence selection. Preserve original fallback tiers, source ranges, graph identity/order, unsigned bitset normalization, worklist order, finite limits, sparse array acceptance, invocation cache scope, output fields, and source scan finally/progress timing. New helpers retain actual concrete types and no new argument-size bounds.

Run focused source tests and installed ESLint/Prettier; one current-source review filtered to owned files, then scoped corrections. Require all targets and new helpers/callbacks <=10 cyclomatic and <=15 cognitive. Review exact diffs and record actual results before freezing with no processes. Root owns combined type/build/API/full-suite/health/impact. No build, reindex, commit, policies, suppression, threshold, VM or benchmark changes.

## Implementation and preserved contracts

All 25 targets completed across 16 exclusively owned files. All exact diffs reviewed against `20ba96c7`, including three final complexity corrections. No shared tests edited; existing focused source tests cover the changed behaviors.

- Rust use-tree helpers preserve flattening and alias order, named-child fallbacks, wildcard source positions and import-name offsets. Callable helpers preserve JavaScript language gating, variable/field identity, curried-wrapper recognition and rejection of nested forwarded calls.
- Behavior skeleton helpers preserve range selection and source read ordering, outline line bounds (800 characters), default savings policy (0.9), signal and clause ordering, copied statement counts, control dispatch precedence and switch default/fallthrough behavior.
- File dependency helpers preserve empty-input early return, forward/reverse enumeration and final sorting. Payload validation keeps version/construction checks, nullable fields, numeric acceptance and sparse arrays; intermediate header types do not assert unvalidated graph contents.
- Reference caller filtering preserves language/leaf/target-ID/cross-file checks. Source reference scanning keeps path counters before eligibility checks, lazy default target resolution, identifier-before-framework ordering, visit counters before callbacks, afterPath in finally, and progress every tenth scanned path only for paths entering the try block.
- JSX helpers preserve fragment/component/native classification, event normalization, property stop words, spread handling and set insertion order. Vue token generation preserves prefix ordering, function stop words/verbs and template event/binding order. Mutation facts preserve delete/update/assign precedence, target fallback, resource record identity and independently computed value/data subtype.
- Topology junctions preserve degree construction (including original self-loop behavior), adjacent candidate identity, structural exclusions, boundary ranking, tie ordering and selected-node budget. Callback enrichment preserves edge disposition filtering, material-line selection, existing semantics, and result-callback append identity. Causal evidence retains family-specific endpoint selection and earlier emitted/focused/path bypasses.
- Slice helpers preserve range-local flow coverage, parser/definition fallback order, detail-field omission, output partition metrics, parameter-use attribution, reached-use insertion before same-unit filtering, candidate-edge counting, control/data dependencies and enclosing predicate additions.
- Local flow helpers preserve name-position exclusion order, reverse-postorder traversal, gen/kill semantics, unsigned bitset normalization, scratch-buffer reuse, queue flags and neighbor order, exact reaching/value-source edges, closure-before-field candidate precedence, and existing unsupported messages.
- Member resolution keeps per-database service cache scope and missing-AST results, provider alias handling, namespace/direct Service precedence, unique paths/sorting, indexed-before-source fallback and local-before-import resolution. Consumer reuse keeps per-consumer search/acceptance bounds, excluded symbols, shared candidate identity, maximum similarity, consumer deduplication, final thresholds/ranking and coverage fields. No new argument-size bounds or API/policy/threshold/suppression changes.

## Validation

221 tests passed across 15 source-focused files; `/tmp/complexity-wave6-worker1-tests.log`: TypeScript local flow (14), Rust semantic provider (19), source facts (12), source-backed accuracy (14), source reference scan (4), file dependency graph (9), exploration topology (20), source evidence (35), causal corridor (12), system map (63), slice cohesion (6), slice coverage (4), React rich internals (5), Vue profile (1), context consumer reuse (3).

After final corrections, all 134 affected tests across six files passed again; `/tmp/complexity-wave6-worker1-correction-tests.log`. All 16 owned files pass installed ESLint, Prettier check and `git diff --check`.

One initial current-source review `/tmp/complexity-wave6-worker1-review.json` was filtered to owned files. Only three files needed correction scans: `/tmp/complexity-wave6-worker1-behavior-review.json`, `/tmp/complexity-wave6-worker1-flow-review.json`, `/tmp/complexity-wave6-worker1-anchor-review.json`. Combined exact metrics are `/tmp/complexity-wave6-worker1-metrics.json`: all 94 changed target/helper/callback records meet cyclomatic <=10 and cognitive <=15. No source-matched coverage artifact supplied; other pre-existing functions remain outside this target set. Concurrent peer edits mean these results make no aggregate completeness claim.

Target metrics (cyclomatic/cognitive):

- flattenRustUseTreePositions: 10/1
- buildBehaviorOutline.emitNode: 10/9
- addSwitchControlFacts: 10/4
- behaviorSkeleton: 9/8
- namedCallableNode: 6/4
- directForwardedCall: 8/6
- fileDependencyPaths: 3/3
- isFileDependencyGraphPayload: 3/2
- addAstCallsiteCallers: 7/11
- recordJsxElement: 2/1
- scanSourceReferences: 8/10
- addAdjacentJunctions: 3/3
- enrichResultCallbackControlSemantics: 4/4
- sliceCohesionForDefinition: 10/6
- projectFlowDependencies: 3/3
- addCrossCallableCandidates: 8/9
- isUseNode: 7/6
- addReachingDefinitionEdges: 4/4
- computePostdominators: 5/7
- mutationFact: 7/6
- buildBehaviorTokens: 9/8
- resolveCallableTargetDefinitions: 9/7
- serviceDeclarationFilesForImplementation: 5/4
- discoverAffectedConsumerReuse: 3/2
- isSelectedCorridorEvidence.<callback:(edge.semantics ?? []).some:0>: 10/9

## Freeze

All source/tests frozen; all worker test, format/lint and scan processes exited. Root owns final combined type/build/API/full-suite/source-health/impact verification and commit. No build, reindex, commit, VM, releases or external agent benchmarks run by this worker.

## Cross-review

Root reviewed all 16 owned frozen file diffs with no concrete findings. Worker 1 read-only cross-review of worker 3 completed after source freeze: all 21 manifest files/25 targets and `tests/scripts/complexity-wave6-worker-3.test.ts` read; no concrete findings. Verified calibration error/default/output ordering, API binding normalization, PE validation precedence, release cleanup/publish-race behavior, receipt coverage, Rust/PHP fallbacks, runtime observation/group identity and wrapper partial-error effects, duplicate-body delimiter fallback, architecture/dependency tie order, exact selector/corridor coverage and command formatting. No worker 3 edits or checks performed. Source remains frozen; no worker processes remain.
