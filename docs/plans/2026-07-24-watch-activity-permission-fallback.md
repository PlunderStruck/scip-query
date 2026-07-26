# Watch Activity Permission Fallback

Date: 2026-07-24

**Superseded refresh-field premise (2026-07-25):** this document remains the
historical design record for permission-tolerant activity writes, but its P3/P5
description of refresh intent inside `watch-activity.json` is no longer
current. Slice 11 of the distributed-state remediation moved accepted refresh
intent to the immutable request/claim/completion protocol in
[`docs/WATCH_REFRESH_REQUESTS.md`](../WATCH_REFRESH_REQUESTS.md). Activity is
now only a last-writer-wins idle-lifetime timestamp; the permission fallback
described here still applies to that advisory write.

## Goal

Keep an automatic scip-query command attached to an already-live watch service when a restricted execution sandbox cannot update the service's activity file, without hiding failures that mean the daemon is absent or unusable.

## Definitions & Invariants

A watch service is a long-lived background process whose source and Git subscriptions refresh one worktree's index; its distinguishing behavior is that it performs refresh work independently of the foreground command that started or reused it. Referents: `ensureWatchService`, `watch-server.ts`, and the live `watch-state.json` record. Source: `scip-query plan-context ensureWatchService`.

Watch activity is a small JSON mailbox whose timestamp extends a live service's idle lifetime and whose optional refresh request wakes it; it is advisory because index queries and daemon liveness are established by the database and watch-state record rather than by a successful activity write. Referents: `recordWatchServiceActivity`, `requestWatchServiceRefresh`, and `readWatchServiceActivity`. Source: `scip-query refs recordWatchServiceActivity` and `scip-query dataflow recordWatchServiceActivity`.

A permission-class failure is an operating-system file error whose code is `EPERM`, `EACCES`, or `EROFS`; what distinguishes it from other I/O failures is that the caller is barred from this write even though the existing daemon may remain live and usable. Referent: the observed `EPERM` opening `watch-activity.json.<pid>.<timestamp>.tmp`; error extraction already exists as `errorCode`. Source: `scip-query code errorCode`.

- I1. Automatic ensure must return `reused` iff a compatible daemon is live, even when only its advisory activity write is permission-blocked.
- I2. Automatic ensure must always preserve non-permission activity failures as `failed`.
- I3. A successful activity write must always retain the current timestamp and pending refresh detail.
- I4. Daemon startup, replacement, and explicit refresh failures must always retain their current failure behavior.

## Premises

- P1. `ensureWatchService` has four activity-write sites covering immediate reuse, concurrent reuse, post-reinspection reuse, and successful start; every site currently throws through the lifecycle operation. Source: `scip-query plan-context ensureWatchService` and `scip-query refs recordWatchServiceActivity`.
- P2. `ensureWatchServiceForCommand` converts any thrown lifecycle error into `{ kind: "failed" }`, which the CLI renders as “watch service did not start.” Source: `scip-query code ensureWatchServiceForCommand` and `scip-query code src/runtime/cli.ts:45-90`.
- P3. `recordWatchServiceActivity` reads the current mailbox and atomically writes the timestamp plus any pending refresh fields. Source: `scip-query code recordWatchServiceActivity`.
- P4. `writeJsonAtomic` creates the observed PID/timestamp temporary filename before renaming it over the mailbox. Source: `scip-query code writeJsonAtomic`.
- P5. The complete writers of the activity mailbox are `recordWatchServiceActivity` for use timestamps and `requestWatchServiceRefresh` for refresh requests; `readWatchServiceActivity` is its reader. The proposed change affects only the ensure-owned timestamp writer and must not weaken explicit refresh writes. Source: `scip-query dataflow recordWatchServiceActivity`, `scip-query similar recordWatchServiceActivity --json --full`, and `scip-query trace writeJsonAtomic`.
- P6. `WatchServiceRuntime` already supplies the clock, process, spawn, signal, and sleep side-effect seams used by unit tests. Source: `scip-query code WatchServiceRuntime`.
- P7. `errorCode` already extracts a code from an `unknown` error using runtime narrowing, so no second error parser is justified. Source: `scip-query code errorCode`.
- P8. The source file's strongest co-change partner is `tests/runtime/watch-service.test.ts`, and the existing test suite already proves start, activity recording, and reuse. Source: `scip-query co-change src/runtime/watch-service.ts --json --full`; the test file is not indexed, so its existing cases were located by narrow text search.

## Current State

Every eligible foreground command calls `ensureWatchServiceForCommand`, which delegates to `ensureWatchService` and reports every exception as a startup failure (P2). A live daemon is reused, but reuse first performs an atomic activity write (P1, P3, P4). A sandbox denial at that advisory write therefore changes a valid `reused` outcome into the false `failed` outcome even though the daemon remains live.

## Reuse Audit

Extend `WatchServiceRuntime` with an optional activity recorder rather than creating a new options object or filesystem abstraction because the runtime is already the lifecycle side-effect boundary (P6). Reuse `recordWatchServiceActivity` as the production implementation and `errorCode` as the existing unknown-error classifier (P3, P7). Add one private best-effort activity function because the permission policy is lifecycle orchestration, not atomic JSON storage behavior; changing `writeJsonAtomic` or `recordWatchServiceActivity` globally would also weaken explicit refresh writers (P5).

## Testability Design

