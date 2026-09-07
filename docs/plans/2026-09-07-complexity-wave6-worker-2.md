# Wave 6 worker 2 complexity refactors

Baseline: `20ba96c7`. Exclusive ownership is the whole source files below. Other workers are active; their edits will be preserved.

## Targets

- `src/runtime/setup.ts`: `uninstallSkills` — uninstallSkills: cyclomatic 11, cognitive 23.
- `src/reindex/shared-generation-store.ts`: `validateSourceGeneration` — validateSourceGeneration: cyclomatic 15, cognitive 14.
- `src/reindex/typescript-index-requester.ts`: `decodeDocumentResponse.fragments.<callback:response.fragments.map:0>` — decodeDocumentResponse.fragments.<callback:response.fragments.map:0>: cyclomatic 15, cognitive 4.
- `src/reindex/typescript-index-service.ts`: `TypeScriptIndexServiceHost.constructor` — TypeScriptIndexServiceHost.constructor: cyclomatic 15, cognitive 7.
- `src/runtime/project-setup.ts`: `remediateIndexers` — remediateIndexers: cyclomatic 15, cognitive 14.
- `src/runtime/watch.ts`: `Watcher.handleFileChange` — Watcher.handleFileChange: cyclomatic 15, cognitive 11.
- `src/semantic/typescript/session-service.ts`: `TypeScriptSemanticServiceHost.status` — TypeScriptSemanticServiceHost.status: cyclomatic 15, cognitive 12.
- `src/reindex/affected-shadow.ts`: `collectAffectedSetShadowRecord` — collectAffectedSetShadowRecord: cyclomatic 14, cognitive 12.
- `src/reindex/index.ts`: `collectIndexerOutputs` — collectIndexerOutputs: cyclomatic 10, cognitive 21.
- `src/reindex/index.ts`: `publishFreshReindexArtifacts` — publishFreshReindexArtifacts: cyclomatic 14, cognitive 13.
- `src/reindex/shared-generation-store.ts`: `readSharedGeneration` — readSharedGeneration: cyclomatic 14, cognitive 10.
- `src/reindex/sqlite-generation-store.ts`: `ensureImmutableSqliteGeneration` — ensureImmutableSqliteGeneration: cyclomatic 14, cognitive 11.
- `src/reindex/typescript-compiler-shards.ts`: `partitionTypeScriptCompilerInputsIntoShards` — partitionTypeScriptCompilerInputsIntoShards: cyclomatic 14, cognitive 16.
- `src/reindex/vue/augment-vue-workers.ts`: `awaitVueReferenceWorkers` — awaitVueReferenceWorkers: cyclomatic 14, cognitive 12.
- `src/reindex/vue/augment-vue-workers.ts`: `readWorkerResult` — readWorkerResult: cyclomatic 14, cognitive 11.
- `src/semantic/rust/durable-session-server.ts`: `processDurableRustSessionRequests` — processDurableRustSessionRequests: cyclomatic 15, cognitive 19.
- `src/semantic/rust/provider.ts`: `createRustSemanticProvider` — createRustSemanticProvider: cyclomatic 15, cognitive 2.
- `src/semantic/rust/scip-occurrence-callees.ts`: `loadScipOccurrenceCalleeIndex` — loadScipOccurrenceCalleeIndex: cyclomatic 15, cognitive 19.
- `src/semantic/rust/scip-occurrence-references.ts`: `loadScipOccurrenceReferenceIndex` — loadScipOccurrenceReferenceIndex: cyclomatic 15, cognitive 17.
- `src/semantic/shared-primitives.ts`: `materializeSemanticReferenceBatch` — materializeSemanticReferenceBatch: cyclomatic 16, cognitive 20.
- `src/semantic/shared-primitives.ts`: `buildSemanticCalleeMap.<callback:profileSpan:1>` — buildSemanticCalleeMap.<callback:profileSpan:1>: cyclomatic 12, cognitive 22.
- `src/semantic/typescript/ts-morph-provider.ts`: `TsMorphSemanticProvider.definitionFromCompilerSymbol` — TsMorphSemanticProvider.definitionFromCompilerSymbol: cyclomatic 16, cognitive 22.
- `src/semantic/typescript/ts-morph-provider.ts`: `TsMorphSemanticProvider.importUsageForSourceFile` — TsMorphSemanticProvider.importUsageForSourceFile: cyclomatic 14, cognitive 24.
- `src/semantic/typescript/ts-morph-provider.ts`: `TsMorphSemanticProvider.referencesForDefinitions` — TsMorphSemanticProvider.referencesForDefinitions: cyclomatic 15, cognitive 19.
- `src/platform/fingerprint-stat-cache.ts`: `isFingerprintStatRecord` — isFingerprintStatRecord: cyclomatic 14, cognitive 5.

## Plan

Extract cohesive validation, collection, and result-handling responsibilities while preserving validation order, defaults, cache sharing, publication and lock scope, resource cleanup, and error precedence. Preserve existing annotations and public signatures. Read implementations through scip-query; drain all continuation cursors. Run focused source tests, installed lint/format tools, and a consolidated source review followed by scoped corrections. Every target and new helper must have cyclomatic complexity at most 10 and cognitive complexity at most 15. Root owns combined build, types, API, full tests, health, and impact checks.

## Evidence and results

Preparation read all 25 exact target implementations and located focused tests; no source changes or checks occurred before START. Implementation and verification complete; source frozen.

## Changes and preserved contracts

