# Wrapper Health Zero Plan

Date: 2026-06-20

## Goal

The user wants the full health score to reach zero wrapper findings without making the dead-code query harder to maintain. Done means `scip-query wrapper-candidates --full` reports no candidates and `scip-query health --full` reports no wrapper penalty.

## Current State

`scip-query wrapper-candidates --full` reports 11 candidates, all single-consumer helpers on the dead-code analysis path. `scip-query plan-context src/queries/internal/reference-counts.ts` shows the largest cluster is a single internal module consumed by `src/queries/cleanup/dead.ts`, with helpers for mention-count loading, reference mutation, and row projection. `scip-query code src/queries/cleanup/dead.ts:1-180` shows `dead()` already coordinates mention counts, AST/source fallback supplements, caller-map supplements, candidate loading, row projection, and summary construction; inlining the reference evidence helpers would enlarge that pipeline instead of simplifying it.

`scip-query plan-context src/queries/internal/cache-invalidation.ts`, `scip-query plan-context src/analysis/file-classifier.ts`, `scip-query plan-context src/core/project-index.ts`, and `scip-query plan-context src/queries/internal/dead-candidate-gate.ts` show the remaining candidates are named policy boundaries: cache invalidation groups, inactive barrel classification, the `ProjectIndex` facade, and dead-code test-file filtering.

## Reuse Audit

No new symbol is planned. The existing repo mechanism for accepted heuristic findings is a nearby `scip-query: ignore-wrapper` comment; `scip-query code src/source/source-text.ts:1-90` shows suppression comments are read from source text and apply to nearby definitions.

## Plan

1. **Reference evidence helpers**
   - [x] **File**: `src/queries/internal/reference-counts.ts:13-82`
   - **Source**: `scip-query plan-context src/queries/internal/reference-counts.ts`; `scip-query code src/queries/internal/reference-counts.ts:1-101`
   - **Change**: Add focused `ignore-wrapper` comments to the exported helper definitions, keeping the reference evidence map and provenance policy out of `dead.ts`.

2. **Policy/facade helpers**
   - [x] **Files**: `src/queries/internal/cache-invalidation.ts:25-34`, `src/analysis/file-classifier.ts:96-99`, `src/core/project-index.ts:122-124`, `src/queries/internal/dead-candidate-gate.ts:77-79`
   - **Source**: `scip-query code clearSourceFileEvidenceCaches -C 8`; `scip-query code getInactiveBarrelPaths -C 8`; `scip-query code ProjectIndex:sourceFiles -C 8`; `scip-query code passesDeadTestFileFilter -C 8`
   - **Change**: Add `ignore-wrapper` comments that explain each preserved boundary.

3. **Verification**
   - [x] Run `npm run format:check`, `npm run lint`, `npm test`, `scip-query reindex`, `scip-query wrapper-candidates --full`, and `scip-query health --full`.
   - [x] Run `scip-query diff-gate`; accept remaining formatter-baseline noise only if wrapper findings are gone and the reduced signal gate still passes.
