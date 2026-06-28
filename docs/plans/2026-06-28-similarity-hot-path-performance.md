# Similarity Hot Path Performance Plan — 2026-06-28

## Goal

Make detector-heavy commands faster without changing findings. A detector-heavy
command is a CLI command whose work is dominated by graph-derived cleanup
analysis rather than index creation or output formatting. Done means
`recent-duplicates`, `incomplete-migration`, and commands that call them
(`health` and `diff-gate`) avoid repeated callee-fingerprint index work while
returning the same evidence contracts.

Baseline evidence:

- `scip-query bench --include-heavy --json` in this repo: `recent-duplicates`
  426ms, `incomplete-migration` 510ms, `health` 1463ms, `diff-gate` 968ms.
- `scip-query bench --include-heavy --json` in
  `/Users/aydansalois/Documents/GitHub/Vega_2.0`: `recent-duplicates` 7195ms,
  `incomplete-migration` 7506ms, `health` 4767ms, `diff-gate` 3576ms.

## Current State

- `src/queries/cleanup/recent-duplicates.ts:177-214` always gathers callable,
  React, hook, Vue component, and Vue composable duplicate candidates before
  orientation. Source: `scip-query code collectRecentDuplicateCandidates -C 10`.
- `src/queries/cleanup/recent-duplicates.ts:217-244` calls `similarAll` for
  callable duplicates. Source: `scip-query code callableDuplicateCandidates -C 10`.
- `src/queries/cleanup/similar.ts:154-235` builds document frequency,
  candidate buckets, and pair candidate sets inside `similarAll`, even though
  the file also has a cached callee-fingerprint index. Source:
  `scip-query code similarAll -C 20`.
- `src/queries/cleanup/similar.ts:369-410` has `getCalleeFingerprintIndex` and
  `buildCalleeFingerprintIndex`, which already compute document frequency and
  rare-callee candidate buckets for the same corpus. Source:
  `scip-query code getCalleeFingerprintIndex -C 20` and
  `scip-query code buildCalleeFingerprintIndex -C 15`.
- `src/analysis/similarity.ts:111-143` computes weighted cosine by allocating a
  shared set, allocating a union set, and sorting all IDF values to compute the
  median on every pair. Source: `scip-query code weightedCosine -C 20`.
- `src/queries/impact/incomplete-migration.ts:223-243` builds a local candidate
  index with the same doc-frequency and ubiquity threshold idea as
  `similarAll`. Source: `scip-query code buildCandidateIndex -C 15`.
- `src/queries/impact/incomplete-migration.ts:246-288` uses that local index to
  find leftovers for each helper. Source:
  `scip-query code collectLeftoversForHelper -C 20`.

## Reuse Audit

- Reuse `buildCalleeFingerprintIndex` rather than keeping a second
  incomplete-migration-only index. Source:
  `scip-query code buildCalleeFingerprintIndex -C 15`; `scip-query similar buildCandidateIndex --json --full`
  did not find a better helper.
- Extend the existing `weightedCosine` primitive instead of adding a second
  cosine function. Source: `scip-query refs weightedCosine --json` shows only
  `src/queries/cleanup/similar.ts` calls it.
- Extend the existing `computeIdf` family rather than recalculating IDF from
  already-known doc frequencies locally. Source:
  `scip-query code computeIdf -C 10`.

## Design Phases

### 1.1 — Remove repeated pair-level IDF median and union allocation

- [ ] **File**: `src/analysis/similarity.ts:66-143`
- **Source**: `scip-query code computeIdf -C 10`; `scip-query code weightedCosine -C 20`.
- **What**: `computeIdf` accepts documents only, while `weightedCosine` calls
  `getMedianIdf(idf)` for every pair and allocates `new Set([...a, ...b])`.
- **Change**: Add `computeIdfFromDocFreq(docFreq, documentCount)` so callers
  with doc frequencies do not rescan documents. Add an optional
  `{ medianIdf?: number }` argument to `weightedCosine`. Recompute dot product,
  magnitudes, and shared features using direct set loops rather than a union
  allocation.
- **Why**: The median IDF is constant for a corpus. Sorting it once preserves
  the significant/trivial split while removing repeated O(F log F) work from
  every pair comparison.

### 1.2 — Reuse cached callee fingerprint index in callable similarity

- [ ] **File**: `src/queries/cleanup/similar.ts:154-235`
- **Source**: `scip-query code similarAll -C 20`; `scip-query code getCalleeFingerprintIndex -C 20`.
- **What**: `similarAll` rebuilds doc-frequency and candidate-bucket maps even
  though `getCalleeFingerprintIndex` builds and memoizes that same shape for the
  same `(minCallees, scope, scanLimit, semantic)` options.
- **Change**: Add IDF weights, median IDF, and numeric candidate buckets to
  `CalleeFingerprintIndex`, then make `similarAll` use
  `getCalleeFingerprintIndex`. Iterate numeric candidate buckets directly and
  pass `index.medianIdf` to `comparePair`.
- **Why**: This keeps all callable duplicate ranking semantics but removes a
  duplicate indexing pass and repeated median computation.

### 1.3 — Share the callee fingerprint index with incomplete migration

- [ ] **File**: `src/queries/impact/incomplete-migration.ts:65-69` and
  `src/queries/impact/incomplete-migration.ts:223-288`
- **Source**: `scip-query code buildCandidateIndex -C 15`;
  `scip-query code collectLeftoversForHelper -C 20`;
  `scip-query code buildCalleeFingerprintIndex -C 15`.
- **What**: `incomplete-migration` owns a parallel
  `IncompleteMigrationCandidateIndex` that stores candidates by callee, doc
  frequency, and the same ubiquity threshold.
- **Change**: Import `buildCalleeFingerprintIndex` and `CalleeFingerprintIndex`
  from `similar.ts`; remove the local candidate-index type and builder; use
  numeric candidate buckets in `collectLeftoversForHelper`.
- **Why**: The shared index excludes candidates that only match on ubiquitous
  callees up front. Those candidates were already rejected later, so this
  preserves accuracy while shrinking the work per helper.

## Stress Test Findings

- Accuracy: weighted cosine math must remain equivalent. Add focused tests for
  `computeIdfFromDocFreq` equivalence and `weightedCosine` equivalence with and
  without precomputed median.
- Blast radius: `src/analysis/similarity.ts` has medium-risk exported
  primitives and `src/queries/cleanup/similar.ts` has five external consumers.
  Source: `scip-query change-surface src/analysis/similarity.ts --json` and
  `scip-query change-surface src/queries/cleanup/similar.ts --json`.
- Reversibility: the changes are internal algorithm substitutions. Rollback is
  restoring local candidate-index construction and old `weightedCosine`.
- Concurrency: all shared caches remain per-DB process-local values; no new
  mutable global state is introduced.
- Human impact: output contracts stay byte-shape-compatible; only runtime
  should change.

## Verification

- Focused tests for similarity math and cleanup/impact detectors.
- `npm run typecheck`
- `npx vitest run --reporter=dot`
- Benchmark before/after on this repo:
  `scip-query bench --include-heavy --json`
- Benchmark before/after on Vega_2.0 for:
  `recent-duplicates`, `incomplete-migration`, `health`, and `diff-gate`.
- `scip-query status --capabilities`
- `scip-query reindex` if stale
- `scip-query diff-gate --json`