- Separated skill-entry removal, indexer remediation, watcher filtering, service capacity validation and status counters. Validation/default precedence, skipped/removed reporting, configuration refresh timing and unsupported event handling remain ordered as before.
- Separated generation identity/metadata/integrity checks, immutable state construction, weighted shard boundary decisions, index output materialization and publication diagnostics. Retained artifact byte limits, metadata checks before bypasses, database close ordering, rollback/publication operations, deferred companion semantics, shard failure blocking and durable state writes.
- Separated Vue worker JSON reads and cleanup. Size checks precede parsing; identity precedes task/payload checks. Workers terminate before directory removal, termination failures preserve the directory, and cleanup errors retain precedence and the original operation error.
- Separated Rust mailbox rejection responses, resolver selection and per-document SCIP collectors. Claim ownership, expiry checks, response identity, completion/rejection timing, per-provider caches, optional session creation, ignore filtering and missing/corrupt index fallbacks remain intact.
- Separated semantic reference application, bounded bulk callees, TypeScript compiler lookup and import item creation. Cache mutations retain their order, incomplete evidence is not cached as complete, scalar/bulk ordering and batch bounds remain unchanged, exact lookup and fallback behavior remain intact.
- Fingerprint validation still accepts exactly the same object fields and finite numeric values; no added positivity, safe-integer, or object-shape restrictions.

## Verification

- 348 distinct focused tests passed across 21 files: `/tmp/wave6-worker2-tests-a.log` (222/11), `-b.log` (99/7), and `-extra.log` (27/3). After metric corrections, 133 affected tests across 8 files passed again (`/tmp/wave6-worker2-tests-correction.log`). Existing suites exercise generation corruption/rollback, deferred incremental publication, worker cleanup, mailbox validation, cache gates, watcher events and semantic provider behavior; no redundant new test was added.
- Installed eslint, prettier check, and owned-file git diff check passed: `/tmp/wave6-worker2-final-{lint,format,diff-check}.log`. Source typecheck passed: `/tmp/wave6-worker2-final-types.log`.
- Consolidated source review, then one correction review restricted to `src`: `/tmp/wave6-worker2-review-initial.json` and `/tmp/wave6-worker2-review-corrected.json`. Final review coverage is accounted with no capture problems. Filtered exact owned after-functions: `/tmp/wave6-worker2-metrics-final.json`. All 25 targets and all 75 added function identities (including nested callbacks moved by extraction) are at most 10 cyclomatic / 15 cognitive.
- Reviewed all owned diffs against `20ba96c7`; no behavior discrepancy found. No source annotations, package files, thresholds or suppressions changed. No build, reindex or commit performed. No processes remain running. Root owns combined frozen build/API/fullsuite/health/impact verification.

## Exact final target metrics

| Target                                                                 | Cyclomatic | Cognitive |
| ---------------------------------------------------------------------- | ---------: | --------: |
| `uninstallSkills`                                                      |          6 |         5 |
| `validateSourceGeneration`                                             |         10 |        10 |
| `decodeDocumentResponse.fragments.<callback:response.fragments.map:0>` |         10 |         3 |
| `TypeScriptIndexServiceHost.constructor`                               |          9 |         1 |
| `remediateIndexers`                                                    |          7 |         7 |
| `Watcher.handleFileChange`                                             |          6 |         5 |
| `TypeScriptSemanticServiceHost.status`                                 |         10 |        12 |
| `collectAffectedSetShadowRecord`                                       |         10 |         8 |
| `collectIndexerOutputs`                                                |          6 |        10 |
| `publishFreshReindexArtifacts`                                         |         10 |         9 |
| `readSharedGeneration`                                                 |         10 |         9 |
| `ensureImmutableSqliteGeneration`                                      |         10 |         8 |
| `partitionTypeScriptCompilerInputsIntoShards`                          |          8 |         8 |
| `awaitVueReferenceWorkers`                                             |         10 |         6 |
| `readWorkerResult`                                                     |         10 |         8 |
| `processDurableRustSessionRequests`                                    |         10 |        10 |
| `createRustSemanticProvider`                                           |          8 |         0 |
| `loadScipOccurrenceCalleeIndex`                                        |          9 |         7 |
| `loadScipOccurrenceReferenceIndex`                                     |          9 |         8 |
| `materializeSemanticReferenceBatch`                                    |          9 |         8 |
| `buildSemanticCalleeMap.<callback:profileSpan:1>`                      |          7 |        12 |
| `TsMorphSemanticProvider.definitionFromCompilerSymbol`                 |         10 |        12 |
| `TsMorphSemanticProvider.importUsageForSourceFile`                     |          9 |        12 |
| `TsMorphSemanticProvider.referencesForDefinitions`                     |          9 |        11 |
| `isFingerprintStatRecord`                                              |          9 |         5 |

## Cross-review correction: callback receiver

Worker 3 identified that the two publication reporters called a detached status callback. Corrected both to receive the fresh-run object and invoke `run.onStatus(...)`, preserving the original receiver and delaying callback access until a report applies. Added `tests/reindex/complexity-wave6-worker2-reporters.test.ts`: two regression cases verify receiver identity, additions/removals/durability message ordering, and no callback access when no report applies.

The regression and affected reindex reliability/incremental-publication suites passed: 55 tests across 3 files (`/tmp/wave6-worker2-receiver-tests.log`). The new tests bring this lane to 350 distinct focused tests across 22 files. Changed-source/test eslint, prettier check and diff check passed (`/tmp/wave6-worker2-receiver-{lint,format}.log`).

This receiver-only correction adds no decisions or logical operators: measured metrics remain `publishFreshReindexArtifacts` 10/9, `reportPublishedIndexMaintenance` 3/2 and `reportLocalGenerationDurability` 2/1. Prior review source hashes for these functions predate the receiver correction; root's combined frozen review is authoritative. Files are frozen again and no processes remain. Root cross-review of all 15 targets and its regression file found no concrete issues.
