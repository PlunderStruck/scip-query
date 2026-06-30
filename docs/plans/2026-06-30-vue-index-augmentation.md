# Vue Index Augmentation Stage Plan

Date: 2026-06-30

## Goal

The user wants the Vue indexing optimization to become structural instead of living as a one-off command path. A post-index augmentation is an index-building operation, visible here as auxiliary `.vue` document insertion and Volar-backed Vue reference materialization, that runs after an upstream SCIP index has been converted to SQLite because the upstream indexer did not emit those project facts. Done means the code has an explicit post-index stage boundary, keeps the existing Vue transaction intact, preserves current CLI behavior, and documents where the boundary sits between indexer facts and scip-query augmentation facts.

## Current State

- `augmentVueResolvedReferences()` currently owns two different responsibilities at `src/reindex/vue/augment-vue.ts:95-129`: it first calls `augmentAuxiliaryDocuments()` quietly, then resolves Vue config, opens SQLite, lists Vue documents, checks `augment-vue-meta.json`, runs the Vue transaction, writes the cache, and closes the database. Source: `node dist/cli.js plan-context augmentVueResolvedReferences`; `node dist/cli.js code src/reindex/vue/augment-vue.ts:1-145`.
- `runVueAugmentationTransaction()` at `src/reindex/vue/augment-vue.ts:146-169` already names the Volar-backed transaction that creates synthetic component symbols, computes references, dedupes occurrences, replaces generated chunks, and emits the Vue status line. Volar is the Vue language-service engine used here to map generated TypeScript positions back to Vue source positions. Source: `node dist/cli.js code src/reindex/vue/augment-vue.ts:146-260`.
- `augmentAuxiliaryDocuments()` at `src/reindex/augment.ts:29-74` is the auxiliary-document transaction: it filters ignored files, discovers configured source extensions, checks existing `documents` rows in chunks, inserts missing document text, and optionally reports status. Source: `node dist/cli.js plan-context augmentAuxiliaryDocuments`; `node dist/cli.js code src/reindex/augment.ts:1-120`.
- Reindex calls auxiliary augmentation directly in both reuse and fresh-publish paths: `reuseExistingIndexIfPossible()` uses it at `src/reindex/index.ts:259-263`, and `publishFreshReindexArtifacts()` uses it at `src/reindex/index.ts:377-381`. Source: `node dist/cli.js code src/reindex/index.ts:230-390`.
- The manual CLI handlers expose the same public behavior separately: `handleAugmentSources()` calls auxiliary augmentation at `src/runtime/commands/command-handlers.ts:142-151`, while `handleAugmentVue()` calls Vue augmentation at `src/runtime/commands/command-handlers.ts:158-171`. Source: `node dist/cli.js code src/runtime/commands/command-handlers.ts:130-180`.
- The blast radius is bounded but real. `augmentAuxiliaryDocuments()` feeds reindex reuse, fresh publish, Vue augmentation, and `handleAugmentSources()`. `augmentVueResolvedReferences()` feeds `handleAugmentVue()`. Source: `node dist/cli.js affected augmentAuxiliaryDocuments --json`; `node dist/cli.js affected augmentVueResolvedReferences --json`.
- Existing tests cover auxiliary document insertion, large file-set query chunking, and the missing Volar dependency error path in `tests/reindex/augment-sources.test.ts:58-122`. Source for code behavior: `node dist/cli.js plan-context augmentAuxiliaryDocuments`; `node dist/cli.js plan-context augmentVueResolvedReferences`. Test line references came from direct test-file inspection because test files are not reliable SCIP symbols in this index.

## Reuse Audit

- No existing post-index augmentation runner exists in `src/reindex`: the surface exposes `augmentAuxiliaryDocuments()` and `augmentVueResolvedReferences()` as separate functions, and no stage abstraction appears in the reindex module map. Source: `node dist/cli.js surface src/reindex --json`; `node dist/cli.js plan-context augmentAuxiliaryDocuments`; `node dist/cli.js plan-context augmentVueResolvedReferences`.
- `similar-files src/reindex/vue/augment-vue.ts --json` returned no structurally similar module to reuse. Source: `node dist/cli.js similar-files src/reindex/vue/augment-vue.ts --json`.
- `similar augmentVueResolvedReferences --json` found only command/reindex scaffolding overlap, not a reusable augmentation stage. Source: `node dist/cli.js similar augmentVueResolvedReferences --json`.
- `similar computeVueReferenceComputation --json` shows the remaining Vue direct/worker similarity is already constrained to shared `createVueReferenceComputationContext()` and `computeVueResolvedReferencesForFiles()`; do not extract more Volar transaction logic. Source: `node dist/cli.js similar computeVueReferenceComputation --json`; `node dist/cli.js code createVueReferenceComputationContext -C 20`.
- `similar-chains --json` surfaced unrelated domain/reexport chains, not an equivalent post-index augmentation lifecycle. Source: `node dist/cli.js similar-chains --json`.

