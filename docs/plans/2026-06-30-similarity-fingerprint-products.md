# Similarity Fingerprint Products — 2026-06-30

## Goal

The user wants the optimization work to become structural instead of a chain of command-specific shortcuts. For this item, "similarity fingerprint product" means the shared read model that turns indexed project facts and source text into reusable callee/source fingerprint corpora and indexes. The real things named by the concept are the `SymbolFingerprint` rows, source-token fingerprints, per-db corpus caches, per-db index caches, and target-specific candidate-pruning logic that drive `similar`, `similarAll`, `recent-duplicates`, health, diff-gate, and incomplete-migration.

Done means the scoring behavior stays the same, but callers stop reaching directly into low-level fingerprint cache functions. They should ask one product-level object for callee corpus, callee index, source corpus, source index, and source candidates, so future optimizations land once and every command receives them.

## Current State

- `src/queries/cleanup/similar.ts:77-113` exports `similar()`, which resolves a target callee fingerprint and falls back to source-shape similarity when the target has no callees or when callee comparison returns no results. Source: `node dist/cli.js code 'src/queries/cleanup/similar.ts:77-147'`.
- `src/queries/cleanup/similar.ts:115-147` has `compareAgainstFingerprints()`, which calls `getCalleeFingerprintIndex()` directly, derives target-specific IDF weights, computes target magnitude, and compares candidate fingerprints. Source: `node dist/cli.js code 'src/queries/cleanup/similar.ts:77-147'`.
- `src/queries/cleanup/similar.ts:260-390` exports `similarAll()`, which calls the product callee index, iterates index buckets by callee, applies focus-file, cross-file, signature, and cosine filters, and keeps only the top ranked results. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:392-509` exports `similarAllCount()`, which repeats the same index walk as `similarAll()` but counts qualifying pairs instead of materializing results. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:513-600` defines `SymbolFingerprint`, product option types, `SimilarityFingerprintProduct`, `CalleeFingerprintIndex`, `SourceFingerprint`, and the source fingerprint file-evidence product. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:691-794` exposes `getAllCalleeFingerprints()`, `getCalleeFingerprintIndex()`, and `similarityFingerprintProduct()`, with option-keyed per-db memoization and profile spans preserved in the low-level cache functions. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:961-1038` implements `similarBySourceShape()`, which now asks the product for source candidates before computing source-token similarity. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:1307-1374` maintains source fingerprint corpus/index caches and derives full-mode source candidates from the index. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:1376-1441` implements target-pruned source candidates by scanning indexed documents for enough target tokens, deriving production callable definitions for matching files, and fingerprinting only those definitions. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/cleanup/similar.ts:1468-1535` builds source fingerprints from production callable definitions, reads/writes per-file source fingerprint evidence keyed by content hash and definition location, and preserves definition order in the returned corpus. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- `src/queries/impact/incomplete-migration.ts:89-220` builds helper callee fingerprints locally and lazily calls the product callee index for the candidate corpus. Source: `node dist/cli.js outline src/queries/impact/incomplete-migration.ts`.
- The blast radius is medium: `src/queries/cleanup/similar.ts` has 21 external consumers, and `getCalleeFingerprintIndex()` affects `compareAgainstFingerprints()`, `similarAll()`, `similarAllCount()`, `incompleteMigration()`, then recent-duplicates, health, diff-gate, and agent hooks transitively. Source: `node dist/cli.js change-surface src/queries/cleanup/similar.ts`, `node dist/cli.js affected getCalleeFingerprintIndex`.
- The SCIP index is fresh and TypeScript semantic evidence is available, so plan citations can use the current graph. Source: `node dist/cli.js status --capabilities`.

Non-obvious invariants to preserve:

- The callee corpus memo intentionally excludes `excludeSymbol` from its key because exclusion is a deterministic post-filter. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- The callee corpus cache clears on whole-project and definition-catalog groups, not source-file clears, to avoid thrashing already extracted fingerprints mid-scan. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- Source fingerprint cache entries are tied to content hash and definition identity, so stale source-token evidence is replaced per file without rebuilding unrelated files. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- Source-shape fallback supports both full-index and target-pruned candidate modes; target-pruned mode is the expensive optimization that avoids fingerprinting the whole corpus for a single target when token prefiltering is enough. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.

## Reuse Audit

- New `SimilarityFingerprintProduct` interface: no existing equivalent owner was found. `similar-files` returned no structurally similar module for `src/queries/cleanup/similar.ts`, and `similar-chains --limit 5` surfaced unrelated domain/config chain pairs rather than an existing evidence-product facade. Source: `node dist/cli.js similar-files src/queries/cleanup/similar.ts`, `node dist/cli.js similar-chains --limit 5`.
- New `similarityFingerprintProduct(db)` factory: reuse the existing per-db caches, cache keys, profile spans, source file-evidence product, and candidate-pruning helpers instead of introducing another cache. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- New source fingerprint product methods: extend the existing `SourceFingerprint`/`SourceFingerprintIndex` flow rather than recreating source-token extraction. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
- Incomplete-migration migration: reuse the new factory while preserving its local helper-fingerprint construction, because `incompleteMigration()` currently scores helpers created in a diff and not necessarily present in the full corpus. Source: `node dist/cli.js outline src/queries/impact/incomplete-migration.ts`.

## Design Phases

### 1.1 — Add the product contract over existing fingerprint caches

- [x] **File**: `src/queries/cleanup/similar.ts:513-600`
- **Source**: `node dist/cli.js outline src/queries/cleanup/similar.ts`
- **What**: Callee fingerprint types are exported, but `SourceFingerprint` and `SourceFingerprintIndex` are private and there is no product-level interface that names the reusable fingerprint read model.
- **Change**: Export `SourceFingerprint` and `SourceFingerprintIndex`, add small option aliases for callee corpus/index and source corpus/index lookup, and add `SimilarityFingerprintProduct` with methods for `calleeCorpus`, `calleeIndex`, `sourceCorpus`, `sourceIndex`, and `sourceCandidates`.
- **Why**: This makes the reusable optimization boundary explicit without moving the scoring math or changing cache invalidation.

### 1.2 — Add a factory that delegates to the current cache functions

- [x] **File**: `src/queries/cleanup/similar.ts:691-794`
- **Source**: `node dist/cli.js outline src/queries/cleanup/similar.ts`
- **What**: `getAllCalleeFingerprints()` and `getCalleeFingerprintIndex()` own per-db callee corpus/index caching directly.
- **Change**: Add `similarityFingerprintProduct(db)` after the cache-backed functions. Each method delegates to the existing cache-backed function or source candidate helper. Leave the exported low-level functions in place as compatibility shims for this deployable phase.
- **Why**: Every command can now share the same access contract while the old API remains reversible.

### 1.3 — Route callee-scoring paths through the product

- [x] **File**: `src/queries/cleanup/similar.ts:115-147`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/similar.ts:77-147'`
- **What**: `compareAgainstFingerprints()` calls `getCalleeFingerprintIndex()` directly.
- **Change**: Replace the direct call with `similarityFingerprintProduct(db).calleeIndex(...)`.
- **Why**: Single-target callee comparison should get future index/candidate optimizations through the product.

