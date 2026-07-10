# Automatic Freshness Service — Phase 1 Concrete Plan

Date: 2026-07-09
Status: ready for implementation after plan approval
Roadmap phase: 1

## Goal

Make `watch.enabled: true` mean that scip-query automatically maintains index
freshness through one repository-scoped background process, without requiring
the user to keep a terminal open. This phase deliberately reuses the current
whole-project/language/project-shard reindexer; it does not claim file-level
incremental indexing.

Completion requires start/status/stop lifecycle, crash and stale-state
recovery, automatic startup from normal enabled CLI and agent-hook paths,
immediate startup refresh when stale, calibrated quiet-period/cooldown values,
unchanged foreground-watch compatibility, built-package validation, benchmark
evidence, and a passing SCIP diff gate.

The system context is
[`2026-07-09-incremental-indexing-current-state.md`](./2026-07-09-incremental-indexing-current-state.md).
Later phases are in
[`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md).

## Scope Boundary

This phase changes _when and how reliably_ the existing reindexer runs. It does
not change what a language indexer computes, how ts-morph facts are keyed, or
how SQLite is constructed. A TypeScript edit in this repository will still
rebuild the root `.` TypeScript project shard, with Rust eligible for reuse.

The deliberate public behavior change is declared now: `watch.enabled: true`
becomes an opt-in request for automatic service startup rather than only a gate
that permits a manually invoked foreground watch. `scip-query watch` without a
lifecycle option remains foreground-compatible. `status` gains additive watch
service information; ordinary query JSON remains unchanged.

## Current State

- `Watcher.start()` owns recursive `fs.watch`, Git polling, and event
  scheduling. `scheduleReindex()` debounces changes, enforces one in-flight
  run, and marks one dirty follow-up. `runReindex()` forks the existing reindex
  worker, which publishes through the current atomic path.
- `handleWatch()` resolves config, acquires `watch.lock`, constructs `Watcher`,
  renders terminal status, and releases the lock on SIGINT/process exit. The
  command description explicitly says foreground.
- Lock metadata records PID, project root, and start time. A live PID blocks a
  second watcher; a stale PID is removed. There is no heartbeat, installed CLI
  version, persisted watcher state, detached server entry, or stop/status API.
- `getIndexFreshness()` compares the current relevant file/config fingerprint
  with metadata and classifies fresh/stale/missing/unknown.
- SessionStart agent hooks spawn a detached one-shot `scip-query reindex
--allow-partial` if stale. UserPromptSubmit warns but does not refresh.
- `cli.ts` has one pre-action hook for update notices. It does not ensure a
  watch owner.
- Current local exact no-op refresh is 323 ms. A TypeScript edit was about 4.7
  seconds. The configured 30-second debounce and 60-second cooldown dominate
  perceived latency before that work begins.

Source evidence:

```bash
scip-query plan-context src/runtime/watch.ts --json
scip-query plan-context src/runtime/commands/command-handlers.ts --json
scip-query plan-context src/runtime/index-freshness.ts --json
scip-query plan-context src/runtime/agent-hooks.ts --json
scip-query refs Watcher --json
scip-query refs handleWatch --json
scip-query refs getIndexFreshness --json
scip-query co-change src/runtime/watch.ts --json
```

## Reuse Audit

- Reuse `Watcher`; add only a public `requestRefresh(trigger)` seam so startup
  recovery can enter its existing coalescing state machine.
- Reuse `WatcherStatus` and `LastRefreshMetadata` inside a versioned service
  state record. Do not create a competing refresh-state vocabulary.
- Move `acquireWatchProcessLock()` and its metadata parsing from the large CLI
  handler into the service module so foreground and daemon modes share one
  ownership rule.
- Reuse `resolveIndexStoragePaths()` for `watch.lock` and `watch-state.json` in
  the repository cache directory.
- Reuse `getIndexFreshness()` once at service startup. The server requests an
  immediate refresh for stale/missing/unknown state; it does not implement a
  second fingerprint algorithm.
- Reuse `reindex-worker.js` and the current atomic publish path. The server
  observes completion through `Watcher` callbacks.
- Reuse the detached-process patterns proven by the durable Rust server for
  `spawn(..., { detached: true, stdio: 'ignore' })`, `unref()`, atomic state
  writes, PID liveness, and versioned state. Do not share its synchronous
  filesystem mailbox or Rust-specific request protocol.
- Add `src/runtime/watch-service.ts` because no existing runtime module owns a
  general watch process lifecycle. Add `src/runtime/watch-server.ts` because a
  detached build entry must own signals, heartbeat, lock, and `Watcher` without
  recursively parsing CLI commands.

## Proposed Contract

### CLI

```text
scip-query watch                 # existing foreground behavior
scip-query watch --daemon        # ensure background service is running
scip-query watch --status        # show running/stale/stopped and refresh state
scip-query watch --stop          # request graceful stop
scip-query watch --status --json # stable machine-readable state
```

`--daemon`, `--status`, and `--stop` are mutually exclusive. `--debounce`,
`--cooldown`, and `--git-poll` apply to foreground/daemon start, not status or
stop. Starting an already compatible live service succeeds idempotently and
reports the existing PID. A live incompatible version is asked to stop and is
replaced; failure to stop is reported rather than creating a second owner.

### Service state

`watch-state.json` is an atomic, versioned observation record, not the ownership
lock. Its minimum fields are:

```ts
interface WatchServiceState {
  version: 1;
  protocolVersion: 1;
  pid: number;
  projectRoot: string;
  cliVersion: string;
  startedAt: string;
  heartbeatAt: string;
  watcher: WatcherStatus;
  lastRefresh?: LastRefreshMetadata;
  lastError?: { at: string; message: string };
}
```

A **PID** is the operating system's numeric identity for one running process.
A **heartbeat** is a repeatedly refreshed timestamp whose defining trait is
that recent updates prove the server is still executing its control loop.
An **idempotent** ensure operation is one whose defining trait is that repeated
calls preserve one live service rather than creating additional owners.

The exclusive `watch.lock` remains the ownership proof. A state record is live
only when its identity matches the project/installed protocol, its heartbeat is
within the configured tolerance, and its PID is alive. PID liveness alone is
insufficient because PIDs can be reused.

### Automatic start

- The CLI pre-action hook best-effort ensures the service for ordinary commands
  when `watch.enabled` is true. It excludes `watch`, `reindex`, setup/uninstall,
  and internal hook commands to avoid recursion or lifecycle surprises.
- SessionStart calls the same ensure function instead of spawning an unrelated
  one-shot reindex. It reports `started`, `already running`, or the failure.
- UserPromptSubmit remains non-blocking. If the service is not healthy, it
  reports the repair command.
- `SCIP_QUERY_SKIP_WATCH_SERVICE=1` is the emergency/process-recursion opt-out;
  `watch.enabled: false` remains the normal durable opt-out.
- The detached server evaluates freshness once after it owns the lock and
  immediately requests `{ kind: 'watch-startup' }` for stale/missing/unknown
  state. It then relies on file/Git events.

### Reader behavior

The old database remains readable while refresh is waiting or in flight. State
and `status` explicitly describe the pending refresh, and the new generation is
visible only after the existing atomic publish completes. Phase 1 does not
block every query for freshness or add fields to ordinary query JSON.

## Testability Design

| Behavior                     | Test seam                                  | Dependencies to inject                        | Pure core                                | Side-effect shell             | Contract                                                                |
| ---------------------------- | ------------------------------------------ | --------------------------------------------- | ---------------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| State parsing/classification | `classifyWatchServiceState()`              | clock, expected project/version, PID liveness | live/stale/incompatible/stopped decision | state-file read               | malformed, old, dead, or mismatched state is never trusted              |
| Start decision               | `planWatchServiceAction()`                 | classified state and requested action         | start/reuse/replace/error                | spawn and readiness polling   | at most one compatible owner; repeated ensure is idempotent             |
| Lock ownership               | moved `acquireWatchProcessLock()`          | PID liveness and filesystem                   | existing/stale decision                  | exclusive open/remove/release | foreground and daemon cannot both own the repository                    |
| State publication            | state serializer/path helper               | clock and atomic writer                       | canonical record                         | temp write + rename           | readers see a whole old/new record, never partial JSON                  |
| Startup refresh              | server bootstrap                           | freshness provider and `Watcher` factory      | refresh/no-refresh decision              | start watcher/request refresh | stale/missing/unknown refresh immediately; fresh waits for events       |
| Edit coalescing              | existing `Watcher` plus `requestRefresh()` | fake timers/reindex runner                    | current state transitions                | child reindex                 | one in flight and at most one dirty follow-up                           |
| Graceful stop                | service controller                         | signal, liveness, clock                       | stopped/timeout classification           | SIGTERM and bounded poll      | lock/state released; timeout does not spawn a replacement               |
| CLI dispatch                 | `handleWatch()` lifecycle mode selection   | service controller                            | mutual-exclusion validation              | console/JSON output           | foreground remains default; JSON is valid and stable                    |
| Auto ensure                  | pre-action/hook helper                     | config loader and controller                  | should-ensure command filter             | background start              | enabled ordinary command ensures once; excluded commands do not recurse |
| Package entry                | built server path resolver                 | installation root                             | deterministic path                       | built tarball process         | published install contains and can start `watch-server.js`              |

Unit tests must not start a real long-running process. One bounded integration
test uses built artifacts and a temporary repository; it always stops the
service and restores edited files in `finally`.

## Pre-Registered Measurements

The benchmark harness records wall-clock event time, scheduled time, reindex
start/end, published metadata time, shard disposition, PID/start disposition,
and command/output hash. Each timing scenario runs five times after one warm-up
and reports median/p95.

| Scenario                               |                                          Baseline | Acceptance                                                         |
| -------------------------------------- | ------------------------------------------------: | ------------------------------------------------------------------ |
| Exact unchanged manual refresh         |                                           0.323 s | median <= 0.5 s, p95 <= 0.75 s                                     |
| One TypeScript leaf edit to fresh      | about 4.7 s compute plus 30 s configured debounce | event-to-scheduled p95 <= 1.5 s; edit-to-fresh p95 <= 8 s          |
| Twenty writes in 500 ms                |                                      not recorded | <= 2 refreshes, zero concurrent reindexes                          |
| Daemon ensure when already live        |                                       unavailable | p95 <= 100 ms and same PID                                         |
| Cold daemon start to healthy heartbeat |                                       unavailable | p95 <= 1 s excluding required stale reindex                        |
| Crash/stale-state recovery             |                                       unavailable | one replacement owner within 2 s; no orphan lock                   |
| Foreground watch/query output          |                                    current hashes | unchanged except declared additive `status`/watch lifecycle output |

Quiet-policy calibration runs the combinations 250/750/1500 ms debounce and
0/1000/5000 ms cooldown against single edit, 20-write burst, edit-during-index,
and save-format-save traces. Select the smallest pair that passes the burst and
single-flight contracts. Record the winner before changing product defaults or
this repository's explicit `.scipquery.json` values.

## Implementation Steps

Each numbered step is one commit after its focused tests pass.

### 1.1 — Add the lifecycle contract and benchmark harness first

- [ ] **Create:** `tests/runtime/watch-service.test.ts`,
      `scripts/incremental-freshness-contract.mjs`
- [ ] **Edit:** `tests/runtime/watch.test.ts`,
      `tests/runtime/cli-contract.test.ts`
- **Source:** `scip-query code Watcher`, `scip-query code handleWatch`,
  `scip-query code acquireWatchProcessLock`, `scip-query refs WatcherStatus`.
- **Change:** Write failing tests for state classification, idempotent ensure,
  incompatible/dead/stale recovery, action mutual exclusion, foreground
  compatibility, startup refresh decision, graceful stop, and single-flight
  coalescing through the new public request seam. Add a harness that can edit a
  fixture, poll metadata/service state, hash outputs, and restore the fixture.
- **Testability:** Inject clock, liveness, spawn/signal, filesystem state, and
  Watcher factory. The harness exposes explicit service/cache reset modes.
- **Validation:** Run `npx vitest run tests/runtime/watch-service.test.ts
tests/runtime/watch.test.ts tests/runtime/cli-contract.test.ts`; failures must
  be missing symbols/behavior, not flaky timers.
- **Why:** Process code is easy to make appear functional while stale-state and
  duplicate-owner behavior remain undefined; tests fix the state machine first.

### 1.2 — Extract one watch-service ownership and state boundary

- [ ] **Create:** `src/runtime/watch-service.ts`
- [ ] **Edit:** `src/runtime/commands/command-handlers.ts`,
      `tests/runtime/watch-service.test.ts`, `tests/runtime/watch.test.ts`
- **Source:** `scip-query code acquireWatchProcessLock`,
  `scip-query refs acquireWatchProcessLock`,
  `scip-query code createDurableRustAnalyzerSessionRequester`.
- **Change:** Move lock parsing/acquisition into the new module; add cache-path
  derivation, versioned state parsing/classification, atomic state writes,
  start/reuse/replace/stop controller functions, bounded readiness polling, and
  detached server spawning. Keep filesystem/process operations injectable.
- **Testability:** State/action functions are pure. The controller receives
  liveness, spawn, signal, clock/wait, and file operations rather than mocking
  Node globals throughout the suite.
- **Validation:** Focused lifecycle/watch tests pass; `scip-query
recent-duplicates --json` reports no duplicate lock/liveness/state helpers.
- **Why:** Foreground and daemon modes must share the same owner; leaving the
  lock in the CLI handler would create two competing lifecycle implementations.

### 1.3 — Add the detached server and startup-refresh seam

- [ ] **Create:** `src/runtime/watch-server.ts`
- [ ] **Edit:** `src/runtime/watch.ts`, `src/domain/maintenance-types.ts`,
      `tsup.config.ts`, `tests/runtime/watch-service.test.ts`,
      `tests/runtime/watch.test.ts`
- **Source:** `scip-query code Watcher:start`,
  `scip-query code Watcher:triggerReindex`,
  `scip-query code getIndexFreshness`,
  `scip-query code publishFreshReindexArtifacts`,
  `scip-query code createDurableRustSessionIdentity`.
- **Change:** Add `watch-startup` to refresh triggers and a public
  `Watcher.requestRefresh()` that delegates to existing scheduling. Implement a
  server that owns the lock, starts `Watcher`, persists status/heartbeat/error
  atomically, requests immediate refresh when startup freshness is not fresh,
  and handles SIGTERM/SIGINT/exit cleanup. Add `watch-server` as a built entry.
- **Testability:** Server bootstrap accepts freshness and Watcher factories;
  signal/heartbeat behavior uses fake timers. One built-artifact smoke test
  starts and stops the real entry in a temporary repository.
- **Validation:** Focused tests, `npm run typecheck`, `npm run build`, then
  assert `dist/watch-server.js` exists and the smoke process exits cleanly.
- **Why:** The existing CLI cannot outlive its terminal; the dedicated entry is
  the smallest owner that preserves the current Watcher and reindex worker.

### 1.4 — Expose daemon/status/stop while preserving foreground mode

- [ ] **Edit:** `src/runtime/commands/command-descriptors.ts`,
      `src/runtime/commands/command-handlers.ts`,
      `src/runtime/cli-context.ts`, `tests/runtime/runtime-config.test.ts`,
      `tests/runtime/cli-contract.test.ts`, `tests/runtime/watch-service.test.ts`,
      `docs/COMMAND_REFERENCE.md`, `skills/_shared/SKILL.md`
- **Source:** `scip-query code handleWatch`, `scip-query refs handleWatch`,
  `scip-query code formatStatus`,
  `scip-query co-change src/runtime/commands/command-descriptors.ts --json`.
- **Change:** Parse and validate lifecycle options, delegate to the controller,
  render stable human/JSON status, and keep no-option foreground behavior.
  Extend normal `status` with additive service state and last refresh/error.
  Generate command docs rather than hand-edit generated command blocks.
- **Testability:** Handler tests inject the controller and capture stdout/stderr;
  CLI contract tests cover option registration, mutual exclusion, JSON shape,
  idempotent start, and status when stopped/stale/running.
- **Validation:** Focused tests, then `npm run docs:commands`; generated docs are
  clean on a second run.
- **Why:** Users and hooks need one observable control surface before automatic
  startup is enabled.

### 1.5 — Make enabled repositories self-starting and remove one-shot races

- [ ] **Edit:** `src/runtime/cli.ts`, `src/runtime/agent-hooks.ts`,
      `src/runtime/project-setup.ts`, `tests/runtime/agent-hooks.test.ts`,
      `tests/runtime/project-setup.test.ts`, `tests/runtime/watch-service.test.ts`
- **Source:** `scip-query code refreshIndexForHookIfNeeded`,
  `scip-query refs getIndexFreshness`,
  `scip-query plan-context src/runtime/cli.ts --json`,
  `scip-query co-change src/runtime/agent-hooks.ts --json`.
- **Change:** Add a shared best-effort `ensureWatchServiceForCommand()` and call
  it from the CLI pre-action filter plus SessionStart. Replace the detached
  one-shot reindex in agent hooks with service ensure; keep UserPromptSubmit
  non-blocking. Report service readiness/degraded repair in setup/status. Honor
  config disable and `SCIP_QUERY_SKIP_WATCH_SERVICE=1`.
- **Testability:** Inject command name, config, env, and controller. Assert every
  excluded command, enabled/disabled behavior, no recursive server startup, and
  hook messages for started/reused/failed states.
- **Validation:** Focused agent/setup/lifecycle tests, CLI contract tests, and a
  built CLI smoke where a normal command starts exactly one server.
- **Why:** A daemon command alone would still require manual action; shared
  ensure semantics make enabled repositories automatic and eliminate competing
  hook-triggered reindexes.

### 1.6 — Calibrate timing, update defaults/config, and close the phase

- [ ] **Edit:** `src/runtime/config.ts`, `src/domain/config-types.ts`,
      `src/runtime/commands/command-descriptors.ts`, `.scipquery.json`,
      targeted config/watch tests,
      `docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`,
      its JSONL run history, and generated command docs if descriptions change
- **Source:** `scip-query code resolveWatchConfig`,
  `scip-query refs resolveWatchConfig`,
  `scip-query co-change src/runtime/config.ts --json`, and the campaign
  ledger's output contract/current checkpoint.
- **Change:** Run the pre-registered quiet-policy matrix and select the lowest
  passing debounce/cooldown pair. Record every trial. Update defaults,
  initialization, option descriptions, and this repository's explicit values
  to the measured winner. Run no-op, leaf edit, burst, edit-during-index,
  crash-recovery, foreground compatibility, separate CLI, and package smoke
  scenarios.
- **Testability:** Harness controls/restores file edits and service state; JSONL
  records cache/shard/service disposition and hashes for every run.
- **Validation:** Acceptance thresholds pass; focused runtime tests, `npm run
typecheck`, `npm run build`, `npm run lint`, `npm test`, `npm pack --dry-run`,
  relevant SCIP postchecks, `scip-query reindex`, and `scip-query diff-gate
--json` all pass or each accepted finding is documented.
- **Why:** The current 30/60-second policy is the dominant perceived delay, but
  lowering it without burst/edit-during-index evidence risks refresh churn.

## Stress-Test Matrix

| Case                                      | Expected result                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Two simultaneous `watch --daemon` calls   | One acquires the lock; the other reuses the same live state or waits for readiness.                                      |
| Foreground watch while daemon lives       | Clear error naming PID/state and `watch --stop`; no second owner.                                                        |
| Daemon start while foreground watch lives | Same refusal; foreground remains authoritative until stopped.                                                            |
| PID exists but heartbeat is old           | Treat as suspect; if PID is the matching server, request graceful replacement; never unlink a live owner's lock blindly. |
| State JSON truncated/malformed            | Ignore as untrusted observation; lock/liveness determine safe recovery.                                                  |
| CLI version/protocol mismatch             | Stop old compatible-control process, wait boundedly, then replace; otherwise report blockage.                            |
| Edit before server heartbeat              | Startup content freshness catches it and requests immediate refresh.                                                     |
| Edit during reindex                       | Dirty flag produces one follow-up after calibrated cooldown.                                                             |
| Save-format-save burst                    | One refresh unless a write lands during the in-flight run, then at most one follow-up.                                   |
| Reindex child fails                       | Prior generation stays readable; state records last error and returns idle/degraded; later edit can retry.               |
| Server receives SIGTERM                   | Watcher stops, heartbeat stops, lock/state clean up, exit code 0.                                                        |
| Parent CLI exits                          | Detached server survives; query command does not own its stdio.                                                          |
| Cache directory is unwritable             | Ensure fails visibly and ordinary command continues with current direct behavior; no false running state.                |
| Package upgraded while server runs        | Identity mismatch forces controlled replacement before new service is reported healthy.                                  |
| Git checkout changes many files           | Git/source events coalesce; startup/full fingerprint remains authoritative.                                              |

## Deviation Protocol

If a step changes files or public behavior beyond its list:

1. Add a dated note under this section before accepting the commit.
2. State the observed fact that invalidated the plan, the alternative chosen,
   affected acceptance gates, and rollback.
3. Rerun `scip-query plan-context` for the new target and extend the testability
   table if a new side-effect boundary appears.
4. Do not weaken timing/parity/crash gates after seeing an unfavorable result;
   record a rejected experiment or request an explicit roadmap revision.

No deviations are recorded at plan time.

## Explicit Deferrals

- **DEFER to Phase 2:** affected-file/dependency closure and shadow validation.
- **DEFER to Phase 3:** persistent ts-morph Project and new semantic cache keys.
- **DEFER to Phase 4:** per-file SCIP fragments/sub-shards.
- **DEFER to Phase 5:** incremental SQLite generation schema.
- **DEFER to Phase 6:** durable Rust default and selective native ports.
- **DEFER:** blocking every query until fresh. Phase 1 preserves availability,
  exposes service state, and publishes atomically; a later policy can add
  `require-fresh` after generation latency is low.

## Execution and Ship Order

1. Contract tests and harness (red).
2. Shared lifecycle/state core (green).
3. Detached server and startup refresh.
4. Observable CLI controls and generated docs.
5. Automatic CLI/hook ensure path.
6. Timing calibration, full verification, benchmark ledger, and rollout.

Ship behind existing `watch.enabled`; it defaults to false for repositories
without explicit opt-in. Keep foreground watch, manual reindex, and direct
semantic providers as fallbacks throughout.

## File Summary

### Create

- `src/runtime/watch-service.ts`
- `src/runtime/watch-server.ts`
- `tests/runtime/watch-service.test.ts`
- `scripts/incremental-freshness-contract.mjs`

### Edit

- `src/runtime/watch.ts`
- `src/runtime/cli.ts`
- `src/runtime/cli-context.ts`
- `src/runtime/agent-hooks.ts`
- `src/runtime/project-setup.ts`
- `src/runtime/config.ts`
- `src/runtime/commands/command-descriptors.ts`
- `src/runtime/commands/command-handlers.ts`
- `src/domain/maintenance-types.ts`
- `src/domain/config-types.ts`
- `tsup.config.ts`
- `.scipquery.json`
- focused runtime/CLI/setup tests
- generated command documentation
- campaign benchmark ledger and JSONL history

### Delete

- No file deletion planned. The one-shot SessionStart reindex branch is
  replaced in place after the shared service ensure path is tested.

## Phase-Close Self-Report

The final Phase 1 commit must append an outcome containing:

- commits mapped 1:1 to steps 1.1–1.6;
- selected debounce/cooldown pair and every rejected pair;
- median/p95 for every pre-registered scenario;
- service start/reuse/recovery dispositions and shard reuse;
- output hashes and graph/semantic fact counts;
- package smoke/install path;
- deviations and deferrals;
- exact first command for Phase 2 affected-set planning.