| Behavior                        | Test seam                          | Dependencies to inject               | Pure core                          | Side-effect shell             | Contract                                  |
| ------------------------------- | ---------------------------------- | ------------------------------------ | ---------------------------------- | ----------------------------- | ----------------------------------------- |
| Permission-blocked live reuse   | `ensureWatchServiceForCommand`     | `WatchServiceRuntime.recordActivity` | permission-code allowlist decision | existing ensure orchestration | `EPERM`/`EACCES`/`EROFS` returns `reused` |
| Unexpected activity I/O failure | `ensureWatchServiceForCommand`     | `WatchServiceRuntime.recordActivity` | same allowlist decision            | existing ensure orchestration | other errors return `failed`              |
| Normal activity update          | existing `ensureWatchService` test | fake clock and filesystem            | unchanged                          | `recordWatchServiceActivity`  | timestamp remains `NOW`                   |

## Design Phases

### 1.1 Make ensure activity best-effort only for permission failures

- [x] **File**: `src/runtime/watch-service.ts:96-107,245-303,594-596`
- **Premises**: P1, P3, P5, P6, P7
- **Deployable**: yes
- **What**: All lifecycle outcomes currently call the concrete activity writer directly.
- **Change**: Add an optional runtime activity recorder, route the four ensure activity sites through one private function, and suppress only `EPERM`, `EACCES`, and `EROFS`; rethrow every other error.
- **Testability**:
  - Test seam: `ensureWatchServiceForCommand`.
  - Injected dependencies: activity recorder through `WatchServiceRuntime`.
  - Pure core: code membership in the permission allowlist.
  - Side-effect shell: activity write.
  - Contract: advisory permission denial cannot overturn a proven live/start outcome.
- **Validation**: targeted watch-service unit tests and `npm run typecheck`.
- **Why**: This repairs the false failure at its ownership boundary without changing atomic JSON or explicit refresh semantics (P1, P5).

### 1.2 Add permission and non-permission regression cases

- [x] **File**: `tests/runtime/watch-service.test.ts:195-250`
- **Premises**: P2, P6, P8
- **Deployable**: yes, with step 1.1
- **What**: Tests cover successful start/reuse but not a failed activity side effect.
- **Change**: Inject a recorder that throws `EPERM` and prove reuse remains `reused`; inject an `EIO` recorder and prove automatic ensure remains `failed`.
- **Testability**:
  - Test seam: `ensureWatchServiceForCommand`.
  - Injected dependencies: fake runtime activity recorder.
  - Pure core: error-code classification.
  - Side-effect shell: none beyond the fake.
  - Contract: permission errors degrade activity only; other errors stay visible.
- **Validation**: `npx vitest run tests/runtime/watch-service.test.ts`.
- **Why**: The paired negative case prevents a broad catch from hiding real lifecycle faults (P2, P8).

## Attack Record

### A1. I1 via sandbox boundary

- Attack: a restricted Codex command sees a compatible live daemon, then its activity recorder throws `EPERM`.
- Outcome: HOLE — repaired by step 1.1 and proved by step 1.2 (P1, P2, P6).

### A2. I2 via storage failure

- Attack: a live daemon is found, then the activity recorder throws `EIO` because the cache device is unhealthy.
- Outcome: HELD — step 1.1 rethrows and step 1.2 proves the wrapper returns `failed` (P2, P7).

### A3. I3 via ordinary writable cache

- Attack: a command starts and then reuses a daemon in a writable cache.
- Outcome: HELD — the production recorder remains `recordWatchServiceActivity`, and the existing timestamp assertion remains in the targeted suite (P3, P8).

### A4. I4 via missing daemon

- Attack: no live state exists and the spawned server never publishes a compatible state.
- Outcome: HELD — step 1.1 changes only post-proof activity recording; startup readiness and timeout stay unchanged (P1).

### A5. I4 via explicit refresh

- Attack: an agent hook requests a refresh but cannot write the mailbox.
- Outcome: HELD — step 1.1 does not change `requestWatchServiceRefresh`, the other mailbox writer (P5).

| Surface or lens                                                 | Attacks        |
| --------------------------------------------------------------- | -------------- |
| ensure immediate/concurrent/reinspection/start activity writers | A1, A2, A3, A4 |
| explicit refresh writer                                         | A5             |
| activity reader                                                 | A3, A5         |
| failure and observability                                       | A1, A2, A4     |
| boundaries                                                      | A1, A5         |
| concurrency                                                     | A3, A4         |
| testability                                                     | A1, A2, A3     |
| reuse                                                           | A3             |

## Execution and Ship Order

Apply steps 1.1 and 1.2 as one deployable slice, then run the targeted test, typecheck, applicable duplicate/parameter checks, reindex, and diff gate. No migration, irreversible data change, or one-way door exists.

Implementation validation: the focused lifecycle suite passed 17/17 tests, TypeScript compilation passed, and the helper/duplicate/parameter postchecks returned no findings. A broader worktree-watcher integration attempt was environment-blocked by `EMFILE` source-subscription exhaustion and an `EPERM` write to the external cache; its focused watch-service tests still passed in the same run.

## Verdict

A plan is `PLANNED-COMPLETE` iff the coverage matrix has no blank rows, every attack ends in `HELD` with cited steps and premises or a recorded repaired/accepted hole, and no premise fails reverification.

Result: **PLANNED-COMPLETE** — 5 attacks, 1 hole repaired, 0 holes accepted; no unresolved items.

## File Summary

- Create: `docs/plans/2026-07-24-watch-activity-permission-fallback.md`
- Edit: `src/runtime/watch-service.ts`
- Edit: `tests/runtime/watch-service.test.ts`
- Verify: targeted Vitest, TypeScript typecheck, plan-context reverification, routed postchecks, reindex, and diff gate.