## Design Phases

### 1.1 - Add the post-index augmentation contract

- [ ] **File**: `src/reindex/post-index-augmentation.ts` (new)
- **Source**: `node dist/cli.js surface src/reindex --json` showed no existing stage runner; `node dist/cli.js deps src/reindex/augment.ts --json` and `node dist/cli.js deps src/reindex/vue/augment-vue.ts --json` showed the new module can stay inside `src/reindex` without pulling runtime command dependencies in.
- **What**: There is no shared concept for an operation that runs after SQLite conversion and writes non-indexer facts into the DB.
- **Change**: Add `PostIndexAugmentationContext`, `PostIndexAugmentationFact`, `PostIndexAugmentationStage<Result>`, `runPostIndexAugmentation()`, and `runFingerprintCachedPostIndexAugmentation()`. The runner returns stage id, fact kinds, duration, and result; the cache helper owns the fingerprint-read/cache-hit/compute/post-write sequence currently local to Vue.
- **Why**: This makes "post-index augmentation" the common mechanism while keeping each stage's domain-specific work local.

### 1.2 - Expose auxiliary documents as a stage

- [ ] **File**: `src/reindex/augment.ts:8-74`
- **Source**: `node dist/cli.js plan-context augmentAuxiliaryDocuments`; `node dist/cli.js code src/reindex/augment.ts:1-120`; `node dist/cli.js change-surface src/reindex/augment.ts --json`.
- **What**: `augmentAuxiliaryDocuments()` is already a complete transaction, but callers must know directly that this transaction belongs after index conversion.
- **Change**: Keep `augmentAuxiliaryDocuments()` public and behavior-compatible. Add `auxiliaryDocumentsAugmentationStage()` beside it; the stage has id `auxiliary-documents`, fact kind `auxiliary-document`, and delegates to `augmentAuxiliaryDocuments()` with the stage context.
- **Why**: Reindex and Vue can depend on a named post-index stage while manual `augment-sources` continues to call the existing API.

### 1.3 - Move reindex callers onto the stage runner

- [ ] **File**: `src/reindex/index.ts:17-18`, `src/reindex/index.ts:216-218`, `src/reindex/index.ts:259-263`, `src/reindex/index.ts:377-381`
- **Source**: `node dist/cli.js code src/reindex/index.ts:1-30`; `node dist/cli.js code src/reindex/index.ts:210-220`; `node dist/cli.js code src/reindex/index.ts:230-390`; `node dist/cli.js refs augmentAuxiliaryDocuments --json`.
- **What**: Reindex directly invokes `augmentAuxiliaryDocuments()` after reuse and after fresh SQLite conversion.
- **Change**: Import `auxiliaryDocumentsAugmentationStage()` and `runPostIndexAugmentation()`, then run the auxiliary stage with the same project root, DB path, and status callback in both reindex paths. Keep the existing re-export of `augmentAuxiliaryDocuments()`, and export the stage helper from the reindex subpath if the local barrel already exports the direct function.
- **Why**: The post-index lifecycle becomes explicit without changing the reindex result model or CLI output.

### 2.1 - Split Vue public orchestration from Vue stage execution

- [ ] **File**: `src/reindex/vue/augment-vue.ts:1-129`
- **Source**: `node dist/cli.js plan-context augmentVueResolvedReferences`; `node dist/cli.js code src/reindex/vue/augment-vue.ts:1-145`; `node dist/cli.js dataflow augmentVueResolvedReferences --json`.
- **What**: The public Vue entry point currently mixes prerequisite auxiliary augmentation with the Vue cache/transaction lifecycle.
- **Change**: Add `vueResolvedReferencesAugmentationStage({ tsconfig })` with id `vue-resolved-references` and fact kinds for synthetic symbols, source-mapped occurrences, definition mentions, replacement chunks, and fingerprint cache. Change `augmentVueResolvedReferences()` to run the auxiliary stage quietly first, then run the Vue stage with the existing status callback and return the Vue stage result. Move the old body into a private `augmentVueResolvedReferencesFromIndexedDocuments()` helper so the Vue stage does not recurse.
- **Why**: The boundary becomes "stage pipeline first, Vue transaction second" while preserving the existing quiet auxiliary behavior inside `augment-vue`.

