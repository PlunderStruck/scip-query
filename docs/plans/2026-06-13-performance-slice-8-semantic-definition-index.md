# Performance Slice 8 Plan: Semantic Definition Resolution Index

Date: 2026-06-13

This plan covers feedback item 15 from `docs/plans/2026-06-13-performance-feedback.md`: cache TypeScript semantic definition resolution instead of issuing repeated wildcard SQL and line-distance queries.

## Goal

When ts-morph resolves a declaration symbol, map it back to the nearest SCIP indexed definition using cached per-file definition data. Preserve the existing "same file, matching name, closest start line" behavior while avoiding repeated SQL in hot semantic callee walks.

## Current Flow

- Source: `rg "findIndexedDefinitionNear|indexedDefinitionLeafMap" -n src tests`
  - `findIndexedDefinitionNear()` is defined in `src/semantic/typescript/indexed-definitions.ts`.
  - It is called by `TsMorphSemanticProvider.definitionFromSymbol()` in `src/semantic/typescript/ts-morph-provider.ts`.
  - `indexedDefinitionLeafMap()` is already cached by `TsMorphSemanticProvider.indexedDefinitionByLeaf()` for import/export usage.

- Source: `scip-query code semanticReferences` and `sed -n '300,500p' src/semantic/typescript/ts-morph-provider.ts`
  - `definitionFromSymbol()` loops ts-morph declarations, converts each declaration path to a project-relative file, computes its line, then calls `findIndexedDefinitionNear(this.db, file, line, symbol.getName())`.
  - `calleeMapForFile()` walks every call/new expression and calls `semanticCalleeForCallNode()`, so declaration resolution can repeat many times per file.

- Source: `sed -n '1,220p' src/semantic/typescript/indexed-definitions.ts`
  - `findIndexedDefinitionNear()` currently performs a wildcard `LIKE ?`, orders by distance from the declaration line, and returns the first row.
  - `indexedDefinitionLeafMap()` independently queries definitions for the same file.

## Plan

1. Build a cached per-file candidate index.
   - Use `getDefinitionsForFile(db, file)` so the index reuses the authoritative AST-corrected definition catalog and its cache.
   - Group definitions by `definition.leaf || leafName(definition.symbol)`.
   - Sort each bucket by `startLine`, then `endLine`, then `symbolId`.
   - Cache the grouping with `createPerDbCache()` under the `definition-catalog` clear group.

2. Rework `findIndexedDefinitionNear()`.
   - First look up exact leaf candidates by `symbolName` and choose the nearest `startLine`.
   - If no exact leaf bucket exists, use a compatibility fallback over the cached file definitions that matches the old wildcard behavior by checking `leaf` or full `symbol` containment.
   - Return `null` when no cached candidate matches.

3. Reuse the candidate index for `indexedDefinitionLeafMap()`.
   - Return the first sorted candidate per leaf, preserving the single-definition map shape expected by import/export resolution.

4. Tests and verification.
   - Add focused tests for nearest same-leaf selection and substring fallback.
   - Run TypeScript semantic/indexed-definition tests, then `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Accuracy Boundary

This slice does not change ts-morph project selection, source-file resolution, call expression traversal, reference lookup, or semantic output shape. It changes only the backing lookup used to map a TypeScript declaration back to an already-indexed SCIP definition.
