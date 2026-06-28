# Indexer Concurrency Config

Date: 2026-06-28

## Gate A - Goal

Make indexing faster on TypeScript workspaces by default, using the latest `flesler/scip-cli` worker-cap idea, while keeping accuracy and safety unchanged. Done means a project can persist an indexer worker cap in `.scipquery.json`, every automatic reindex path honors it, and the default uses more available CPU for multi-shard work without changing index contents.

## Gate B - Current Flow

- [x] `src/reindex/indexer-runner.ts:83-95` resolves indexer concurrency from explicit `configured`, then `SCIP_QUERY_INDEXER_CONCURRENCY`, then a hard default of `Math.min(2, cpus().length - 1)`. Change the fallback to a higher bounded default equivalent to `min(8, cpus)` while still clamping to `runCount`.  
  Source: `scip-query code resolveIndexerConcurrency -C 35`.

- [x] `src/runtime/commands/command-handlers.ts:110-128` passes only the CLI `--indexer-concurrency` option into `reindex()`. Add project config fallback so CLI option wins, config comes next, env/default remains inside the runner.  
  Source: `scip-query code handleReindex -C 30`.

- [x] `src/runtime/commands/command-handlers.ts:305-331` and `src/runtime/commands/command-handlers.ts:346-362` run bench cold/warm index paths without any project-configured concurrency. Thread the same config value into both so benchmarked indexing matches real indexing.  
  Source: `scip-query code src/runtime/commands/command-handlers.ts:300-365`.

- [x] `src/runtime/project-setup.ts:192-204` runs setup reindex using project language and TypeScript settings, but no concurrency setting. Thread the config value through setup so first-run setup benefits from the same policy.  
  Source: `scip-query code runProjectSetup -C 40`.

- [x] `src/runtime/agent-hooks.ts:434-445` auto-refreshes stale indexes from hooks, but no concurrency setting reaches `reindex()`. Thread the config value through so hook refreshes are not slower than manual refreshes.  
  Source: `scip-query code src/runtime/agent-hooks.ts:410-455`.

- [x] `src/runtime/watch.ts:255-278` forks `reindex-worker.js` and passes project root, output paths, language list, TypeScript config, and trigger through env. Add one env var for project-configured indexer concurrency, re-reading the latest config before every watcher-triggered child process as it already does for TypeScript config.  
  Source: `scip-query code src/runtime/watch.ts:250-292`.

- [x] `src/reindex/worker.ts:24-34` reads env and invokes `reindex()` without concurrency. Parse a positive integer env value and pass it through.  
  Source: `scip-query code parseTypeScriptWorkerConfig -C 35`.

- [x] `src/runtime/config.ts:65-130` validates language, watch, and TypeScript indexer config fields, but no project-wide indexer concurrency field exists. Add `ProjectConfig.indexerConcurrency?: number` in `src/domain/config-types.ts`, validate it as a positive integer here, and keep `initProjectConfig()` default output unchanged unless a user opts in.  
  Source: `scip-query code validateProjectConfig -C 45`; `scip-query code initProjectConfig -C 35`.

## Gate C - Reuse Audit

- [x] Reuse the existing `runPreparedIndexers()` concurrency runner and serial retry behavior; do not add a second scheduler.  
  Source: `scip-query code runPreparedIndexers -C 20`.

- [x] Reuse the existing config validation style in `validateProjectConfig()` and the existing CLI option parser in `handleReindex()`. No new parser helper is needed.  
  Source: `scip-query code validateProjectConfig -C 45`; `scip-query code handleReindex -C 30`.

- [x] `scip-query similar resolveIndexerConcurrency --json --full` returned no close helper to reuse for this specific precedence chain.  
  Source: `scip-query similar resolveIndexerConcurrency --json --full`.

## Stress Test

- Understand: This is an indexing throughput change, not a new indexing algorithm. The runner already treats parallel failure as recoverable by retrying failed direct-output indexers serially.
- Blast radius: Manual reindex, bench index, setup, hook auto-refresh, and watcher worker all need the same config value.
- Intermediate validity: Adding the config field is optional; existing configs continue to parse and use env/default behavior.
- Reversibility: Removing `indexerConcurrency` from config or setting CLI/env override returns to current behavior; the code change itself is internal.
- Failure: If higher concurrency exposes an indexer failure, existing serial retry still runs before a shard is skipped.
- Concurrency: The existing runner clamps by run count and default-output indexers remain serial.
- Boundary: CLI/config inputs are validated as positive integers before use.
- Data integrity: No schema or persisted index format changes.
- Observability: Existing reindex status lines remain; no silent background path is introduced.
- Human: Users can persist the setting instead of remembering a terminal flag.
- Reuse: Use existing runner, config, watcher env, and worker patterns.

## Verification

- [x] `npm run typecheck`
- [x] Focused tests for config validation, manual reindex config fallback, watcher worker env propagation, and runner default cap.
- [x] `npm run build`
- [x] `npm test -- --run`
- [x] Stable temp workspace-index benchmark: old-default-equivalent concurrency 2 completed in 21.7s; new auto default completed in 21.2s on three TypeScript shards. Stable's earlier single-mode full reindex was 26.7s, so workspace sharding remains the larger win.
- [x] Reindex this repo and confirm fresh status.
- [x] `scip-query diff-gate --json`
