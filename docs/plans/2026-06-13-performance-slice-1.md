# Performance Slice 1 Plan

Date: 2026-06-13

This plan covers the first low-risk performance slice from `docs/plans/2026-06-13-performance-feedback.md`: cached source lines, bulk `diff-impact` SQL, and one-per-file semantic callee stale deletes.

## Accuracy Contract

These changes must not reduce tool accuracy. A cached source line array is the same source text split once and invalidated with the same database and source-file cache groups as `getSourceText()`. A bulk SQL query is the same set of `mentions`, `chunks`, and `documents` rows selected in one query instead of many. A deduplicated stale-delete is the same deletion predicate run once per `(relativePath, contentHash)` instead of once per symbol in that file.

## Evidence

- `scip-query plan-context getSourceText` identifies `src/source/source-text.ts:16` as the source reader used by many query paths.
- `scip-query code 'src/source/source-text.ts:1-80'` shows `SOURCE_TEXT_CACHE` and `hasSuppressionComment()` splitting source text on every call.
- `scip-query code 'src/queries/similar.ts:380-520'` shows `definitionSnippet()` splitting source text while building source-shape fingerprints.
- `scip-query code 'src/queries/internal/consumer-evidence.ts:117-260'` shows `isReExportOnlyConsumer()` splitting source text to count re-export-only references.
- `scip-query code 'src/queries/diff-impact.ts:104-150'` shows `diffImpactPartial()` calling per-symbol fan-in before adding changed-definition impact.
- `scip-query code 'src/queries/diff-impact.ts:373-455'` shows per-symbol `scipFanIn()` and `scipConsumerFiles()` SQL.
- `scip-query code 'src/queries/diff-impact.ts:254-372'` shows per-file wildcard document resolution in `indexedChangedFiles()` and `indexedChangedRanges()`.
- `scip-query plan-context writeCachedSemanticCalleesBatch` shows the semantic callee write path is downstream of `cachedSemanticCalleeMap()`.
- `scip-query code 'src/storage/evidence-cache.ts:229-255'` shows `dropStaleCallees` running inside the per-entry loop.

## Work Plan

1. Add `getSourceLines(db, relativePath)` in `src/source/source-text.ts`.
   - Store line arrays in a per-db cache keyed by normalized relative path.
   - Use the same `whole-project` and `source-file` cache groups as `getSourceText()`.
   - Preserve existing `getSourceText()` behavior for missing files by returning an empty string and an empty line array.

2. Replace repeated source splits in the hot consumers.
   - Use `getSourceLines()` in `hasSuppressionComment()`.
   - Use `getSourceLines()` in `definitionSnippet()` in `src/queries/similar.ts`.
   - Use `getSourceLines()` in `isReExportOnlyConsumer()` in `src/queries/internal/consumer-evidence.ts`.
   - Keep slice/join logic unchanged so snippets and line offsets remain identical.

3. Bulk `diff-impact` indexed evidence.
   - Replace `scipFanIn(db, symbolId)` calls with `scipFanInBySymbolId(db, symbolIds)`, returning the same distinct document counts keyed by symbol ID.
   - Replace `scipConsumerFiles(db, symbolId, changedFiles)` with `scipConsumerFilesBySymbolId(db, symbolIds, changedFiles)`, returning the same non-changed, non-ignored consumer files keyed by symbol ID.
   - Update `addChangedDefinitionImpact()` to consume precomputed file sets instead of querying per definition.
   - Replace per-file `LIKE` lookups in changed file/range resolution with a document-path resolver that first checks exact paths and then suffix matches using the already-loaded indexed document list.

4. Deduplicate semantic callee stale deletes.
   - In `writeCachedSemanticCalleesBatch()`, collect unique `(relativePath, contentHash)` pairs.
   - Run `dropStaleCallees` once per pair before writing all entries.
   - Preserve the existing transaction and write order for row upserts.

5. Tests and verification.
   - Add source-line cache coverage in an existing focused test if available, or add a small test that confirms repeated calls return identical line content and missing files produce an empty array.
   - Extend `tests/diff-impact-accuracy.test.ts` so multiple changed definitions in one file still report the same changed symbols and affected consumers through bulk fan-in and consumer maps.
   - Extend `tests/evidence-cache.test.ts` so two semantic callee entries for one file/hash preserve stale-row invalidation and both payloads.
   - Run `npm test -- tests/diff-impact-accuracy.test.ts tests/evidence-cache.test.ts tests/consumer-evidence.test.ts`.
   - Run `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.
   - Re-run Stable_Management smoke checks with the freshly built CLI, at minimum `cleanup-plan --min-loc 100 --max-depth 1 --json` and `diff-gate --json`.

## Out of Scope

This slice does not change detector heuristics, candidate thresholds, semantic provider resolution, or cleanup accuracy policy. Larger architecture work such as Git-backed freshness, per-language incremental reindexing, and persistent Git-history facts stays in the broader performance backlog.
