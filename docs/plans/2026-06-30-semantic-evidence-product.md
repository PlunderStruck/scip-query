# Semantic Evidence Product — 2026-06-30

## Goal

The user wants the fifth structural optimization register item completed in order: semantic facts should become a product-level contract instead of a group of command-facing helper functions. In this repo, semantic facts are compiler-backed observations from the TypeScript semantic provider: import usage, references, caller files derived from references, callees, and normalized signatures. A semantic evidence product is the shared object that tells callers whether those facts are available for a file/language and, when available, returns the facts through one owner boundary.

Done means TypeScript remains the only semantic provider, existing commands keep their current behavior, and "semantic unavailable" becomes an explicit product capability result instead of each command inventing its own provider/option branch.

## Current State

- `src/semantic/shared-primitives.ts:20-50` now defines semantic evidence slots, capability results, the product interface, and `semanticEvidenceProduct(db)`, whose methods route capability, import usage, references, caller maps, callee maps, and signatures through one owner boundary. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:1-120'`.
- `src/semantic/shared-primitives.ts:52-80` preserves the legacy `semanticImportUsage()`, `semanticReferences()`, and `semanticCallerMap()` exports as product-delegating compatibility wrappers; the private builders still return empty arrays when no TypeScript provider is available. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:1-120'`.
- `src/semantic/shared-primitives.ts:82-180` keeps the existing caller-map cache behavior: it reads persisted semantic reference rows by project evidence fingerprint, computes misses, records cross-file caller files, and batch-writes misses only if the semantic references slot is available. Source: `node dist/cli.js outline src/semantic/shared-primitives.ts`, `node dist/cli.js code 'src/semantic/shared-primitives.ts:1-120'`.
- `src/semantic/shared-primitives.ts:182-283` keeps semantic reference cache parsing and caller-file recording behind the product builder rather than changing the persisted row format. Source: `node dist/cli.js outline src/semantic/shared-primitives.ts`.
- `src/semantic/shared-primitives.ts:285-380` preserves `semanticCalleeMap()` and `semanticSignature()` as product-delegating wrappers while the private callee builder keeps the bulk-provider path, scalar fallback path, and profiling counters. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:280-416'`.
- `src/semantic/shared-primitives.ts:382-415` makes semantic absence explicit: non-TypeScript paths return an unavailable TypeScript capability with a reason, provider construction failures become unavailable capabilities, and `availableTypeScriptProvider()` still rejects non-TypeScript files for fact builders. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:280-416'`.
- `src/semantic/provider-cache.ts:19-31` owns expensive provider construction in a per-db cache keyed to the TypeScript workspace. Source: `node dist/cli.js code 'src/semantic/provider-cache.ts:1-32'`.
- `src/semantic/types.ts:3-50` defines the semantic availability, import usage, reference, callee, and provider contracts used by all semantic helpers. Source: `node dist/cli.js code 'src/semantic/types.ts:1-51'`.
- `src/storage/evidence-cache.ts:151-167` stores semantic callees and semantic references in dedicated symbol-scoped tables, not in the file-evidence product table. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:120-260'`.
- `src/storage/evidence-cache.ts:264-365` provides disable-on-error read/write helpers for semantic callee/reference rows and batch writes. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:260-380'`.
- `src/symbols/graph/call-graph-evidence.ts:290-389` has a semantic callee cache layer that reads/writes semantic callee rows, computes misses with `semanticCalleeMap()`, and asks `semanticEvidenceProduct(db).capability('semantic-callees').available` before writing. Source: `node dist/cli.js code 'src/symbols/graph/call-graph-evidence.ts:290-390'`.
- `src/queries/quality/self-audit.ts:161-170` probes `semanticEvidenceProduct(db).capability('semantic-references', probe.relativePath).available` to decide whether semantic can be an audit oracle. Source: `node dist/cli.js code 'src/queries/quality/self-audit.ts:158-172'`.
- `src/semantic/index.ts:1-19` re-exports the low-level provider, existing helper functions, and the semantic product/capability contract. Source: `node dist/cli.js outline src/semantic/index.ts`.
- The shared primitive file remains high risk because it has 38 external consumers; `semanticCallerMap()` alone affects 26 symbols across 15 files. Source: `node dist/cli.js change-surface src/semantic/shared-primitives.ts`, `node dist/cli.js affected semanticCallerMap`.
- The SCIP index is fresh and TypeScript semantic evidence is available. Source: `node dist/cli.js status --capabilities`.

Non-obvious invariants to preserve:

- The semantic provider cache is deliberately behind `getSemanticProvider()` so query modules do not depend on concrete ts-morph provider construction. Source: `node dist/cli.js code 'src/semantic/provider-cache.ts:1-32'`.
- Semantic references use a project evidence fingerprint instead of per-file content hashes, because reference results can depend on project-level indexed language inputs. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:1-120'` and `node dist/cli.js code 'src/storage/evidence-cache.ts:1-120'`.
- Semantic callees are content-hash plus dependency-digest guarded; stale callee rows are dropped per file on write. Source: `node dist/cli.js code 'src/symbols/graph/call-graph-evidence.ts:290-390'`, `node dist/cli.js code 'src/storage/evidence-cache.ts:260-380'`.
- Bulk provider APIs are optional and must remain optional; scalar fallback keeps the product compatible with future semantic providers that do not batch. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:280-416'`.

