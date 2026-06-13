# Performance Slice 6 Plan: Definition Line-Owner Index

Date: 2026-06-13

This plan covers feedback item 11 from `docs/plans/2026-06-13-performance-feedback.md`: avoid repeated linear definition scans when attributing call or reference lines to their enclosing definition.

## Goal

Preserve the existing ownership rule, "the smallest definition range containing the line wins," while making repeated per-file lookups cheaper. The optimization should change lookup cost, not caller/callee attribution semantics.

## Current Flow

- Source: `scip-query plan-context innermostDefinitionAtLine`
  - `buildAstCalleeMap()` groups definitions by file, scans AST callsites per file, then calls `innermostDefinitionAtLine(fileDefs, site.line)`.
  - `innermostDefinitionAtLine()` currently uses `definitions.find(...)` after `definitionsByFile()` sorts each file's definitions by smallest range.

- Source: `scip-query code buildAstCalleeMap -C 14`
  - `buildAstCalleeMap()` performs the enclosing-definition lookup inside the callsite loop at `src/symbols/call-graph-evidence.ts:363-365`.
  - `definitionsByFile()` initializes result buckets and sorts definitions by range width at `src/symbols/call-graph-evidence.ts:383-395`.

- Source: `scip-query plan-context findEnclosingDefinition`
  - `findEnclosingDefinition()` is the shared reference/caller attribution helper in `src/symbols/definition-catalog.ts:204-218`.
  - Consumers include `reference-sites`, `identifier-attribution`, targeted semantic caller rows, `affected`, `wrapper-candidates`, and `slice`.

- Source: `scip-query code buildReferenceSites -C 14` and `scip-query code materializeReferenceSites -C 14`
  - Reference attribution already groups candidate lines per file, loads definitions once per file, then calls `findEnclosingDefinition()` for each candidate line.

## Plan

1. Add a reusable line-owner index builder.
   - Source: `scip-query code findEnclosingDefinition -C 14`
   - In `src/symbols/definition-catalog.ts`, add `createDefinitionLineIndex(definitions)`.
   - Iterate definitions sorted by range width while preserving original order for equal-width ties, and assign each covered line only once. That preserves the current "smallest containing range, first tie wins" behavior.

2. Cache the shared `findEnclosingDefinition()` index by definition-array identity.
   - Source: `scip-query plan-context findEnclosingDefinition`
   - `getDefinitionsForFile()` returns cached arrays from `FILE_DEFINITION_CACHE`, so a `WeakMap<IndexedDefinition[], DefinitionLineIndex<IndexedDefinition>>` lets repeated per-file lookups reuse the same owner map without changing the public API.

3. Use the same helper in AST callee attribution.
   - Source: `scip-query code buildAstCalleeMap -C 14`
   - Replace per-callsite `innermostDefinitionAtLine(fileDefs, site.line)` scans with a per-file line index and `index.get(site.line)`.
   - Keep callee candidate resolution, member-access filtering, self-recursion skip, and result ordering unchanged.

4. Tests and verification.
   - Add a direct nested-definition test for `findEnclosingDefinition()` to pin smallest-range behavior and equal-width tie behavior.
   - Add or adjust call-graph/source-backed tests so nested owners still receive callsite edges.
   - Run focused source-backed and definition tests, then `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Accuracy Boundary

The index is built from the same AST-corrected definition ranges already used today. It does not infer new definitions, change range correction, or change how unresolved lines are handled. Inclusive start/end line semantics remain unchanged.
