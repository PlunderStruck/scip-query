# Global cache cleanup and reindex frequency plan

Date: 2026-07-24

## Goal

Reclaim abandoned global cache data now, keep reindex telemetry bounded, measure refresh frequency and estimated logical output bytes, and prevent a watcher from launching a second reindex when the just-completed index is already fresh.

## Definitions & invariants

A **project cache** is a directory below the scip-query cache root whose path is derived from the canonical project root and whose contents are disposable indexing artifacts. Its defining trait is that deleting it can cost rebuild time but cannot delete project source.
Source: `scip-query code resolveDefaultCacheDir`

A **refresh activity record** is a bounded operational observation stored beside one project cache. Its defining trait is that it records either an actual reindex attempt or a refresh request suppressed after freshness was proven, rather than source-code evidence or profiling spans.
Source: `scip-query code buildLastRefresh`; `scip-query files telemetry --json`

A **logical output-byte estimate** is a count of bytes emitted into scip-query artifacts by a successful rebuilt refresh. Its defining trait is that it measures application-level output, not filesystem amplification, compression, copy-on-write behavior, or SSD NAND writes.
Source: `scip-query code ReindexShardDiagnostic`; `scip-query code ReindexResult`

A **redundant rerun** is a queued watcher refresh whose triggering changes are already represented by the index that just completed. Its defining trait is a fresh post-completion fingerprint despite a dirty watcher flag.
Source: `scip-query code 'Watcher#triggerReindex'`; `scip-query code runWatchServiceServer`

A **polling fallback** is a source-change subscription that compares file metadata on a timer after the operating system refuses another event-backed watch. Its defining trait is preserving source refresh correctness under `EMFILE` while remaining inactive on systems where ordinary subscriptions work.
Source: `scip-query code 'Watcher#start'`

Invariants:

- A queued dirty refresh must be suppressed iff the completion callback proves the published index fresh.
- A missing, failed, or throwing freshness observation must always preserve the queued rerun.
- Activity recording must never change a reindex result or turn a successful reindex into a failure.
- Activity history must always remain bounded to two fixed-size segments.
- A logical output-byte estimate must always be labeled as an estimate and must never be presented as physical SSD writes.
- Global cleanup must always remain inside the resolved scip-query cache root and must never remove a cache with a live watcher or reindex/lifecycle lock.
- An event-backed source watch that fails with `EMFILE` must always retry once with bounded polling rather than silently leaving the project unwatched.

## Premises

- P1. Project cache directories are `resolveScipQueryCacheRoot()/projects/<12-character hash of canonical project root>`. — Source: `scip-query code resolveDefaultCacheDir`; `scip-query code resolveScipQueryCacheRoot`
- P2. The watcher merges triggers into `pendingTrigger`, marks `dirty` for events during indexing or cooldown, and unconditionally launches a second reindex after a successful in-flight run when `dirty` is true. — Source: `scip-query code 'src:runtime:watch:Watcher'`
- P3. Writers of watcher scheduling state (`dirty`, `pendingTrigger`, `changedFiles`, `reindexInFlight`, and `lastReindexEnd`) are `requestRefresh`, `scheduleReindex`, and `triggerReindex`; readers are those methods plus watcher tests. — Source: `scip-query refs 'Watcher#requestRefresh'`; `scip-query dataflow pendingTrigger`; `scip-query refs 'src:runtime:watch:Watcher:dirty'`; `scip-query refs 'src:runtime:watch:Watcher:lastReindexEnd'`; `scip-query refs 'src:runtime:watch:Watcher:changedFiles'`
- P4. The daemon completion callback already calls `getIndexFreshness`, updates `lastRefresh`, and publishes the fresh generation identity before the watcher decides whether to rerun. — Source: `scip-query code runWatchServiceServer`
- P5. The foreground watcher has a separate `onReindexComplete` writer that currently reports duration only. — Source: `scip-query code handleWatch`
- P6. Every successful reuse and rebuild produces `ReindexResult.lastRefresh`; failures build and persist failed `LastRefreshMetadata` before rethrowing. — Source: `scip-query code reindex`; `scip-query code reuseExistingIndexIfPossible`; `scip-query code buildLastRefresh`
- P7. Shard diagnostics distinguish reused shards and expose cached SCIP output size and production duration. — Source: `scip-query code ReindexShardDiagnostic`; `scip-query code buildFreshReindexShardDiagnostics`
- P8. No existing telemetry, activity, or metrics module provides a durable reindex-frequency history; opt-in profiling spans exist but do not provide automatic operational history. — Source: `scip-query files telemetry --json`; `scip-query files activity --json`; `scip-query files metrics --json`; `scip-query outline src/instrumentation/profile.ts --json`
- P9. Existing affected-set telemetry establishes a two-segment bounded JSONL pattern and treats operational metadata as best effort. — Source: `scip-query code appendAffectedSetShadowHistory`; `scip-query code updateReindexLastRefresh`
- P10. Current global inventory contains 1,616 project-cache directories, three abandoned `reindex-*` directories totaling 430,924,305 bytes, and two oversized legacy affected-shadow logs totaling 38,142,850 bytes. — Source: 2026-07-24 read-only global-cache inventory recorded in `docs/benchmarks/2026-07-24-reindex-frequency-baseline.md`
- P11. The three abandoned workspaces have no `index.lock`, are dated 2026-07-13, and belong to refreshes that are no longer running. — Source: 2026-07-24 lock and metadata inventory recorded in `docs/benchmarks/2026-07-24-reindex-frequency-baseline.md`
- P12. The source watcher reports asynchronous chokidar errors but had no recovery path; the worktree integration test reproduces `EMFILE` when the host watcher allowance is exhausted. — Source: `scip-query code 'src:runtime:watch:Watcher'`; `tests/runtime/worktree-watch-service.integration.test.ts`

