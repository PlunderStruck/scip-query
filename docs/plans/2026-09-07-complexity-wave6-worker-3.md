# Wave 6 worker 3 complexity checkpoint

Base: `20ba96c7`. Own only the 21 source/script files in the assigned manifest, a unique regression test if warranted, and this checkpoint. Other workers are editing concurrently; no peer changes will be reverted.

## Targets

- `scripts/change-benchmark-core.mjs` — `checkStructure.visit`: checkStructure.visit: cyclomatic 15, cognitive 21.
- `src/analysis/runtime-boundaries/extractors.ts` — `nodeChildProcessBindings`: nodeChildProcessBindings: cyclomatic 15, cognitive 16.
- `src/analysis/runtime-boundaries/graph.ts` — `buildRelationGroups`: buildRelationGroups: cyclomatic 12, cognitive 22.
- `src/analysis/runtime-boundaries/wrapper-propagation.ts` — `propagateCompilerResolvedWrappers`: propagateCompilerResolvedWrappers: cyclomatic 10, cognitive 22.
- `src/language-parsers/languages/php.ts` — `parsePhpImportsAst`: parsePhpImportsAst: cyclomatic 10, cognitive 22.
- `src/queries/cleanup/dead.ts` — `deadSummary`: deadSummary: cyclomatic 12, cognitive 22.
- `scripts/accuracy-calibration-core.mjs` — `parseDeadCalibrationOptions`: parseDeadCalibrationOptions: cyclomatic 14, cognitive 20.
- `scripts/accuracy-calibration.mjs` — `renderDeadPacket`: renderDeadPacket: cyclomatic 14, cognitive 3.
- `scripts/api-surface-contract.mjs` — `normalizeNamedBindings`: normalizeNamedBindings: cyclomatic 14, cognitive 16.
- `scripts/profile-scoreboard.mjs` — `profileScoreboard`: profileScoreboard: cyclomatic 14, cognitive 18.
- `scripts/scip-windows-provenance.mjs` — `inspectPortableExecutable`: inspectPortableExecutable: cyclomatic 14, cognitive 10.
- `scripts/scip-windows-release.ts` — `runWindowsSidecarRelease`: runWindowsSidecarRelease: cyclomatic 14, cognitive 11.
- `skills/scip-explore/scripts/capture-evidence.mjs` — `priorSourceCoverage`: priorSourceCoverage: cyclomatic 14, cognitive 20.
- `src/analysis/framework-patterns.ts` — `collectRustAstExclusions`: collectRustAstExclusions: cyclomatic 14, cognitive 13.
- `src/analysis/framework-patterns.ts` — `normalizeExclusionEntry`: normalizeExclusionEntry: cyclomatic 14, cognitive 13.
- `src/analysis/runtime-boundaries/extractors.ts` — `capabilityRegistryExtractor.extract.<callback:visitDescendantsOfType:2>`: capabilityRegistryExtractor.extract.<callback:visitDescendantsOfType:2>: cyclomatic 14, cognitive 15.
- `src/analysis/runtime-boundaries/extractors.ts` — `effectHttpApiExtractor.extract.<callback:visitDescendantsOfType:2>`: effectHttpApiExtractor.extract.<callback:visitDescendantsOfType:2>: cyclomatic 14, cognitive 12.
- `src/queries/cleanup/duplicate-bodies.ts` — `extractImplementationBody`: extractImplementationBody: cyclomatic 14, cognitive 17.
- `src/queries/graph/architecture.ts` — `analyzeArchitectureGraph`: analyzeArchitectureGraph: cyclomatic 14, cognitive 15.
- `src/queries/graph/deep-chains.ts` — `dependencyDepth`: dependencyDepth: cyclomatic 14, cognitive 21.
- `src/queries/graph/graph-evidence.ts` — `graphEvidence`: graphEvidence: cyclomatic 14, cognitive 11.
- `src/queries/graph/system-map.ts` — `causalCorridorFocusLocations`: causalCorridorFocusLocations: cyclomatic 14, cognitive 15.
- `src/queries/navigation/source-inspection.ts` — `inspectSource`: inspectSource: cyclomatic 14, cognitive 11.
- `src/runtime/commands/command-handlers.ts` — `renderSqliteGeneration`: renderSqliteGeneration: cyclomatic 14, cognitive 15.
- `src/runtime/commands/command-handlers.ts` — `renderWatchReindexActivity`: renderWatchReindexActivity: cyclomatic 14, cognitive 6.

## Plan recorded before edits

