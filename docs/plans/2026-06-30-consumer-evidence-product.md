# Consumer Evidence Product Plan — 2026-06-30

## Goal

The user wants the third structural optimization register item completed in order: make consumer evidence a shared product instead of a detector-local composition. A consumer, in this repository context, is a source file that references a definition; consumer evidence is the reusable record that says which files consume that definition, which evidence source found each file, and whether each file is a real use, import-only mention, or re-export-only passthrough. Done means stale abstractions, wrapper candidates, and locality candidates can ask the same product for consumer facts without reassembling caller maps and source classifications differently.

## Current State

- `src/queries/internal/consumer-evidence.ts:46-55` exposes `definitionConsumerFileMap()`, which delegates directly to `ProjectIndex.callerFileMap()` and returns only `Map<number, Set<string>>`; it does not retain provenance. Source: `node dist/cli.js code definitionConsumerFileMap -C 8`.
- `src/queries/internal/consumer-evidence.ts:61-82` exposes `partitionDefinitionConsumers()`, which loops over caller files and classifies them as real, re-export-only, or import-only. Source: `node dist/cli.js code partitionDefinitionConsumers -C 8`.
- `src/queries/internal/consumer-evidence.ts:84-90` uses source-backed file leaf usage to classify import-only consumers. Source: `node dist/cli.js plan-context src/queries/internal/consumer-evidence.ts`.
- `src/core/project-index.ts:60-65` keeps caller-file composition behind `ProjectIndex.callerFileMap()`. Source: `node dist/cli.js code callerFileMap -C 8`.
- `src/symbols/references/caller-evidence.ts:40-49` composes cross-file caller maps with source fallback caller maps. Source: `node dist/cli.js code callerFileEvidenceMap -C 8`.
- `src/symbols/references/reference-callers.ts:29-52` shows cross-file caller evidence is already additive: AST callsites, SCIP chunk mentions, Rust attribute references, and semantic callers are merged when semantic evidence is enabled. Source: `node dist/cli.js code buildCrossFileCallerMap -C 12`.
- `src/semantic/shared-primitives.ts:26-124` exposes `semanticCallerMap()`, which can provide semantic caller files directly and therefore gives the new product precise semantic provenance. Source: `node dist/cli.js code semanticCallerMap -C 10`.
- `src/queries/cleanup/stale-abstractions.ts:213-236` currently runs a staged policy: indexed callers first, semantic callers only for likely stale type candidates, then source fallback only for candidates still likely stale. Source: `node dist/cli.js code 'src/queries/cleanup/stale-abstractions.ts:213-244'`.
- `src/queries/cleanup/wrapper-candidates.ts:71-124` runs a similar staged policy: indexed callers first, semantic callers for low-fan-in candidates, then source fallback for remaining candidates. Source: `node dist/cli.js code consumerMapForWrapperCandidates -C 10`.
- `src/queries/cleanup/locality-candidates.ts:307-317` directly calls `definitionConsumerFileMap()` for symbol-level consumer files. Source: `node dist/cli.js trace symbolConsumerFiles`.

Non-obvious invariants:

- Wrapper detection must keep its staged semantic/fallback narrowing; broad semantic or fallback work for every wrapper candidate would undo prior performance optimizations. Source: `node dist/cli.js code consumerMapForWrapperCandidates -C 10`.
- Stale-abstraction detection treats import-only consumers as barrel-like count evidence and separately preserves transitive same-file type reachability. Source: `node dist/cli.js code staleCandidateRow -C 10`.
- The product must not replace `ProjectIndex` as the lower-level caller facade; `ProjectIndex` is high risk with 26 consumers, while `callerFileMap()` itself has one direct consumer. Source: `node dist/cli.js plan-context src/core/project-index.ts`.

## Reuse Audit

