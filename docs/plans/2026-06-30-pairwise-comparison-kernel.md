# Pairwise Comparison Kernel — 2026-06-30

## Goal

The user wants the ninth structural optimization item completed in order. A pairwise comparison kernel is a shared analysis routine that chooses pairs of profiles, runs an exact scorer on each possible pair, ranks the matches, and returns the bounded result set. Its essential job is to make pair selection, focus-file pruning, candidate indexing, overrun stopping, exact scoring, and profile counters one reusable contract instead of duplicated loop policy.

Done means the existing `rankedPairwiseProfileResults()` runner supports a reusable candidate index and standardized counters, all five current pairwise consumers use indexed candidate selection, command outputs match pre-change hashes, and `similarAll()` remains on its specialized callee-fingerprint path until a separate benchmark proves migration is faster.

## Current State

- `src/queries/internal/pairwise-profiles.ts:15-27` now defines the pairwise counter contract, `src/queries/internal/pairwise-profiles.ts:31-33` defines the candidate-index contract, and `src/queries/internal/pairwise-profiles.ts:79-140` implements the indexed runner. Source: `node dist/cli.js outline src/queries/internal/pairwise-profiles.ts --json`.
- The runner has five direct consumers: `similarFiles()`, `reactComponentDuplicates()`, `reactHookCandidates()`, `vueComponentDuplicates()`, and `vueComposableCandidates()`. Source: `node dist/cli.js plan-context rankedPairwiseProfileResults`, `node dist/cli.js affected rankedPairwiseProfileResults`.
- `src/queries/cleanup/similar-files.ts:32-58` builds dependency profiles, derives an index from dependency keys, and sends both to `rankedPairwiseProfileResults()`. Its exact scorer at `src/queries/cleanup/similar-files.ts:126-174` returns `null` unless the profiles share at least three dependencies and at least two distinctive dependencies. Source: `node dist/cli.js outline src/queries/cleanup/similar-files.ts --json`.
- `src/queries/frontend/react-component-duplicates.ts:36-79`, `react-hook-candidates.ts:53-95`, `vue-component-duplicates.ts:39-64`, and `vue-composable-candidates.ts:52-88` compare frontend behavior token profiles through the indexed runner. Their exact scorers require non-empty shared token evidence before returning a result. Source: `node dist/cli.js outline src/queries/frontend/react-component-duplicates.ts --json`, `node dist/cli.js outline src/queries/frontend/react-hook-candidates.ts --json`, `node dist/cli.js outline src/queries/frontend/vue-component-duplicates.ts --json`, `node dist/cli.js outline src/queries/frontend/vue-composable-candidates.ts --json`.
- `src/queries/cleanup/recent-duplicates.ts:185-241` delegates frontend duplicate candidate collection to those frontend pairwise commands, while `src/queries/cleanup/recent-duplicates.ts:243-273` delegates callable duplicate candidates to `similarAll()`. Source: `node dist/cli.js code collectRecentDuplicateCandidates -C 8`, `node dist/cli.js code callableDuplicateCandidates -C 8`.
- `src/queries/cleanup/similar.ts:260-390` already has a specialized callee-index pair scan with counters for corpus size, candidate sets, candidate pairs, compared pairs, skips, and inserted results. Source: `node dist/cli.js plan-context similarAll`, `node dist/cli.js code similarAll -C 8`.
- The structural inventory doc has no doc-drift findings and recent-duplicates is clean before this slice. Source: `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`, `node dist/cli.js recent-duplicates --json`.

Non-obvious invariants to preserve:

