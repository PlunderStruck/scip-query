# Recent Duplicates Full Focus-Pair Plan - 2026-06-28

## Goal

Make `scip-query recent-duplicates --json --full` faster on large repositories
without changing its observable findings. Done means the command still reports
only recent duplicate echoes/twins, preserves the Vega_2.0 JSON hash, and spends
less time comparing pairs whose files cannot possibly survive the git-age
orientation step.

## Current State

- `recentDuplicates` in `src/queries/cleanup/recent-duplicates.ts:132-176`
  loads file add records, collects all duplicate candidates, then calls
  `orientRecentDuplicate` and filters `null` findings.
  Source: `scip-query code recentDuplicates -C 12`.
- `collectRecentDuplicateCandidates` in
  `src/queries/cleanup/recent-duplicates.ts:178-229` runs callable similarity,
  React component duplicates, React hook candidates, Vue component duplicates,
  and Vue composable candidates.
  Source: `scip-query plan-context collectRecentDuplicateCandidates`.
- `orientRecentDuplicate` in
  `src/queries/cleanup/recent-duplicates.ts:369-413` returns `null` when neither
  candidate file was added inside the window; old-old pairs are not observable
  recent-duplicate findings.
  Source: `scip-query code orientRecentDuplicate -C 16`.
- `definedLimitOption` in `src/runtime/commands/command-execution.ts:215-227`
  maps `--full` to `Number.POSITIVE_INFINITY` and forbids combining `--full`
  with `--limit`.
  Source: `scip-query code definedLimitOption -C 10`.
- `similarAll` in `src/queries/cleanup/similar.ts:192-258` iterates callee-based
  candidate pairs and calls `comparePair` before inserting ranked results.
  Source: `scip-query plan-context similarAll`.
- `rankedPairwiseProfileResults` in
  `src/queries/internal/pairwise-profiles.ts:14-44` performs a nested profile
  pair scan for React/Vue/file-profile detectors.
  Source: `scip-query plan-context rankedPairwiseProfileResults`.
- `reactComponentDuplicates` and `reactHookCandidates` both build React profiles
  and pass all pair comparison through `rankedPairwiseProfileResults`.
  Sources: `scip-query plan-context reactComponentDuplicates`,
  `scip-query plan-context reactHookCandidates`.

Current Vega_2.0 warm measurements from
`node dist/cli.js bench --json --command ...`:

| Command                           | Duration | stdout bytes |
| --------------------------------- | -------: | -----------: |
| `recent-duplicates --json --full` |   5.344s |        3,618 |
| `doc-drift --json --full`         |   3.628s |      963,953 |
| `health --json`                   |   3.876s |       15,342 |
| `dead --json --full`              |   3.341s |    3,803,655 |

The current Vega `recent-duplicates --json --full` SHA-256 is
`abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.

## Reuse Audit

- Reuse `rankedPairwiseProfileResults` rather than adding React-specific
  pairwise loops. Source: `scip-query plan-context rankedPairwiseProfileResults`.
- Extend `similarAll` rather than creating a separate recent-callable similarity
  implementation. Source: `scip-query plan-context similarAll`.
- Reuse `getFileAddRecords` and `orientRecentDuplicate`'s existing recency
  semantics rather than introducing a new git-history concept.
  Sources: `scip-query plan-context getFileAddRecords`,
  `scip-query code orientRecentDuplicate -C 16`.
- `scip-query similar rankedPairwiseProfileResults --json --full` found only
  `similarFiles` as a related file-profile flow, not an existing focus-file
  pair filter to reuse.

## Design

### 1. Build the recent focus set before full candidate collection

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:132-176`
- **Source**: `scip-query code recentDuplicates -C 12`.
- **What**: The command collects all candidates and only later discards old-old
  pairs in `orientRecentDuplicate`.
- **Change**: Derive a `Set<string>` of files whose `FileAddRecord.commitsAgo`
  is within `windowCommits`. If the set is empty, return the same empty
  available result early. Pass the set into candidate collection only when
  `limit` is not finite, which is the `--full` path.
- **Why**: For full output, every pair with neither file in this set is
  provably unobservable because `orientRecentDuplicate` returns `null`.

