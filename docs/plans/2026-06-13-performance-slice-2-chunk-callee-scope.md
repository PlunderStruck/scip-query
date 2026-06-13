# Performance Slice 2 Plan: Scoped Chunk Callee Evidence

Date: 2026-06-13

This plan covers feedback item 10 from `docs/plans/2026-06-13-performance-feedback.md`: restrict `buildChunkCalleeMap()` to the requested documents and symbols instead of scanning whole-project mention and symbol tables.

## Goal

Make the non-AST chunk fallback cheaper without changing call graph evidence. The caller passes a definition set; the chunk fallback should only inspect non-definition mentions in those definitions' documents, then resolve symbol metadata only for the symbols that occur in those mentions.

## Current Flow

- Source: `scip-query plan-context buildChunkCalleeMap`
  - `buildChunkCalleeMap()` is defined in `src/symbols/call-graph-evidence.ts:419-540`.
  - Its only direct caller is `buildCalleeMap()` at `src/symbols/call-graph-evidence.ts:265`.
  - Downstream consumers include `ProjectIndex.calleeMap()`, `getCalleeRowsForSymbol()`, `buildCallerRowsMap()`, and query commands such as `call-graph`, `dataflow`, `similar`, `incomplete-migration`, and `cleanup-plan`.

- Source: `scip-query code buildCalleeMap -C 8`
  - `buildCalleeMap()` splits definitions into AST-backed and chunk-only definitions at `src/symbols/call-graph-evidence.ts:229-237`.
  - It calls `buildChunkCalleeMap(db, chunkDefs)` only for non-AST definitions unless `additive` is true at `src/symbols/call-graph-evidence.ts:263-265`.

- Source: `scip-query code buildChunkCalleeMap -C 8`
  - `buildChunkCalleeMap()` currently selects every non-definition mention in the database at `src/symbols/call-graph-evidence.ts:425-437`.
  - It groups those rows by document at `src/symbols/call-graph-evidence.ts:439-444`.
  - It loads every document path at `src/symbols/call-graph-evidence.ts:454-458`.
  - It loads every global symbol and definition-document fallback row at `src/symbols/call-graph-evidence.ts:459-472`.
  - It then only uses mentions from each requested definition's document at `src/symbols/call-graph-evidence.ts:496-535`.

## Plan

1. Scope non-definition mentions to requested definition documents.
   - Source: `scip-query code buildChunkCalleeMap -C 8`
   - In `src/symbols/call-graph-evidence.ts:425-437`, replace the whole-project `WHERE m.role != 1` query with a `c.document_id IN (...)` query built from unique `definitions.map((def) => def.documentId)`.
   - Preserve returned columns: `document_id`, `chunk_id`, `start_line`, `end_line`, `symbol_id`.
   - If the unique document list is empty, return a map containing no callees for the requested definitions.

2. Resolve only symbols that appear in scoped mention rows.
   - Source: `scip-query code buildChunkCalleeMap -C 8`
   - After `refRows`, collect unique `symbol_id` values.
   - In `src/symbols/call-graph-evidence.ts:459-472`, add `WHERE gs.id IN (...)` and restrict the role-definition fallback subquery with the same symbol IDs.
   - Preserve the existing `defn_enclosing_ranges` preference over role-definition chunks and the existing duplicate guard at `src/symbols/call-graph-evidence.ts:473-479`.

3. Load only document paths needed for matching and callee file labels.
   - Source: `scip-query code buildChunkCalleeMap -C 8`
   - Replace the all-document path query at `src/symbols/call-graph-evidence.ts:454-458` with a query over the union of requested definition document IDs and non-null callee definition document IDs.
   - Keep the later `filePathById.get(def.documentId)` lookup unchanged so source-confirmation still scans the requested definition file.

4. Preserve range-confirmation semantics exactly.
   - Source: `scip-query code buildChunkCalleeMap -C 8`
   - Leave the contained-range path at `src/symbols/call-graph-evidence.ts:522-529` unchanged.
   - Leave `getIdentifiersByLine()` source confirmation at `src/symbols/call-graph-evidence.ts:501-515` unchanged.
   - Source: `scip-query code getIdentifiersByLine -C 5`
   - `getIdentifiersByLine()` already caches per file in `src/symbols/identifier-index.ts:121-146`; no new cache is needed.

5. Tests and verification.
   - Source: `scip-query trace getCalleeRowsForSymbol`
   - `getCalleeRowsForSymbol()` delegates to `buildCalleeMap()` at `src/symbols/call-graph-evidence.ts:52`, so focused query accuracy tests that exercise callee rows cover the scoped chunk path.
   - Add or update a focused test fixture with two documents: one requested definition document and one unrelated document whose mentions should not appear in the callee output.
   - Run focused tests that cover call graph/source-backed accuracy, then run `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Co-Change Partners

- Source: `scip-query plan-context buildChunkCalleeMap`
  - History reports frequent co-change with `src/symbols/file-dep-graph.ts`, `src/symbols/leaf-symbol-index.ts`, `src/reindex/augment-vue.ts`, `src/runtime/cli-support.ts`, and `package.json`.
  - This slice changes only the SQL scope inside chunk callee evidence. It does not change file dependency graph behavior, leaf candidate selection, Vue augmentation, runtime budgeting, or package metadata, so those partners are intentionally untouched.

## Accuracy Boundary

The optimized path must produce the same rows because the old implementation already discarded mentions outside each requested definition's document during the per-definition loop. The new implementation moves that filter into SQL and moves symbol resolution after the scoped mention scan. Symbols that are never mentioned in requested documents cannot contribute to any requested definition's callee list.
