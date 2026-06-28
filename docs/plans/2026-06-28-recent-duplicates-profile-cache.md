# recent-duplicates React Profile Cache Plan - 2026-06-28

## Goal

Make `scip-query recent-duplicates --json --full` faster on large React-heavy
repositories without changing its JSON output or ranking. Done means the Vega
2.0 command returns the same byte hash as the pre-change run and the warm
runtime improves from the current 6.439s baseline recorded in
`docs/benchmarks/2026-06-28-vega-current-scoreboard.md`.

## Current State

- `recentDuplicates()` in `src/queries/cleanup/recent-duplicates.ts:132-176`
  loads git add records, collects duplicate candidates, orients candidates by
  file age, sorts echoes before twins, and slices to the requested limit.
  Source: `scip-query code recentDuplicates -C 12`.
- `collectRecentDuplicateCandidates()` in
  `src/queries/cleanup/recent-duplicates.ts:178-229` runs callable similarity,
  then React component and hook detectors when React files are present, then Vue
  detectors when Vue files are present. Source:
  `scip-query code collectRecentDuplicateCandidates -C 10`.
- `reactComponentDuplicates()` in
  `src/queries/frontend/react-component-duplicates.ts:32-69` builds React
  behavior profiles with `minJsxTokens`, filters to component profiles, then
  ranks pairwise duplicates. Source:
  `scip-query code reactComponentDuplicates -C 10`.
- `reactHookCandidates()` in
  `src/queries/frontend/react-hook-candidates.ts:49-84` builds React behavior
  profiles with `minBehaviorTokens`, then ranks pairwise hook extraction
  candidates. Source: `scip-query code reactHookCandidates -C 10`.
- `buildReactComponentBehaviorProfiles()` in
  `src/source/react-profile.ts:117-134` gets React source files, applies
  `scope`/`scanLimit`, calls `buildReactComponentBehaviorProfilesForFile()` for
  every file, then filters by token thresholds. Source:
  `scip-query code buildReactComponentBehaviorProfiles -C 12`.
- `buildReactComponentBehaviorProfilesForFile()` in
  `src/source/react-profile.ts:136-174` normalizes the path, reads the cached
  AST and source lines, collects React candidates, and builds sets/arrays for
  JSX and behavior evidence. Source:
  `scip-query code 'src/source/react-profile.ts:1-180'`.
- Existing lower-level caches already cover source text, source-file lists, and
  AST parsing, but the assembled React profile objects are rebuilt for each
  detector. Sources: `scip-query code getSourceText -C 10`,
  `scip-query code getSourceFiles -C 12`, and `scip-query code getAst -C 12`.
- The output hash before edits on Vega 2.0 is 3,618 bytes and SHA-256
  `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.

## Reuse Audit

- Reuse `createSourceFileCache()` from `src/storage/per-db-cache.ts:128-130`
  through the same import pattern used by Vue. Source:
  `scip-query code createPerDbSourceCache -C 18`.
- Reuse the Vue profile cache shape instead of inventing a new cache. Vue's
  `buildVueComponentBehaviorProfile()` in `src/source/vue/vue-profile.ts:72-79`
  caches per `(db, file, source)` and returns a clone; its clone helper copies
  mutable sets and arrays in `src/source/vue/vue-profile.ts:126-138`. Sources:
  `scip-query code 'src/source/vue/vue-profile.ts:1-110'` and
  `scip-query code cloneVueComponentBehaviorProfile -C 16`.
- New React-specific symbols are justified because React returns multiple
  profiles per file while Vue returns one profile per SFC. Source:
  `scip-query code buildReactComponentBehaviorProfilesForFile -C 12` and
  `scip-query code buildVueComponentBehaviorProfiles -C 16`.

## Design Phases

### 1.1 - Add a React per-file profile cache

- [x] **File**: `src/source/react-profile.ts:1-8`
- **Source**: `scip-query code 'src/source/react-profile.ts:1-180'`.
- **What**: The module imports `ScipDatabase`, AST helpers, source-file and
  source-text helpers, but no per-file profile cache helper.
- **Change**: Import `createSourceFileCache` from
  `../storage/per-db-cache.js`.
- **Why**: React should reuse the same per-source cache primitive already used
  by Vue.

### 1.2 - Cache uncached React profiles by source text

- [x] **File**: `src/source/react-profile.ts:117-174`
- **Source**: `scip-query code buildReactComponentBehaviorProfiles -C 12`;
  `scip-query code 'src/source/react-profile.ts:1-180'`.
- **What**: `buildReactComponentBehaviorProfiles()` currently flatMaps every
  file through `buildReactComponentBehaviorProfilesForFile()`, and the per-file
  builder recomputes React candidates, JSX facts, and behavior facts on every
  call.
- **Change**: Add
  `REACT_COMPONENT_BEHAVIOR_PROFILE_CACHE =
