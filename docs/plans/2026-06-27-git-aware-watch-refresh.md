# Git-Aware Watch Refresh Plan

Date: 2026-06-27

## Gate A: Goal

Make `scip-query watch` better for long-running agent work by detecting Git state changes, recording why each refresh happened, and surfacing the last refresh in status/setup context.

A watcher is the runtime process that observes a repository and schedules index refreshes when the facts that the index describes may have changed. A Git state trigger is a repository change signal from Git's own bookkeeping files, especially the checked-out commit pointer and staging-area index, that can make source code meaningfully different even when the normal source-file watcher misses or filters the event. Refresh metadata is the persisted record beside the SQLite index that explains what index artifacts exist and why the most recent refresh attempt did or did not rebuild them. Index freshness is the relationship between the stored index fingerprint and the repository's current source inputs; it is fresh when the stored facts still identify the current code.

Success looks like this:

- `scip-query watch` notices source-file changes and resolved Git `HEAD`/index changes through one refresh scheduler.
- Reindex metadata keeps `updatedAt` as the artifact build time and adds `lastRefresh` for the latest attempt, including trigger, result, duration, and optional detail/error.
- `scip-query status --json`, `scip-query status`, setup smoke tests, and agent session context can report the last refresh without inventing a second metadata source.
- Reused unchanged indexes still record a refresh attempt as `lastRefresh.result = "reused"` without pretending the index was rebuilt.
- We do not copy CKB's per-file incremental database patching. The local reindexer already has safer language-shard reuse, and the current improvement should preserve that path.

## Gate B: Current State

- `handleWatch` resolves project root/config, accepts `--debounce` and `--cooldown`, constructs `Watcher`, prints the active timing, starts it, and stops on `SIGINT`.
  Source: `scip-query code handleWatch --json`

- `Watcher` owns the current watch state machine: `idle`, `waiting`, `indexing`, and `cooldown`; it stores changed-file counts, dirty state, in-flight state, timers, index paths, language options, and callbacks.
  Source: `scip-query code Watcher --json`

- `Watcher#start` uses recursive `fs.watch` over the project root. `Watcher#handleFileChange` filters through `.gitignore` and explicit ignore patterns before scheduling a debounced reindex.
  Source: `scip-query code 'Watcher#handleFileChange' --json`

- `Watcher#triggerReindex` owns cooldown, in-flight suppression, dirty retry scheduling, and error recovery. It currently has no trigger parameter, so all refreshes are behaviorally identical once scheduled.
  Source: `scip-query code 'Watcher#triggerReindex' --json`

- `Watcher#runReindex` forks `reindex-worker.js` and passes project/index/language settings through environment variables. The watcher previously passed temp paths and swapped outputs itself; implementation must pass canonical index paths so the reindexer's own reuse and atomic promotion path remains authoritative.
  Source: `scip-query code Watcher --json`

- `src/reindex/worker.ts` reads the watcher-provided environment and calls `reindex`; it currently has no refresh-trigger environment input.
  Source: `scip-query code 'src/reindex/worker.ts' --json`

- `ReindexOptions`, `ReindexResult`, and `ReindexMetadata` have language, path, duration, reuse, skipped-language, fingerprint, and metadata status fields, but no refresh provenance.
  Source: `scip-query code ReindexOptions --json`; `scip-query code ReindexResult --json`; `scip-query code ReindexMetadata --json`

- `reindex` computes fingerprints, tries `reuseExistingIndexIfPossible`, and otherwise runs `runFreshReindex`.
  Source: `scip-query code reindex --json`

- `reuseExistingIndexIfPossible` returns a reused result when outputs and metadata fingerprints are unchanged, but it does not update metadata to record that the refresh was attempted.
  Source: `scip-query code reuseExistingIndexIfPossible --json`

- `publishFreshReindexArtifacts` writes version 3 metadata, caches language shards, materializes SCIP, converts to SQLite, augments auxiliary documents, and promotes temp artifacts.
  Source: `scip-query code publishFreshReindexArtifacts --json`

- `getIndexFreshness` reads `meta.json`, checks fingerprint/current languages, and returns `fresh`, `stale`, `missing`, or `unknown` with reason/remedy/updatedAt.
  Source: `scip-query code getIndexFreshness --json`

- `getIndexFreshness` feeds agent session context, status/doctor reports, and setup readiness.
  Source: `scip-query call-graph getIndexFreshness --json`

- `renderStatusReport` prints freshness but not last refresh provenance.
  Source: `scip-query code renderStatusReport --json`

