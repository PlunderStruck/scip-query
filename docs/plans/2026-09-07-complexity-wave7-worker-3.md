# Complexity wave 7 — worker 3

Base: `623e4e63`. Exclusive ownership: the 21 files below, covering all 41 assigned findings. Other agents edit separate files; preserve their work.

## Plan recorded before implementation

Read all target implementations through scip-query and drained their continuation pages. Split meaningful validation stages, per-entry processing, rendering, and resource operations. Preserve first-error precedence, fallback parsers, sparse input behavior, key and output ordering, callback receivers, disposal and bounded work. Keep helpers lexical outside exported classes. No API, policy, threshold or suppression changes.

Run focused source tests, installed lint/format, and one full source review against the base filtered to owned files; use correction reviews only as needed. Every selected target and introduced helper must be at most cyclomatic 10 and cognitive 15. Root owns combined build, API, types, full suite and impact checks. No external benchmarks, builds, reindexing, releases or commits in this lane.

## Targets

| File                                             | Target                                                     | Baseline                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `scripts/affected-set-shadow-contract.mjs`       | `verifyShadow`                                             | verifyShadow: cyclomatic 13, cognitive 12.                                             |
| `scripts/benchmark-query-service.ts`             | `defaultOperand`                                           | defaultOperand: cyclomatic 13, cognitive 12.                                           |
| `scripts/codex-exploration-trial-core.mjs`       | `classifyExplorationCommand`                               | classifyExplorationCommand: cyclomatic 13, cognitive 16.                               |
| `scripts/codex-exploration-trial.mjs`            | `main`                                                     | main: cyclomatic 13, cognitive 7.                                                      |
| `src/platform/git-worktree.ts`                   | `gitControlDirectoriesMatchHint`                           | gitControlDirectoriesMatchHint: cyclomatic 13, cognitive 13.                           |
| `src/platform/process-tree.ts`                   | `signalKnownTree`                                          | signalKnownTree: cyclomatic 13, cognitive 19.                                          |
| `src/platform/project-files.ts`                  | `journalEntryValidationReason`                             | journalEntryValidationReason: cyclomatic 13, cognitive 17.                             |
| `src/platform/project-observation-snapshot.ts`   | `fixedGitFileReader.read`                                  | fixedGitFileReader.read: cyclomatic 13, cognitive 13.                                  |
| `src/platform/project-observation-snapshot.ts`   | `isExcludedObservationArtifact`                            | isExcludedObservationArtifact: cyclomatic 13, cognitive 3.                             |
| `src/runtime/cleanup-verify.ts`                  | `extendToBalanced`                                         | extendToBalanced: cyclomatic 13, cognitive 14.                                         |
| `src/runtime/cleanup-verify.ts`                  | `parseCljKondoJsonDiagnostics`                             | parseCljKondoJsonDiagnostics: cyclomatic 13, cognitive 19.                             |
| `src/runtime/cleanup-verify.ts`                  | `workingTreeInspectionFailureReason`                       | workingTreeInspectionFailureReason: cyclomatic 13, cognitive 12.                       |
| `src/runtime/cli-json-envelope.ts`               | `isCliEvidenceContextV1`                                   | isCliEvidenceContextV1: cyclomatic 13, cognitive 8.                                    |
| `src/runtime/cli-support.ts`                     | `runHealthSemanticPrewarm`                                 | runHealthSemanticPrewarm: cyclomatic 13, cognitive 12.                                 |
| `src/runtime/config.ts`                          | `validateCoverageContracts`                                | validateCoverageContracts: cyclomatic 13, cognitive 16.                                |
| `src/runtime/health-report-cache.ts`             | `isHealthReportCacheKey`                                   | isHealthReportCacheKey: cyclomatic 13, cognitive 6.                                    |
| `src/runtime/isolated-analysis-runner.ts`        | `parseIsolatedAnalysisResult`                              | parseIsolatedAnalysisResult: cyclomatic 13, cognitive 13.                              |
| `src/runtime/output-pagination.ts`               | `parseOutputCursor`                                        | parseOutputCursor: cyclomatic 13, cognitive 10.                                        |
| `src/runtime/query-commands/cleanup/handlers.ts` | `handleRecentDuplicates.<callback:budgetedDbCommand:1>`    | handleRecentDuplicates.<callback:budgetedDbCommand:1>: cyclomatic 13, cognitive 17.    |
| `src/runtime/query-commands/impact.ts`           | `handleCoChange.<callback:budgetedDbCommand:1>`            | handleCoChange.<callback:budgetedDbCommand:1>: cyclomatic 13, cognitive 15.            |
| `src/runtime/query-commands/impact.ts`           | `handleIncompleteMigration.<callback:budgetedDbCommand:1>` | handleIncompleteMigration.<callback:budgetedDbCommand:1>: cyclomatic 13, cognitive 15. |
| `src/runtime/update-notice.ts`                   | `maybePrintUpdateNotice`                                   | maybePrintUpdateNotice: cyclomatic 13, cognitive 6.                                    |
| `src/runtime/watch-service-prune.ts`             | `pruneOrphanWatchServices`                                 | pruneOrphanWatchServices: cyclomatic 13, cognitive 16.                                 |
| `src/runtime/watch.ts`                           | `Watcher.pollGitState`                                     | Watcher.pollGitState: cyclomatic 13, cognitive 13.                                     |
| `scripts/accuracy-calibration-core.mjs`          | `parseTypeScriptDetectorOptions`                           | parseTypeScriptDetectorOptions: cyclomatic 12, cognitive 19.                           |
| `scripts/accuracy-calibration-core.mjs`          | `summarizeCalibration`                                     | summarizeCalibration: cyclomatic 12, cognitive 9.                                      |
| `scripts/affected-set-shadow-contract.mjs`       | `parseArgs`                                                | parseArgs: cyclomatic 12, cognitive 13.                                                |
| `scripts/codex-exploration-trial.mjs`            | `parseArgs`                                                | parseArgs: cyclomatic 12, cognitive 8.                                                 |
| `src/platform/project-files.ts`                  | `isProjectArtifactPath`                                    | isProjectArtifactPath: cyclomatic 12, cognitive 3.                                     |
| `src/platform/project-observation-snapshot.ts`   | `verifyKnownIndexInputs`                                   | verifyKnownIndexInputs: cyclomatic 12, cognitive 9.                                    |
| `src/runtime/cleanup-verify.ts`                  | `verifyCleanupPlan`                                        | verifyCleanupPlan: cyclomatic 12, cognitive 17.                                        |
| `src/runtime/output-pagination.ts`               | `emitCapturedOutputPage`                                   | emitCapturedOutputPage: cyclomatic 12, cognitive 12.                                   |
| `src/runtime/query-commands/cleanup/handlers.ts` | `handleSimilar.render`                                     | handleSimilar.render: cyclomatic 10, cognitive 18.                                     |
| `src/platform/project-files.ts`                  | `listFilesystemProjectFiles`                               | listFilesystemProjectFiles: cyclomatic 8, cognitive 17.                                |
| `src/platform/project-observation-snapshot.ts`   | `listFilesystemRepositoryContentFiles`                     | listFilesystemRepositoryContentFiles: cyclomatic 8, cognitive 17.                      |
| `scripts/accuracy-calibration-core.mjs`          | `deterministicStratifiedSample`                            | deterministicStratifiedSample: cyclomatic 11, cognitive 15.                            |
| `src/platform/project-files.ts`                  | `completeUtf8PrefixLength`                                 | completeUtf8PrefixLength: cyclomatic 11, cognitive 15.                                 |
| `src/platform/project-files.ts`                  | `readProjectFile`                                          | readProjectFile: cyclomatic 11, cognitive 9.                                           |
| `src/runtime/watch.ts`                           | `scopedProjectInputChangeKind`                             | scopedProjectInputChangeKind: cyclomatic 11, cognitive 11.                             |
| `src/runtime/cli-support.ts`                     | `commandAnalysisBudget`                                    | commandAnalysisBudget: cyclomatic 10, cognitive 16.                                    |
| `src/runtime/query-commands/cleanup/handlers.ts` | `handleDrift.render`                                       | handleDrift.render: cyclomatic 8, cognitive 16.                                        |