## Current state

Filesystem and Git changes converge on `scheduleReindex`, which debounces while idle but sets a coarse `dirty` bit during an active run (P2, P3). Completion always interprets that bit as proof that another reindex is required (P2), even though the daemon has already computed authoritative freshness at the same boundary (P4). Reindex metadata retains only the latest refresh (P6), affected-set history does not identify the triggering refresh, and opt-in profiles are not a durable per-project frequency source (P8).

## Reuse audit

- Extend the existing `WatcherOptions.onReindexComplete` boundary to return whether the resulting index is fresh; do not add a second fingerprint pass (P4, P5).
- Extend the existing bounded JSONL technique from affected-set history, but use a new `reindex-activity.ts` module because affected-set records describe prediction correctness and do not carry trigger or output-write semantics (P8, P9).
- Extend `WatchServiceState` and the existing watch/status render path with a summary; do not add a new command solely for measurement.
- Use existing `ReindexResult`, `LastRefreshMetadata`, and shard diagnostics to estimate logical output bytes; do not instrument filesystem syscalls or claim physical-write precision (P6, P7).
- Use the existing exclusive reindex cleanup for future per-project abandoned workspaces; perform the one-time global cleanup only for the exact inventoried, unlocked targets (P10, P11).

## Testability design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Suppress a dirty rerun after a fresh completion | `Watcher` with mocked fork/timers | completion callback, suppression callback | fresh/dirty decision | child process and timers | completion returns `true` only for proven freshness |
| Preserve a dirty rerun when stale or unknown | same | completion callback | same decision | same | false/undefined/throw never suppresses |
| Recover from watcher descriptor exhaustion | `Watcher.start` integration test | chokidar backend | `EMFILE` classification | close/reopen subscription | retry once with 500 ms polling |
| Record bounded activity | activity module exports | clock, append/read/rename/stat operations | record summarization and byte estimate | JSONL persistence | two segments, malformed lines ignored |
| Report 24-hour frequency | activity summary reader | clock/read function | filter and aggregate records | file read | counts runs/results/triggers/suppressions and estimated bytes |
| Clean current global debris | exact target inventory | filesystem stat/lock checks | target allowlist | deletion | cache-root containment and no live lock |

## Implementation checklist

### 1. Add bounded refresh activity

- [ ] **File**: `src/reindex/reindex-activity.ts`
- **Premises**: P6-P9
- **Deployable**: yes
- **Change**: Add compact run/suppression records, pure byte estimation and aggregation, two-segment persistence, malformed-line tolerance, and best-effort writes.
- **Validation**: unit tests cover rebuilt/reused/failed/suppressed aggregation, bounds, malformed input, and write failures.

### 2. Record all reindex outcomes

- [ ] **File**: `src/reindex/index.ts`
- **Premises**: P6, P7
- **Deployable**: part of single-deploy group `activity-schema`
- **Change**: Record reused and rebuilt results before return and failed metadata before rethrow. Estimate bytes only from non-reused shard outputs plus published SCIP/SQLite artifacts.
- **Validation**: existing reindex tests plus focused activity integration assertions.

### 3. Suppress only freshness-proven dirty reruns and preserve source watching

