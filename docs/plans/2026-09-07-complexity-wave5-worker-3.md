# Complexity wave5 worker3

Base `07d24068`. Exclusive ownership of the listed files; other workers edit separate files.

- `complexity:scripts/api-surface-contract.mjs:compareReferencedDeclarations`: compareReferencedDeclarations: cyclomatic 16, cognitive 25.
- `complexity:src/platform/typescript-projects.ts:typeScriptProjectSelectionIsTreeOwned`: typeScriptProjectSelectionIsTreeOwned: cyclomatic 16, cognitive 25.
- `complexity:src/runtime/query-commands/cleanup/handlers.ts:handleLocalityCandidates.<callback:budgetedDbCommand:1>`: handleLocalityCandidates.<callback:budgetedDbCommand:1>: cyclomatic 16, cognitive 25.
- `complexity:scripts/accuracy-calibration.mjs:renderRelationshipPacket`: renderRelationshipPacket: cyclomatic 16, cognitive 3.
- `complexity:scripts/accuracy-calibration.mjs:runResampleMode`: runResampleMode: cyclomatic 16, cognitive 17.
- `complexity:scripts/accuracy-calibration.mjs:runSummarizeMode`: runSummarizeMode: cyclomatic 16, cognitive 16.
- `complexity:skills/scip-explore/scripts/capture-evidence.mjs:projectCommandResult`: projectCommandResult: cyclomatic 16, cognitive 9.
- `complexity:src/analysis/runtime-boundaries/extractors.ts:capabilityDescriptorHandler`: capabilityDescriptorHandler: cyclomatic 16, cognitive 22.
- `complexity:src/platform/process-tree.ts:terminateOwnedProcessTree`: terminateOwnedProcessTree: cyclomatic 16, cognitive 23.
- `complexity:src/queries/cleanup/drift.ts:patternDeviationDrift`: patternDeviationDrift: cyclomatic 11, cognitive 24.
- `complexity:src/queries/navigation/evidence.ts:qualifiedEvidence`: qualifiedEvidence: cyclomatic 16, cognitive 12.
- `complexity:src/runtime/query-commands/navigation.ts:sourceInspectionSections.searchRows.<callback:result.searches.map:0>`: sourceInspectionSections.searchRows.<callback:result.searches.map:0>: cyclomatic 16, cognitive 9.

## Plan before implementation

Separate per-module/export comparison, config ownership checks, result-row rendering, calibration sample/review dispatch, search projection coverage, descriptor member recognition, platform termination paths, per-directory drift detection, and selected evidence collection. Preserve exact errors/validation order, string output/key order, sample determinism, sparse-input behavior, process identity and force-error precedence, query laziness, and all numeric limits. New helpers and targets must stay <=10 cyclomatic/15 cognitive.

Use scip-query exact source reads and drain all cursors; focused existing source tests plus isolated calibration script fixtures, installed ESLint/Prettier, numeric source review, and diff review. No policy/suppression/threshold changes, builds, reindex, commits, VM actions, or external model/calibration trials. Root owns combined validation.

## Completion evidence

All twelve assigned targets are refactored. Source and test edits are frozen; no test or review processes remain running. Owned source files are the ten files in `/tmp/complexity-wave5-worker-3-targets.json`; the only new regression file is `tests/scripts/complexity-wave5-worker-3.test.ts`.

The refactors separate export comparison, tree ownership checks, locality rendering, calibration sampling and summary/rendering, search completeness predicates, capability handler recognition, process termination phases, per-directory drift checks, evidence selection, and search inspection rendering. Preserved contracts include sorted export processing and unexplained declaration changes; configured-project iteration and conservative symlink/tracking checks; locality output order and consumer cap eight; deterministic sampling, separate packet-family defaults, JSON-before-Markdown writes, schema/error precedence and Markdown bytes; search coverage predicates and refusal text; nearest descriptor and handler-name recognition; process identity rechecks, receiver binding, TERM/KILL ordering and failure precedence; dependency insertion order and sibling minimums; evidence query evaluation order; and sparse map/for-of behavior. No thresholds, suppressions, policy, API, or skill prose were changed.

Final numeric evidence: `/tmp/wave5-worker3-review-final.json`. Target cyclomatic/cognitive pairs in manifest order: 6/9, 6/7, 5/4, 4/3, 6/5, 8/4, 9/7, 6/11, 10/9, 3/3, 8/6, 7/4 (the last is the extracted search-row mapper). All introduced helpers are at most 9 cyclomatic and 15 cognitive. `appendDirectoryPatternDeviations` is 9/15; no introduced helper warnings remain. Root will validate combined coverage and metrics after the other lanes freeze.

Focused verification: 156 distinct tests passed across twelve files: API surface contract (14), platform TypeScript projects (4), reindex TypeScript projects (4), process tree (7), capture evidence (5), accuracy calibration core (20), runtime boundaries (30), locality candidates (13), advanced navigation (7), source evidence (35), search CLI contract (13), and the unique calibration regression file (4). Initial combined execution had seven search CLI exit-status failures while concurrent changes were active; an isolated diagnostic passed and was removed, and the complete search CLI plus source evidence rerun passed all 48 tests. No source change was needed to resolve those transient failures; their original cause was not established.

The new calibration tests exercise repository/detector ordering and sample-count fields, packet-family summary dispatch, argument/schema and write ordering, and relationship Markdown defaults and trailing newlines through extracted functions with unit fixtures only. No external calibration/model trials ran. Installed ESLint and Prettier checks passed for all ten owned source files and the unique test; `git diff --check` passed. Complete owned diffs reviewed. Global build, types, API, full suite, and diff impact remain root integration responsibilities.

Test transcript retention: the initial focused run and final rerun were captured by tool output rather than redirected to log files; no filesystem log paths exist for those runs. Their completed execution session identifiers were 56843 (initial focused run) and 15025 (final 48-test rerun, exit 0). This records the actual retention limitation instead of claiming an unavailable log artifact.

Read-only cross-review of worker2 wave5: reviewed all eight source files named by its twelve-target manifest against HEAD, plus exact current source for publication lock/finally cleanup, SQLite staging cleanup, indexer restoration, and watch reinspection. No concrete correctness or maintainability findings. Checked lease identity predicate order and catch behavior, staged artifact order and durability stages, publication race fallback, local/overlay lease precedence, accepted generation freshness reasons, shard failure precedence, indexer abort/retry and reverse configuration cleanup, wire-field validation/bytes, watch wait caps and runtime receiver binding, and readiness sparse-array/default semantics. No worker2 files were edited and no review tests/builds were run.