## Results

Implementation and focused validation pending.

## First packet results and continuation authorization

All 41 targets and introduced helpers are at most 10/15 in `/tmp/wave7-worker3-metrics.json`; full review artifacts `/tmp/wave7-worker3-review.json` and `-review-corrections.json`, accounted source coverage. Initial lint caught two return/newline extraction mistakes; corrected before focused tests. Diff review also corrected a cached-update microtask change and retained lazy error-message reads. No new exported class members. All owned diffs reviewed.

Focused checks: 343 tests/17 files (`/tmp/wave7-worker3-focused.log`), 126 tests/6 files (`-additional.log`, including a repeated update-notice suite), 4 new regression tests (`-regression.log`). Regression source: `tests/scripts/complexity-wave7-worker-3.test.ts` (script argument precedence/consumption, exact operand dispatch, cached notice timing/null results, inspection failure precedence). ESLint and Prettier pass (`-lint-final.log`, `-format-final.log`). No external benchmarks executed.

Root authorized the continuation packet of 34 targets across 22 additional exclusive files at the same base `623e4e63`; combined ownership is 75 targets/43 files in `/tmp/complexity-final-worker-3-targets.json`. Read every continuation implementation before editing; then preserve its validation order, parsing, cleanup, output and bounds. Root still owns all global validation and commit.