- [x] **File**: `src/queries/cleanup/similar.ts:260-390`
- **Source**: `node dist/cli.js outline src/queries/cleanup/similar.ts`
- **What**: `similarAll()` calls `getCalleeFingerprintIndex()` directly before pair scanning.
- **Change**: Create a product once inside the outer profile span and get the callee index through `product.calleeIndex(...)`.
- **Why**: Bulk pair scanning is one of the largest consumers of the fingerprint index, so it should use the canonical access point.

- [x] **File**: `src/queries/cleanup/similar.ts:392-509`
- **Source**: `node dist/cli.js outline src/queries/cleanup/similar.ts`
- **What**: `similarAllCount()` repeats the bulk pair scan and also calls `getCalleeFingerprintIndex()` directly.
- **Change**: Create a product once inside the outer profile span and get the callee index through `product.calleeIndex(...)`.
- **Why**: Count mode must share the same product-level optimization path as result mode.

### 1.4 — Route source-shape candidate selection through the product

- [x] **File**: `src/queries/cleanup/similar.ts:961-1038`
- **Source**: `node dist/cli.js outline src/queries/cleanup/similar.ts`
- **What**: `similarBySourceShape()` chooses between `targetPrunedSourceCandidatesForTarget()` and `sourceCandidatesFromIndex(target, getSourceFingerprintIndex(...))` inline.
- **Change**: Create a product once in the profile span and call `product.sourceCandidates(target, { minSimilarity, scanLimit: opts.scanLimit, candidateMode })`.
- **Why**: Target-specific pruning becomes part of the shared fingerprint product instead of a private one-off in the source-shape fallback.

