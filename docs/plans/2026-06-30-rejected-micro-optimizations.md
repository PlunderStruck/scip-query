# Rejected Micro-optimizations Plan - 2026-06-30

## Goal

The user wants the structural optimization register finished in order without disturbing the performance work already landed. A micro-optimization is a small code-level speed change in a real loop, cache, or reference path whose defining trait is that it alters local mechanics while leaving the tool's evidence contract unchanged. An architectural optimization is a reusable structure whose defining trait is that it makes many consumers faster or more precise by changing where evidence is produced, cached, or scheduled.

Done for this item means no production code changes unless SCIP evidence shows a reusable structure that is missing. The register examples here are ledger lessons: preserve the existing targeted paths, record why broad rewrites stay rejected, and verify the repo still gates cleanly.

## Current State

`scip-query status --capabilities` reported a fresh TypeScript index with semantic support available, so the following references are SCIP-backed.

Set overlap helpers are intentionally tiny shared primitives. `src/analysis/similarity.ts:17-42` defines `intersection()` by iterating `a` and checking `b.has(item)`, and defines `jaccard()` by counting shared items over the same iteration shape before deriving the union size. `scip-query plan-context intersection --json` reports `intersection()` at `src/analysis/similarity.ts:17-23`, fan-in 6, eight reverse-dependent files, and medium risk for the shared module. `scip-query similar intersection --json` and `scip-query similar jaccard --json` show overlap with the neighboring set math primitives and generic set loops, not a missing higher-level product.

Semantic references already have a workload boundary. `scip-query code 'TsMorphSemanticProvider#referencesForDefinitions' -C 5` shows `src/semantic/typescript/ts-morph-provider.ts:197-257` checking the per-symbol cache, splitting misses into precise-search definitions and bulk-scan definitions, and only calling `referencesForDefinitionsBySymbolScan()` when at least `BULK_REFERENCE_SCAN_MIN_DEFINITIONS` non-precise definitions are present. `scip-query code 'TsMorphSemanticProvider#referencesForDefinitionsBySymbolScan' -C 5` shows `src/semantic/typescript/ts-morph-provider.ts:260-320` scanning indexed TypeScript-like documents only after package import references have been added and ignored paths have been skipped. `scip-query code 'TsMorphSemanticProvider#addReferencesFromSourceFileScan' -C 5` shows `src/semantic/typescript/ts-morph-provider.ts:323-377` filtering identifier text with `referenceNames` and `importLocalNames` before resolving compiler symbols, then accepting only requested symbol IDs and excluding definition self-locations.

Package-import reference dispatch is local. `scip-query code src/semantic/typescript/ts-morph-provider.ts:627-644` shows `addPackageImportReferencesForDeclaration()` deriving references for one import declaration and calling `addReferencesForSymbols()` only when textual identifier locations exist. `scip-query refs addReferencesForSymbols --json` reports that single call site at `src/semantic/typescript/ts-morph-provider.ts:642`; `scip-query code addReferencesForSymbols -C 5` shows the helper at `src/semantic/typescript/ts-morph-provider.ts:1107-1116` appending the same reference list into symbol buckets.

Scoped definition loading already has a targeted replacement for broad scans. `scip-query code getScopedDefinitions -C 5` shows `src/symbols/definition-catalog.ts:290-293` reading definitions by indexed document path and filtering ignored rows. `scip-query code getScopedDefinitionsMatchingSymbols -C 5` shows `src/symbols/definition-catalog.ts:302-324` loading primary and fallback rows with optional SQL prefilters, merging the rows, applying the requested symbol predicate, and preserving source range correction. `scip-query code loadScopedPrimaryDefinitionRows -C 5` and `scip-query code loadScopedFallbackDefinitionRows -C 5` show `src/symbols/definition-catalog.ts:327-392` applying scope, symbol, path-exclusion, and symbol-noise filters inside SQL.

## Reuse Audit

No new symbol is proposed.

`scip-query recent-duplicates --json` returned no findings. `scip-query similar intersection --json` and `scip-query similar jaccard --json` found neighboring set math and generic set-loop overlap, which supports keeping the primitives simple rather than adding another abstraction around them. `scip-query similar 'TsMorphSemanticProvider#referencesForDefinitionsBySymbolScan' --json` found only the existing `referencesForDefinitions()` flow, confirming the batch boundary is already inside the semantic provider. `scip-query similar getScopedDefinitionsMatchingSymbols --json` found the helper's own SQL row loaders, not a broader reusable read model. `scip-query similar addReferencesForSymbols --json` found bucket-append shapes in unrelated reference/call graph code, but the evidence was mixed scaffolding and not a shared semantic-reference contract.

The existing reuse targets are therefore the current ones: `referencesForDefinitions()` keeps the semantic reference cache and scan threshold together, `referencesForDefinitionsBySymbolScan()` owns large non-precise scans, and `getScopedDefinitionsMatchingSymbols()` owns symbol-prefiltered scoped definition loading.

## Design Phases

### 1.1 - Keep Set Helper Micro-tweaks Rejected

