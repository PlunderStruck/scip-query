# Performance Slice 4 Plan: Source-Shape Token Index

Date: 2026-06-13

This plan covers feedback item 20 from `docs/plans/2026-06-13-performance-feedback.md`: use an inverted token index for `similarBySourceShape()` so source-token fallback compares only candidates that share at least one meaningful token with the target.

## Goal

Reduce source-shape fallback comparisons without changing results. A candidate with zero shared source tokens cannot pass the existing `shared.size < 2` gate, so it can be skipped before computing intersections and unions.

## Current Flow

- Source: `scip-query plan-context similarBySourceShape`
  - `similarBySourceShape()` is defined in `src/queries/similar.ts:339-379`.
  - Its only direct caller is `similar()` at `src/queries/similar.ts:61`.
  - Downstream impact flows through `diff-gate` echo checks.

- Source: `scip-query code similarBySourceShape -C 10`
  - `similarBySourceShape()` builds a target source fingerprint at `src/queries/similar.ts:344-347`.
  - It currently loops every `getAllSourceFingerprints(db)` candidate at `src/queries/similar.ts:352`.
  - It skips self and tiny token sets at `src/queries/similar.ts:353`.
  - It computes `intersection(target.tokens, candidate.tokens)` and requires at least two shared tokens at `src/queries/similar.ts:355-356`.
  - It preserves result ordering by sorting on similarity and short name at `src/queries/similar.ts:377-378`.

- Source: `scip-query code getAllSourceFingerprints -C 10`
  - `SOURCE_FINGERPRINT_CORPUS` caches the tokenized source corpus in `src/queries/similar.ts:404-412`.
  - `buildSourceFingerprints()` uses `ProjectIndex.productionCallableDefinitions()` at `src/queries/similar.ts:418-423`.

- Source: `scip-query trace sourceTokens`
  - `sourceTokens()` returns a `Set<string>` after stripping stop words and the target leaf parts at `src/queries/similar.ts:476-506`.

## Plan

1. Derive a token index from the cached source fingerprint corpus.
   - Source: `scip-query code getAllSourceFingerprints -C 10`
   - In `src/queries/similar.ts`, keep `SOURCE_FINGERPRINT_CORPUS` as the single cache, using the same `whole-project` and `definition-catalog` cache groups.
   - Build a per-call `Map<string, SourceFingerprint[]>` from `getAllSourceFingerprints(db)`. This avoids changing the cache singleton contract while still avoiding zero-overlap candidate scoring.

2. Use the token index in `similarBySourceShape()`.
   - Source: `scip-query code similarBySourceShape -C 10`
   - Replace the full corpus loop at `src/queries/similar.ts:352` with a deduped candidate set collected from every token in `target.tokens`.
   - Keep the existing self/tiny-token skip, shared-token threshold, similarity computation, result shape, and sorting unchanged.

3. Tests and verification.
   - Source: `scip-query plan-context similarBySourceShape`
   - Because `similarBySourceShape()` is reached through `similar()`, run the command accuracy tests that assert source-token fallback output.
   - Run `npm test -- tests/command-accuracy.test.ts tests/similarity.test.ts`, `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Co-Change Partners

- Source: `scip-query plan-context similarBySourceShape`
  - History reports co-change with detector modules such as `extract-candidates`, `passthrough-candidates`, `wrapper-candidates`, `dead`, and `stale-abstractions`.
  - This slice changes only source-shape candidate enumeration inside `similar.ts`; detector thresholds, output contracts, and query APIs remain unchanged, so those partners are intentionally untouched.

## Accuracy Boundary

The token index is a reorganization of the same `SourceFingerprint[]` corpus. The old loop rejected zero-overlap candidates after computing `intersection()`. The new loop never visits zero-overlap candidates, while preserving all candidates that share one or more target tokens; the existing `shared.size < 2` gate remains in place.
