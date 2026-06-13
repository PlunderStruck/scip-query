# Performance Slice 7 Plan: Exact `similarAll()` Top-K

Date: 2026-06-13

This plan covers feedback item 19 from `docs/plans/2026-06-13-performance-feedback.md`: replace `similarAll()`'s approximate early stop with exact bounded top-K selection.

## Goal

Make `similarAll()` return the best `limit` pairs from the candidate set it already considers, without stopping after `limit * 5` accepted pairs. This improves correctness for later high-scoring pairs and keeps memory bounded.

## Current Flow

- Source: `scip-query plan-context similarAll`
  - `similarAll()` is defined in `src/queries/similar.ts:135-214`.
  - Downstream consumers include health baseline, health candidate counting, recent duplicates, and cleanup automation.

- Source: `scip-query code similarAll -C 16`
  - The query builds callee fingerprints and TF-IDF weights at `src/queries/similar.ts:149-150`.
  - It already uses an inverted callee index to avoid full `N^2` comparison at `src/queries/similar.ts:152-168`.
  - It currently pushes every accepted result into `results` and breaks the outer loop when `results.length > limit * 5` at `src/queries/similar.ts:206-208`.
  - It sorts by descending similarity and slices to `limit` at `src/queries/similar.ts:212-213`.

## Plan

1. Replace the approximate early break with a bounded collector.
   - Source: `scip-query code similarAll -C 16`
   - Continue iterating every candidate pair produced by the existing inverted callee index.
   - Keep at most `limit` ranked entries in memory.
   - Insert a new result only if the collector is not full or the result scores higher than the current worst kept result.

2. Preserve tie behavior.
   - The previous full sort kept encounter order for equal similarity scores because JavaScript sort is stable.
   - Track encounter order in the bounded collector and sort by `similarity DESC, order ASC` before returning.
   - Do not replace an existing cutoff result with an equal-scoring later result.

3. Tests and verification.
   - Add a direct helper test showing a high-scoring later result displaces an earlier lower-scoring result, while equal-score later results do not displace earlier ties.
   - Run focused similarity tests, then `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Accuracy Boundary

This slice does not change fingerprint construction, callee filtering, TF-IDF weights, pair scoring, signature filtering, cross-file filtering, or output shape. It only changes how accepted pair results are retained before the final ranking.