### Continuation targets (before implementation)

| File                                             | Target                                  | Baseline                                                            |
| ------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------- |
| `scripts/accuracy-calibration.mjs`               | `renderFactualPacket`                   | renderFactualPacket: cyclomatic 12, cognitive 3.                    |
| `scripts/api-surface-contract.mjs`               | `updateApiContract`                     | updateApiContract: cyclomatic 12, cognitive 12.                     |
| `scripts/benchmark-cold-reindex.ts`              | `parseOptions`                          | parseOptions: cyclomatic 12, cognitive 13.                          |
| `scripts/evidence-product-contract.mjs`          | `parseArgs`                             | parseArgs: cyclomatic 11, cognitive 18.                             |
| `scripts/incremental-freshness-contract.mjs`     | `runDaemonEditScenario`                 | runDaemonEditScenario: cyclomatic 12, cognitive 17.                 |
| `scripts/semantic-command-calibration.mjs`       | `runOne`                                | runOne: cyclomatic 12, cognitive 7.                                 |
| `src/analysis/file-classifier.ts`                | `computePackageSurfaceReachability`     | computePackageSurfaceReachability: cyclomatic 10, cognitive 18.     |
| `src/analysis/frontend-route-conventions.ts`     | `nextRouteIdentity`                     | nextRouteIdentity: cyclomatic 12, cognitive 17.                     |
| `src/platform/process-file-lock.ts`              | `createOwnedLock`                       | createOwnedLock: cyclomatic 12, cognitive 10.                       |
| `src/platform/scip-cli.ts`                       | `tryInstallScipCli`                     | tryInstallScipCli: cyclomatic 12, cognitive 14.                     |
| `src/platform/terminal-output.ts`                | `consumeEscapeSequence`                 | consumeEscapeSequence: cyclomatic 12, cognitive 8.                  |
| `src/platform/typescript-projects.ts`            | `discoverTsconfigProjectDirs`           | discoverTsconfigProjectDirs: cyclomatic 10, cognitive 18.           |
| `src/platform/typescript-projects.ts`            | `normalizeConfiguredProject`            | normalizeConfiguredProject: cyclomatic 12, cognitive 14.            |
| `src/platform/typescript-semantic-hash.ts`       | `typeScriptSemanticHash`                | typeScriptSemanticHash: cyclomatic 12, cognitive 17.                |
| `scripts/accuracy-calibration.mjs`               | `runNavigationMode`                     | runNavigationMode: cyclomatic 10, cognitive 17.                     |
| `src/analysis/config-referenced-files.ts`        | `discoverConfigReferencedFiles`         | discoverConfigReferencedFiles: cyclomatic 10, cognitive 17.         |
| `src/analysis/framework-patterns.ts`             | `isGeneratedFileHeader`                 | isGeneratedFileHeader: cyclomatic 11, cognitive 17.                 |
| `scripts/accuracy-calibration.mjs`               | `collectGraphRiskCandidates`            | collectGraphRiskCandidates: cyclomatic 11, cognitive 11.            |
| `scripts/accuracy-calibration.mjs`               | `runHealthDeadMode`                     | runHealthDeadMode: cyclomatic 11, cognitive 14.                     |
| `scripts/accuracy-calibration.mjs`               | `runTypeScriptDetectorMode`             | runTypeScriptDetectorMode: cyclomatic 11, cognitive 12.             |
| `scripts/api-surface-contract.mjs`               | `classifySignatureChange`               | classifySignatureChange: cyclomatic 11, cognitive 12.               |
| `scripts/incremental-freshness-contract.mjs`     | `waitForRefresh`                        | waitForRefresh: cyclomatic 11, cognitive 16.                        |
| `scripts/render-command-reference.ts`            | `validateSkillCommand`                  | validateSkillCommand: cyclomatic 11, cognitive 13.                  |
| `src/analysis/change-risk-metadata.ts`           | `inspectFileChangeRiskMetadata`         | inspectFileChangeRiskMetadata: cyclomatic 11, cognitive 11.         |
| `src/analysis/file-classifier.ts`                | `isFrameworkDiscoveredEntrypointSymbol` | isFrameworkDiscoveredEntrypointSymbol: cyclomatic 11, cognitive 10. |
| `src/analysis/framework-patterns.ts`             | `rustAttributeTexts`                    | rustAttributeTexts: cyclomatic 11, cognitive 13.                    |
| `src/analysis/runtime-boundaries/http-mounts.ts` | `composeHttpMountsWithCoverage`         | composeHttpMountsWithCoverage: cyclomatic 11, cognitive 15.         |
| `src/analysis/similarity.ts`                     | `weightedCosine`                        | weightedCosine: cyclomatic 11, cognitive 11.                        |
| `src/analysis/ui-kit-surface.ts`                 | `findShadcnManifests.visit`             | findShadcnManifests.visit: cyclomatic 11, cognitive 11.             |
| `src/analysis/ui-kit-surface.ts`                 | `shadcnUiDirectory`                     | shadcnUiDirectory: cyclomatic 11, cognitive 10.                     |
| `src/platform/verified-binary-fetch.ts`          | `fetchVerifiedBinary`                   | fetchVerifiedBinary: cyclomatic 11, cognitive 9.                    |
| `src/queries/health/health-baseline.ts`          | `collectBaselineFindings`               | collectBaselineFindings: cyclomatic 11, cognitive 14.               |
| `src/platform/process-file-lock.ts`              | `acquireReclaimGuard`                   | acquireReclaimGuard: cyclomatic 8, cognitive 16.                    |
| `src/platform/typescript-projects.ts`            | `typeScriptProjectInputPaths`           | typeScriptProjectInputPaths: cyclomatic 10, cognitive 16.           |