### 2.2 - Move Vue fingerprint cache policy into the stage cache helper

- [ ] **File**: `src/reindex/vue/augment-vue.ts:65-83`, `src/reindex/vue/augment-vue.ts:131-250`
- **Source**: `node dist/cli.js code src/reindex/vue/augment-vue.ts:1-145`; `node dist/cli.js code src/reindex/vue/augment-vue.ts:146-260`.
- **What**: `AugmentVueCache`, `reuseCachedVueAugmentation()`, `readAugmentVueCache()`, and `writeAugmentVueCache()` are local cache plumbing around one fingerprinted post-index stage.
- **Change**: Remove those local cache helpers and call `runFingerprintCachedPostIndexAugmentation()` with `cachePath`, `readFingerprint: () => computeAugmentVueFingerprint(...)`, `compute: () => runVueAugmentationTransaction(...)`, and the existing Vue cache-hit status message.
- **Why**: Fingerprint/cache/recompute becomes a reusable post-index stage policy while Vue keeps ownership of its DB/source fingerprint shape.

### 3.1 - Update focused tests for the new stage boundary

- [ ] **File**: `tests/reindex/augment-sources.test.ts:58-122`
- **Source**: `node dist/cli.js plan-context augmentAuxiliaryDocuments`; `node dist/cli.js plan-context augmentVueResolvedReferences`.
- **What**: The current tests assert direct auxiliary augmentation and the Vue missing-dependency path, but not the stage metadata or generic cache policy.
- **Change**: Add assertions that the auxiliary stage exposes `auxiliary-documents` and `auxiliary-document` and returns the same result through `runPostIndexAugmentation()`. Keep the direct public API tests.
- **Why**: This verifies the architectural boundary without requiring a full Volar fixture.

### 3.2 - Add cache-helper coverage and keep reindex mocks aligned

- [ ] **File**: `tests/reindex/post-index-augmentation.test.ts` (new), `tests/reindex/reindex-reliability.test.ts:497-499`
- **Source**: `node dist/cli.js code src/reindex/index.ts:230-390`; `node dist/cli.js refs augmentAuxiliaryDocuments --json`; `node dist/cli.js affected augmentAuxiliaryDocuments --json`.
- **What**: Reindex reliability tests mock `augmentAuxiliaryDocuments()` only, and no test covers corrupt/matching/mismatching stage cache behavior.
- **Change**: Add a focused cache test for `runFingerprintCachedPostIndexAugmentation()` that proves cache hit skips compute and fingerprint drift recomputes. Extend the reindex mock to include `auxiliaryDocumentsAugmentationStage()` returning a stage whose `run()` returns the same zero-result fixture.
- **Why**: The new stage boundary is verified in isolation, and existing reindex tests remain stable.

## Stress Test

