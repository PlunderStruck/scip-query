# TypeScript Project Sharding Plan - 2026-06-27

## Goal

Make cold TypeScript indexing materially faster on monorepos while preserving the current single-project behavior and query output contracts.

A TypeScript project is a compiler configuration root that names the source files and type relationships a TypeScript tool can see. A TypeScript project shard is one independently indexed compiler root whose SCIP protobuf can be merged with other shards from the same repository. Done means `scip-query reindex` can run multiple TypeScript project shards concurrently when the project config opts into that mode, watcher and bench reindex paths use the same setting, stale-index fingerprints change when the setting changes, and the final SQLite index remains one coherent project index.

## Current State

- `src/reindex/indexers.ts:13-21` runs TypeScript today as one `scip-typescript index --infer-tsconfig --output <path> --no-progress-bar` process, optionally inserting `--pnpm-workspaces`.  
  Source: `scip-query code src/reindex/indexers.ts:1-120`.
- `src/reindex/index.ts:320-349` reuses unchanged language shards, prepares language indexer runs, calls `runPreparedIndexers`, collects successful outputs, validates partial failures, and returns one list of indexed language outputs.  
  Source: `scip-query plan-context runLanguageIndexersForFreshReindex`; `scip-query code runLanguageIndexersForFreshReindex -C 20`.
- `src/reindex/indexer-runner.ts:92-128` already runs direct-output indexers with bounded concurrency and retries failed direct-output runs serially, but it identifies runs only by language. Multiple TypeScript runs would currently collide in retry lookup and result ordering.  
  Source: `scip-query plan-context runPreparedIndexers`; `scip-query code PreparedIndexerRun -C 20`; `scip-query code runWithConcurrency -C 20`.
- `src/reindex/merge.ts:40-54` already merges multiple SCIP protobuf files into one protobuf, and `src/reindex/index.ts:581-595` already calls that merge when more than one indexed output reaches publishing.  
  Source: `scip-query plan-context mergeScipFiles`; `scip-query code materializeScipOutput -C 20`.
- `src/reindex/index.ts:354-399` caches language shards before materializing the final SCIP and SQLite outputs. That means project shards must be consolidated to a single TypeScript language output before this publish phase, or the language shard cache would be overwritten by whichever TypeScript project finished last.  
  Source: `scip-query code publishFreshReindexArtifacts -C 20`.
- `src/reindex/index.ts:793-824` fingerprints current index semantics with languages, `pnpmWorkspaces`, and project files. The fingerprint must include project-sharding settings so a setting flip cannot reuse an index produced under different semantics.  
  Source: `scip-query code computeReindexFingerprint -C 20`; `scip-query code computeLanguageFingerprints -C 20`.
- `src/runtime/index-freshness.ts:61-100` independently computes runtime freshness for `status`, `doctor`, and hook auto-refresh. It must use the same effective TypeScript project mode and project list as reindex metadata.  
  Source: subagent review using `scip-query code getIndexFreshness -C 35`.
- `src/semantic/typescript/tsconfig-discovery.ts:55-81` already discovers configured or workspace TypeScript configs for semantic providers, but it returns tsconfig files and is coupled to semantic DB discovery in the same module. Reindex needs project roots and ancestor-deduping to avoid duplicate document occurrences.  
  Source: `scip-query plan-context src/semantic/typescript/tsconfig-discovery.ts`; `scip-query code src/semantic/typescript/tsconfig-discovery.ts:1-220`.
- `src/domain/config-types.ts:90-109` exposes `.scipquery.json` project config and `src/domain/config-types.ts:174-177` currently has only the TypeScript `pnpmWorkspaces` indexer override.  
  Source: `scip-query code ProjectConfig -C 20`; `scip-query code IndexerOverrides -C 10`.