- [ ] **Files**: `src/runtime/watch.ts`, `src/runtime/watch-server.ts`, `src/runtime/commands/command-handlers.ts`
- **Premises**: P2-P5, P12
- **Deployable**: yes
- **Change**: Let completion callbacks report freshness. When dirty and fresh, clear the queued trigger and counters, record a suppression, and become idle. When freshness is false, absent, or throws, retain current cooldown/rerun behavior. If the event-backed source subscription returns `EMFILE`, close it and retry once with 500 ms polling.
- **Validation**: fake-timer watcher tests prove one child for late duplicate events and two children for stale/unknown completion; worktree integration tests prove source refresh under descriptor exhaustion.

### 4. Surface the durable 24-hour summary

- [ ] **Files**: `src/platform/watch-service-state.ts`, `src/runtime/watch-server.ts`, `src/runtime/commands/command-handlers.ts`
- **Premises**: P4, P8
- **Deployable**: part of single-deploy group `activity-schema`
- **Change**: Include an optional backward-compatible summary in daemon state and JSON/text status.
- **Validation**: state parser and watch-status contract tests accept absent metrics and render present metrics.

### 5. Clean inactive global project caches

- [ ] **Targets**: immediate managed project-cache children inactive for more than seven days
- **Premises**: P10, P11
- **Deployable**: yes
- **Change**: Recheck immediate-child containment, names, symlinks, watcher/reindex/lifecycle PIDs, metadata timestamps, and repository lease timestamps immediately before deletion; delete only inactive rebuildable caches and measure bytes reclaimed.
- **Validation**: targets absent, active cache directories present, global size measured after cleanup.

## Counterexample attacks

1. Actor: editor. Starting state: reindex fingerprint captured, then a file is saved before publish. Sequence: watcher becomes dirty; completion freshness is stale. Draft outcome: **HOLE** — an unconditional suppression would lose the change. Repair: Step 3 suppresses iff completion proves fresh; stale retains the rerun. Final outcome: **HELD** by P4 and Step 3.
2. Actor: filesystem failure. Starting state: completed reindex, unreadable metadata. Sequence: freshness callback throws. Outcome: **HELD** — Step 3 treats error as unknown and preserves the rerun.
3. Actor: malformed telemetry file. Starting state: one truncated JSONL line after a crash. Sequence: status reads the window. Draft outcome: **HOLE** — whole-file JSON parsing would hide all measurements. Repair: Step 1 parses lines independently and ignores malformed lines. Final outcome: **HELD** by Step 1 and P9.
4. Actor: cache cleanup. Starting state: a cache contains a live `index.lock`. Sequence: global cleanup sees a matching directory name. Outcome: **HELD** — invariant and Step 5 exclude any live lock and use exact contained targets.
5. Actor: SSD estimator consumer. Starting state: shared-generation copies may be copy-on-write. Sequence: user compares logical bytes to SSD endurance. Outcome: **HELD** — definition, Step 1, and status label explicitly identify an estimate rather than NAND writes.
6. Actor: old client state. Starting state: `watch-state.json` lacks the new optional summary. Sequence: new CLI parses it. Outcome: **HELD** — Step 4 keeps the field optional and preserves protocol compatibility.
7. Actor: host process. Starting state: macOS refuses another event-backed subscription with `EMFILE`. Sequence: two worktree watchers start. Draft outcome: **HOLE** — both watchers reported errors and missed source changes. Repair: Step 3 closes the failed subscription and retries once with 500 ms polling. Final outcome: **HELD** by P12, Step 3, and the worktree integration test.

## Coverage matrix

| Invariant | Premises | Steps | Attacks |
| --- | --- | --- | --- |
| Suppress iff proven fresh | P2-P5 | 3 | 1, 2 |
| Unknown freshness reruns | P2-P5 | 3 | 2 |
| Telemetry never changes result | P6, P9 | 1, 2 | 3 |
| History remains bounded | P9 | 1 | 3 |
| Logical bytes are not physical writes | P7 | 1, 4 | 5 |
| Cleanup stays contained and avoids live locks | P1, P10, P11 | 5 | 4 |
| Descriptor exhaustion preserves source watching | P12 | 3 | 7 |

## Verdict

**PLANNED-COMPLETE.** Every invariant has a source-backed implementation step and constructed attack. Three draft holes were found and repaired: stale-after-capture changes cannot be suppressed, malformed JSONL cannot invalidate the full measurement window, and event-descriptor exhaustion falls back to bounded polling instead of disabling source refreshes.