### 1.5 — Migrate incomplete-migration to the product API

- [x] **File**: `src/queries/impact/incomplete-migration.ts:89-220`
- **Source**: `node dist/cli.js outline src/queries/impact/incomplete-migration.ts`
- **What**: `incompleteMigration()` lazily calls `getCalleeFingerprintIndex()` while scoring new helper shapes.
- **Change**: Import `similarityFingerprintProduct` instead of `getCalleeFingerprintIndex`, create the product once near helper fingerprint construction, and have the lazy getter call `fingerprints.calleeIndex(...)`.
- **Why**: The diff-gate path should receive the same shared index behavior without changing how new helper fingerprints are built.

### 1.6 — Add regression coverage for the product contract

- [x] **File**: `tests/queries/cleanup/similarity-fingerprint-product.test.ts` (new file)
- **Source**: `node dist/cli.js affected getCalleeFingerprintIndex`
- **What**: Existing consumers exercise `similar()`/`similarAll()` indirectly, but the new product-level contract has no direct assertion.
- **Change**: Add a focused test that builds a small fixture database, asks the product for a callee index twice with the same options, asserts referential cache reuse, and checks source candidate lookup returns stable non-target candidates for full and target-pruned modes.
- **Why**: The optimization boundary should have one test that asserts cache reuse and candidate routing without depending on command-specific output formatting.

## Stress-Test Findings

1. Understand before touch: the current code optimizes expensive similarity by caching production callable fingerprints and source-token fingerprints; the product wraps those existing facts, it does not redefine similarity. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
2. Blast radius: `getCalleeFingerprintIndex()` affects 17 symbols across 7 files; the plan keeps the low-level function exported and migrates only direct internal consumers found by the graph. Source: `node dist/cli.js affected getCalleeFingerprintIndex`.
3. Valid intermediate states: Phases 1.1 and 1.2 are additive; phases 1.3 through 1.5 only swap call sites to an equivalent delegate; phase 1.6 adds tests after behavior remains buildable. Source: `node dist/cli.js trace getCalleeFingerprintIndex`.
4. Reversibility: every phase is a two-way internal refactor. Rolling back means restoring direct calls to `getCalleeFingerprintIndex()` and direct source candidate helpers.
5. Failure design: no new async path, database write, or external input is added. Existing source fingerprint cache read/write behavior remains in `sourceFingerprintsForDefinitions()`. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
6. Concurrency: product methods share the same process-local per-db cache maps used today; no new mutable global state or cross-process lock is introduced. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
7. Boundaries: affected entry points remain CLI/internal query functions; no user authorization boundary changes. Source: `node dist/cli.js surface src/queries/cleanup/similar.ts`.
8. Data integrity: no SQLite schema or evidence cache format changes are planned; `SOURCE_FINGERPRINT_PRODUCT` serialization remains unchanged. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
9. Observability: existing profile spans stay in the low-level cache functions and source candidate functions. The product must not bypass `similar.callee-index.resolve`, `similar.callee-fingerprints.resolve`, or source-shape spans. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
10. Human impact: command output and recommendations stay unchanged because result sorting, evidence classification, and similarity thresholds are untouched. Source: `node dist/cli.js outline src/queries/cleanup/similar.ts`.
11. Reuse: the product reuses the current cache implementation; no new cache, scorer, or source-tokenizer is introduced. Source: `node dist/cli.js similar-files src/queries/cleanup/similar.ts`, `node dist/cli.js similar getCalleeFingerprintIndex`.

## Execution Order

1. Add exported product types and factory in `src/queries/cleanup/similar.ts`.
2. Migrate `compareAgainstFingerprints()`, `similarAll()`, `similarAllCount()`, and `similarBySourceShape()` to the product.
3. Migrate `incompleteMigration()` to the product.
4. Add direct product contract tests.
5. Run typecheck, focused tests, cleanup command smokes, structural checks, benchmark, `scip-query reindex`, and `scip-query diff-gate`.

## Ship Order

Ship as one deployable internal refactor. There are no one-way doors: no schema change, no cache format change, no public CLI output change, and low-level functions remain exported for compatibility.

## Summary

Files to modify:

- `src/queries/cleanup/similar.ts`
- `src/queries/impact/incomplete-migration.ts`
- `tests/queries/cleanup/similarity-fingerprint-product.test.ts`

Expected net effect: small type/interface additions, four direct call-site migrations, one test file, no scoring math changes.