createSourceFileCache<ReactComponentBehaviorProfile[]>('react-component-behavior-profiles')`.
  Make `buildReactComponentBehaviorProfilesForFile()` normalize the file, read
  `getSourceText(db, file)`, cache the uncached per-file result, and return
  cloned profiles.
- **Why**: `recent-duplicates` invokes both React frontend detectors in one
  process, so the second detector should reuse the same per-file profile work.

### 1.3 - Clone mutable React profile data on cache reads

- [x] **File**: `src/source/react-profile.ts:150-174`
- **Source**: `scip-query code cloneVueComponentBehaviorProfile -C 16`.
- **What**: React profiles contain mutable `Set<string>` fields and arrays.
  Vue protects cached values by cloning sets and arrays before returning them.
- **Change**: Add `cloneReactComponentBehaviorProfile()` and use it when
  returning cached profile arrays.
- **Why**: Keeps the cache invisible to callers and preserves output even if a
  future detector mutates a profile.

### 1.4 - Record the measurement decision

- [x] **File**: `docs/benchmarks/2026-06-28-recent-duplicates-ledger.md`
- **Source**: `scip-query plan-context src/queries/cleanup/recent-duplicates.ts`;
  `scip-query trace buildReactComponentBehaviorProfiles`.
- **What**: The ledger has baseline timings and identifies the React detectors
  as the main component cost, but no accepted change yet.
- **Change**: Add the React per-file cache hypothesis, changed symbols,
  before/after timing, and output hash comparison.
- **Why**: The hyper-optimization skill requires the measurement evidence to be
  written down with the implementation decision.

## Stress-Test Findings

- Understanding: the change does not alter pairwise scoring, sorting, limit
  logic, or recent/established orientation; it only avoids rebuilding the same
  per-file profile objects. Sources: `scip-query code recentDuplicates -C 12`
  and `scip-query code rankedPairwiseProfileResults -C 10`.
- Blast radius: `buildReactComponentBehaviorProfiles()` has three direct
  detector consumers: React component duplicates, React hook candidates, and
  React large component pressure. Source:
  `scip-query affected buildReactComponentBehaviorProfiles`.
- Intermediate state: this is a single internal cache change; if only this
  phase ships, standalone React detectors still call the same public function.
- Reversibility: deleting the cache constant and clone helpers restores the
  previous eager recomputation path.
- Failure modes: the cache key includes source text through
  `createSourceFileCache`, so changed files invalidate by source mismatch and
  project/file cache clear groups. Source:
  `scip-query code createPerDbSourceCache -C 18`.
- Concurrency: the CLI runs these detectors in-process; the cache is a
  per-`ScipDatabase` WeakMap, matching existing source caches. Source:
  `scip-query code createPerDbCache -C 16`.
- Boundary/data integrity: no CLI flags, JSON fields, SQLite schema, or index
  format changes.
- Observability/user impact: no new user-facing messages; success is measured
  by identical output hash and lower runtime.

## Execution Order

1. Add the React profile cache and clone helper.
2. Run targeted tests/typecheck/build.
3. Compare Vega `recent-duplicates --json --full` output hash and timing.
4. Update the ledger and scoreboard if timing changes.
5. Run scip-query freshness, reindex if needed, then `scip-query diff-gate`.

## Ship Order

This is one reversible internal phase. No migration or one-way door exists.

## Summary

Files changed:

- `src/source/react-profile.ts`
- `docs/benchmarks/2026-06-28-recent-duplicates-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`

Verification completed:

- Vega `recent-duplicates --json --full`: 4.896s median over three warm repeats
  with unchanged 3,618-byte output hash
  `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.
- `npm run typecheck`, `npm run build`, targeted ESLint, targeted Prettier, and
  focused frontend/recent-duplicate Vitest files passed.