- Result order must stay deterministic after indexing. The current runner sorts by custom comparator or by descending `similarity` after collecting matches. Source: `node dist/cli.js code rankedPairwiseProfileResults -C 8`.
- Focus-file behavior means "return pairs where at least one side is in the focus set"; an empty focus set returns no pairs. Source: `node dist/cli.js code rankedPairwiseProfileResults -C 8`.
- A candidate index can only skip pairs that share no dependency/token key, because every migrated exact scorer already returns `null` when there is no shared dependency/token evidence. Source: `node dist/cli.js code 'src/queries/cleanup/similar-files.ts:90-170'`, `node dist/cli.js code vueComponentDuplicates -C 8`.
- `similarAll()` should not be migrated in this slice. It already has callee-bucket candidate indexing and hand-tuned top-k insertion; the register warns that a mathematically equivalent smaller-set iteration trial was slower. Source: `node dist/cli.js plan-context similarAll`, `docs/plans/2026-06-30-structural-optimization-inventory.md`.

## Reuse Audit

- Extend `rankedPairwiseProfileResults()` instead of adding a second pairwise loop. Source: `node dist/cli.js plan-context rankedPairwiseProfileResults`.
- `node dist/cli.js similar rankedPairwiseProfileResults` found only a low-similarity relation to `similarFiles()`, and `node dist/cli.js similar-files src/queries/internal/pairwise-profiles.ts` found no similar file pairs; this supports extending the existing runner rather than merging unrelated flows.
- Reuse the existing `profileSpan()` pattern from `similarAll()` and the candidate pipeline work for counters; do not write profile JSONL directly from pairwise consumers. Source: `node dist/cli.js code similarAll -C 8`.
- Reuse each consumer's existing profile tokens/dependencies as candidate-index keys; do not change exact scorer thresholds or output shaping. Source: `node dist/cli.js code similarFiles -C 8`, `node dist/cli.js code reactComponentDuplicates -C 8`, `node dist/cli.js code vueComponentDuplicates -C 8`.

## Baseline Output Hashes

These hashes were captured before changing item 9 and must match after migration:

- `similar-files --json`: `5b7c15219270e6d0f066ed46961614fb1297cbd2b58223636355acd78ccefc29`
- `react-component-duplicates --json`: `fc3c40510fcf34ca867c8b1b2aa32a92aa133ff5a7625a4f3c40a9b7439844b4`
- `react-hook-candidates --json`: `b73b18030a1078a222732d790dca478f06631b4aed02bb88b23e4d4f748578d2`
- `vue-component-duplicates --json`: `8657b07c2b04af5b902c081d3a9da61f6e95cfc63ed004c27bddd781d2803152`
- `vue-composable-candidates --json`: `d3220627186119ce58effef5388ea610d4d9df008a769b54501fd0459ab662ae`

## Design Phases

### 1.1 — Add candidate-index and counter contracts to the pairwise runner

- [x] **File**: `src/queries/internal/pairwise-profiles.ts:1-204`
- **Source**: `node dist/cli.js plan-context rankedPairwiseProfileResults`, `node dist/cli.js code rankedPairwiseProfileResults -C 8`, `node dist/cli.js code similarAll -C 8`
- **What**: The runner owns pair enumeration, focus-file pruning, overrun stopping, exact scoring, sorting, and limiting, but it cannot receive a candidate index and emits no standardized counters.
- **Change**: Add exported `PairwiseCandidateIndex`, `PairwiseProfileCounters`, `PairwiseProfileRun`, and `PairwiseProfileMetadata` contracts. Add `candidateIndex`, `profile`, and `onProfile` options. Add `pairwiseCandidateIndexFromKeys(profiles, keysFor)` to build deterministic key-to-index maps. Update the runner to enumerate candidate indexes when supplied, keep focus/file-pattern semantics, count profile count, focused profile count, candidate pairs, compared pairs, matched results, emitted results, overrun use, and whether a candidate index was applied, then emit counters through `onProfile` and `profileSpan('pairwise-profile:<name>', ...)`.
- **Why**: Pairwise consumers need the same measured candidate-index path before this kernel is considered for broader similarity work.

### 1.2 — Index dependency-profile pairs

