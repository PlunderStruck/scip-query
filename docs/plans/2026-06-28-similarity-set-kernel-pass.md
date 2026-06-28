# Similarity Set Kernel Pass - 2026-06-28

## Goal

Make the remaining React-heavy `recent-duplicates` path cheaper without
changing duplicate scoring, ranking, JSON shape, or output bytes. Done means the
Vega 2.0 `scip-query recent-duplicates --json --full` hash stays
`abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` and warm
runtime improves from the current 4.897s-5.174s band.

## Current State

- `recentDuplicates()` in `src/queries/cleanup/recent-duplicates.ts:132-176`
  loads git add records, collects candidates, orients candidate pairs by file
  age, sorts echoes before twins, then slices to the requested limit. Source:
  `scip-query plan-context recentDuplicates`.
- `collectRecentDuplicateCandidates()` in
  `src/queries/cleanup/recent-duplicates.ts:178-229` runs callable similarity,
  then React component and hook detectors when React files are present, then Vue
  detectors when Vue files are present. Source:
  `scip-query code collectRecentDuplicateCandidates -C 8`.
- Vega 2.0 currently returns one `recent-duplicates --json --full` finding, in
  the `react-component` domain, with a 3,618-byte output hash
  `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.
  Source: hash/output probe run before this plan.
- Standalone detector timing on Vega 2.0 with `--limit 150` shows React work as
  the dominant component: callable similarity 1.202s, React component
  duplicates 3.241s, React hook candidates 2.527s, Vue component duplicates
  0.195s, and Vue composable candidates 0.200s. Source:
  `scip-query bench --json --command "similar --json --limit 150 --min-similarity 0.7" ...`.
- `reactComponentDuplicates()` in
  `src/queries/frontend/react-component-duplicates.ts:32-69` builds React
  behavior profiles, filters component profiles, then ranks pairwise duplicate
  results. Source: `scip-query code reactComponentDuplicates -C 8`.
- `reactHookCandidates()` in
  `src/queries/frontend/react-hook-candidates.ts:49-84` builds the same React
  profile source and ranks pairwise behavior candidates. Source:
  `scip-query code reactHookCandidates -C 8`.
- `rankedPairwiseProfileResults()` in
  `src/queries/internal/pairwise-profiles.ts:14-44` compares every profile pair
  unless a file pattern is supplied, sorts results, and slices to the limit.
  Source: `scip-query trace rankedPairwiseProfileResults`.
- `intersection()` in `src/analysis/similarity.ts:18-24` always iterates the
  left set, even when the right set is smaller. Its direct consumers are source
  shape similarity, React component duplicates, React hook candidates, Vue
  component duplicates, Vue composable candidates, and frontend behavior
  similarity. Source: `scip-query plan-context intersection`.
- `jaccard()` in `src/analysis/similarity.ts:37-43` also always iterates the
  left set to count shared members. Its direct consumers are similar-files,
  frontend behavior similarity, React component duplicates, and Vue component
  duplicates. Source: `scip-query plan-context jaccard`.

## Reuse Audit

- Reuse the existing exported `intersection()` and `jaccard()` primitives in
  `src/analysis/similarity.ts` instead of adding a new set-overlap helper.
  Source: `scip-query surface src/analysis/similarity.ts` from
  `scip-query plan-context intersection`.
- Do not add early recent-file filtering in this pass. `orientRecentDuplicate()`
  in `src/queries/cleanup/recent-duplicates.ts:369-413` drops pairs only after
  each detector has already ranked and limited its candidates. Moving the age
  filter earlier could surface different lower-ranked candidates, which is a
  separate output-contract decision. Source:
  `scip-query code orientRecentDuplicate -C 8`.
- `scip-query similar intersection --json` found overlap with `containment()`
  and `jaccard()`, but those return numeric ratios while `intersection()`
  returns the actual shared set needed by frontend evidence renderers. Reuse is
  therefore to tune the existing primitive, not merge it into another function.

## Design Phases

### 1.1 - Iterate the smaller set in `intersection`

- [x] **File**: `src/analysis/similarity.ts:18-24`
- **Source**: `scip-query plan-context intersection`.
- **What**: `intersection(a, b)` creates a new `Set`, loops over `a`, and adds
  items that also exist in `b`.
- **Change**: Select `smaller` and `larger` by `size`, loop over `smaller`, and
  test membership in `larger`.
- **Why**: The returned membership is identical, and consumers sort shared
  evidence before rendering; pairwise scans avoid unnecessary probes when one
  token set is much smaller.
- **Decision**: Rejected after Vega benchmarking. Output stayed identical, but
  `recent-duplicates --json --full` ran 5.970s, 5.269s, and 4.956s against the
  4.897s-5.174s baseline band, so the source/test change was reverted.

### 1.2 - Iterate the smaller set in `jaccard`

- [x] **File**: `src/analysis/similarity.ts:37-43`
- **Source**: `scip-query plan-context jaccard`.
- **What**: `jaccard(a, b)` counts shared items by looping over `a`.
- **Change**: Keep the empty-set and union formula unchanged, but count shared
  items by looping over the smaller set and probing the larger set.
- **Why**: Jaccard is used inside frontend pairwise comparisons; this preserves
  the exact ratio while reducing membership probes.
- **Decision**: Rejected with phase 1.1 because the combined set-kernel change
  did not improve the real Vega recent-duplicates workload.

### 1.3 - Extend similarity-kernel tests

- [x] **File**: `tests/analysis/similarity.test.ts`
- **Source**: `scip-query plan-context intersection` and
  `scip-query plan-context jaccard` for changed symbols; test file is the
  existing similarity-kernel test target from the current worktree diff.
- **What**: Existing tests already exercise the similarity kernel, including
  weighted-cosine equivalence added in the earlier optimization pass.
- **Change**: Add order-invariance assertions for `intersection()` and
  `jaccard()` with asymmetric set sizes.
- **Why**: The optimization depends on preserving membership and ratios when
  argument order and size differ.
- **Decision**: Reverted with the rejected implementation; the focused tests
  passed before revert.

### 1.4 - Record benchmark evidence

- [x] **File**: `docs/benchmarks/2026-06-28-recent-duplicates-ledger.md`
- **Source**: `scip-query plan-context recentDuplicates`.
- **What**: The ledger records the React profile cache pass and leaves broader
  pair-level pruning deferred.
- **Change**: Add this set-kernel hypothesis, before/after Vega timings, output
  hash, accepted/rejected decision, and any detector-specific timings.
- **Why**: The hyper-optimization workflow requires every accepted speedup to
  have written measurement evidence.
- **Decision**: Record as rejected evidence; no scoreboard update because the
  latest accepted runtime did not improve.

## Stress-Test Findings

- Understanding: this pass changes only set operation iteration order, not
  duplicate candidate collection, ranking, sorting, limits, or recent-file
  orientation. Sources: `scip-query plan-context recentDuplicates`,
  `scip-query trace rankedPairwiseProfileResults`,
  `scip-query plan-context intersection`, and `scip-query plan-context