- `src/runtime/commands/command-handlers.ts:109-126`, `src/runtime/commands/command-handlers.ts:291-345`, `src/runtime/watch.ts:64-80`, `src/runtime/watch.ts:246-276`, `src/reindex/worker.ts:21-31`, `src/runtime/agent-hooks.ts:434-443`, and `src/runtime/project-setup.ts:192-201` all pass reindex settings through separate manual, bench, watcher, worker, hook, and setup paths. Any new persistent config must flow through all of them.  
  Source: `scip-query code handleReindex -C 25`; `scip-query code measureColdIndex -C 25`; `scip-query code measureWarmIndex -C 20`; `scip-query code Watcher -C 5`; `scip-query code src/runtime/watch.ts:180-276`; `scip-query code src/reindex/worker.ts:1-80`; subagent review using `scip-query code refreshIndexForHookIfNeeded -C 35`; subagent review using `scip-query code runProjectSetup -C 35`.
- `src/runtime/config.ts:65-195` validates project config today, including watch settings and suppressions, but it does not validate any TypeScript project indexing mode or configured project roots.  
  Source: `scip-query plan-context loadProjectConfig`; `scip-query code validateProjectConfig -C 20`.

## Reuse Audit

- Reuse `runPreparedIndexers` and its existing bounded concurrency model, but add per-run identity so multiple same-language runs are safe.  
  Source: `scip-query plan-context runPreparedIndexers`; `scip-query similar prepareIndexerRuns --json --full`.
- Reuse `mergeScipFiles` for both language-level publishing and TypeScript project-shard consolidation. Add exact occurrence de-duplication in the merge layer only if overlap creates identical occurrences.  
  Source: `scip-query plan-context mergeScipFiles`; `scip-query code mergeDocuments -C 15`.
- Reuse the config surface at `indexer.typescript` rather than creating a separate top-level indexing section. The existing override already holds TypeScript-specific indexing behavior.  
  Source: `scip-query code IndexerOverrides -C 10`; `scip-query code ProjectConfig -C 20`.
- Do not reuse `discoverTypeScriptTsconfigsForProject` directly for reindex project sharding because it returns tsconfig file paths and falls back to semantic-provider needs; reindex needs project directories, ancestor de-duplication, and root-alongside-projects logic before calling `scip-typescript [projects...]`. Create a reindex-owned discovery helper and keep the semantic helper untouched for now.  
  Source: `scip-query plan-context src/semantic/typescript/tsconfig-discovery.ts`; `scip-query similar-files src/semantic/typescript/tsconfig-discovery.ts --json --full`.

## Design Phases

### 1.1 - Add TypeScript project-sharding config

- [ ] **File**: `src/domain/config-types.ts:33-63`, `src/domain/config-types.ts:90-109`, `src/domain/config-types.ts:174-177`
- **Source**: `scip-query code IndexerConfig -C 20`; `scip-query code ProjectConfig -C 20`; `scip-query code IndexerOverrides -C 10`.
- **What**: `IndexerConfig.indexArgs` can only receive `projectRoot`, `outputPath`, `pnpmWorkspaces`, and `indexerBinary`. `.scipquery.json` can only persist `indexer.typescript.pnpmWorkspaces`.
- **Change**: Add a `TypeScriptProjectMode = 'single' | 'workspace'` type; add `projectMode?: TypeScriptProjectMode` and `projects?: string[]` to `IndexerOverrides`; add `projectPath?: string` to `IndexerConfig.indexArgs` options.
- **Why**: The setting must be persistent in JSON config and must reach `scip-typescript` as explicit project arguments when sharding is enabled.

### 1.2 - Validate the new config

- [ ] **File**: `src/runtime/config.ts:65-195`
- **Source**: `scip-query code validateProjectConfig -C 20`.
- **What**: Config validation checks languages, watch settings, locality, declared couplings, and suppressions, but no TypeScript indexer project fields.
- **Change**: Validate `indexer.typescript.projectMode` as `single` or `workspace`; validate `indexer.typescript.projects` as a non-empty string array when present; warn when configured project paths do not exist if `projectRoot` is available.
- **Correction**: Treat outside-project paths as errors and warn when `pnpmWorkspaces` is set with `projectMode: "workspace"` because explicit project arguments make that flag single-mode-only.
- **Why**: Bad persistent config should fail fast through `scip-query config-validate`, `doctor`, and `status` instead of failing halfway through an index build.

