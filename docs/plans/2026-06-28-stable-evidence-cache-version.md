# Stable Evidence Cache Version Plan - 2026-06-28

## Goal

Prevent npm patch version bumps from forcing large repositories back onto cold
semantic evidence paths. Done means `scip-query similar --json --full` and
`recent-duplicates --json --full` can reuse content-identical Vega_2.0 semantic
callee rows written by the previous package version, produce identical output
hashes, and avoid the multi-GB cold ts-morph pass observed after bumping to
`0.10.9`.

## Current State

- `similarAll` builds callee fingerprints through `getCalleeFingerprintIndex`,
  then compares weighted-cosine candidate pairs.
  Source: `scip-query plan-context similarAll`.
- `buildCalleeFingerprints` selects production callables and calls
  `ProjectIndex.calleeMap(candidates, { semantic })`.
  Source: `scip-query code buildCalleeFingerprints -C 8`.
- `buildCalleeMap` merges AST callsite evidence, semantic callee evidence, and
  chunk fallback evidence.
  Source: `scip-query plan-context buildCalleeMap`.
- The Vega diagnostic split measured production callable selection at 701ms,
  non-semantic callee-map construction at 276ms, then semantic callee-map
  construction still running past 30s with multi-GB RSS.
  Source: local diagnostic using exported `ProjectIndex` against Vega_2.0.
- `cachedSemanticCalleeMap` calls `readCachedSemanticCallees` for each
  TypeScript-like definition before constructing the ts-morph provider for
  misses.
  Source: `scip-query code cachedSemanticCalleeMap -C 10`.
- `readCachedSemanticCallees` required an exact `VERSION`, and `VERSION` was
  derived from `package.json`.
  Source: `scip-query plan-context readCachedSemanticCallees`.
- Vega's `evidence.db` had 6,677 `semantic_callees` rows for version `0.10.8`
  and zero for version `0.10.9`, so a package patch bump invalidated otherwise
  content-identical semantic cache rows.
  Source: local SQLite inventory of
  `/Users/aydansalois/.cache/scip-query/projects/eec2188f862b/evidence.db`.

## Reuse Audit

- `readCachedSemanticCallees` and `readCachedSemanticReferences` already share
  the same evidence-cache read/disable pattern.
  Source: `scip-query similar readCachedSemanticCallees --json --limit 5`.
- `semanticCalleeRowCount` already exposes semantic callee cache inventory and
  uses the same `connectionFor`/`disable` boundary.
  Source: `scip-query plan-context semanticCalleeRowCount`.
- `packageVersion` only served evidence cache versioning in
  `src/storage/evidence-cache.ts`; its closest match is CLI package-info
  scaffolding, not cache correctness.
  Source: `scip-query similar packageVersion --json --limit 5`.

## Design

### 1. Use a stable evidence payload version

- [x] **File**: `src/storage/evidence-cache.ts:79-92`
- **Source**: `scip-query code evidence-cache -C 4`.
- **What**: `VERSION` was derived from the npm package version, so every patch
  release forced misses even when the cache payload contract and source content
  were unchanged.
- **Change**: Replace package-version lookup with a stable payload contract
  version, `evidence-v1`.
- **Why**: Evidence cache compatibility should change when the payload schema or
  algorithm contract changes, not whenever the CLI package version changes.

### 2. Read compatible rows after exact-version misses

- [x] **File**: `src/storage/evidence-cache.ts:32-42`, `src/storage/evidence-cache.ts:170-195`,
      `src/storage/evidence-cache.ts:211-299`
- **Source**:
  `scip-query plan-context readCachedSemanticCallees`,
  `scip-query code readCachedSemanticCallees -C 8`,
  `scip-query code readCachedSemanticReferences -C 8`.
- **What**: Exact-version reads missed existing rows whose content hash,
  dependency digest, or project fingerprint still matched.
- **Change**: Add compatible read statements for file evidence, semantic
  callees, and semantic references that ignore version only after the
  version-exact lookup misses, while keeping content hash, deps digest, or
  project fingerprint in the key.
- **Why**: This lets package-versioned legacy rows warm the new stable-version
  reader without accepting rows for changed file contents or dependency graphs.

### 3. Update storage tests

- [x] **File**: `tests/storage/evidence-cache.test.ts:138-168`
- **Source**: focused test failure from
  `npm test -- tests/storage/evidence-cache.test.ts ...`.
- **What**: The previous test expected any version drift to miss.
- **Change**: Keep the content-hash mismatch assertion, and assert that same
  content with version drift is now readable.
- **Why**: The test now proves the intended compatibility boundary.

## Stress Test

- Blast radius: `src/storage/evidence-cache.ts` has 28 external consumers and
  feeds source facts, doc drift, import resolution, semantic references, and
  call-graph evidence.
  Source: `scip-query change-surface src/storage/evidence-cache.ts --json --full`.
- Correctness boundary: compatible reads still require the same file content
  hash for file evidence, the same file content hash plus dependency digest for
  semantic callees, or the same project fingerprint for semantic references.
  Source: `scip-query code readCachedSemanticCallees -C 8`,
  `scip-query code readCachedSemanticReferences -C 8`.
- Reversibility: this is a two-way storage read-policy change; reverting the
  stable version and compatible statements restores package-version isolation.
- Failure mode: cache SQLite errors still call `disable()` and degrade to misses.
  Source: `scip-query plan-context readCachedSemanticCallees`.

## Verification

- `npm test -- tests/storage/evidence-cache.test.ts tests/storage/cache-registry.test.ts tests/semantic/typescript/typescript-semantic-provider.test.ts tests/queries/cleanup/similar-topk.test.ts`: passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Vega `similar --json --full`: 2.169s, 88,859 bytes,
  SHA-256 `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf`.
- Vega `recent-duplicates --json --full`: 5.287s, 3,618 bytes,
  SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`.

## Ship Order

Ship as a patch-level performance fix. The accepted behavior is cache reuse
across package versions only when the stronger content/dependency/project keys
still match.
