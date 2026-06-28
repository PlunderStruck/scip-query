# Semantic Reference Bulk Plan - 2026-06-28

## Goal

Apply the same class of optimization from semantic callee extraction to the
reference-side caller evidence path. Done means commands that fill semantic
reference evidence can resolve cache misses in batches while preserving the
same `semantic_references` cache contract and caller-file output.

## Current State

`scip-query plan-context semanticCallerMap --json` shows
`src/semantic/shared-primitives.ts:25-49` loops through every definition,
calling `semanticReferencesForCallerMap()` one definition at a time, then
writes cache rows in one batch. Its callers include `dead`, `isolated`,
`stale-abstractions`, `change-surface`, `diff-impact`, and
`buildCrossFileCallerMap`.

`scip-query plan-context TsMorphSemanticProvider#referencesFor --json` shows
`src/semantic/typescript/ts-morph-provider.ts:147-154` resolves one definition
through `nodeForDefinition()`, `packageImportReferencesForDefinition()`, and
`semanticReferencesForNode()`.

`scip-query code src/semantic/typescript/semantic-locations.ts:1-140 --json`
shows `semanticReferencesForNode()` owns the current reference semantics:
`findReferences()`, declaration-range filtering, package refs, and dedupe.

## Reuse Audit

Reuse the callee bulk pattern already in
`src/semantic/shared-primitives.ts:86-147` and
`src/semantic/typescript/ts-morph-provider.ts:165-186`: optional provider bulk
method, group definitions by provider, fall back to scalar methods for providers
without bulk support, and preserve per-definition result maps.

The first pass should reuse `semanticReferencesForNode()` so dispatch
granularity changes before semantics. If profiling proves `findReferences()`
itself dominates, the second pass may add a lower-level bulk algorithm only
with side-by-side output verification and a precise fallback for cases where
TypeScript's related-symbol search is required.

## Design

### 1. Add Provider Bulk References

- [x] **File**: `src/semantic/types.ts:40-48`
- **Source**: `scip-query code src/semantic/types.ts:1-80 --json`
- **What**: `SemanticProvider` exposes scalar `referencesFor()` and optional
  bulk `calleesForDefinitions()`.
- **Change**: Add optional
  `referencesForDefinitions?(definitions): Map<number, SemanticReference[]>`.
- **Why**: Shared semantic caller evidence can request many definitions at
  once, just like semantic callee evidence.

### 2. Batch Shared Reference Misses

- [x] **File**: `src/semantic/shared-primitives.ts:25-81`
- **Source**: `scip-query plan-context semanticCallerMap --json`
- **What**: `semanticCallerMap()` loops definitions, reads cache, calls scalar
  reference resolution on each miss, then writes cache rows.
- **Change**: Split cache scan, compute misses, and cache write into profiled
  spans. Route misses through a new grouped `semanticReferenceMap()` that uses
  `provider.referencesForDefinitions()` when available and scalar fallback
  otherwise.
- **Why**: This mirrors the callee optimization and lets every caller-map
  consumer benefit from one shared batch path.

### 3. Implement TypeScript Bulk References

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts:147-186`
- **Source**:
  `scip-query plan-context TsMorphSemanticProvider#referencesFor --json`
- **What**: `referencesFor()` resolves one definition through cached node
  lookup and current reference semantics.
- **Change**: Add `referencesForDefinitions()` that groups definitions by file,
  reads `definitionNodesForFile()` once per file, computes missing
  `referencesCache` entries, and returns a `Map` for all requested definitions.
- **Why**: The implementation preserves `semanticReferencesForNode()` while
  removing scalar provider dispatch and repeated per-file setup.

### 4. Add Inverted TypeScript Reference Scan

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts`
- **Source**: Vega cold `dead --json --full` profile:
  `semantic.references.compute-misses` stayed above 22s after dispatch batching,
  with most time inside per-definition `findReferences()`.
- **What**: Large non-member definition sets can be resolved by walking indexed
  TypeScript source files once, checking likely identifier names, resolving
  compiler symbols, and inverting those references back to requested symbol ids.
- **Change**: For at least 128 non-member misses, use an inverted checker scan
  with a cheap name prefilter. Keep precise `findReferences()` for member
  symbols (`#`) because TypeScript's related-symbol reference search protects
  class override/interface-member accuracy.
- **Why**: This changes the hot path from thousands of semantic reference
  searches to one program scan while preserving the legacy Vega output hash.

### 5. Instrument Dead Caller Evidence

- [x] **File**: `src/queries/cleanup/dead.ts`
- **Source**: Vega profile showed `dead.caller-map-supplement` dominated cold
  `dead --full`.
- **What**: Add profiling spans around candidate loading, mention counts,
  source fallback, caller-map supplement, chunk caller loading, and semantic
  candidate filtering.
- **Change**: Expose stage counts and timings in `bench --profile` JSONL.
- **Why**: Future dead/health optimization can target the exact stage instead
  of treating the command as one opaque timing.

## Verification

1. `npx tsc --noEmit --pretty false`
2. Focused semantic/reference tests.
3. `npm run build`
4. Focused Vega benchmark/profile on a semantic caller-map consumer.
5. Legacy/current Vega output hash comparison.
6. `node dist/cli.js reindex`
7. `node dist/cli.js diff-impact --json`
8. `node dist/cli.js diff-gate --json`

## Accepted Measurements

- Legacy current-commit baseline (`0720bac`) cold direct on Vega:
  `dead --json --full` in 24.40s, 3,804,419 bytes, SHA-256
  `b7afa7e3cdd88c02ed31ffaf02da9547b6187591ef681dc67882dbfef76bc2e8`.
- Final filtered hybrid cold direct on Vega: 14.31s, same 3,804,419 bytes and
  same SHA-256.
- Final filtered hybrid cold profiled bench on Vega: 13.333s. The profile
  recorded `typescript.references-map.inverted-scan` at 3.034s for 3,623
  non-member definitions and 103,232 checker lookups, plus precise member
  `typescript.references-map.file` at 5.386s for 572 definitions.
- Warm control after cache-fill: 1.064s, same output size.

## Rejected / Superseded Trials

- Pure dispatch batching preserved semantics but did not materially improve
  cold time: Vega profiled runs stayed around 25.6s-26.1s because
  `findReferences()` remained the dominant cost.
- Unfiltered inverted scan was faster (16.38s direct) and found more references,
  but it introduced 17 new dead findings for class members/overrides because it
  did not model TypeScript related-symbol searches. Superseded by the hybrid
  precise-member fallback.
- Hybrid without the name prefilter preserved member precision and removed 13
  legacy findings, but cold direct runtime was still 23.42s. Superseded by the
  filtered hybrid that preserves the legacy output hash and cuts cold runtime
  more substantially.
