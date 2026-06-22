# Locality Candidates Implementation Plan

Date: 2026-06-22

## Goal

The missing feature is the report-only directory-organization and ancestry analyzer described by `docs/locality-analyzer-design.md`: a user should be able to ask `scip-query locality-candidates [symbol-or-file]` and see whether a source unit's directory placement is broader, narrower, or aligned with its actual consumers. Done means the command is registered, emits JSON and text output, includes explicit consumer-coverage caveats, and is tested against symbol and file targets.

## Current State

Status: implemented in this diff. The bullets below record the pre-implementation context used to plan the work.

- `src/runtime/commands/query-command-specs.ts:10-72` lists every public query command. Source: `scip-query code 'src/runtime/commands/query-command-specs.ts:10-72'`. `locality-candidates` is absent.
- `src/runtime/query-commands/cleanup/descriptors.ts:65-360` registers cleanup and heuristic analyzers with descriptor-owned docs/options/handlers. Source: `scip-query code 'src/runtime/query-commands/cleanup/descriptors.ts:65-140'`, `scip-query code 'src/runtime/query-commands/cleanup/descriptors.ts:140-260'`, and `scip-query code 'src/runtime/query-commands/cleanup/descriptors.ts:256-360'`.
- `src/runtime/query-commands/cleanup/handlers.ts:126-220` shows the current custom/list-handler pattern for extraction, wrapper, passthrough, and stale-abstraction candidates. Source: `scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:126-220'`.
- `src/queries/index.ts:1-120` is the public query export surface for analyzer functions and result types. Source: `scip-query code 'src/queries/index.ts:1-120'`.
- `ProjectIndex` already exposes scoped definitions, definitions per file, caller-file maps, file dependency graph, source files, and file kind. Source: `scip-query code 'src/core/project-index.ts:1-220'`.
- Symbol target lookup should reuse `findFirstSymbolMatch`, which already handles exact symbols, `file:line-line`, path-qualified patterns, and fuzzy lookup. Source: `scip-query code 'src/symbols/symbol-lookup.ts:1-180'`.
- Existing detector-grade consumer evidence lives in `definitionConsumerFileMap`, which names the policy for cross-file callers plus optional source fallback. Source: `scip-query code definitionConsumerFileMap -C 6`.

## Reuse Audit

- Reuse `ProjectIndex.fileDependencyGraph()` for file-level reverse dependencies rather than writing a new import parser. Source: `scip-query code 'src/core/project-index.ts:1-220'`.
- Reuse `ProjectIndex.definitionsForFile()` and `definitionConsumerFileMap()` for symbol-level consumers rather than querying raw SCIP tables directly. Source: `scip-query code 'src/core/project-index.ts:1-220'` and `scip-query code definitionConsumerFileMap -C 6`.
- Reuse `findFirstSymbolMatch()` for target resolution rather than introducing a second fuzzy lookup path. Source: `scip-query code 'src/symbols/symbol-lookup.ts:1-180'`.
- A new analyzer module is justified because no existing command combines directory ancestry, nearest common consumer owner, boundary markers, and placement recommendations. Source: `scip-query system src/queries/cleanup --json` showed cleanup analyzers such as wrapper, passthrough, extraction, drift, and stale abstractions, but no locality command or exported locality module.

## Design Phases

### 1. Add Analyzer Module

- [x] **File**: `src/queries/cleanup/locality-candidates.ts`
- **Source**: `scip-query system src/queries/cleanup --json`; `scip-query code 'src/core/project-index.ts:1-220'`; `scip-query code 'src/symbols/symbol-lookup.ts:1-180'`.
- **What**: Cleanup analyzers currently live under `src/queries/cleanup`, but no module reports directory-structure locality.
- **Change**: Add `localityCandidates(db, opts)` plus result types. Resolve a target as either an indexed file path or symbol. For each candidate, emit `sourceUnit`, `candidatePath`, `directoryAncestry`, `consumerFiles`, `consumerCoverage`, `nearestCommonOwner`, `boundaryMarkers`, `recommendedTier`, `suggestedHome`, `counterevidence`, `actionTier: "signal"`, and `recommendation`.
- **Why**: This implements the validated report-only analyzer while keeping placement moves outside automation.

### 2. Wire Public Command

- [x] **File**: `src/queries/index.ts:1-120`
- **Source**: `scip-query code 'src/queries/index.ts:1-120'`.
- **Change**: Export `localityCandidates` and its result types.

- [x] **File**: `src/runtime/query-commands/cleanup/handlers.ts:1-220`
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:1-40'` and `scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:126-220'`.
- **Change**: Add `handleLocalityCandidates` with JSON output and concise text rendering.

- [x] **File**: `src/runtime/query-commands/cleanup/descriptors.ts:1-360`
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup/descriptors.ts:1-64'` and descriptor-range commands above.
- **Change**: Register `locality-candidates [target]` with `--scope`, `--limit`, `--min-consumers`, `--full`, and `--json`.

- [x] **File**: `src/runtime/commands/query-command-specs.ts:10-72`
- **Source**: `scip-query code 'src/runtime/commands/query-command-specs.ts:10-72'`.
- **Change**: Add `locality-candidates` to descriptor order near extraction/frontend pressure commands.

### 3. Tests And Docs

- [x] **File**: `tests/queries/cleanup/locality-candidates.test.ts`
- **Source**: test files are not present in the current SCIP index; fixture pattern was inspected directly after `scip-query plan-context tests/runtime/cli-contract.test.ts --json` reported no matching indexed file.
- **Change**: Add fixture-backed tests for symbol targets, file targets, nearest-common-owner calculation, root/generic-owner caveats, and exact/degraded consumer coverage.

- [x] **File**: `docs/COMMAND_REFERENCE.md`
- **Source**: `tests/runtime/cli-contract.test.ts` asserts command reference text is generated from descriptors.
- **Change**: Regenerate or update command reference output through the existing descriptor-owned docs path.

## Stress-Test Findings

- The feature is a two-way internal addition: no existing command behavior is removed.
- Failure design: no exact consumers should produce `consumerCoverage: "none"` or `"degraded"` and a non-move recommendation, not a direct repair.
- Boundary defense: CLI input is only a symbol/file pattern resolved against the existing index; no files are mutated.
- Reuse: target lookup, definition consumers, source files, and file dependency graph come from existing modules rather than fresh parsers.
- Human outcome: text output must explain why a row is a review signal, not a direct instruction to move code.

## Execution Order

1. Analyzer module.
2. Query exports plus CLI handler/descriptor/order.
3. Focused tests and command reference.
4. Verification: focused tests, typecheck, build, full tests, `scip-query reindex`, `scip-query diff-gate`.