### 2.1 - Discover TypeScript project roots for reindex

- [ ] **File**: new `src/reindex/typescript-projects.ts`
- **Source**: `scip-query plan-context src/semantic/typescript/tsconfig-discovery.ts`; `scip-query code src/semantic/typescript/tsconfig-discovery.ts:1-220`.
- **What**: The semantic helper finds tsconfig files from config and package workspaces. It does not produce project root arguments for `scip-typescript [projects...]`, and it does not drop ancestor projects when a more specific descendant exists.
- **Change**: Add `discoverTypeScriptProjectRoots(projectRoot, configuredProjects)` returning relative project directories. It should scan `tsconfig*.json`, skip artifact directories, keep configs that have `include`, `files`, `references`, or are named `tsconfig.json`, drop ancestor directories when descendant projects are present, include `.` when the root `tsconfig.json` covers subdirectories, and fall back to `['.']`.
- **Why**: Project-root sharding must avoid indexing the same files through both parent and child projects unless the root config explicitly covers shared source.

### 2.2 - Pass project roots to scip-typescript

- [ ] **File**: `src/reindex/indexers.ts:13-21`
- **Source**: `scip-query code src/reindex/indexers.ts:1-120`.
- **What**: TypeScript always receives `--infer-tsconfig`, and `--pnpm-workspaces` is the only special option.
- **Change**: When `projectPath` is present, build args as `['index', '--output', outputPath, '--no-progress-bar', projectPath]` and do not add `--infer-tsconfig`. Keep the current `--infer-tsconfig` and optional `--pnpm-workspaces` behavior when no project path is present.
- **Why**: This preserves existing single-run semantics while enabling one `scip-typescript` process per project root.

### 3.1 - Make indexer runs identifiable

- [ ] **File**: `src/reindex/indexer-runner.ts:9-25`, `src/reindex/indexer-runner.ts:92-128`, `src/reindex/indexer-runner.ts:133-172`
- **Source**: `scip-query plan-context runPreparedIndexers`; `scip-query code PreparedIndexerRun -C 20`; `scip-query code runPreparedIndexer -C 15`.
- **What**: Retry and ordering identify results by language, which is insufficient for multiple TypeScript project runs.
- **Change**: Add `id`, `label`, and `outputScipPath` to `PreparedIndexerRun`; add the same identity/output fields to `IndexerRunResult`; key serial retries and result replacement by `id`; show `label` in status messages.
- **Why**: Parallel sharding only helps if same-language runs can execute and retry independently without overwriting each other.

### 3.2 - Expand TypeScript into project runs, then consolidate by language

- [ ] **File**: `src/reindex/index.ts:453-548`, `src/reindex/index.ts:581-595`, `src/reindex/index.ts:631-635`
- **Source**: `scip-query code prepareIndexerRuns -C 30`; `scip-query code collectIndexerOutputs -C 20`; `scip-query code materializeScipOutput -C 20`; `scip-query code tempScipPath -C 15`.
- **What**: Each detected language creates one prepared run and one successful output. Multiple outputs only mean multiple languages today.
- **Change**: If language is TypeScript and `projectMode === 'workspace'`, discover project roots. Create one run per discovered or configured project root, even when there is only one, with a unique shard path and a shared `outputScipPath` for the TypeScript language. After runs finish, group successes by `outputScipPath`; merge multiple project shard paths into that language output before returning `IndexedOutput[]`.
- **Correction**: Aggregate same-language shard failures into one `skipped` entry with shard detail so `ReindexResult.skipped` remains language-based.
- **Why**: The publish phase and language shard cache must still see one output per language.

### 3.3 - De-duplicate exact occurrences during merge