- `WatchConfig` currently contains enabled/debounce/cooldown/ignore only. `DEFAULT_WATCH` fills those values, `validateProjectConfig` validates debounce/cooldown, and `initProjectConfig` writes the default watch config.
  Source: `scip-query code WatchConfig --json`; `scip-query code DEFAULT_WATCH --context 8 --json`; `scip-query code validateProjectConfig --json`; `scip-query code initProjectConfig --json`

## Gate C: Reuse Audit

- No recent duplicate groups were reported.
  Source: `scip-query recent-duplicates --json`

- No similar symbol implementation exists for `Watcher#triggerReindex`; reusing an existing scheduler is not available.
  Source: `scip-query similar 'Watcher#triggerReindex' --json`

- No similar implementation exists for `reindex`; keep the current reindexer and metadata path instead of introducing a parallel indexer.
  Source: `scip-query similar reindex --json`

- `src/runtime/watch.ts` has one similar-file result, `src/runtime/cli-context.ts`, because they share runtime dependencies. That is not a scheduler or metadata implementation to reuse.
  Source: `scip-query similar-files src/runtime/watch.ts --json`

- `src/reindex/index.ts` has no similar files.
  Source: `scip-query similar-files src/reindex/index.ts --json`

- The public surfaces affected by watch changes are `command-handlers.ts` and `runtime/index.ts`; the public surfaces affected by reindex metadata changes are the worker, command handlers, and project setup.
  Source: `scip-query surface src/runtime/watch.ts --json`; `scip-query surface src/reindex/index.ts --json`

## Design Phases

### Phase 1: Shared Refresh Provenance Types

- [ ] Add exported refresh provenance types to `src/domain/maintenance-types.ts`: `RefreshTriggerKind`, `RefreshTrigger`, `RefreshResultKind`, and `LastRefreshMetadata`.
      Source: `scip-query outline src/domain/maintenance-types.ts --json`

- [ ] Extend `ReindexOptions` with optional `trigger?: RefreshTrigger`, `ReindexResult` with optional `lastRefresh?: LastRefreshMetadata`, and `ReindexMetadata` with optional `lastRefresh?: LastRefreshMetadata`.
      Source: `scip-query code ReindexOptions --json`; `scip-query code ReindexResult --json`; `scip-query code ReindexMetadata --json`

- [ ] Keep trigger kinds bounded to concrete reasons: `manual-cli`, `watch-source`, `watch-git-head`, `watch-git-index`, `watch-git-state`, `setup`, and `unknown`. Do not use `worker` as a trigger; the worker is transport, not the reason for refresh.
      Source: `scip-query code handleReindex --json`; `scip-query code handleWatch --json`; `scip-query code 'src/reindex/worker.ts' --json`; `scip-query code runProjectSetup --json`

### Phase 2: Metadata Writes for Fresh, Reused, and Failed Attempts

- [ ] Add a small metadata helper near `writeReindexMeta` to read existing metadata, preserve artifact fields, and update only `lastRefresh` for reused or failed attempts. Metadata-only writes must be atomic: write a sibling temp metadata file and rename it over `meta.json`.
      Source: `scip-query code writeReindexMeta --json`; `scip-query code reuseExistingIndexIfPossible --json`

- [ ] In `publishFreshReindexArtifacts`, write `lastRefresh` with result `rebuilt`, trigger from `opts.opts.trigger`, duration, indexed languages, skipped languages, and completion time.
      Source: `scip-query code publishFreshReindexArtifacts --json`; `scip-query code runFreshReindex --json`

- [ ] In `reuseExistingIndexIfPossible`, after auxiliary augmentation succeeds, update existing metadata with `lastRefresh.result = "reused"` and return the same `lastRefresh` on `ReindexResult`.
      Source: `scip-query code reuseExistingIndexIfPossible --json`

- [ ] Wrap `reindex` failures after paths are resolved so an existing metadata file can record `lastRefresh.result = "failed"` and the error message without changing `updatedAt` or fingerprints.
      Source: `scip-query code reindex --json`; `scip-query code ReindexMetadata --json`

### Phase 3: Git-Aware Watch Scheduling

- [ ] Extend `WatchConfig` with `gitPollMs?: number` and default it to `2_000`; validate that configured values are greater than zero; include it in newly initialized `.scipquery.json`.
      Source: `scip-query code WatchConfig --json`; `scip-query code DEFAULT_WATCH --context 8 --json`; `scip-query code validateProjectConfig --json`; `scip-query code initProjectConfig --json`

- [ ] Add a `--git-poll <ms>` watch option and wire it into `handleWatch`, matching the existing debounce/cooldown override pattern.
      Source: `scip-query code 'src:runtime:commands:command-descriptors:commandDescriptors' --context 240 --json`; `scip-query code handleWatch --json`