- [x] **File**: `src/queries/cleanup/similar-files.ts:32-58`
- **Source**: `node dist/cli.js plan-context similarFiles`, `node dist/cli.js code 'src/queries/cleanup/similar-files.ts:90-170'`
- **What**: `similarFiles()` compares every file profile pair and lets `compareProfiles()` reject pairs with insufficient shared deps.
- **Change**: Import `pairwiseCandidateIndexFromKeys`, build `candidateIndex` from each profile's `deps`, pass it to `rankedPairwiseProfileResults()`, and add `profile: { name: 'similar-files' }`.
- **Why**: A file pair with zero shared dependency keys cannot pass the exact scorer, so this skips impossible comparisons without changing output.

### 1.3 — Index React profile pairs

- [x] **File**: `src/queries/frontend/react-component-duplicates.ts:36-79`
- **Source**: `node dist/cli.js plan-context reactComponentDuplicates`, `node dist/cli.js code reactComponentDuplicates -C 8`
- **What**: React component duplicate detection compares all component JSX-token profiles after broad profile loading.
- **Change**: Build a candidate index from each pairwise profile's `tokens`, pass it to the runner, add `profile: { name: 'react-component-duplicates' }`, and keep the exact scorer/sort unchanged.
- **Why**: Pairs with no shared JSX tokens cannot pass the shared-token threshold.

- [x] **File**: `src/queries/frontend/react-hook-candidates.ts:53-95`
- **Source**: `node dist/cli.js code reactHookCandidates -C 8`
- **What**: React hook candidate detection compares all behavior-token profiles.
- **Change**: Build a token candidate index, pass it to the runner, and add `profile: { name: 'react-hook-candidates' }`.
- **Why**: Pairs with no shared behavior tokens cannot pass the shared-behavior threshold.

### 1.4 — Index Vue profile pairs

- [x] **File**: `src/queries/frontend/vue-component-duplicates.ts:39-64`
- **Source**: `node dist/cli.js plan-context vueComponentDuplicates`, `node dist/cli.js code vueComponentDuplicates -C 8`
- **What**: Vue component duplicate detection compares all template-token profiles.
- **Change**: Build a token candidate index, pass it to the runner, and add `profile: { name: 'vue-component-duplicates' }`.
- **Why**: Pairs with no shared template tokens cannot pass the Vue overlap gate.

- [x] **File**: `src/queries/frontend/vue-composable-candidates.ts:52-88`
- **Source**: `node dist/cli.js code vueComposableCandidates -C 8`
- **What**: Vue composable candidate detection compares all behavior-token profiles.
- **Change**: Build a token candidate index, pass it to the runner, and add `profile: { name: 'vue-composable-candidates' }`.
- **Why**: Pairs with no shared behavior tokens cannot pass the shared-behavior threshold.

### 1.5 — Test pairwise kernel semantics and hash-check outputs

- [x] **File**: `tests/queries/internal/pairwise-profiles.test.ts:48-183` (new test file; tests are not indexed by scip-query)
- **Source**: `node dist/cli.js plan-context rankedPairwiseProfileResults`
- **What**: No focused test currently pins candidate-index behavior, focus-file semantics, overrun counters, or profile counters.
- **Change**: Add tests for candidate-index pair pruning, file-pattern target comparison, focus-file behavior, result sorting/limiting, and emitted counters.
- **Why**: The runner becomes a kernel contract, so its pair-selection semantics need direct tests.

- [x] **File**: command output fixtures in `/tmp` (verification artifact)
- **Source**: baseline commands and hashes listed above
- **What**: The candidate index should skip only impossible pairs.
- **Change**: After build, rerun the five baseline commands, hash their JSON outputs, and require exact hash matches.
- **Why**: Hash equality proves the indexed kernel preserved command output contracts.

## Stress-Test Findings