- [ ] **File**: `src/reindex/merge.ts:75-99`
- **Source**: `scip-query code mergeDocuments -C 15`; `scip-query code mergeSymbolInfos -C 15`.
- **What**: `mergeDocuments` concatenates occurrences when two SCIP indexes contain the same relative path. Overlapping TypeScript projects can produce exact duplicate occurrences.
- **Change**: Add a small `mergeOccurrences` helper that keeps distinct occurrences but removes exact duplicates by range, symbol, role, syntax kind, and enclosing range before writing the merged document.
- **Why**: Project sharding should not inflate references or health signals when two legitimate projects overlap.

### 4.1 - Fingerprint the sharding semantics

- [ ] **File**: `src/reindex/index.ts:131-152`, `src/reindex/index.ts:354-419`, `src/reindex/index.ts:786-824`, `src/runtime/index-freshness.ts:61-100`
- **Source**: `scip-query code reindex -C 20`; `scip-query code publishFreshReindexArtifacts -C 20`; `scip-query code computeReindexFingerprint -C 20`.
- **What**: Reindex fingerprints currently track languages, `pnpmWorkspaces`, and file content.
- **Change**: Add `typescriptProjectMode` and normalized `typescriptProjects` to full and language fingerprints. Pass those options into `prepareIndexerRuns`, `reusableLanguageOutputs`, `computeLanguageFingerprints`, and runtime freshness. Record effective `pnpmWorkspaces` as false in workspace mode because the option is ignored there.
- **Why**: Changing sharding mode changes how the index is produced, so the cache must rebuild instead of reusing stale artifacts.

### 4.2 - Wire manual, bench, watch, and worker paths

- [ ] **File**: `src/runtime/commands/command-handlers.ts:109-126`, `src/runtime/commands/command-handlers.ts:291-345`, `src/runtime/watch.ts:64-80`, `src/runtime/watch.ts:246-276`, `src/reindex/worker.ts:21-31`, `src/runtime/agent-hooks.ts:434-443`, `src/runtime/project-setup.ts:192-201`
- **Source**: `scip-query code handleReindex -C 25`; `scip-query code measureColdIndex -C 25`; `scip-query code measureWarmIndex -C 20`; `scip-query code Watcher -C 5`; `scip-query code src/runtime/watch.ts:180-276`; `scip-query code src/reindex/worker.ts:1-80`.
- **What**: The CLI, bench, watcher, and forked worker currently pass only languages, output paths, `pnpmWorkspaces`, and trigger metadata.
- **Change**: Thread `config.indexer?.typescript?.projectMode` and `config.indexer?.typescript?.projects` through these reindex calls. Encode watcher worker TypeScript settings as one JSON env payload. Re-read `.scipquery.json` before each watcher-triggered worker run so a long-running watcher picks up changed indexing settings.
- **Why**: Persistent config must behave identically whether reindexing is manual, benchmarked, or triggered in the background.

### 5.1 - Test behavior and compatibility

- [ ] **File**: add focused tests under the existing reindex/runtime test suites
- **Source**: `scip-query plan-context runLanguageIndexersForFreshReindex`; `scip-query plan-context loadProjectConfig`; `scip-query plan-context mergeScipFiles`.
- **What**: The indexed source slice proves the behavior hooks, but tests are not part of the current SCIP index.
- **Change**: Add tests for project discovery ancestor de-duplication, config validation, runner retry identity for same-language runs, and exact occurrence de-duplication. Add a fixture or mocked indexer test that confirms workspace mode prepares multiple TypeScript runs and returns one language output.
- **Why**: This is indexing infrastructure; regressions would be expensive and easy to miss with only an end-to-end reindex.

## Stress Test