- [ ] Refactor `Watcher#handleFileChange` to call a shared scheduler method that accepts a `RefreshTrigger`; source-file events should use `watch-source` with the relative path as detail.
      Source: `scip-query code 'Watcher#handleFileChange' --json`; `scip-query code 'Watcher#triggerReindex' --json`

- [ ] Add Git state polling fields to `Watcher`: last seen resolved commit identity from `git -C <root> rev-parse --verify HEAD` and index metadata from `git -C <root> rev-parse --git-path index`. Start polling in `Watcher#start` and clear the timer in `Watcher#stop`.
      Source: `scip-query code Watcher --json`

- [ ] When Git polling detects `HEAD` movement, schedule a debounced refresh with `watch-git-head`; when staging-area metadata changes, schedule one with `watch-git-index`; when the exact cause cannot be separated, use `watch-git-state`.
      Source: `scip-query code Watcher --json`

- [ ] Explicitly exclude `.git/**` from the source-file watcher path so Git bookkeeping does not duplicate or mislabel the Git polling trigger.
      Source: `scip-query code 'Watcher#handleFileChange' --json`

- [ ] Preserve the most specific pending trigger through debounce, cooldown, and in-flight dirty retries so `Watcher#runReindex` can tell the worker why the refresh is happening.
      Source: `scip-query code 'Watcher#triggerReindex' --json`; `scip-query code WatcherStatus --json`

### Phase 4: Worker and CLI Trigger Plumbing

- [ ] Update `Watcher#runReindex` to include `SCIP_REINDEX_TRIGGER_KIND` and `SCIP_REINDEX_TRIGGER_DETAIL` in the child environment.
      Source: `scip-query code Watcher --json`

- [ ] Update `Watcher#runReindex` to pass canonical `index.scip` and `index.db` paths to the worker, not watcher-local temp paths, so `reuseExistingIndexIfPossible` can observe the existing artifacts and the reindexer remains the owner of atomic promotion.
      Source: `scip-query code Watcher --json`; `scip-query code reuseExistingIndexIfPossible --json`

- [ ] Update `src/reindex/worker.ts` to parse those environment variables into `ReindexOptions.trigger`, falling back to `unknown` if absent or invalid.
      Source: `scip-query code 'src/reindex/worker.ts' --json`

- [ ] Update `handleReindex` to pass `trigger: { kind: "manual-cli", detail: "scip-query reindex" }` and update setup reindex calls to pass `setup`.
      Source: `scip-query code handleReindex --json`; `scip-query outline src/runtime/project-setup.ts --json`

### Phase 5: Status, Setup, and Agent Context

- [ ] Extend `ReindexMetadataLike` and `IndexFreshness` to include optional `lastRefresh`, and return it from `getIndexFreshness` whenever metadata contains it.
      Source: `scip-query outline src/runtime/index-freshness.ts --json`; `scip-query code getIndexFreshness --json`; `scip-query code 'src:runtime:index-freshness:IndexFreshness' --json`

- [ ] Render a compact `Refresh:` line in `status` human output, including trigger kind, result, duration, and completion time.
      Source: `scip-query code renderStatusReport --json`

- [ ] Let `status --json` include `freshness.lastRefresh` automatically through the existing diagnostic report shape; avoid adding a second report field.
      Source: `scip-query code buildProjectDiagnosticReport --json`

- [ ] Improve setup smoke evidence and session-start context to include last refresh when available, without changing pass/fail semantics.
      Source: `scip-query code buildSetupSmokeTests --json`; `scip-query code gitBackedSmokeEvidence --json`; `scip-query code renderSessionStartContext --json`

## Stress-Test Findings

- `updatedAt` must remain the artifact build timestamp. A reused refresh proves the watcher ran and found no needed rebuild; it does not prove a new artifact was built.
  Source: `scip-query code publishFreshReindexArtifacts --json`; `scip-query code reuseExistingIndexIfPossible --json`

- A failed refresh should not mark the index stale by itself. Freshness is still determined by fingerprint comparison; `lastRefresh.result = "failed"` is operational evidence, not source truth.
  Source: `scip-query code getIndexFreshness --json`

- Git polling must share debounce and cooldown with source events. Otherwise a branch checkout plus file events can produce duplicate reindexes.
  Source: `scip-query code 'Watcher#triggerReindex' --json`; `scip-query code 'Watcher#handleFileChange' --json`

- `fs.watch` errors currently only report watcher startup failure. Git polling should fail soft: if `.git` is absent or unreadable, watch source files as today and do not turn that into a fatal error.
  Source: `scip-query code Watcher --json`