- Reuse `ProjectIndex.crossFileCallerMap()` and `ProjectIndex.sourceFallbackCallerFiles()` instead of re-querying SCIP tables. Source: `node dist/cli.js code crossFileCallerMap -C 8`; `node dist/cli.js code sourceFallbackCallerFiles -C 8`.
- Reuse `semanticCallerMap()` for semantic provenance instead of comparing additive caller maps and guessing where semantic files came from. Source: `node dist/cli.js trace semanticCallerMap`.
- Reuse existing `isImportOnlyConsumer()` and `isReExportOnlyConsumer()` classifiers by moving their result into a richer product record, not rewriting their AST/source rules. Source: `node dist/cli.js plan-context src/queries/internal/consumer-evidence.ts`.
- Reuse `mergeSetMaps()` where detector policies still need map-level staged composition. Source: `node dist/cli.js code mergeSetMaps -C 8`.
- Reuse the `sourceEvidence()` facade already introduced for text, AST, lines, and re-exports. Source: `node dist/cli.js plan-context src/queries/internal/consumer-evidence.ts`.
- `node dist/cli.js recent-duplicates` found no recent re-implementation. `node dist/cli.js similar-files src/queries/internal/consumer-evidence.ts` found no similar file pairs. `node dist/cli.js similar definitionConsumerFileMap` found only thin wrappers around existing consumer map behavior, not an existing product with classification and provenance.

## Design Phases

### 1.1 — Add Consumer Evidence Product API

- [ ] **File**: `src/queries/internal/consumer-evidence.ts:11-82`
- **Source**: `node dist/cli.js plan-context src/queries/internal/consumer-evidence.ts`
- **What**: The module exports options, a partition shape, and two functions: one returns a caller file map, while the other partitions a supplied list of files.
- **Change**: Add `DefinitionConsumerSource`, `DefinitionConsumerClassification`, `DefinitionConsumerFileEvidence`, `DefinitionConsumerEvidence`, `DefinitionConsumerEvidenceMap`, `ConsumerEvidenceProduct`, and `consumerEvidenceProduct(db, index)`. The product should expose `forDefinitions(definitions, opts)` and return per-definition consumer records with file provenance and classification.
- **Why**: This creates one owner module for the register item without moving lower-level caller evidence out of its existing home.

### 1.2 — Build Provenance From Existing Evidence Sources

- [ ] **File**: `src/queries/internal/consumer-evidence.ts:46-90`
- **Source**: `node dist/cli.js code definitionConsumerFileMap -C 8`; `node dist/cli.js code semanticCallerMap -C 10`
- **What**: `definitionConsumerFileMap()` delegates to `ProjectIndex.callerFileMap()`, losing whether a consumer came from indexed callers, semantic callers, or source fallback.
- **Change**: Inside the new product, build a combined map from `index.crossFileCallerMap(definitions, { semantic: false })`, `semanticCallerMap(db, definitions)` when `opts.semantic` is true, and `index.sourceFallbackCallerFiles(definitions)` when `opts.sourceFallback !== false`. Record provenance per `(symbolId, file)`.
- **Why**: The product can answer both "who consumes this?" and "why do we believe that?" without weakening existing caller evidence.

### 1.3 — Centralize Classification Output

- [ ] **File**: `src/queries/internal/consumer-evidence.ts:61-194`
- **Source**: `node dist/cli.js code partitionDefinitionConsumers -C 8`
- **What**: Classification is currently returned only as counts and real consumer file names; provenance is discarded.
- **Change**: Add a private `classifyDefinitionConsumers(db, definition, consumerFiles, provenance)` helper. `partitionDefinitionConsumers()` should delegate to it and return the same legacy shape. The new product should expose the richer classified files.
- **Why**: Existing detector output stays byte-compatible while new callers can use the structural product.

### 2.1 — Migrate Stale-Abstraction Consumer Maps Safely

- [ ] **File**: `src/queries/cleanup/stale-abstractions.ts:202-236`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/stale-abstractions.ts:213-244'`
- **What**: Stale abstractions composes indexed, semantic, and fallback maps manually so expensive evidence only runs on likely stale candidates.
- **Change**: Use `consumerEvidenceProduct(db, index).forDefinitions()` plus `consumerFileMapFromEvidence()` for the indexed, semantic-candidate, and fallback-candidate stages. Keep the staged candidate narrowing exactly as-is.
- **Why**: This migrates the detector to the product without broadening expensive semantic/fallback work.

### 2.2 — Migrate Wrapper Consumer Maps Safely

- [ ] **File**: `src/queries/cleanup/wrapper-candidates.ts:71-124`
- **Source**: `node dist/cli.js code consumerMapForWrapperCandidates -C 10`
- **What**: Wrapper candidates use indexed callers, then semantic callers for low-fan-in candidates, then source fallback for remaining candidates.
- **Change**: Replace direct `definitionConsumerFileMap()` calls with product calls and convert evidence back to maps for the existing staged logic. Keep `externalCallerFiles()` filtering and partitioning behavior.
- **Why**: Wrapper detection gets provenance-ready consumer facts without changing its policy.