Continuation implementation prep complete: all 34 functions read through scip-query with continuation pages drained. Preserve lock candidate close/error precedence and hard-link/directory-sync rollback, two-attempt reclaim guard, verified-fetch abort precedence and release, source hash byte/newline semantics, first matching framework tier, exact route interception, sparse iteration behavior, and script cleanup/output contracts.

## Combined source freeze

All 75 assigned targets across 43 owned source files are implemented and source/tests are frozen for peer review. Every target is at most cyclomatic 10/cognitive 15; all 135 added function records (including relocated callbacks) are at most 10/12. No added or modified owned function exceeds 10/15. Numeric target/function details: `/tmp/complexity-final-worker3-metrics.json`; continuation source review `/tmp/wave8-worker3-review.json`, corrected directory traversal `/tmp/wave8-worker3-review-tsprojects.json`. Source comparison coverage is accounted. No source-matched coverage artifact was requested, so these reports make no coverage percentage claim.

Continuation checks passed: 147 tests/17 files (`/tmp/wave8-worker3-focused.log`), 40 tests/3 files (`-additional.log`), and 6 new regressions (`-regression.log`). Combined so far: 666 test executions covering 649 distinct tests/41 files, with per-file counts in `/tmp/complexity-final-worker3-tested-files.json`. The additional UI policy suite is completing separately. Installed ESLint, Prettier check, and owned-file git diff check passed; logs `/tmp/complexity-final-worker3-lint.log` and `-format.log`.

New regression files are `tests/scripts/complexity-wave7-worker-3.test.ts` and `tests/scripts/complexity-wave8-worker-3.test.ts`. The continuation checks route processing after interception, zero-valued evidence budgets and argument consumption, config callback receiver/key order/metadata overrides, refresh transition counts, first lock publication error and close-before-cleanup, and stdout getter failures inside parser fallback. Declarations are evaluated with local injected fixtures; no benchmark startup, real installations, external agent trials, or releases run.