## Reuse Audit

- New `SemanticEvidenceProduct` interface: reuse `SemanticAvailability`, `SemanticImportUsage`, `SemanticReference`, `SemanticCallee`, and `SemanticProvider` from `src/semantic/types.ts:3-50` instead of creating parallel fact shapes. Source: `node dist/cli.js code 'src/semantic/types.ts:1-51'`.
- New `semanticEvidenceProduct(db)` factory: extend `src/semantic/shared-primitives.ts` because it is already the owner for semantic import/reference/caller/callee/signature primitives and has all semantic consumers. Source: `node dist/cli.js plan-context src/semantic/shared-primitives.ts`.
- New capability slot type: no equivalent first-class slot object exists; `similar-files` found no structurally similar file for `src/semantic/shared-primitives.ts`, and `surface` shows only the current helper functions. Source: `node dist/cli.js similar-files src/semantic/shared-primitives.ts`, `node dist/cli.js surface src/semantic/shared-primitives.ts`.
- Storage registry reuse: do not force symbol-scoped semantic reference/callee rows into `createFileEvidenceProduct()`, because `src/storage/evidence-cache.ts:151-167` stores them in dedicated semantic tables with different keys. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:120-260'`, `node dist/cli.js code 'src/storage/evidence-products.ts:1-50'`.
- Direct provider consumers: `call-graph-evidence` and `self-audit` now use the product capability method; `getSemanticProvider()` remains exported from `src/semantic/index.ts:1-19` as a low-level provider boundary for callers that truly need the provider. Source: `node dist/cli.js trace getSemanticProvider`, `node dist/cli.js trace semanticEvidenceProduct`, `node dist/cli.js outline src/semantic/index.ts`.

## Design Phases

### 1.1 — Add semantic product types and capability slots

- [x] **File**: `src/semantic/shared-primitives.ts:20-39`
- **Source**: `node dist/cli.js code 'src/semantic/shared-primitives.ts:1-120'`
- **What**: Semantic helpers are exported as independent functions, and provider absence is represented only as empty arrays or `null`.
- **Change**: Import `SemanticAvailability`, add `SemanticEvidenceSlot`, `SemanticEvidenceCapability`, and `SemanticEvidenceProduct`. Slots are `semantic-references`, `semantic-callers`, `semantic-callees`, `semantic-import-usage`, and `semantic-signatures`.
- **Why**: Capability absence becomes a named semantic product state rather than an implicit empty result.

### 1.2 — Add `semanticEvidenceProduct(db)` and preserve wrappers

- [x] **File**: `src/semantic/shared-primitives.ts:41-80`, `src/semantic/shared-primitives.ts:285-380`
- **Source**: `node dist/cli.js plan-context src/semantic/shared-primitives.ts`
- **What**: `semanticImportUsage()`, `semanticReferences()`, `semanticCallerMap()`, `semanticCalleeMap()`, and `semanticSignature()` own provider lookup directly.
- **Change**: Add `semanticEvidenceProduct(db)` that returns methods `capability`, `importUsage`, `references`, `callerMap`, `calleeMap`, and `signature`. Rename current implementations to private `buildSemantic*` functions, and make the existing exports delegate to the product.
- **Why**: Existing consumers remain source-compatible while future consumers have one product-level contract.

### 1.3 — Route semantic callee cache writes through product capability

- [x] **File**: `src/symbols/graph/call-graph-evidence.ts:1-40`
- **Source**: `node dist/cli.js code 'src/symbols/graph/call-graph-evidence.ts:1-40'`
- **What**: The module imports `getSemanticProvider` only to check availability in the semantic callee cache write path.
- **Change**: Replace the direct provider import with `semanticEvidenceProduct` from `src/semantic/shared-primitives.ts`.
- **Why**: Cache-write decisions should ask the semantic product whether the callee slot is available.

- [x] **File**: `src/symbols/graph/call-graph-evidence.ts:290-389`
- **Source**: `node dist/cli.js code 'src/symbols/graph/call-graph-evidence.ts:290-390'`
- **What**: `cachedSemanticCalleeMap()` checks `getSemanticProvider(db).availability().available` before writing semantic callee cache entries.
- **Change**: Replace that check with `semanticEvidenceProduct(db).capability('semantic-callees').available`.
- **Why**: This makes semantic unavailability a product state in a hot semantic callee path.

### 1.4 — Route self-audit semantic oracle probing through product capability

