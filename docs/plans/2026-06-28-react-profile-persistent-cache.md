# React Profile Persistent Cache Plan

Date: 2026-06-28

## Goal

Make the remaining `recent-duplicates --json --full` hot path faster on large React repos without changing findings, ordering, JSON shape, or supported input files. Done means Vega_2.0 produces the same `recent-duplicates --json --full` SHA-256 while the warm median improves from the current 4.590s baseline, and the cache miss path still rebuilds exactly the same profiles.

## Current State

- Vega_2.0 warm benchmark now shows `recent-duplicates --json --full` as the slowest stable command after the false `complexity-hotspots` warm-up outlier: three direct repeats were 4.636s, 4.575s, and 4.590s; stdout stayed 3,618 bytes with SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.
- `recentDuplicates()` reads file-add records, derives `focusFiles`, gathers callable/frontend candidates, orients them, groups root causes, and sorts/limits findings. Source: `scip-query plan-context recentDuplicates`.
- `collectRecentDuplicateCandidates()` calls `callableDuplicateCandidates()`, then React component/hook candidates when `sourceFrameworkApplicability()` says React is present, then Vue candidates when Vue is present. Source: `scip-query code collectRecentDuplicateCandidates -C 8`.
- `buildReactComponentBehaviorProfiles()` enumerates `.tsx`/`.jsx` files with `getSourceFiles()`, applies `scope` and `scanLimit`, then calls `buildReactComponentBehaviorProfilesForFile()` for each file and filters profiles by JSX/behavior token thresholds. Source: `scip-query plan-context buildReactComponentBehaviorProfiles`.
- `buildReactComponentBehaviorProfilesForFile()` reads source text, uses the in-process `REACT_COMPONENT_BEHAVIOR_PROFILE_CACHE`, computes uncached profiles on a miss, and returns cloned profiles. Source: `scip-query code buildReactComponentBehaviorProfilesForFile -C 20`.
- `buildReactComponentBehaviorProfilesForFileUncached()` parses the file AST, counts lines, collects top-level React candidates, filters to hooks or JSX-containing components, then collects JSX and behavior facts into `Set` and array fields. Source: `scip-query code buildReactComponentBehaviorProfilesForFileUncached -C 20`.
- Existing `source-facts` has the persistent-cache shape this path lacks: it computes `fileContentHash()`, reads `readCachedFileEvidence()`, deserializes and validates language, otherwise parses/builds and writes `writeCachedFileEvidence()`. Source: `scip-query code loadOrBuildSourceFacts -C 30`.
- `FileEvidenceKind` currently allows `'source-facts'`, `'doc-path-tokens'`, `'source-imports'`, and `'consumer-file-usage'`. Source: `scip-query code 'src/storage/evidence-cache.ts:24-28'`.
- Change risk is medium for `src/source/react-profile.ts` because `ReactComponentBehaviorProfile`, `buildReactComponentBehaviorProfiles()`, and `buildReactComponentBehaviorProfilesForFile()` have frontend query consumers; `src/storage/evidence-cache.ts` is also medium because evidence cache helpers are shared. Sources: `scip-query change-surface src/source/react-profile.ts --json --full`; `scip-query change-surface src/storage/evidence-cache.ts --json --full`.

## Reuse Audit

- Reuse `readCachedFileEvidence()`, `writeCachedFileEvidence()`, and `fileContentHash()` instead of adding a separate cache store. These helpers are the public storage boundary and degrade to misses/no-ops on cache errors. Sources: `scip-query code readCachedFileEvidence -C 25`; `scip-query code writeCachedFileEvidence -C 25`; `scip-query code fileContentHash -C 15`.
- Reuse the `source-facts` serialization pattern: store JSON-only payloads, rebuild derived `Set` fields on deserialize, and treat corrupt payloads as misses. Sources: `scip-query code deserializeSourceFacts -C 40`; `scip-query code loadOrBuildSourceFacts -C 30`.
- Reuse the existing in-process `createSourceFileCache()` wrapper. The persistent cache should sit inside `buildReactComponentBehaviorProfilesForFile()`'s compute callback so repeated calls in one process remain cheap and repeated CLI processes can hit `evidence.db`. Sources: `scip-query code buildReactComponentBehaviorProfilesForFile -C 20`; `scip-query code createSourceFileCache -C 20`.
- Similarity audit found Vue's analogous profile loader as the closest same-shape path, but Vega's Vue stages are negligible and React is the measured bottleneck. Do not change Vue in this slice. Source: `scip-query similar buildReactComponentBehaviorProfilesForFile --json --full`.

## Design Phases

### 1.1 — Add a React profile evidence kind

- [ ] **File**: `src/storage/evidence-cache.ts:24-28`
- **Source**: `scip-query code 'src/storage/evidence-cache.ts:24-28'`
- **What**: `FileEvidenceKind` enumerates per-file payload kinds that are pure functions of one file's content.
- **Change**: Add `'react-component-behavior-profiles'` to the union.
- **Why**: The React profile payload is a pure function of one file's content, matching the existing file-evidence contract.

### 1.2 — Wire persistent reads/writes into the React file-profile path

- [ ] **File**: `src/source/react-profile.ts:1-9`
- **Source**: `scip-query code 'src/source/react-profile.ts:1-25'`
- **What**: The module imports `ScipDatabase`, `createSourceFileCache`, AST helpers, source files, and source text helpers.
- **Change**: Import `fileContentHash`, `readCachedFileEvidence`, and `writeCachedFileEvidence` from `../storage/evidence-cache.js`.
- **Why**: The profile loader needs the same content-hash and evidence-cache boundary used by `source-facts`.