### 2. Thread focus files through recent duplicate candidate sources

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:178-367`
- **Source**: `scip-query code collectRecentDuplicateCandidates -C 12`.
- **What**: Callable, React, and Vue sources receive no git-recency information,
  so they spend work on old-old candidate pairs that the aggregate drops.
- **Change**: Add an internal optional `focusFiles?: ReadonlySet<string>` to the
  recent duplicate candidate options and pass it through to `similarAll` and the
  frontend detector wrappers.
- **Why**: The aggregate command already owns the recency filter; pushing that
  filter down avoids repeated expensive comparisons without changing candidate
  meaning.

### 3. Skip old-old pairs in callable similarity when focused

- [x] **File**: `src/queries/cleanup/similar.ts:192-258`
- **Source**: `scip-query code similarAll -C 20`.
- **What**: `similarAll` compares every callee candidate pair that passes
  structural filters, even when a caller only cares about pairs touching a
  known set of files.
- **Change**: Add optional `focusFiles?: ReadonlySet<string>` and skip a pair
  before signature and similarity work when neither side's file is focused.
- **Why**: `recent-duplicates --full` can remove old-old pairs before
  `comparePair` while direct `similar` behavior remains unchanged.

### 4. Skip old-old profile pairs in the shared profile helper

- [x] **File**: `src/queries/internal/pairwise-profiles.ts:5-44`
- **Source**: `scip-query code rankedPairwiseProfileResults -C 14`.
- **What**: React/Vue/file-profile detectors run expensive `compare` functions
  for every profile pair in nested order.
- **Change**: Add optional `focusFiles?: ReadonlySet<string>` and, in the normal
  all-pairs path, continue before `compare` when neither profile file is
  focused. Preserve the existing nested iteration order for compared pairs.
- **Why**: This keeps tie behavior stable while avoiding intersections and
  result construction for unobservable old-old pairs.

### 5. Expose focus files to React and Vue detector internals

- [x] **File**: `src/queries/frontend/react-component-duplicates.ts:32-69`
- [x] **File**: `src/queries/frontend/react-hook-candidates.ts:49-84`
- [x] **File**: `src/queries/frontend/vue-component-duplicates.ts:35-56`
- [x] **File**: `src/queries/frontend/vue-composable-candidates.ts:45-82`
- **Source**:
  `scip-query plan-context reactComponentDuplicates`,
  `scip-query plan-context reactHookCandidates`,
  `scip-query plan-context rankedPairwiseProfileResults`.
- **What**: The frontend detector public functions pass profiles to the shared
  pairwise helper without a focus filter.
- **Change**: Add optional `focusFiles?: ReadonlySet<string>` to the option
  objects and forward it to `rankedPairwiseProfileResults`.
- **Why**: `recent-duplicates --full` can optimize through existing detector
  APIs while standalone frontend commands remain byte-identical by default.

## Stress Test

- Understand before touching: the command is directional duplicate detection,
  not generic duplicate detection; old-old pairs belong to `similar`, not
  `recent-duplicates`. Source: `scip-query code recentDuplicates -C 12`.
- Blast radius: `similarAll` has callers in `recent-duplicates`, health, health
  baseline, runtime handlers, and exports. Source:
  `scip-query plan-context similarAll`.
- Intermediate validity: every new option is optional; omitted options preserve
  current direct command behavior.
- Reversibility: this is a two-way internal filter. Removing the optional
  fields restores previous all-pair comparison.
- Failure design: if git add records are unavailable, `recentDuplicates` still
  returns `{ available: false }` before any focus-set logic. Source:
  `scip-query code recentDuplicates -C 12`.
- Concurrency: the focus set is immutable per command invocation and does not
  mutate shared caches.
- Data integrity: no persistent data or cache schema changes.
- Observability: no new error path; output contracts are verified by SHA-256 on
  Vega_2.0.
- Human impact: full-mode users get the same findings faster.

## Verification

- `npm test -- tests/queries/frontend/frontend-recent-duplicates.test.ts tests/queries/cleanup/similar-topk.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- Vega output hash before/after:
  `node dist/cli.js recent-duplicates --json --full > /tmp/scip-query-vega-recent-after.json`
- Vega timing:
  `node dist/cli.js bench --json --command "recent-duplicates --json --full" --timeout-ms 600000`
- `scip-query diff-impact --json`
- `scip-query diff-gate --json`

## Ship Order

Ship this as one internal performance commit after the Vega hash and tests pass.
Do not version bump as part of this optimization campaign.
