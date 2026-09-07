# Complexity wave 5 worker 2

Base: `07d24068`.

## Targets

- complexity:src/reindex/shared-generation-store.ts:publishSharedGenerationOwned — publishSharedGenerationOwned: cyclomatic 17, cognitive 16.
- complexity:src/reindex/sqlite-generation-store.ts:materializeGeneration — materializeGeneration: cyclomatic 17, cognitive 15.
- complexity:src/runtime/index-freshness.ts:getPublishedIndexFreshness — getPublishedIndexFreshness: cyclomatic 17, cognitive 15.
- complexity:src/runtime/project-readiness.ts:getProjectCapabilities — getProjectCapabilities: cyclomatic 17, cognitive 19.
- complexity:src/runtime/watch-service.ts:ensureWatchService — ensureWatchService: cyclomatic 17, cognitive 15.
- complexity:src/reindex/index.ts:classifyLanguageShardReuse — classifyLanguageShardReuse: cyclomatic 16, cognitive 22.
- complexity:src/reindex/indexer-runner.ts:runPreparedIndexer — runPreparedIndexer: cyclomatic 16, cognitive 23.
- complexity:src/reindex/shared-generation-store.ts:managedGenerationMatchesFingerprint — managedGenerationMatchesFingerprint: cyclomatic 16, cognitive 7.
- complexity:src/reindex/shared-generation-store.ts:prepareSharedGenerationForProject — prepareSharedGenerationForProject: cyclomatic 16, cognitive 18.
- complexity:src/reindex/shared-generation-store.ts:publishFreshLocalGenerationForProject — publishFreshLocalGenerationForProject: cyclomatic 16, cognitive 13.
- complexity:src/runtime/project-readiness.ts:languageCapability — languageCapability: cyclomatic 16, cognitive 16.
- complexity:src/reindex/sanitize.ts:sanitizeScipBuffer — sanitizeScipBuffer: cyclomatic 14, cognitive 25.

## Plan

Exact implementations and focused tests located during read-only preparation. Extract publication staging/validation, generation artifact handling, freshness acceptance, capability aggregation, watcher start preparation, shard acceptance, indexer outcome reporting and sanitizer symbol collection. Preserve publication locks, durability hooks, race recovery, cleanup, validation precedence, read-only lease proof, double watcher inspection, abort/trusted-tool checks and reverse temporary-config release. Every target/new helper <=10 cyclomatic /15 cognitive. Run focused source tests, installed lint/format, scoped metrics and diff review. Parent owns build/full-suite/API/combined checks.

## Results

All 12 assigned targets completed across eight source files. Every changed target and introduced helper is <=10 cyclomatic and <=15 cognitive; introduced-helper maxima are 9/10.

| Target                                  | Cyclomatic | Cognitive |
| --------------------------------------- | ---------: | --------: |
| `materializeGeneration`                 |          9 |         8 |
| `getPublishedIndexFreshness`            |          7 |         7 |
| `getProjectCapabilities`                |          9 |         9 |
| `languageCapability`                    |         10 |        11 |
| `ensureWatchService`                    |          7 |         5 |
| `classifyLanguageShardReuse`            |          4 |         3 |
| `runPreparedIndexer`                    |         10 |        11 |
| `sanitizeScipBuffer`                    |          6 |         7 |
| `managedGenerationMatchesFingerprint`   |          8 |         6 |
| `prepareSharedGenerationForProject`     |         10 |         9 |
| `publishFreshLocalGenerationForProject` |         10 |         8 |
| `publishSharedGenerationOwned`          |          8 |         6 |

Publication retains the existing-generation fast return, source proof/signature checks, read-only artifact clones, ordered durability hooks, corrupt-target replacement and raced-generation fallback, plus staging cleanup under the original publication lock. SQLite materialization retains verified-artifact validation, existing-manifest matching, ordered cloning, sync/rename and finally cleanup. Shared preparation retains dirty/exact/peer/baseline precedence and lease differences; managed fingerprint proof remains read-only. Freshness checks publication metadata before always inspecting the SQLite generation. Capability aggregation retains empty/sparse handling, runtime probes and result ordering. Watcher ensure retains both inspections, live-old-heartbeat refusal, bounded concurrent-start wait and activity writes. Indexer failure reporting retains abort precedence, 8KiB detail bounds, retry classification, default-output recovery and reverse temporary-config release. Shard classification retains every miss reason and metadata/file/fingerprint/coverage precedence. Sanitizer symbol collection validates document paths before repair and retains malformed-wire handling and unchanged wire bytes. Existing annotations remain attached to their owners.

Validation: 187 distinct tests across 12 files passed: reindex-reliability46, shared-generation-store28, sqlite-generation-store29, watch-service35, index-freshness12, indexer-runner-temporary-config7, project-tool-execution2, indexer-runner-cancellation1, project-readiness8, reindex-sanitize10, shared-worktree-cache integration6 and worktree-watch-service integration3. Final shared snapshot extraction was followed by another passing 28-test shared-generation run. Source typecheck passed (/tmp/wave5-worker2-frozen-types.log), all eight changed-file ESLint/Prettier checks passed, and scoped diff whitespace checks passed.

Exact source metrics: /tmp/wave5-worker2-final-review-{0..7}.json, superseded shared review /tmp/wave5-worker2-shared-final-review.json, selective metrics /tmp/wave5-worker2-metrics.json. All final review packets have accounted coverage with no problems; no function remains above the required limits. Parent owns final combined build/full suite/API/health/impact. Root nine-target diff plus calibration regression test reviewed read-only with no concrete findings.

Source and checkpoint frozen; no test or check process remains running. No package, threshold, policy, suppression or public API changes; no build/reindex/commit/VM/benchmark performed.