### 2.3 — Migrate Locality Symbol Consumers

- [ ] **File**: `src/queries/cleanup/locality-candidates.ts:234-317`
- **Source**: `node dist/cli.js code buildLocalityCandidate -C 12`
- **What**: `buildLocalityCandidate()` calls `symbolConsumerFiles()` without access to `db`, so `symbolConsumerFiles()` can only use the legacy map wrapper.
- **Change**: Thread `db` into `buildLocalityCandidate()` and `symbolConsumerFiles()`, then use `consumerEvidenceProduct(db, index).forDefinitions([definition], { semantic: semantic !== false, sourceFallback: true })`.
- **Why**: Locality becomes a consumer of the shared product while preserving existing sorted output.

### 2.4 — Remove The Legacy Consumer Map Wrapper

- [ ] **File**: `src/queries/internal/consumer-evidence.ts:46-55`
- **Source**: `node dist/cli.js trace definitionConsumerFileMap`
- **What**: After stale abstractions, wrapper candidates, and locality candidates migrate, `definitionConsumerFileMap()` has no remaining internal callers.
- **Change**: Delete `definitionConsumerFileMap()` and keep `consumerFileMapFromEvidence()` as the product-to-legacy-map adapter for staged detector policies.
- **Why**: This prevents the old command-local abstraction from remaining as a second path beside the product.

### 3.1 — Add Product Coverage

- [ ] **File**: `tests/queries/internal/consumer-evidence.test.ts`
- **Source**: `node dist/cli.js trace partitionDefinitionConsumers`
- **What**: The existing test covers partitioning but not provenance or product map conversion.
- **Change**: Extend the fixture to call `consumerEvidenceProduct(db, new ProjectIndex(db)).forDefinitions()` and assert indexed provenance plus real/import-only/re-export-only classifications.
- **Why**: The new structural API needs a direct contract test, not only indirect detector tests.

## Stress-Test Findings

1. **Understand before touch**: The module distinguishes "has a reference" from "is a real consumer"; import-only and re-export-only references are not real uses. Verified by `node dist/cli.js code partitionDefinitionConsumers -C 8`.
2. **Blast radius**: `definitionConsumerFileMap()` affects locality, stale abstractions, wrappers, health summaries, health baselines, and diff-gate baseline checks. Verified by `node dist/cli.js affected definitionConsumerFileMap`.
3. **Intermediate validity**: Phase 1 is additive; legacy exports remain until all internal callers migrate. Phase 2 migrates callers one at a time and then removes the unused wrapper. Each phase should build independently.
4. **Reversibility**: This is a two-way internal refactor; reverting means changing detector imports back to legacy map helpers.
5. **Failure design**: Bad source evidence still falls back through existing `isImportOnlyConsumer()` and `isReExportOnlyConsumer()` behavior; no new persistent payload is introduced in this phase.
6. **Concurrency**: The product uses per-call local maps plus existing per-DB/file caches; no new shared mutable state is introduced.
7. **Boundaries**: No CLI or external input boundary changes.
8. **Data integrity**: No schema change and no new persistent table writes; existing semantic and file-usage caches keep their validators and fallback paths.
9. **Observability**: Add one `profileSpan()` around product assembly with counts for definitions, files, indexed files, semantic files, fallback files, real files, import-only files, and re-export-only files.
10. **Human impact**: Command output should remain byte-identical; users should only see the same findings computed through a more reusable path.
11. **Reuse**: The product reuses `ProjectIndex`, `semanticCallerMap()`, `sourceEvidence()`, and existing classifiers. Verified by the reuse audit commands above.

## Execution Order

1. Phase 1: add the product API and product test. Deployable by itself because legacy exports remain.
2. Phase 2: migrate stale, wrapper, and locality consumers. Deployable after Phase 1.
3. Phase 3: run targeted tests, full tests, benchmark contract, `scip-query reindex`, and `scip-query diff-gate --json`.

## Ship Order

Ship as one internal refactor after verification. There are no one-way doors, schema changes, public CLI changes, or data migrations.

## Summary

Expected touched files:

- `src/queries/internal/consumer-evidence.ts`
- `src/queries/cleanup/stale-abstractions.ts`
- `src/queries/cleanup/wrapper-candidates.ts`
- `src/queries/cleanup/locality-candidates.ts`
- `tests/queries/internal/consumer-evidence.test.ts`

Expected net effect: a richer shared product API with small call-site migrations and no detector output changes.
