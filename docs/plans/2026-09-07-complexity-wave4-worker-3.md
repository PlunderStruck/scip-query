# Complexity wave4 worker3

Base: `1d028fc1`. Own the following 12 targets and their listed files; other workers edit separate files.

- `complexity:scripts/npm-release.ts:runNpmRelease`: runNpmRelease: cyclomatic 18, cognitive 21.
- `complexity:src/analysis/runtime-boundaries/carrier-discriminators.ts:deriveConsumerDiscriminators`: deriveConsumerDiscriminators: cyclomatic 13, cognitive 27.
- `complexity:src/analysis/runtime-boundaries/http-summaries.ts:deriveParameterRoles.<callback:walk:1>`: deriveParameterRoles.<callback:walk:1>: cyclomatic 18, cognitive 17.
- `complexity:src/analysis/runtime-boundaries/http-summaries.ts:propagateCompilerResolvedHttpSummaries.<callback:recordSpan:1>`: propagateCompilerResolvedHttpSummaries.<callback:recordSpan:1>: cyclomatic 12, cognitive 27.
- `complexity:src/runtime/uninstall.ts:formatUninstallReport`: formatUninstallReport: cyclomatic 18, cognitive 27.
- `complexity:src/semantic/rust/durable-session-protocol.ts:isResponseForKind`: isResponseForKind: cyclomatic 18, cognitive 15.
- `complexity:src/reindex/detect.ts:collectExtensions`: collectExtensions: cyclomatic 13, cognitive 26.
- `complexity:src/runtime/cleanup-verify.ts:parseCargoJsonDiagnostics`: parseCargoJsonDiagnostics: cyclomatic 17, cognitive 26.
- `complexity:src/analysis/framework-patterns.ts:legacyDispositionForReason`: legacyDispositionForReason: cyclomatic 17, cognitive 2.
- `complexity:src/analysis/git-history.ts:loadFileAddRecords`: loadFileAddRecords: cyclomatic 17, cognitive 25.
- `complexity:src/queries/impact/incomplete-migration.ts:incompleteMigration`: incompleteMigration: cyclomatic 17, cognitive 20.
- `complexity:src/queries/navigation/code.ts:sameFileCallClosureForRange`: sameFileCallClosureForRange: cyclomatic 17, cognitive 21.

## Plan before implementation

Split meaningful per-item analysis, result formatting, validation, and resource-finalization responsibilities. Preserve npm sidecar/main ordering and error aggregation, per-handler carrier error scope, HTTP depth8 and proof propagation, uninstall output order, Rust response acceptance, filesystem fallback behavior, Cargo first-primary-span selection, exact legacy reason matching, Git aliases and oldest-add overwrite order, migration skip precedence and lazy indexing, and exact-range callsite inclusion. No thresholds, policies, suppressions, skill instructions, or APIs change.

Use exact scip source reads and drain cursors. Run focused source tests, installed lint/format and scoped current-source metrics, review diffs, then freeze. No builds, reindex, commits, VM actions, publishing, external releases, or model benchmarks. Root performs combined validation.

## Completed behavior-preserving changes

- Release orchestration delegates prepared execution, independent temporary-directory/lock finalization, and outcome/error aggregation. Package validation precedes lock acquisition; all later operations remain under it. The sidecar is observed/published/verified before main publication, state writes retain order, and cleanup failure never skips lock release. Original handling of thrown `undefined` remains unchanged. Only injected runtime fixtures were exercised; no publishing occurred.
- Carrier consumer analysis separates handler recovery, registry call recognition, and concrete consumer emission. Production/noncandidate gates, first covering route call, handler argument order, per-handler catch scope, source family matching, proof IDs, and accumulated partial output remain intact.
- HTTP propagation separates one summary from one callsite. Depth 8, batch queue semantics, unresolved-frontier ordering, per-summary failure handling, inspected-file timing, instantiation-before-forwarding, individual role merges, proof arrays, and persisted dirty role files remain unchanged. Fetch and object-carrier role collection retain exact fields and opaque-init fallback.
- Uninstall reporting separates global/project lines, retaining output order, verbose singular/plural text, dry-run prefix, and zero-removal message.
- Rust response validation splits import/reference shapes after the existing availability/reason checks. Optional tuple fields, sparse-array iteration behavior, and accepted integer domains remain unchanged; no stronger type assertions were introduced.
- Filesystem extension discovery retains Git-inventory precedence, directory read failures, stack traversal, ignored/hidden directory rules, and extension order.
- Cargo JSON parsing retains line qualification, error-only messages, first primary span, field type checks, defaults, and output ordering.
- Legacy disposition uses the exact same finite reason and prefix sets without changing suppression policy.
- Git additions separate block and record processing. Commit ordinal/timestamp fallback, newest-first alias traversal, oldest-add overwrite behavior, insertion order, and separate per-add record objects with shared aliases remain unchanged.
- Migration scoring separates base-reader selection and per-helper decisions. Early availability return still precedes mutually-exclusive reader validation; helper skips, lazy candidate-index construction, counters, sorting, and limits remain unchanged.
- Source-range call closure separates direct-call collection and callsite qualification. Freshness gates, same-file restriction, exact-source line bounds, nonexact-source fallback, symbol deduplication order, and transitive closure call remain unchanged.

## Verification

- Focused Vitest suite: 12 files, 194 tests passed. Files: npm-release, npm-release-state, uninstall, durable-session-protocol, reindex-detect, cleanup-plan, framework-patterns, git-history, incomplete-migration, navigation/source-evidence, lossless-source-sensor, and runtime-boundaries.
- After final helper splits, four affected suites passed again: 89 tests (runtime-boundaries, navigation/source-evidence, lossless-source-sensor, git-history).
- Existing npm-release suite uses synthetic package archives and an injected runtime, including 34 release ordering/error/cleanup cases; no external release commands ran.
- Installed ESLint and Prettier passed for all 11 owned files. `git diff --check` passed. Complete owned diffs reviewed. No new tests were required beyond the existing focused contract coverage.
- Final numeric current-source review artifact: `/tmp/wave4-worker3-review-final.json`; peers were being edited, so aggregate comparison status may be uncomparable, but exact current-source function fields were inspected. All 12 targets and introduced helpers are at most 10 cyclomatic and 15 cognitive. Existing unrelated functions remain out of scope. No thresholds/suppressions changed.

| Target | Before cyclomatic/cognitive | After |
| --- | --- | --- |
| runNpmRelease | 18/21 | 3/1 |
| deriveConsumerDiscriminators | 13/27 | 10/15 |
| deriveParameterRoles walk callback | 18/17 | 2/1 |
| HTTP process-call-sites callback | 12/27 | 2/1 |
| formatUninstallReport | 18/27 | 8/6 |
| isResponseForKind | 18/15 | 9/8 |
| collectExtensions | 13/26 | 5/6 |
| parseCargoJsonDiagnostics | 17/26 | 9/13 |
| legacyDispositionForReason | 17/2 | 3/2 |
| loadFileAddRecords | 17/25 | 7/9 |
| incompleteMigration | 17/20 | 9/7 |
| sameFileCallClosureForRange | 17/21 | 5/3 |

New helper maxima: cyclomatic 10 (`collectCarrierParameterRoles`), cognitive 14 (`collectDirectoryExtensions`). Source frozen; all test/review processes completed. Root owns combined build, full-suite, types/API and diff-impact validation. No build/reindex/commit/installation/VM/benchmark/publishing actions performed.