- [x] **File**: `src/queries/quality/self-audit.ts:161-170`
- **Source**: `node dist/cli.js code 'src/queries/quality/self-audit.ts:158-172'`
- **What**: `oracleKindForSample()` directly probes `getSemanticProvider()` inside a try/catch to decide whether semantic can be the audit oracle.
- **Change**: Import `semanticEvidenceProduct` and replace the direct provider availability probe with `semanticEvidenceProduct(db).capability('semantic-references', probe.relativePath).available`.
- **Why**: Self-audit should use the same capability contract as other semantic consumers.

### 1.5 — Re-export the product contract and extend semantic tests

- [x] **File**: `src/semantic/index.ts:1-19`
- **Source**: `node dist/cli.js outline src/semantic/index.ts`
- **What**: The semantic module re-exports current helpers and types, but not a product contract.
- **Change**: Export `semanticEvidenceProduct` and the new semantic product/capability types.
- **Why**: The public semantic module should expose the product boundary.

- [x] **File**: `tests/semantic/typescript/typescript-semantic-provider.test.ts` (test file not indexed by scip-query; source behavior is cited above)
- **Source**: `node dist/cli.js trace semanticImportUsage`, `node dist/cli.js trace semanticCallerMap`, `node dist/cli.js trace semanticSignature`
- **What**: The existing TypeScript semantic provider test asserts the legacy helpers.
- **Change**: Extend it to create a `semanticEvidenceProduct(db)`, assert the import-usage capability is available for a TypeScript source file, assert a non-TypeScript path returns unavailable capability, and assert product methods return the same import usage, caller map, and signature facts as the legacy wrappers.
- **Why**: The product contract needs direct coverage without losing the existing end-to-end semantic provider assertions.

## Stress-Test Findings

1. Understand before touch: semantic helpers are already shared and optimized; this change names the product boundary and does not rewrite ts-morph provider logic. Source: `node dist/cli.js plan-context src/semantic/shared-primitives.ts`, `node dist/cli.js outline src/semantic/typescript/ts-morph-provider.ts`.
2. Blast radius: `src/semantic/shared-primitives.ts` is high risk with 32 external consumers, so the plan keeps all existing exports and migrates only two direct provider availability probes. Source: `node dist/cli.js change-surface src/semantic/shared-primitives.ts`, `node dist/cli.js trace getSemanticProvider`.
3. Valid intermediate states: phases 1.1 and 1.2 are additive and wrapper-preserving; phases 1.3 and 1.4 only replace availability checks; phase 1.5 adds exports/tests.
4. Reversibility: all changes are internal TypeScript refactors. Rollback restores direct helper bodies and direct provider probes; no persisted evidence format or schema changes are included.
5. Failure design: product capability returns unavailable for non-TypeScript paths and for unavailable providers; existing empty array/null fallbacks remain on the legacy helper wrappers. Source: `node dist/cli.js code 'src/semantic/shared-primitives.ts:280-416'`.
6. Concurrency: no new cache or mutable process-global state is added; provider construction remains in `PROVIDER_CACHE`. Source: `node dist/cli.js code 'src/semantic/provider-cache.ts:1-32'`.
7. Boundaries: no CLI/user input boundary changes. The semantic product is an internal query/module boundary. Source: `node dist/cli.js surface src/semantic/shared-primitives.ts`.
8. Data integrity: no SQLite table, key, version, or evidence payload shape changes. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:120-260'`, `node dist/cli.js code 'src/storage/evidence-cache.ts:260-380'`.
9. Observability: existing profile spans in reference/callee cache scans, provider loops, and cache writes remain in the private build functions. Source: `node dist/cli.js trace semanticCallerMap`, `node dist/cli.js trace semanticCalleeMap`.
10. Human impact: command outputs remain unchanged because existing helper signatures and return fallbacks remain unchanged.
11. Reuse: the product reuses the current provider cache, semantic types, reference cache, callee cache, and test fixture. Source: `node dist/cli.js code 'src/semantic/provider-cache.ts:1-32'`, `node dist/cli.js code 'src/semantic/types.ts:1-51'`, `node dist/cli.js similar-files src/semantic/shared-primitives.ts`.

## Execution Order

1. Add semantic product/capability types and factory in `src/semantic/shared-primitives.ts`.
2. Convert existing exported helpers into product-delegating wrappers.
3. Migrate direct provider availability checks in call-graph evidence and self-audit.
4. Re-export the product contract from `src/semantic/index.ts`.
5. Extend the TypeScript semantic provider test.
6. Run typecheck, focused semantic tests, semantic-relevant command smokes, structural checks, full tests, benchmark, reindex, and diff-gate.

## Ship Order

Ship as one internal refactor. There are no one-way doors: no schema changes, no cache key changes, no provider behavior changes, and existing helper exports remain.

## Summary

Files modified:

- `src/semantic/shared-primitives.ts`
- `src/symbols/graph/call-graph-evidence.ts`
- `src/queries/quality/self-audit.ts`
- `src/semantic/index.ts`
- `tests/semantic/typescript/typescript-semantic-provider.test.ts`

Expected net effect: a small semantic product/capability API, two availability-call migrations, existing wrapper compatibility, and expanded semantic provider tests.