- [x] **File**: `src/analysis/similarity.ts:17-42`
- **Source**: `scip-query code src/analysis/similarity.ts:17-42`; `scip-query plan-context intersection --json`; `scip-query similar intersection --json`; `scip-query similar jaccard --json`
- **What**: `intersection()` and `jaccard()` are minimal shared set primitives used by multiple cleanup and frontend detectors.
- **Change**: Do not add smaller-set iteration or a new shared loop helper in this pass.
- **Why**: The potential gain is local to tiny loops, while the functions are shared enough that churn would require cross-detector regression proof. No missing structural product appeared in the reuse audit.

### 1.2 - Keep Semantic Reference Batching Inside the Provider

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts:197-377`
- **Source**: `scip-query plan-context 'TsMorphSemanticProvider#referencesForDefinitions' --json`; `scip-query code 'TsMorphSemanticProvider#referencesForDefinitions' -C 5`; `scip-query code 'TsMorphSemanticProvider#referencesForDefinitionsBySymbolScan' -C 5`; `scip-query code 'TsMorphSemanticProvider#addReferencesFromSourceFileScan' -C 5`
- **What**: The provider separates cache hits, precise reference searches, large non-precise inverted scans, ignored-file filtering, identifier-name prefiltering, requested-symbol filtering, and self-location suppression.
- **Change**: Do not introduce pure dispatch batching or unfiltered inverted scans.
- **Why**: The existing threshold and filters are the architectural optimization. Moving the batching out or scanning without those guards would weaken precision and make the workload boundary harder to reason about.

### 1.3 - Keep Package Reference Dispatch Local

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts:627-644`; `src/semantic/typescript/ts-morph-provider.ts:1107-1116`
- **Source**: `scip-query code src/semantic/typescript/ts-morph-provider.ts:627-644`; `scip-query code addReferencesForSymbols -C 5`; `scip-query refs addReferencesForSymbols --json`; `scip-query similar addReferencesForSymbols --json`
- **What**: `addReferencesForSymbols()` appends package-import textual references to exported symbol buckets and has one call site.
- **Change**: Do not promote it into a general semantic-reference dispatcher.
- **Why**: The helper is coupled to package import references; similar hits are generic bucket appends with different evidence contracts.

### 1.4 - Keep Scoped Definition Prefiltering Targeted

- [x] **File**: `src/symbols/definition-catalog.ts:290-392`
- **Source**: `scip-query plan-context getScopedDefinitionsMatchingSymbols --json`; `scip-query code getScopedDefinitions -C 5`; `scip-query code getScopedDefinitionsMatchingSymbols -C 5`; `scip-query code loadScopedPrimaryDefinitionRows -C 5`; `scip-query code loadScopedFallbackDefinitionRows -C 5`; `scip-query refs getScopedDefinitionsMatchingSymbols --json`
- **What**: Broad scoped reads still exist, while symbol-matching callers can use `getScopedDefinitionsMatchingSymbols()` to push coarse filters into SQL and retain source range correction.
- **Change**: Do not replace all `getScopedDefinitions()` usage with the symbol-matching helper.
- **Why**: The helper has two specific consumers and a symbol predicate contract. A broad replacement would mix full-catalog reads with filtered reads and risk silently dropping definitions for callers that do not have a safe symbol predicate.

### 1.5 - Verify the Ledger-only Decision

- [x] **File**: `docs/plans/2026-06-30-rejected-micro-optimizations.md`
- **Source**: `scip-query doc-drift docs/structural-optimization-register.md --json`; `scip-query recent-duplicates --json`
- **What**: The structural optimization register has no doc-drift findings, and recent duplicate detection has no findings.
- **Change**: Format this plan and run the final repo gate.
- **Why**: This item changes documentation only; the gate proves the no-code implementation did not disturb the indexed project.

## Stress Test

1. Understand before touching: the current code already separates tiny math primitives, semantic reference workload thresholds, package import dispatch, and scoped definition prefiltering by evidence contract.
2. Blast radius: `plan-context intersection` shows medium-risk shared consumers; `plan-context 'TsMorphSemanticProvider#referencesForDefinitions'` shows semantic provider co-change history and consumers through `semanticReferenceMap()`; `plan-context getScopedDefinitionsMatchingSymbols` shows its two direct consumers.
3. Valid intermediate state: no production code changes are required, so the only intermediate state is adding this plan.
4. Reversibility: the change is a docs-only two-way door.
5. Failure design: no runtime path is added. The rejected semantic scan changes would have introduced precision failures, so they stay rejected.
6. Concurrency: no shared mutable runtime state changes; semantic caches and evidence caches are left untouched.
7. Boundaries: no CLI, database, or user-input boundary changes.
8. Data integrity: no schema, cache payload, or evidence write path changes.
9. Observability: existing `profileSpan()` instrumentation in the semantic provider remains the measurement boundary for future experiments.
10. Human impact: users keep the same command behavior and performance contracts.
11. Reuse: the audit found current targeted primitives rather than missing abstractions; reuse means preserving them.

## Execution Order

1. Add this plan as the item 15 implementation record.
2. Run Prettier on this plan.
3. Run `node dist/cli.js reindex && node dist/cli.js diff-gate --json`.

## Ship Order

Ship as a docs-only accepted/rejected optimization record. There are no one-way doors, no schema changes, and no production code changes.

## Summary

Created `docs/plans/2026-06-30-rejected-micro-optimizations.md`. Net production code delta: zero. The implementation is to keep the rejected micro-optimizations rejected because SCIP evidence shows the useful boundaries already live in the local provider, catalog, and similarity primitives.