All target implementations were read through exact scip-query source and all cursors drained during read-only preparation. Split import/AST recognition, per-observation and per-wrapper processing, import clause emission, exclusion validation and inherited Rust state, dead-symbol classification, graph mapping and longest-path phases, source inspection coverage/frontier assembly, and output rendering into named responsibilities. Preserve traversal, append and key order; validation/argument/error precedence; byte identity and first-error PE bounds; release registry modes and raced-publish errors with finally cleanup; partial wrapper progress; graph selection and coverage bounds; parser fallbacks and sparse-input behavior. Do not change policies, suppressions, thresholds, APIs, skill prose, or external behavior.

Run focused existing tests and meaningful unique fixtures if gaps warrant them, installed lint/format checks, and one current-source review filtered to all owned files. Correct only measured target/helper excesses with selective metrics; all targets/new helpers must be at most 10 cyclomatic and 15 cognitive. Record exact metrics and real log paths. Root owns combined build/types/API/full suite/health/diff-impact. No build, reindex, commit, external release, VM, or external agent benchmark execution.

## Exact source metrics

One initial source review and two scoped corrections: `/tmp/wave6-worker3-review.json`, `/tmp/wave6-worker3-review-pe.json`, `/tmp/wave6-worker3-review-render.json`. Selectively merged metric evidence: `/tmp/wave6-worker3-metrics.json`. All targets and added helpers pass 10/15 bounds. The two distinct nested `checkStructure.visit` identities are uncomparable by name in review, but both exact current implementations measure below limits (7/6 and 5/5); the assigned first visitor is 7/6.

| Target | Cyclomatic | Cognitive |
| --- | ---: | ---: |
| `checkStructure.visit` | 7 | 6 |
| `nodeChildProcessBindings` | 3 | 2 |
| `buildRelationGroups` | 4 | 3 |
| `propagateCompilerResolvedWrappers` | 6 | 10 |
| `parsePhpImportsAst` | 4 | 3 |
| `deadSummary` | 8 | 13 |
| `parseDeadCalibrationOptions` | 10 | 10 |
| `renderDeadPacket` | 4 | 3 |
| `normalizeNamedBindings` | 9 | 7 |
| `profileScoreboard` | 9 | 12 |
| `inspectPortableExecutable` | 3 | 2 |
| `runWindowsSidecarRelease` | 10 | 5 |
| `priorSourceCoverage` | 5 | 5 |
| `collectRustAstExclusions` | 5 | 4 |
| `normalizeExclusionEntry` | 8 | 7 |
| `capabilityRegistryExtractor.extract.<callback:visitDescendantsOfType:2>` | 2 | 1 |
| `effectHttpApiExtractor.extract.<callback:visitDescendantsOfType:2>` | 4 | 3 |
| `extractImplementationBody` | 5 | 6 |
| `analyzeArchitectureGraph` | 8 | 5 |
| `dependencyDepth` | 5 | 6 |
| `graphEvidence` | 9 | 9 |
| `causalCorridorFocusLocations` | 3 | 2 |
| `inspectSource` | 10 | 9 |
| `renderSqliteGeneration` | 8 | 6 |
| `renderWatchReindexActivity` | 5 | 2 |

Named added helpers (callback helpers also checked within bounds):

- `deadCalibrationLanguage`: 2/1.
- `deadCalibrationSampleSize`: 3/2.
- `deadCalibrationSeed`: 2/1.
- `appendDeadRepository`: 6/0.
- `appendDeadRow`: 6/0.
- `normalizeExportBindings`: 3/2.
- `normalizeImportBindings`: 4/3.
- `checkStructure.checkModuleBoundary`: 9/15.
- `accumulateProfileMetadata`: 6/4.
- `publishOrVerifySidecar`: 6/7.
- `receiptSourceRanges`: 10/10.
- `collectRustNodeExclusions`: 10/9.
- `validExclusionFields`: 8/7.
- `appendCapabilityDescriptor`: 9/5.
- `appendCapabilityReferences`: 5/6.
- `appendEffectEndpoint`: 4/2.
- `appendEffectRegistration`: 8/6.
- `collectDirectProcessBindings`: 7/7.
- `addRelationGroupObservation`: 9/7.
- `propagateWrapperReferences`: 5/8.
- `emitPhpUseClauses`: 4/5.
- `deadRowSymbol`: 5/5.
- `implementationBodyAt`: 7/7.
- `mapArchitectureFiles`: 4/5.
- `reciprocalArchitecturePairs`: 4/5.
- `condensedDependencyGraph`: 5/7.
- `longestComponentPaths`: 6/8.
- `graphEvidenceRoots`: 6/2.
- `addCorridorBehaviorLocations`: 9/9.
- `addCorridorGoverningLocations`: 4/2.
- `inspectionCausalFrontier`: 2/1.
- `inspectionExactSelectorsComplete`: 4/1.
- `portableExecutableHeaderOffset`: 8/6.
- `validatePortableExecutableSignature`: 5/2.
- `renderWatchReindexEvidence`: 7/2.
- `renderWatchReindexTotals`: 4/2.
- `sqlitePublicationDetails`: 7/9.