1. Understand before touch: current pairwise work is a result-ranking kernel for profile comparisons, while `similarAll()` is a specialized callee-index scanner. Source: `node dist/cli.js plan-context rankedPairwiseProfileResults`, `node dist/cli.js plan-context similarAll`.
2. Blast radius: changing the runner affects five direct command functions and their health/recent-duplicate consumers. Source: `node dist/cli.js affected rankedPairwiseProfileResults`.
3. Valid intermediate states: adding optional runner fields is source-compatible; consumers can migrate one at a time.
4. Reversibility: this is an internal TypeScript refactor with no schema or output-format changes.
5. Failure design: profile output uses `profileSpan()`, whose writer does not fail commands on profile write errors. Source: `node dist/cli.js code profileSpan -C 8`.
6. Concurrency: no shared mutable state is introduced; candidate indexes are local to each command invocation.
7. Boundaries: CLI option parsing and output formatting remain in existing command handlers.
8. Data integrity: no persistent cache or SQLite writes are introduced.
9. Observability: counters expose profile count, candidate pairs, compared pairs, matched results, emitted results, focus/file-pattern use, overrun use, and candidate-index use.
10. Human impact: command outputs must remain byte-for-byte identical for the five migrated commands.
11. Reuse: exact scorers stay local; only pair selection and counters move into the kernel.

## Execution Order

1. Extend `src/queries/internal/pairwise-profiles.ts`.
2. Add focused pairwise kernel tests.
3. Migrate `similar-files` to dependency candidate indexing.
4. Migrate React pairwise commands to token candidate indexing.
5. Migrate Vue pairwise commands to token candidate indexing.
6. Run focused tests, typecheck, build, five command hash checks, structural checks, full tests, benchmark, health, reindex, and diff-gate.

## Ship Order

Ship as one internal refactor. There are no one-way doors: all new runner fields are optional, exact scorers remain unchanged, and the output hash check guards behavior.

## Verification

- `npx vitest run tests/queries/internal/pairwise-profiles.test.ts` passed: 5 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- Output hashes matched all five pre-change baselines:
  - `similar-files --json`: `5b7c15219270e6d0f066ed46961614fb1297cbd2b58223636355acd78ccefc29`
  - `react-component-duplicates --json`: `fc3c40510fcf34ca867c8b1b2aa32a92aa133ff5a7625a4f3c40a9b7439844b4`
  - `react-hook-candidates --json`: `b73b18030a1078a222732d790dca478f06631b4aed02bb88b23e4d4f748578d2`
  - `vue-component-duplicates --json`: `8657b07c2b04af5b902c081d3a9da61f6e95cfc63ed004c27bddd781d2803152`
  - `vue-composable-candidates --json`: `d3220627186119ce58effef5388ea610d4d9df008a769b54501fd0459ab662ae`
- `node dist/cli.js reindex` passed.
- Structural checks passed: `wrapper-candidates`, `incomplete-migration`, `recent-duplicates`, and `unused-params` returned no findings; `stale-abstractions` stayed at the known five baseline findings.
- Profile smoke passed: `react-component-duplicates` emitted `pairwise-profile:react-component-duplicates` counters.
- `npm test` passed: 85 files, 471 tests.
- `npm run bench:evidence-products -- --warm-iterations 0 --no-clear --out /tmp/pairwise-comparison-kernel.jsonl` passed with 0 failed commands.
- `node dist/cli.js diff-impact --json` completed for the current changed working tree.
- `node dist/cli.js health --full --json` reported 99/100. The score deduction is still the existing similar-function axis; the pairwise kernel helpers did not appear in `similar --json --full`.
- `npx prettier --check` passed for the item 9 files. The repo-wide `npm run format:check` still fails on 29 broader working-tree files outside this slice.
- Final `node dist/cli.js reindex && node dist/cli.js diff-gate --json` passed with no findings.

## Summary

Files to modify/create:

- `src/queries/internal/pairwise-profiles.ts`
- `src/queries/cleanup/similar-files.ts`
- `src/queries/frontend/react-component-duplicates.ts`
- `src/queries/frontend/react-hook-candidates.ts`
- `src/queries/frontend/vue-component-duplicates.ts`
- `src/queries/frontend/vue-composable-candidates.ts`
- `tests/queries/internal/pairwise-profiles.test.ts`

Expected net effect: pairwise profile commands use one indexed, measured kernel; frontend and similar-file outputs stay identical; and future migration of callable similarity has a concrete benchmarkable contract instead of another hand-rolled loop.