jaccard`.
- Blast radius: `intersection()` affects fourteen downstream symbols across
  similarity, frontend detectors, diff-gate echo checks, and agent hook stop
  handling. Source: `scip-query affected intersection`.
- Intermediate state: changing `intersection()` and `jaccard()` together is
  still an internal math-kernel update; each function remains independently
  valid if only one change ships.
- Reversibility: both changes are one-line loop source swaps with no schema,
  CLI, config, or JSON contract changes.
- Failure mode: set insertion order could change for raw `intersection()`
  callers when the smaller set is the right-hand argument. Current consumers
  either use size only or sort shared evidence before output. Sources:
  `scip-query code tokenValues -C 5`, `scip-query code sortedTokens -C 5`,
  and `scip-query code 'src/queries/cleanup/similar.ts:490-530'`.
- Concurrency and data integrity: the functions remain stateless and allocate a
  new result set per call.

## Execution Order

1. Update `intersection()` and `jaccard()`.
2. Add focused similarity-kernel tests.
3. Run targeted tests, typecheck, and build.
4. Rebuild the CLI and benchmark Vega `recent-duplicates --json --full` plus
   the React detector components.
5. Update the recent-duplicates ledger and scoreboard if accepted.
6. Reindex if stale, then run `scip-query diff-impact --json` and
   `scip-query diff-gate --json`.

## Ship Order

Single reversible internal optimization. No one-way doors.

## Summary

Files changed:

- `docs/benchmarks/2026-06-28-recent-duplicates-ledger.md`
- `docs/plans/2026-06-28-similarity-set-kernel-pass.md`

Files tried and reverted:

- `src/analysis/similarity.ts`
- `tests/analysis/similarity.test.ts`

No scoreboard update was made because the measured candidate was rejected.
