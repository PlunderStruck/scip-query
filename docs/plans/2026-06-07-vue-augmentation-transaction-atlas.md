# Vue Augmentation Transaction Compression Atlas

Date: 2026-06-07
Scope: `src/reindex/augment-vue.ts`, `src/reindex/augment-vue-runtime.ts`, Vue augmentation tests, and the Primogen disgust register.

A Vue augmentation transaction is the reindexing operation that takes Vue language-service facts and persists them as SCIP database mentions. Its real-world referents are the Volar language context, Vue component symbols, resolved source occurrences, replacement chunks, inserted mentions, cache metadata, and CLI status messages; its defining characteristic is that these facts must be computed and committed as one ordered database update.

## Scope Map

- Entry point: `augmentVueResolvedReferences()` in `src/reindex/augment-vue.ts`.
- Worker entry point: `computeVueResolvedReferencesForWorker()` in `src/reindex/augment-vue.ts`.
- Runtime helpers: Volar setup, source readers, symbol lookup, dedupe, and SQLite replacement in `src/reindex/augment-vue-runtime.ts`.
- Public result: `AugmentVueResolvedResult` in `src/reindex/augment-vue-types.ts`.
- Tests: `tests/augment-sources.test.ts`.

## Role Inventory

- Project setup: augment auxiliary documents, resolve tsconfig, open the database, list Vue documents.
- Cache policy: fingerprint project/DB state, reuse exact prior Vue result, persist the new result.
- Transaction: create Vue synthetic symbols, compute Volar-backed references, dedupe occurrences, replace generated chunks, return the persisted summary.
- Runtime bridges: hide Volar dependency loading, source/generated offset mapping, SQLite chunk replacement, and source-text reads behind named helpers.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| V1 | Name the transaction in code instead of a suppression comment. | `augmentVueResolvedReferences()` previously carried the "Vue augmentation transaction" name only in a comment while locals performed compute/dedupe/write/report. | extract |
| V2 | Remove loose write/result helpers that only existed because the transaction was unnamed. | `writeVueResolvedOccurrences()` and `vueResolvedResult()` were single-step helpers called only by `augmentVueResolvedReferences()`. | inline |
| V3 | Rename low-threshold Vue helper candidates as explicit phase bridges. | `createVueSymbolLookup()` materialized synthetic component symbols; `resolveDefinitionSymbolId()` bridged Volar definitions to SCIP symbol ids. The old names hid those roles. | enforce |
| V4 | Keep Volar context creation separate from the transaction. | `createVueLanguageContext()` owns dependency loading, tsconfig parsing, project host construction, and language-service creation. | keep |
| V5 | Do not introduce a public `VueAugmentationTransaction` type yet. | The existing public summary type already represents the persisted result, and exporting a new single-consumer type would widen API surface without another adapter. | skip |

## Dependency Order

1. Preserve cache setup and reuse at the command-facing entry point.
2. Extract `runVueAugmentationTransaction()` as the compute-normalize-write-report boundary.
3. Inline the previous write and result wrappers into that boundary.
4. Rename `createVueComponentSymbolLookup()` and `resolveVueDefinitionSymbolId()` as phase bridges.
5. Verify that worker computation still compiles and direct augmentation behavior remains covered.

## Touch Map

- `src/reindex/augment-vue.ts`: transaction boundary and helper inlining.
- `docs/plans/2026-06-07-primogen-disgust-register.md`: completion note.
- `docs/plans/2026-06-07-vue-augmentation-transaction-atlas.md`: this ledger.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/augment-sources.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js wrapper-candidates --max-loc 40 --limit 80
```

Validation result:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- tests/augment-sources.test.ts`: passed, 3 tests.
- `npm test`: passed, 36 files and 177 tests.
- `npm run build`: passed.
- `node dist/cli.js reindex --force --allow-partial`: passed.
- `node dist/cli.js health --json`: score 100, zero findings.
- `node dist/cli.js drift --min-deviation 3`: no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120`: no stale abstractions.
- `node dist/cli.js wrapper-candidates --max-loc 40 --limit 80`: Vue helper candidates removed; 4 pre-existing evidence/AST boundary candidates remain.

## Compression Audit

The new mechanism removes one hidden concept: Vue augmentation is no longer a sequence of loose locals inside the CLI-facing entry point. The entry point now coordinates cache reuse and persistence, while `runVueAugmentationTransaction()` owns the ordered mutation. This is a real compression because two one-use helpers disappeared and the lifecycle name now sits on the code that enforces the order. The remaining Vue runtime helpers now identify their real phase roles: component-symbol materialization and Volar-definition resolution.