Reviewed all owned diffs. Preserved original predicates and tier precedence, exact object and output insertion order, sparse loops, parser fallback and timeout errors, callback receiver bindings, source hash tokens/newline bytes, fixed snapshot symlink boundaries, HTTP-derived record identity followed by original-handler downgrade, lock candidate publication/reclamation/durability, download abort/release order, and script resource cleanup. Verified-fetch catch explicitly returns its never-returning error helper to satisfy TypeScript without widening the result. Final combined type/API/build/fullsuite/health/impact remain root-owned.

### Exact target metrics

| File                                             | Target                                                     | Before line | Before C / Cog | After line | After C / Cog |
| ------------------------------------------------ | ---------------------------------------------------------- | ----------: | -------------: | ---------: | ------------: |
| `scripts/affected-set-shadow-contract.mjs`       | `verifyShadow`                                             |         490 |        13 / 12 |        490 |         6 / 5 |
| `scripts/benchmark-query-service.ts`             | `defaultOperand`                                           |         246 |        13 / 12 |        246 |         2 / 0 |
| `scripts/codex-exploration-trial-core.mjs`       | `classifyExplorationCommand`                               |         185 |        13 / 16 |        185 |         8 / 7 |
| `scripts/codex-exploration-trial.mjs`            | `main`                                                     |          48 |         13 / 7 |         48 |         8 / 6 |
| `src/platform/git-worktree.ts`                   | `gitControlDirectoriesMatchHint`                           |         304 |        13 / 13 |        304 |        10 / 9 |
| `src/platform/process-tree.ts`                   | `signalKnownTree`                                          |         200 |        13 / 19 |        200 |         6 / 8 |
| `src/platform/project-files.ts`                  | `journalEntryValidationReason`                             |         819 |        13 / 17 |        804 |         4 / 4 |
| `src/platform/project-observation-snapshot.ts`   | `fixedGitFileReader.read`                                  |         409 |        13 / 13 |        402 |         9 / 8 |
| `src/platform/project-observation-snapshot.ts`   | `isExcludedObservationArtifact`                            |         504 |         13 / 3 |        481 |         6 / 2 |
| `src/runtime/cleanup-verify.ts`                  | `extendToBalanced`                                         |         755 |        13 / 14 |        734 |         6 / 6 |
| `src/runtime/cleanup-verify.ts`                  | `parseCljKondoJsonDiagnostics`                             |         954 |        13 / 19 |        930 |         6 / 6 |
| `src/runtime/cleanup-verify.ts`                  | `workingTreeInspectionFailureReason`                       |         467 |        13 / 12 |        453 |         9 / 8 |
| `src/runtime/cli-json-envelope.ts`               | `isCliEvidenceContextV1`                                   |         306 |         13 / 8 |        306 |         6 / 5 |
| `src/runtime/cli-support.ts`                     | `runHealthSemanticPrewarm`                                 |         536 |        13 / 12 |        531 |        10 / 9 |
| `src/runtime/config.ts`                          | `validateCoverageContracts`                                |         704 |        13 / 16 |        704 |         4 / 3 |
| `src/runtime/health-report-cache.ts`             | `isHealthReportCacheKey`                                   |         156 |         13 / 6 |        156 |        10 / 3 |
| `src/runtime/isolated-analysis-runner.ts`        | `parseIsolatedAnalysisResult`                              |         146 |        13 / 13 |        146 |         8 / 8 |
| `src/runtime/output-pagination.ts`               | `parseOutputCursor`                                        |        1715 |        13 / 10 |       1695 |         9 / 9 |
| `src/runtime/query-commands/cleanup/handlers.ts` | `handleRecentDuplicates.<callback:budgetedDbCommand:1>`    |         912 |        13 / 17 |        876 |        8 / 10 |
| `src/runtime/query-commands/impact.ts`           | `handleCoChange.<callback:budgetedDbCommand:1>`            |          74 |        13 / 15 |         74 |         9 / 9 |
| `src/runtime/query-commands/impact.ts`           | `handleIncompleteMigration.<callback:budgetedDbCommand:1>` |         172 |        13 / 15 |        152 |        10 / 9 |
| `src/runtime/update-notice.ts`                   | `maybePrintUpdateNotice`                                   |          27 |         13 / 6 |         27 |        10 / 4 |
| `src/runtime/watch-service-prune.ts`             | `pruneOrphanWatchServices`                                 |          42 |        13 / 16 |         42 |         8 / 5 |
| `src/runtime/watch.ts`                           | `Watcher.pollGitState`                                     |         943 |        13 / 13 |        943 |       10 / 10 |
| `scripts/accuracy-calibration-core.mjs`          | `parseTypeScriptDetectorOptions`                           |          92 |        12 / 19 |         92 |       10 / 15 |
| `scripts/accuracy-calibration-core.mjs`          | `summarizeCalibration`                                     |         272 |         12 / 9 |        269 |         2 / 1 |
| `scripts/affected-set-shadow-contract.mjs`       | `parseArgs`                                                |         759 |        12 / 13 |        763 |         4 / 3 |
| `scripts/codex-exploration-trial.mjs`            | `parseArgs`                                                |         218 |         12 / 8 |        205 |         9 / 4 |
| `src/platform/project-files.ts`                  | `isProjectArtifactPath`                                    |         970 |         12 / 3 |        944 |         9 / 2 |
| `src/platform/project-observation-snapshot.ts`   | `verifyKnownIndexInputs`                                   |         373 |         12 / 9 |        373 |         8 / 8 |
| `src/runtime/cleanup-verify.ts`                  | `verifyCleanupPlan`                                        |         105 |        12 / 17 |        105 |         8 / 8 |
| `src/runtime/output-pagination.ts`               | `emitCapturedOutputPage`                                   |         575 |        12 / 12 |        575 |         9 / 9 |
| `src/runtime/query-commands/cleanup/handlers.ts` | `handleSimilar.render`                                     |         434 |        10 / 18 |        434 |         4 / 4 |
| `src/platform/project-files.ts`                  | `listFilesystemProjectFiles`                               |         944 |         8 / 17 |        923 |        7 / 15 |
| `src/platform/project-observation-snapshot.ts`   | `listFilesystemRepositoryContentFiles`                     |         482 |         8 / 17 |        464 |        7 / 15 |
| `scripts/accuracy-calibration-core.mjs`          | `deterministicStratifiedSample`                            |         218 |        11 / 15 |        218 |       10 / 15 |
| `src/platform/project-files.ts`                  | `completeUtf8PrefixLength`                                 |         437 |        11 / 15 |        423 |         7 / 5 |
| `src/platform/project-files.ts`                  | `readProjectFile`                                          |         206 |         11 / 9 |        206 |         6 / 3 |
| `src/runtime/watch.ts`                           | `scopedProjectInputChangeKind`                             |        1563 |        11 / 11 |       1556 |         5 / 4 |
| `src/runtime/cli-support.ts`                     | `commandAnalysisBudget`                                    |         301 |        10 / 16 |        301 |        8 / 11 |
| `src/runtime/query-commands/cleanup/handlers.ts` | `handleDrift.render`                                       |         534 |         8 / 16 |        517 |         3 / 2 |
| `scripts/accuracy-calibration.mjs`               | `renderFactualPacket`                                      |        1471 |         12 / 3 |       1449 |         8 / 3 |
| `scripts/api-surface-contract.mjs`               | `updateApiContract`                                        |         310 |        12 / 12 |        310 |        10 / 8 |
| `scripts/benchmark-cold-reindex.ts`              | `parseOptions`                                             |         287 |        12 / 13 |        287 |       10 / 11 |
| `scripts/evidence-product-contract.mjs`          | `parseArgs`                                                |         151 |        11 / 18 |        151 |         8 / 9 |
| `scripts/incremental-freshness-contract.mjs`     | `runDaemonEditScenario`                                    |         113 |        12 / 17 |        113 |        8 / 13 |
| `scripts/semantic-command-calibration.mjs`       | `runOne`                                                   |         419 |         12 / 7 |        419 |         9 / 3 |
| `src/analysis/file-classifier.ts`                | `computePackageSurfaceReachability`                        |         232 |        10 / 18 |        232 |         5 / 6 |
| `src/analysis/frontend-route-conventions.ts`     | `nextRouteIdentity`                                        |          53 |        12 / 17 |         53 |         6 / 5 |
| `src/platform/process-file-lock.ts`              | `createOwnedLock`                                          |         306 |        12 / 10 |        306 |         9 / 7 |
| `src/platform/scip-cli.ts`                       | `tryInstallScipCli`                                        |         355 |        12 / 14 |        355 |        7 / 10 |
| `src/platform/terminal-output.ts`                | `consumeEscapeSequence`                                    |         125 |         12 / 8 |        125 |         8 / 7 |
| `src/platform/typescript-projects.ts`            | `discoverTsconfigProjectDirs`                              |         178 |        10 / 18 |        174 |         4 / 4 |
| `src/platform/typescript-projects.ts`            | `normalizeConfiguredProject`                               |         213 |        12 / 14 |        200 |         8 / 7 |
| `src/platform/typescript-semantic-hash.ts`       | `typeScriptSemanticHash`                                   |          18 |        12 / 17 |         18 |         6 / 5 |
| `scripts/accuracy-calibration.mjs`               | `runNavigationMode`                                        |        1622 |        10 / 17 |       1583 |         6 / 6 |
| `src/analysis/config-referenced-files.ts`        | `discoverConfigReferencedFiles`                            |          31 |        10 / 17 |         31 |         6 / 8 |
| `src/analysis/framework-patterns.ts`             | `isGeneratedFileHeader`                                    |         641 |        11 / 17 |        635 |         6 / 8 |
| `scripts/accuracy-calibration.mjs`               | `collectGraphRiskCandidates`                               |         973 |        11 / 11 |        961 |         9 / 9 |
| `scripts/accuracy-calibration.mjs`               | `runHealthDeadMode`                                        |        1672 |        11 / 14 |       1629 |       10 / 14 |
| `scripts/accuracy-calibration.mjs`               | `runTypeScriptDetectorMode`                                |         431 |        11 / 12 |        431 |        8 / 10 |
| `scripts/api-surface-contract.mjs`               | `classifySignatureChange`                                  |         368 |        11 / 12 |        357 |         7 / 5 |
| `scripts/incremental-freshness-contract.mjs`     | `waitForRefresh`                                           |         188 |        11 / 16 |        167 |        9 / 10 |
| `scripts/render-command-reference.ts`            | `validateSkillCommand`                                     |         169 |        11 / 13 |        169 |         7 / 7 |
| `src/analysis/change-risk-metadata.ts`           | `inspectFileChangeRiskMetadata`                            |          27 |        11 / 11 |         27 |         7 / 7 |
| `src/analysis/file-classifier.ts`                | `isFrameworkDiscoveredEntrypointSymbol`                    |         326 |        11 / 10 |        321 |         2 / 1 |
| `src/analysis/framework-patterns.ts`             | `rustAttributeTexts`                                       |         483 |        11 / 13 |        483 |         8 / 9 |
| `src/analysis/runtime-boundaries/http-mounts.ts` | `composeHttpMountsWithCoverage`                            |          25 |        11 / 15 |         25 |        9 / 10 |
| `src/analysis/similarity.ts`                     | `weightedCosine`                                           |         115 |        11 / 11 |        115 |        9 / 10 |
| `src/analysis/ui-kit-surface.ts`                 | `findShadcnManifests.visit`                                |          97 |        11 / 11 |         97 |       10 / 10 |
| `src/analysis/ui-kit-surface.ts`                 | `shadcnUiDirectory`                                        |         117 |        11 / 10 |        112 |         7 / 7 |
| `src/platform/verified-binary-fetch.ts`          | `fetchVerifiedBinary`                                      |         100 |         11 / 9 |        100 |         9 / 5 |
| `src/queries/health/health-baseline.ts`          | `collectBaselineFindings`                                  |          35 |        11 / 14 |         35 |         7 / 7 |
| `src/platform/process-file-lock.ts`              | `acquireReclaimGuard`                                      |         400 |         8 / 16 |        384 |         5 / 9 |
| `src/platform/typescript-projects.ts`            | `typeScriptProjectInputPaths`                              |          83 |        10 / 16 |         83 |        8 / 11 |

### Final focused check completion

UI policy suite passed (`/tmp/wave8-worker3-ui-policy.log`); combined focused coverage is now 653 distinct tests across 42 files. Final semantic-script metric export `/tmp/wave8-worker3-review-semantic.json` replaces that file in the merged metric artifact, with no over-limit target/helper. All lane test/check processes have finished. Source and tests remain frozen pending peer/global review.
