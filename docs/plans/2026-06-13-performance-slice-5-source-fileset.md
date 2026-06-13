# Performance Slice 5 Plan: Indexed-First Source Filesets

Date: 2026-06-13

This plan covers feedback item 9 from `docs/plans/2026-06-13-performance-feedback.md`: avoid blind recursive disk walks when indexed documents and Git can enumerate source files more cheaply.

## Goal

Keep `getSourceFiles()` accurate while reducing repeated filesystem traversal. Indexed SCIP documents should provide the main source set. Auxiliary unindexed source files should be found by Git when available, with the existing recursive walk kept as the non-Git fallback.

## Current Flow

- Source: `scip-query plan-context getSourceFiles`
  - `getSourceFiles()` is defined in `src/source/source-fileset.ts:94-120`.
  - It is used by file classifiers, suppression scans, `ProjectIndex.sourceFiles()`, and identifier attribution.
  - Downstream impact reaches dead-code/source-reference fallback and health reporting.

- Source: `scip-query code getSourceFiles -C 12`
  - `getSourceFiles()` adds indexed document paths at `src/source/source-fileset.ts:106-110`.
  - When `includeAuxiliary` is true, it always calls `listOnDiskSources()` at `src/source/source-fileset.ts:112-116`.

- Source: `scip-query code 'src/source/source-fileset.ts:125-148'`
  - `listOnDiskSources()` recursively walks directories with `readdirSync()` at `src/source/source-fileset.ts:125-147`.
  - It skips `SKIP_DIRS` and filters by extension.

- Source: `scip-query code indexedDocumentPaths -C 8`
  - `indexedDocumentPaths()` already filters SCIP `documents` by path exclusions and optional extensions at `src/storage/scip-documents.ts:10-36`.

## Plan

1. Keep indexed documents as the primary source set.
   - Source: `scip-query code getSourceFiles -C 12`
   - In `src/source/source-fileset.ts:104-116`, retain the indexed document loop and record indexed paths in the output set before looking for auxiliary files.

2. Replace the default auxiliary search with Git-backed source listing.
   - Source: `scip-query code 'src/source/source-fileset.ts:125-148'`
   - Add a Git-backed listing helper that runs `git ls-files --cached --others --exclude-standard` from `db.config.projectRoot`.
   - Filter listed paths with the existing extension set and `db.isIgnored()` rules.
   - When indexed files are included, add only files not already present in the indexed output set.

3. Preserve non-Git fallback behavior.
   - Source: `scip-query code 'src/source/source-fileset.ts:125-148'`
   - Keep the existing recursive `readdirSync()` walk as a fallback when Git listing fails.
   - Continue honoring `SKIP_DIRS` and extension filtering.

4. Tests and verification.
   - Source: `scip-query plan-context getSourceFiles`
   - Add focused tests for a Git repo where indexed `.ts` files and unindexed `.vue` files are both returned, ignored/untracked excluded paths are not returned, and indexed paths are not duplicated.
   - Run focused source-fileset tests, then `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Co-Change Partners

- Source: `scip-query plan-context getSourceFiles`
  - History reports co-change with `src/core/project-index.ts`, `src/queries/dead.ts`, `src/queries/drift.ts`, `src/queries/imports.ts`, and `src/queries/redundant-reexports.ts`.
  - This slice preserves the `getSourceFiles()` API and returned set semantics, so those query consumers should not need source changes. They are covered by focused and full test runs.

## Accuracy Boundary

Git listing is used only to enumerate candidate on-disk paths; SCIP indexed documents still provide indexed source files. The recursive filesystem walk remains available when Git cannot list files. The output still applies extension filters, `db.isIgnored()`, skip directories, de-duplication, and sorting.