- Understand before touching: the Vue transaction itself stays intact because `runVueAugmentationTransaction()` already owns the Volar compute-normalize-write unit. Source: `node dist/cli.js code src/reindex/vue/augment-vue.ts:146-260`.
- Blast radius: `augmentAuxiliaryDocuments()` has medium-risk consumers in reindex, Vue, and CLI handlers; keep the public function stable and only move reindex/Vue internal callers. Source: `node dist/cli.js change-surface src/reindex/augment.ts --json`; `node dist/cli.js affected augmentAuxiliaryDocuments --json`.
- Valid intermediate states: Phase 1 can ship with `augmentAuxiliaryDocuments()` still callable directly; Phase 2 moves Vue onto the stage after the stage exists.
- Reversibility: all changes are internal TypeScript refactors plus tests; no schema or data migration is introduced.
- Failure design: cache read failures remain best-effort misses; cache write failures still propagate as before. Missing Volar dependencies continue to surface from `requireVueAugmentDependency()` through the public Vue API. Source: `node dist/cli.js code src/reindex/vue/augment-vue.ts:1-145`; `node dist/cli.js code src/reindex/vue/augment-vue.ts:146-260`.
- Concurrency: no new shared DB writes are added; existing auxiliary and Vue transactions still own their DB mutation ordering.
- Boundaries: CLI handlers keep their existing validation and project-root resolution. Source: `node dist/cli.js code src/runtime/commands/command-handlers.ts:130-180`.
- Data integrity: auxiliary insertion remains `INSERT OR IGNORE`; Vue chunk replacement remains inside `replaceVueDocumentChunks()`. Source: `node dist/cli.js code src/reindex/augment.ts:1-120`; `node dist/cli.js code src/reindex/vue/augment-vue.ts:146-260`.
- Observability: preserve existing status lines. Do not add an auxiliary status line to `augment-vue`, because today its prerequisite auxiliary pass is quiet.
- Human impact: CLI output should remain behavior-compatible; new architecture is visible to maintainers through stage ids and fact kinds.
- Reuse: no existing runner was found; the new module only absorbs stage execution metadata and fingerprinted cache plumbing, not Vue-specific Volar logic. Source: `node dist/cli.js similar-chains --json`; `node dist/cli.js similar-files src/reindex/vue/augment-vue.ts --json`; `node dist/cli.js similar augmentVueResolvedReferences --json`.

## Execution Order

1. Add `src/reindex/post-index-augmentation.ts`.
2. Add `auxiliaryDocumentsAugmentationStage()` in `src/reindex/augment.ts`.
3. Move reindex internal callers in `src/reindex/index.ts` to the stage runner.
4. Split Vue public orchestration from Vue stage execution in `src/reindex/vue/augment-vue.ts`.
5. Replace Vue-local cache plumbing with `runFingerprintCachedPostIndexAugmentation()`.
6. Update focused tests and mocks.
7. Verify with focused tests, typecheck, build, structural checks, full tests, `reindex`, and `diff-gate`.

## Ship Order

Ship as one internal refactor. There are no one-way doors: no database schema changes, no command signature changes, and no public direct API removals.

## Verification Plan

- `npx vitest run tests/reindex/augment-sources.test.ts tests/reindex/post-index-augmentation.test.ts tests/reindex/reindex-reliability.test.ts`
- `npm run typecheck`
- `npm run build`
- `npx prettier --check src/reindex/post-index-augmentation.ts src/reindex/augment.ts src/reindex/vue/augment-vue.ts src/reindex/index.ts tests/reindex/augment-sources.test.ts tests/reindex/post-index-augmentation.test.ts tests/reindex/reindex-reliability.test.ts docs/plans/2026-06-30-vue-index-augmentation.md`
- `node dist/cli.js wrapper-candidates --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js stale-abstractions --include-low-confidence --json`
- `npm test`
- `node dist/cli.js reindex && node dist/cli.js diff-gate --json`

Verification result:

- Focused tests passed: 3 files, 22 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- Item-specific Prettier check passed after formatting.
- `node dist/cli.js reindex` passed and rebuilt the fresh TypeScript index.
- `wrapper-candidates --json` returned no findings.
- `recent-duplicates --json` returned no findings.
- `incomplete-migration --json` returned no findings; it skipped the small new stage/cache helpers as too small to score.
- `stale-abstractions --include-low-confidence --json` still reports the known five from earlier work: `FileEvidenceKind`, `ReactComponentProfileOptions`, `VueComponentProfileOptions`, `SemanticReferenceCacheEntry`, and `FileAddRecord`. No new post-index augmentation type was reported.
- `npm test` passed: 88 files, 482 tests. The suite still prints the existing git diff usage warning from a fixture path, but exits 0.
- `health --full --json` remains 99/100 with wrappers 0 and wrapperScoreCount 0. The eight similar-function pairs do not include the new post-index stage module or Vue stage functions.

## Summary

Files expected to change: `src/reindex/post-index-augmentation.ts`, `src/reindex/augment.ts`, `src/reindex/index.ts`, `src/reindex/vue/augment-vue.ts`, `tests/reindex/augment-sources.test.ts`, `tests/reindex/post-index-augmentation.test.ts`, and `tests/reindex/reindex-reliability.test.ts`. Net effect should be a small internal stage mechanism, fewer Vue-local cache helpers, and no change to SCIP indexer facts or Vue transaction semantics.