## Completion, contracts, and validation

All 25 targets are implemented and all source/test edits are frozen. No processes remain running. The 21 owned source/script files and unique `tests/scripts/complexity-wave6-worker-3.test.ts` are the complete implementation scope.

Preserved contracts: benchmark module resolution/dynamic-source reporting and visit order; named-import/require alias syntax and overwrite order; endpoint declaration before handler recognition and observation append order; registry descriptor/reference dedup identities; relation group source scopes, hashes, key order and normalization; wrapper partial progress and per-template catch scope; PHP grouped versus top-level clauses and AST fallback; exclusion header checks before disposition checks with only validated required fields added to the type predicate; Rust inherited test/trait state and classification precedence; dead-row exclusion counters and symbol order; body-scanner delimiter clamping and source fallback; architecture mapping ambiguity and production/test policy coverage; condensed graph component depth/tie order/suffix limits; graph selector validation before options, direction inventories and rejection precedence; source inspection channel budgets, exact completeness and all-candidate causal seeds; causal corridor explicit/local/evidence overwrite order, 3000-character bound and smallest-owner tie-break; exact activity, SQLite and dead-packet output; dead calibration argument consumption, root fallback and errors; finite profile metadata and ordering; PE buffer/offset/signature/architecture/magic first-error sequence; release local-only/verify/publish modes, tarball identity, raced publication errors, and finally cleanup. No policy/threshold/suppression/API changes or external operations were introduced.

Verification: 426 distinct tests passed across 26 files. `/tmp/wave6-worker3-focused.log`: 332 tests, 20 files, exit 0. `/tmp/wave6-worker3-regression.log`: 4 tests, 1 file, exit 0. `/tmp/wave6-worker3-additional.log`: 90 tests, 5 files, exit 0 (architecture, dead output/policy, search CLI, npm release fixtures). No failing test run in this wave. Regression fixtures cover exact dead-packet Markdown bytes, PE error precedence, nonfinite profile values and tie order, and malformed/nested implementation body boundaries. Benchmark tests exercised local unit fixtures only; release tests used injected runtimes, with no external model trials or registry mutation.

Installed ESLint passed all owned source files and the unique test: `/tmp/wave6-worker3-lint-final.log` (empty successful log). Prettier passed the same scope: `/tmp/wave6-worker3-format-final.log`. `git diff --check` passed. Complete owned diffs reviewed; worker1 independently reviewed all 21 source files and the new test with no concrete findings. Initial lint caught an unused inherited-state initialization, removed before final verification. Initial source metrics caught the PE header helper and activity renderer over limit; the two scoped correction artifacts above confirm the final values.

Limits: source coverage is accounted in the review artifacts, but source-matched test-coverage artifacts were not requested. Root owns combined frozen build, types, API, full-suite, health and diff-impact verification. No build, reindex, commit, VM, release, or external agent benchmark was run by this lane.

## Worker2 read-only cross-review

Reviewed all 19 source files covering worker2's 25 targets against HEAD; no added worker2 regression files were present in the worktree. Reviewed lifecycle/cleanup, mailbox response identity, semantic result/cache ordering, provider receiver calls, shard bounds, validation precedence, and publication reporting. One concrete finding reported to root and worker2: the two new reindex publication reporters receive `opts.onStatus` as a bare callback, changing the receiver from the fresh-run options object to undefined for these notifications. Recommended passing the run object or a wrapper that preserves `opts.onStatus(message)`. No other findings. No worker2 files were edited or checks run. Root/worker2 own the integration correction and its verification.

## Root-delegated Watcher API integration correction

After integration API validation identified the added private `Watcher.shouldSkipChangedWatchPath` declaration, root explicitly assigned its correction to this lane. Removed that class member and kept the local-cache, gitignore, and extra-ignore checks in original `handleFileChange` order and with their original receivers. Standalone `isInvalidChangedWatchPath` and `isWatchOutputPath` own only lexical path predicates. No API snapshot edit. Exact diff reviewed; installed ESLint, Prettier, and changed-file diff check passed. Scoped numeric evidence `/tmp/wave6-worker3-watch-correction-review.json` is accounted; metrics and focused test results are reported to root. Source is frozen again and both test/review processes completed. Root owns rebuild/API verification and full-suite rerun.