- Git state resolution should use Git plumbing instead of assuming `.git` is a directory. Worktrees and custom Git directories can store metadata outside the working tree.
  Source: `scip-query code Watcher --json`

- Source file watching must explicitly ignore `.git/**` once Git polling owns Git metadata changes.
  Source: `scip-query code 'Watcher#handleFileChange' --json`

- Watch-triggered reuse depends on the worker receiving canonical output paths. Passing temp paths makes unchanged watch refreshes rebuild because `reuseExistingIndexIfPossible` checks `opts.paths.outputScip` and `opts.paths.outputDb`.
  Source: `scip-query code Watcher --json`; `scip-query code reuseExistingIndexIfPossible --json`

- `status --json` consumers already depend on the diagnostic report shape. Adding nested optional data under `freshness` is lower risk than adding a top-level sibling.
  Source: `scip-query code buildProjectDiagnosticReport --json`; `scip-query call-graph getIndexFreshness --json`

## Execution Order

1. Types and config: add refresh provenance types, `gitPollMs`, defaults, validation, init output, and watch command option.
   Source: `scip-query code WatchConfig --json`; `scip-query code DEFAULT_WATCH --context 8 --json`; `scip-query code validateProjectConfig --json`; `scip-query code 'src:runtime:commands:command-descriptors:commandDescriptors' --context 240 --json`

2. Reindex metadata: extend options/results/metadata and add helper logic for fresh/reused/failed `lastRefresh`.
   Source: `scip-query code ReindexOptions --json`; `scip-query code ReindexResult --json`; `scip-query code ReindexMetadata --json`; `scip-query code reindex --json`

3. Worker and CLI plumbing: pass trigger data from manual CLI, setup, watcher parent, and worker env into `reindex`.
   Source: `scip-query code handleReindex --json`; `scip-query code 'src/reindex/worker.ts' --json`; `scip-query outline src/runtime/project-setup.ts --json`

4. Watch scheduling: add shared trigger-aware scheduling, `.git/**` source exclusion, Git state polling, timer cleanup, canonical worker artifact paths, and trigger preservation through dirty/cooldown retries.
   Source: `scip-query code Watcher --json`; `scip-query code 'Watcher#triggerReindex' --json`

5. Freshness/status fanout: expose `freshness.lastRefresh`, render human status, and enrich setup/agent context.
   Source: `scip-query code getIndexFreshness --json`; `scip-query code renderStatusReport --json`; `scip-query code renderSessionStartContext --json`; `scip-query code buildSetupSmokeTests --json`

6. Tests and verification: add focused unit/integration coverage for metadata update on fresh/reused/failed attempts, canonical worker paths, trigger env parsing, `.git/**` source exclusion, config validation, and status JSON shape.
   Source: `scip-query files watch --json`; `scip-query files reindex --json`; `scip-query files freshness --json`; `scip-query call-graph getIndexFreshness --json`

## Ship Order

- Ship 1: Metadata provenance for manual `scip-query reindex` and reused unchanged indexes. This immediately improves `status --json` and setup evidence without touching watcher behavior.
  Source: `scip-query code handleReindex --json`; `scip-query code reuseExistingIndexIfPossible --json`; `scip-query code getIndexFreshness --json`

- Ship 2: Trigger-aware watcher source events and worker env plumbing. This proves the scheduler can preserve reasons before adding Git polling.
  Source: `scip-query code Watcher --json`; `scip-query code 'src/reindex/worker.ts' --json`

- Ship 3: Git state polling behind `gitPollMs`, plus human status rendering. This is the CKB-inspired behavior that makes long-running sessions safer.
  Source: `scip-query code WatchConfig --json`; `scip-query code renderStatusReport --json`

- Ship 4: Setup/session-context polish and required command reference update, then run the CLI contract test because descriptor-rendered docs must match `docs/COMMAND_REFERENCE.md`.
  Source: `scip-query code renderSessionStartContext --json`; `scip-query code buildSetupSmokeTests --json`; `scip-query code 'src:runtime:commands:command-descriptors:commandDescriptors' --context 240 --json`

## Summary

CKB's watcher/indexer suggests one practical improvement worth adopting: treat repository state changes as first-class refresh triggers and keep a persisted record of refresh attempts. `scip-query` should implement that idea through its existing watcher, worker, metadata, freshness, and status paths instead of cloning CKB's daemon/incremental database design.

This makes ours objectively better for its stated purpose because agents do not only need an index; they need to know whether the index reflects the code they are about to reason over, why it refreshed, and whether the last refresh rebuilt, reused, or failed.