- [ ] **File**: `src/source/react-profile.ts:140-149`
- **Source**: `scip-query code buildReactComponentBehaviorProfilesForFile -C 20`
- **What**: The current cache miss directly calls `buildReactComponentBehaviorProfilesForFileUncached()`.
- **Change**: Replace the compute callback with `loadOrBuildReactComponentBehaviorProfiles(db, file, source)`.
- **Why**: This preserves the existing in-process source-equality cache while adding a persistent miss/hit layer beneath it.

### 1.3 — Add JSON serialization helpers for React profiles

- [ ] **File**: `src/source/react-profile.ts:152-205`
- **Source**: `scip-query code buildReactComponentBehaviorProfilesForFileUncached -C 20`; `scip-query code cloneReactComponentBehaviorProfile -C 10`
- **What**: Fresh profiles contain `Set` fields for `jsxTokens` and `behaviorTokens`, plus array fields for sorted evidence buckets.
- **Change**: Add a `SerializedReactComponentBehaviorProfile` type plus `serializeReactComponentBehaviorProfiles()` and `deserializeReactComponentBehaviorProfiles()` helpers. Store `Set` fields as arrays and rebuild `Set` fields on read. Return `null` on malformed payload so corrupt cache entries degrade to a rebuild.
- **Why**: JSON cannot preserve `Set` instances directly; rebuilding them mirrors `source-facts` and keeps downstream comparison code unchanged.

### 1.4 — Preserve failure and cache-miss semantics

- [ ] **File**: `src/source/react-profile.ts:140-189`
- **Source**: `scip-query code loadOrBuildSourceFacts -C 30`; `scip-query code readCachedFileEvidence -C 25`; `scip-query code writeCachedFileEvidence -C 25`
- **What**: `source-facts` reads cached file evidence by content hash, validates it, otherwise builds and writes; evidence-cache errors disable the cache and return misses/no-ops.
- **Change**: Implement `loadOrBuildReactComponentBehaviorProfiles()` with the same flow: compute content hash, read kind `react-component-behavior-profiles`, deserialize if valid, otherwise build uncached profiles, write serialized payload, and return the fresh result.
- **Why**: This makes the optimization reversible and safe: cache misses, corrupt payloads, and evidence DB failures still produce exact fresh results.

## Stress-Test Findings

- **Understand before touching**: The React profile builder is not just a JSX duplicate detector; it also feeds hook candidates and large-component pressure. Source: `scip-query plan-context buildReactComponentBehaviorProfiles`.
- **Blast radius**: `react-component-duplicates`, `react-hook-candidates`, and `react-large-component-pressure` consume the profile builder; verification must cover all three. Source: `scip-query plan-context buildReactComponentBehaviorProfiles`.
- **Intermediate validity**: Adding the union member alone is harmless; adding imports without use is not. Commit the complete slice only after typecheck/tests pass.
- **Reversibility**: This is a two-way internal cache change. Removing the new kind/import/helpers restores the old uncached behavior.
- **Failure design**: Corrupt JSON returns `null`, evidence-cache errors already degrade to miss/no-op, and the fresh build path remains the source of truth. Sources: `scip-query code deserializeSourceFacts -C 40`; `scip-query code readCachedFileEvidence -C 25`.
- **Concurrency**: Writes use `INSERT OR REPLACE` through the existing SQLite evidence-cache connection. Source: `scip-query code writeCachedFileEvidence -C 25`.
- **Boundaries**: No CLI flags or public JSON output change; only an internal cache kind is added.
- **Data integrity**: The cache key is the file content hash, so stale per-file reads are structurally excluded. Source: `scip-query code fileContentHash -C 15`.
- **Observability**: No new warnings are needed because evidence-cache failures already follow the existing debug disable path. Source: `scip-query code readCachedFileEvidence -C 25`.
- **Human impact**: Users should only see faster repeated frontend-heavy commands; cold misses still produce normal output.
- **Reuse**: The plan reuses evidence-cache and source-facts patterns instead of adding a new cache system.

## Execution Order

1. Add the `FileEvidenceKind` literal.
2. Add React profile serialization/deserialization helpers.
3. Add `loadOrBuildReactComponentBehaviorProfiles()` and call it from the existing in-process cache callback.
4. Run focused profile/frontend tests and Vega hash/timing checks.

Each step is deployable only as part of the complete cache slice; there is no one-way door.

## Verification

- `npm test -- tests/queries/frontend/react-frontend-rich-internals.test.ts tests/queries/frontend/frontend-recent-duplicates.test.ts tests/source/vue-profile.test.ts`
- `npm test`
- `npm run typecheck`
- `npm run build`
- Vega: run `scip-query recent-duplicates --json --full` before/after and require SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.
- Vega: run the command twice after deleting any test-only output capture; first run may populate cache, second/third warm medians must be compared against 4.590s.
- `scip-query diff-impact --json`
- `scip-query unused-params --json --full`
- `scip-query recent-duplicates --json --full`
- `scip-query doc-drift --json --full`
- `scip-query reindex && scip-query diff-gate --json`

## Summary

Files expected to change:

- `src/storage/evidence-cache.ts`
- `src/source/react-profile.ts`
- `docs/benchmarks/2026-06-28-recent-duplicates-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`

Net code delta should be small: one cache-kind literal and a few local serialization helpers in the React profile module.