- Understand before touch: the current implementation optimizes safety first: a lock, temp outputs, atomic publish, language shard caching, and a serial retry after concurrent failures. The plan preserves that lifecycle. Sources: `scip-query code reindex -C 20`; `scip-query plan-context runPreparedIndexers`.
- Blast radius: primary downstream path is `runLanguageIndexersForFreshReindex -> runFreshReindex -> reindex`; external command entry points are manual reindex, bench, watcher, and worker. Sources: `scip-query plan-context runLanguageIndexersForFreshReindex`; `scip-query plan-context loadProjectConfig`.
- Intermediate validity: Phase 1 only adds inert config shape and validation; Phase 2 adds discovery; Phase 3 turns it on inside reindex; Phase 4 wires callers. Single mode remains current behavior throughout.
- Reversibility: `projectMode: 'single'` is a rollback switch. Removing the new config returns to the current `--infer-tsconfig` single-process path.
- Failure design: a failed project shard becomes a skipped TypeScript run. With `allowPartial` false, existing validation preserves the previous index; with `allowPartial` true, successful shards can publish a partial index with metadata.
- Concurrency: same-language run identity removes retry/result collisions; existing project-level reindex lock still prevents two publishers from racing. Sources: `scip-query code runPreparedIndexer -C 15`; `scip-query code src/runtime/watch.ts:180-276`.
- Boundaries: `.scipquery.json` remains the trust boundary; validation catches invalid modes and malformed project arrays before execution. Source: `scip-query code validateProjectConfig -C 20`.
- Data integrity: publish still writes temp SCIP, temp SQLite, temp metadata, then atomically promotes. Source: `scip-query code publishFreshReindexArtifacts -C 20`.
- Observability: status labels must include the TypeScript project path so slow or failing shards are diagnosable from CLI/watch output.
- Human impact: default `single` behavior avoids surprising existing projects; `workspace` is explicit and persistent for monorepos that want parallel indexing.
- Reuse: the plan reuses the existing concurrency runner, SCIP merge path, config section, watcher worker, and metadata cache instead of building a separate TypeScript indexing pipeline.

## Execution Order

1. Phase 1: config types and validation.
2. Phase 2: reindex TypeScript project discovery.
3. Phase 3: runner identity, TypeScript run expansion, consolidation, merge de-duplication.
4. Phase 4: CLI/bench/watch/worker wiring and fingerprints.
5. Phase 5: tests, measurements, reindex, and diff gate.

## Verification

- `npm run typecheck`
- Focused Vitest for reindex, config, merge, and watcher worker changes.
- `npm run build`
- Baseline single-mode reindex in this repo: `node dist/cli.js reindex --force`, then compare document/symbol counts and command output hashes against the current index.
- Synthetic or fixture workspace-mode reindex proving multiple TypeScript project runs produce one language output.
- Performance measurement: `scip-query bench --cold-index --json` for this repo and, if available locally, one larger monorepo with `indexer.typescript.projectMode: "workspace"`.
- Postchecks: `scip-query unused-params --json --full`, `scip-query stale-abstractions --json --full`, `scip-query wrapper-candidates --json --full`, `scip-query passthrough-candidates --json --full`, `scip-query co-change src/domain/config-types.ts --json --full`, `scip-query co-change src/reindex/index.ts --json --full`, `scip-query recent-duplicates --json --full`, `scip-query incomplete-migration --json --full`.
- Final gates: `scip-query reindex && scip-query diff-gate --json`.

## Measurement Notes

- Current repo temporary-output parity: single mode `3058ms`; workspace mode `2961ms`; both produced `237` documents, `11941` symbols, and `37847` mentions.
- Current repo active config now sets `indexer.typescript.projectMode: "workspace"` and active reindex completed in `3224ms` with fresh status.
- `Vega_2.0` temporary-output comparison: single mode `49098ms`; workspace mode `33828ms`; both produced `1779` documents, `103982` symbols, and `288684` mentions. Workspace mode discovered four TypeScript project shards: `apps/api`, `apps/web`, `packages/companion`, and `packages/shared`.

## Summary

Expected write scope: `src/domain/config-types.ts`, `src/runtime/config.ts`, `src/reindex/typescript-projects.ts`, `src/reindex/indexers.ts`, `src/reindex/indexer-runner.ts`, `src/reindex/index.ts`, `src/reindex/merge.ts`, `src/runtime/commands/command-handlers.ts`, `src/runtime/watch.ts`, `src/reindex/worker.ts`, plus focused tests.

The only intended behavior change is opt-in TypeScript workspace sharding. Current single-project indexing remains the default path.
