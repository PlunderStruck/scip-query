# Complexity wave 4 worker 2

Base: `1d028fc1`.

## Targets

- complexity:src/reindex/index.ts:prepareSharedGenerationCache — prepareSharedGenerationCache: cyclomatic 18, cognitive 22.
- complexity:src/reindex/project-shards.ts:deriveProjectDependencies — deriveProjectDependencies: cyclomatic 15, cognitive 27.
- complexity:src/reindex/project-shards.ts:stripJsonComments — stripJsonComments: cyclomatic 16, cognitive 27.
- complexity:src/reindex/runtime-boundaries.ts:runtimeBoundaryAugmentationStage.run — runtimeBoundaryAugmentationStage.run: cyclomatic 18, cognitive 18.
- complexity:src/reindex/shared-generation-store.ts:findSharedBaselineGeneration — findSharedBaselineGeneration: cyclomatic 18, cognitive 21.
- complexity:src/reindex/shared-generation-store.ts:hydrateSharedGeneration — hydrateSharedGeneration: cyclomatic 18, cognitive 20.
- complexity:src/reindex/sqlite-generation-store.ts:inspectLocalSqliteGenerationRetention — inspectLocalSqliteGenerationRetention: cyclomatic 18, cognitive 14.
- complexity:src/reindex/typescript-overlay-store.ts:commitTypeScriptOverlay — commitTypeScriptOverlay: cyclomatic 18, cognitive 11.
- complexity:src/runtime/repository-cache-lifecycle.ts:buildSweepInventory — buildSweepInventory: cyclomatic 18, cognitive 27.
- complexity:src/runtime/watch.ts:Watcher.constructor — Watcher.constructor: cyclomatic 18, cognitive 1.
- complexity:src/runtime/watch.ts:resolveReindexWorkerLaunch — resolveReindexWorkerLaunch: cyclomatic 18, cognitive 5.
- complexity:src/reindex/index.ts:buildFreshReindexShardDiagnostics — buildFreshReindexShardDiagnostics: cyclomatic 17, cognitive 24.

## Plan

Exact implementations read before START. Extract cohesive cache selection, hydration staging, diagnostic assembly, dependency scanning, JSON comment scanning, runtime graph reporting, retention observations, overlay validation, sweep inventories and watcher defaults. Preserve branch precedence, lock scopes, mutation and rollback order, ownership annotations, error messages, defaults and output order. No broad name substitutions. Run focused existing tests, installed lint/format and exact scoped reviews; all targets and new helpers <=10 cyclomatic /15 cognitive. Parent owns combined validation/build.

## Results

All 12 targets implemented across the eight manifest files. Current after-function metrics for every changed/introduced function are <=10 cyclomatic and <=15 cognitive.

| Target                                  | Cyclomatic | Cognitive |
| --------------------------------------- | ---------: | --------: |
| `deriveProjectDependencies`             |          5 |         5 |
| `stripJsonComments`                     |          9 |        14 |
| `runtimeBoundaryAugmentationStage.run`  |          9 |         7 |
| `findSharedBaselineGeneration`          |          8 |         8 |
| `hydrateSharedGeneration`               |         10 |         8 |
| `inspectLocalSqliteGenerationRetention` |          7 |         7 |
| `commitTypeScriptOverlay`               |          7 |         4 |
| `buildSweepInventory`                   |          1 |         0 |
| `Watcher.constructor`                   |         10 |         1 |
| `resolveReindexWorkerLaunch`            |          7 |         4 |
| `buildFreshReindexShardDiagnostics`     |          6 |         9 |
| `prepareSharedGenerationCache`          |          9 |         7 |

Hydration retains its 30-second default lifecycle lock, pre-mutation staging/integrity/rebase, backup and mutation marker, promotion, final validation, lease write, rollback and cleanup/release ordering. Shared baseline selection retains cheap manifest filtering before artifact hashing, exact-tree/distance/newest/id precedence and corrupt-candidate fallback. Overlay validation retains missing-base/producer/project precedence and one-time legacy migration semantics before ordered blob writes. Retention retains zero-wait locking, previous-collection defaults and observational lease inspection. Sweep scanning retains lease/lock/generation order, symlink rejection and temporary-directory race handling. Watcher initialization retains callback/clock defaults and per-instance input-state registration; worker environment keeps latest-config overrides and serialization order. Existing ownership annotations remain attached to their owners.

Validation: 186 distinct tests across eight files passed (project-shards21, shared-generation-store28, sqlite-generation-store29, typescript-fragment-store3, runtime-boundaries30, repository-cache-lifecycle15, watch54, shared-worktree-cache integration6). Integration includes simultaneous cold worktrees, dirty first attachment, shared publication/private updates and retention plateau. All eight changed-file ESLint and Prettier checks and scoped diff whitespace check passed. A deterministic differential check matched original/new comment stripping for 10,000 inputs including quotes, escapes, slashes, comment markers and whitespace.

Metrics: scoped reviews write JSON to /tmp/wave4-worker2-final-review-{0..7}.json and final index review to /tmp/wave4-worker2-index-final-review.json; selective combined metrics at /tmp/wave4-worker2-metrics.json. Earlier scoped reviews marked aggregate coverage incomplete because another worker changed navigation.ts during parsing; their own-file after metrics were available. The final index review has accounted coverage with no problems. Parent performs final combined metrics after all workers freeze.

The final source typecheck reports errors only in other workers' co-change.ts and output-pagination.ts; no errors in this lane. Log: /tmp/wave4-worker2-frozen-types.log. No source/test/check process remains running. No new dependencies, policies, thresholds, suppressions or public APIs; no build/reindex/commit executed. Source and checkpoint frozen for parent integration.
