# Watcher Disk-Pressure Remediation

Date: 2026-07-29

## Goal

Make automatic indexing remain fresh without allowing one repository watcher to
create sustained CPU or disk pressure. Completion means:

1. normal editing bursts are coalesced;
2. repeated automatic rebuilds stop at a persisted rolling resource budget;
3. a reindex worker cannot silently outlive its watcher owner;
4. artifact staging uses copy-on-write cloning where the filesystem supports
   it and reports fallback-copy cost where it does not;
5. watcher status explains every pause and recovery action; and
6. existing configuration and manually requested reindexes remain compatible.

## Definitions and Invariants

A **watcher owner** is the background `watch-server` process that holds the
repository's process-identity lock and is therefore the one process authorized
to subscribe to source changes and admit automatic refreshes. The lock is what
makes ownership exclusive rather than the process merely happening to be
alive. Source: `src/runtime/watch-service.ts:282-346`,
`src/runtime/watch-service.ts:437-483`.

A **refresh budget** is an automatic-work admission policy over persisted
reindex activity whose essential characteristic is that it refuses the next
automatic rebuild when recent completed rebuilds have already consumed the
configured count or estimated-write allowance. Because the evidence is
persisted, restarting the watcher cannot erase the debt. Source:
`src/reindex/reindex-activity.ts:22-80`,
`src/reindex/reindex-activity.ts:119-177`.

A **parent-death guard** is a worker-lifetime mechanism that continuously ties
a reindex worker to the exact birth identity of the watcher that launched it.
The birth token, not the numeric PID alone, prevents PID reuse from turning a
new unrelated process into an apparent owner. Source:
`src/platform/process-identity.ts`, `src/runtime/watch.ts:714-799`.

A **reflink clone** is a filesystem copy operation that initially shares the
source file's storage blocks and acquires private blocks only when either file
changes. This differs from a byte copy because unchanged artifact bytes do not
have to be rewritten. Source: `src/filesystem/durable-file.ts:15-20`.

**I1.** At every observable moment, one repository cache has at most one
watcher owner and at most one watcher reindex in flight.

**I2.** A watcher-launched reindex worker must stop admitting or continuing
child indexer work after its exact owner process dies, and its child processes
must receive the same cancellation.

**I3.** An automatic watcher refresh is admitted iff the rolling activity
ledger is readable and neither configured budget is exhausted. A missing
ledger is an empty history; malformed or unreadable existing evidence pauses
automatic work rather than guessing.

**I4.** A budget pause retains at most one coalesced pending refresh, is visible
in persisted/status output, and is cancellable by watcher shutdown.

**I5.** Reflink success and byte-copy fallback produce byte-identical staging
artifacts. Unsupported clone capability falls back; unrelated errors fail the
reindex rather than silently weakening publication.

**I6.** Manual `scip-query reindex` remains an explicit escape hatch. Its
completed activity counts against subsequent automatic admission so repeated
manual work cannot be hidden from the watcher.

**I7.** Existing watch configuration without resource-budget fields resolves
to documented safe defaults; explicit opt-out remains possible.

**I8.** Automatic watcher rebuilds always observe at least 5,000 ms between
completed runs. Legacy configuration and process-local overrides below that
floor remain readable but resolve to the floor.

## Premises

**P1.** At investigation time, the repository config enabled the watcher with
a 250 ms quiet period and explicitly disabled cooldown spacing with
`cooldownMs: 0`. The remediation changes the repository value and makes the
runtime floor independent of persisted configuration. Historical source:
`.scipquery.json:4-10` before this change.

**P2.** The runtime default is already a 250 ms debounce and 5,000 ms cooldown,
but the project override wins. Source: `src/runtime/config.ts:24-35`,
`src/runtime/config.ts:720-725`.

**P3.** `Watcher` coalesces changes with one pending trigger, one dirty bit, and
one `reindexInFlight` flag; it never starts a second worker while the flag is
set. Source: `src/runtime/watch.ts:146-153`,
`src/runtime/watch.ts:328-345`, `src/runtime/watch.ts:363-395`.

**P4.** Normal stop rejects new work, clears all timers, closes every
subscription, and cancels the active reindex operation before reporting a
clean stop. Source: `src/runtime/watch.ts:217-242`,
`src/runtime/watch.ts:448-505`.

**P5.** The watcher worker is launched as a detached bounded process. Its
15-minute timeout and cancellation controller live in the parent watcher
process. Source: `src/runtime/watch.ts:706-799`,
`src/platform/bounded-process.ts:114-218`.

**P6.** The worker currently has no parent-death monitor and calls `reindex`
without an abort signal. `ReindexOptions` has no cancellation field and
`runPreparedIndexers` does not pass a signal to bounded indexer processes.
Source: `src/reindex/worker.ts:1-55`, `src/reindex/index.ts:110-144`,
`src/reindex/indexer-runner.ts:122-181`.

**P7.** Four reindex staging paths and the incremental SQLite patch use plain
`copyFileSync`, while the existing durable publication helper already requests
copy-on-write cloning. Source: `src/reindex/index.ts:1067`,
`src/reindex/index.ts:1087`, `src/reindex/index.ts:1467`,
`src/reindex/index.ts:1658`,
`src/reindex/incremental-sqlite-publication.ts:115`,
`src/filesystem/durable-file.ts:15-20`.

**P8.** Reindex activity persists rebuilt/reused/failed outcomes and only a
logical-output estimate. It does not record reflink bytes, fallback-copy bytes,
or an estimated physical-write total. Source:
`src/reindex/reindex-activity.ts:22-80`.

**P9.** Complete compiler-resolved consumers of `WatcherStatus` are the state
validator, CLI formatter, refresh coordinator, watcher server/service,
`Watcher`, and tests. Source: `scip-query refs WatcherStatus --full` and
`scip-query dataflow WatcherStatus --full`, run 2026-07-29.

**P10.** Complete compiler-resolved consumers of `WatchConfig` are
`ProjectConfig`, runtime default resolution, and watch-service overrides.
Source: `scip-query refs WatchConfig --full` and
`scip-query dataflow WatchConfig --full`, run 2026-07-29.

**P11.** Complete compiler-resolved consumers of `runBoundedProcess` are the
indexer runner, isolated-analysis runner, watcher runner, and their tests.
Source: `scip-query refs runBoundedProcess --full`, run 2026-07-29.

**P12.** In the incident interval, reindex activity contained 14 rebuilt runs,
with a peak of eight rebuilds and 546.9 MB of logical output inside 15 minutes.
The intervals did not overlap. The macOS diagnostic attributed 34.36 GB of
file-backed dirty writes to a Node child in the watcher coalition and sampled
`node::fs::CopyFile`. Source:
`~/.cache/scip-query/projects/178a22f2ce58/reindex-activity.jsonl` and
`/Library/Logs/DiagnosticReports/node_2026-07-29-102456_Aydans-MacBook-Pro-2.diag`,
inspected 2026-07-29.

**P13.** The targeted watcher lifecycle suite currently passes 56/56 tests.
Source: `pnpm exec vitest run tests/runtime/watch.test.ts
tests/runtime/watch-service.test.ts tests/runtime/watch-server.test.ts`, run
2026-07-29.

## Current State

Source activity reaches `Watcher.handleFileChange`, which records one pending
trigger and resets a 250 ms debounce timer (P1, P3). The trigger launches one
detached reindex worker; further activity sets a dirty bit rather than creating
a concurrent worker (P3, P5). With this repository's zero cooldown, a change
arriving after completion can start another rebuild after only the debounce
period (P1, P2). Each rebuilt run publishes several large artifacts, and five
hot staging paths request ordinary byte copies instead of the existing
copy-on-write capability (P7). The activity ledger describes useful logical
output but cannot distinguish cheap reflinks from expensive fallback copies
(P8). Normal shutdown is carefully drained (P4), but an uncatchable parent
death removes the timeout/cancellation owner while leaving the detached worker
without a parent-identity guard (P5, P6).

## State-Authority Map

### Watcher status

Writer: `Watcher.setStatus`. Readers: `watch-server` persistence,
`watch-service` idle decisions, `watch-refresh-coordinator`, state decoding, and
CLI formatting. The complete set is P9. Adding a budget-paused state therefore
requires updating the union, writer state machine, parser, formatter, idle
policy, coordinator behavior, and tests in one slice.

### Reindex activity ledger

Writers: successful, failed, and suppressed activity functions in
`src/reindex/reindex-activity.ts`, called from `reindex` and `watch-server`.
Readers: activity summary, watch-state persistence/validation, status
rendering, and the new admission inspector. Complete type consumers are P8 and
the `ReindexActivitySummary` `refs`/`dataflow` results run 2026-07-29.

### Watch configuration

Writer: project initialization/setup and explicit user configuration. Readers:
`resolveWatchConfig`, watcher construction, daemon overrides, validation, and
JSON Schema consumers. Compiler-visible consumers are complete in P10;
schema/docs are non-code consumers assigned to Slice 2.

### Worker ownership

Writer: `resolveReindexWorkerLaunch` captures the owner identity into the
worker environment. Readers: the worker parent monitor and tests. Numeric PID
and birth token are immutable after launch. No other writer is permitted.

## Reuse Audit

- Extend `WatcherStatus` rather than create a second parallel service-status
  channel; every status consumer already meets at that union (P9).
- Extend `reindex-activity` rather than create a new budget database; it is
  already bounded, rotated, persisted across service restarts, and records both
  manual and automatic work (P8).
- Extend `WatchConfig` with one nested `resourceBudget` policy rather than add
  four unrelated root fields; watcher timing and resource admission are one
  operator-owned policy surface (P10).
- Add a small parent monitor beside process-identity utilities. Existing
  liveness functions identify a process at one instant but do not own a timer
  or cancellation transition, so folding the monitor into either would mix
  observation with lifecycle.
- Add a non-durable reflink-or-copy staging helper instead of reusing
  `cloneFileDurable`: staging files are made durable by the later generation
  publication, and fsyncing every intermediate clone would add the writes this
  program is intended to remove.
- Propagate the existing `AbortSignal` accepted by `runBoundedProcess` rather
  than invent another cancellation protocol (P11).

## Testability Design

- Pure seam: `evaluateReindexActivityBudget(records, config, now)` receives
  parsed values and returns allow/pause plus evidence and retry time.
- Filesystem shell: `inspectReindexActivityBudget` reads the bounded rotated
  ledger and delegates to the pure evaluator.
- Pure seam: parent ownership evaluation compares expected and observed
  `ProcessIdentity` values. The monitor receives injected clock/identity/abort
  functions.
- Process shell: `reindex/worker.ts` installs the monitor and passes one
  `AbortSignal` through `reindex` to every bounded child indexer.
- Pure seam: clone error classification decides whether fallback is safe.
- Filesystem shell: reflink-or-copy performs the clone/copy and returns method
  plus source byte count.
- Observable tests assert paused status, coalesced recovery, cancellation,
  ledger totals, byte-identical files, and child exit—not private method call
  order.

## Design Phases

### Slice 1 — Restore disk-light scheduling

Deployable: yes.

What: the repository overrides the safe 5-second default with zero spacing
(P1, P2).

Change: set the repository cooldown to 5,000 ms and add a regression proving
the documented/default generated configuration retains safe spacing.

Validation: runtime config tests, watcher burst tests, config validation.

### Slice 2 — Persisted refresh-budget admission

Deployable: yes.

What: the watcher has single-flight execution but no rolling rate/resource
limit (P3, P8, P12).

Change: add nested safe defaults—15-minute window, four completed rebuilds,
and a configurable estimated-write ceiling. Parse the bounded ledger before
automatic admission. Add `budget-paused` status with the exact retry time and
consumption evidence. Missing ledger means empty history; corrupt or unreadable
existing history pauses automatic work. Manual reindex remains allowed and
contributes activity (I3, I4, I6, I7).

Validation: pure budget boundary tests, restart-persistence test, paused-state
parser/formatter tests, watcher timer/stop tests, JSON Schema/config tests.

### Slice 3 — Parent-death cancellation

Deployable: yes.

What: normal stop drains, but unexpected parent death removes the only timeout
owner while a detached worker may continue (P4-P6).

Change: capture the watcher's exact process identity at launch; monitor it in
the worker; abort reindex when it disappears or changes; add `signal` to
`ReindexOptions`; propagate it through structured indexer execution and every
bounded child; never convert owner cancellation into a skippable indexer
failure.

Validation: parent missing, PID-reused, normal-owner, and monitor-disposal unit
tests; active-indexer cancellation integration test; existing bounded-process
tree tests.

### Slice 4 — Clone-aware publication and telemetry

Deployable: yes.

What: five hot staging paths use unconditional byte copies and telemetry
cannot reveal the amplification (P7, P8).

Change: add reflink-force with classified fallback; replace all five staging
copies; aggregate cloned and fallback-copied bytes per reindex; persist
`estimatedWriteBytes`, `reflinkedBytes`, and `fallbackCopiedBytes`; use
estimated writes for the budget and display all three in status.

Validation: reflink success/fallback/unrelated-error tests, byte identity test,
incremental SQLite publication test, reindex activity backward-compatibility
and aggregation tests, focused reindex reliability tests.

### Slice 5 — Documentation and operational closure

Deployable: yes.

Change: update README configuration/status/recovery guidance, schema, generated
API if affected, and command reference only where output changes. Document
that the breaker controls future automatic runs and does not interrupt a
single already admitted run.

Validation: docs/contract checks, API report, build, full suite, relevant SCIP
postchecks, and `scip-query diff-gate`.

## Attack Record

**A1 — I1, concurrency.** Two commands start a daemon simultaneously.
Outcome: HELD by the process-identity lock and reuse/refusal path (P3; existing
service ownership).

**A2 — I1/I4, concurrency.** Hundreds of files change while a reindex runs.
Outcome: HELD by one in-flight flag, one dirty bit, and one pending trigger
(P3); Slice 2 retains that shape during a pause.

**A3 — I3, resilience.** An operator restarts the service after the breaker
opens to obtain a fresh budget. Outcome: HOLE — repaired by Slice 2 reading the
persisted bounded activity ledger before every admission.

**A4 — I6, human experience.** The automatic budget blocks an urgent explicit
manual rebuild. Outcome: HELD by Slice 2 limiting admission only inside
`Watcher`; manual work remains explicit and is recorded afterward.

**A5 — I3, data integrity.** The activity file is missing on a new project.
Outcome: HELD by Slice 2 distinguishing absent history from an existing
unreadable/corrupt segment.

**A6 — I3, resilience.** One admitted indexer alone writes more than the
budget. Outcome: HOLE — accepted. The budget is a rolling admission breaker,
not an in-process byte quota; a run has no portable source of actual device
writes. The existing 15-minute process timeout and Slice 3 cancellation bound
time, while Slice 4 removes known copy amplification. Status/docs must state
this limitation.

**A7 — I5, portability.** Reflinks are unsupported on the filesystem.
Outcome: HOLE — repaired by Slice 4 classifying capability errors, falling
back to a byte copy, and recording its byte cost.

**A8 — I5, data integrity.** The clone fails with permission or I/O error.
Outcome: HELD by Slice 4 refusing fallback for errors that do not prove missing
clone capability.

**A9 — I2, failure.** The watcher is killed while an indexer child is active.
Outcome: HOLE — repaired by Slice 3's exact-owner monitor and end-to-end abort
propagation.

**A10 — I2, concurrency.** The watcher PID is reused before the worker's next
poll. Outcome: HELD by comparing the captured process birth token, not PID
alone (Slice 3).

**A11 — I2, reversibility.** Normal shutdown races the parent monitor.
Outcome: HELD by idempotent AbortController cancellation and disposing the
monitor when reindex settles (Slice 3).

**A12 — I4, shutdown.** The watcher stops while budget-paused.
Outcome: HELD by Slice 2 assigning the retry to the existing clearable timer
ownership and covering it with a stop test (P4).

**A13 — I3/I7, configuration.** A user needs to disable the guard for a
special environment. Outcome: HELD by an explicit nested `enabled` field,
validated and documented in Slice 2.

## Implementation Note

The count default was tightened from the plan's initial eight to four after
comparing the proposed boundary with the incident evidence. A limit of eight
would have admitted the entire observed eight-rebuild burst and blocked only a
ninth run; four materially halves that failure mode while manual reindex
remains available for an urgent explicit refresh.

**A14 — I3, observability.** The breaker pauses but an agent interprets the
index as fresh. Outcome: HOLE — repaired by Slice 2 adding a distinct persisted
status, clearing trusted generation while paused with dirty work, and
rendering the reason/retry time.

**A15 — I5, efficiency.** Reflinks succeed but telemetry counts their full
length as physical writes and opens the breaker. Outcome: HELD by Slice 4
separating reflinked bytes from fallback-copy bytes and excluding reflinked
payload bytes from the write estimate.

**A16 — I7, API evolution.** Old configs and activity records lack the new
fields. Outcome: HELD by additive optional persisted fields and resolved
defaults; fixtures cover legacy decode in Slices 2 and 4.

## Coverage Matrix

| Surface / writer                   | Concurrency | Failure | Integrity | Observability | Efficiency                   | Testability              |
| ---------------------------------- | ----------- | ------- | --------- | ------------- | ---------------------------- | ------------------------ |
| `Watcher.setStatus`                | A2, A12     | A12     | A14       | A14           | A2                           | Slice 2 fake clock       |
| successful activity writer         | A3          | A5      | A5, A16   | A14           | A15                          | Slice 4 ledger tests     |
| failed/suppressed activity writers | A3          | A5      | A16       | A14           | accepted: zero write payload | Slice 2 legacy tests     |
| config init/resolve                | A13         | A5      | A16       | A13           | A6                           | Slice 2 config tests     |
| worker launch owner writer         | A9-A11      | A9      | A10       | A9            | accepted: 1 s poll           | Slice 3 injected monitor |
| worker owner monitor reader        | A9-A11      | A9      | A10       | A9            | accepted: 1 s poll           | Slice 3 injected monitor |
| five staging-copy writers          | A7, A8      | A7, A8  | A8        | A15           | A15                          | Slice 4 filesystem tests |
| manual reindex writer              | A4          | A6      | A16       | A4            | A6                           | Slice 2 integration      |

No enforcement window spans deployments: each new status/config/activity field
is accepted by its parser and renderer in the same slice, and each copy site is
migrated in the same slice that introduces telemetry.

## Execution and Ship Order

Slices 1 and 2 install immediate admission containment. Slice 3 is independent
in code but lands before publication so unexpected termination cannot bypass
the new policy. Slice 4 changes performance, not publication semantics, and
must land with its fallback tests. Slice 5 closes public documentation and
generated surfaces. All slices ship together in one package release because
the persisted paused status requires the matching CLI decoder.

The one-way door is the public package version, not the data format: config and
activity changes are additive and rollback-compatible.

## Verdict

A plan is **PLANNED-COMPLETE** iff the coverage matrix has no blank rows, every
attack ends in HELD with cited steps/premises or an accepted hole with a written
reason, and no premise failed reverification.

Result: **PLANNED-COMPLETE** — 16 attacks, 6 holes repaired by planned slices,
1 explicitly accepted limitation, 0 blank coverage rows, and 0 failed
premises.

## File Summary

Create:

- a focused parent-monitor module and tests;
- a non-durable clone-aware staging helper and tests.

Edit:

- `.scipquery.json`;
- watcher/config/state/runtime files and focused tests;
- reindex activity, worker, indexer runner, artifact publication files and
  focused tests;
- project JSON Schema, README, and generated public API/command documentation
  only where contracts change.

Delete: none.

Verify:

- focused config, watcher, process, clone, activity, incremental SQLite, and
  reindex reliability tests;
- lint, TypeScript build, API compatibility/reporting, consumer fixture, full
  test suite;
- routed SCIP postchecks and `scip-query diff-gate`.

## Completion Record

Completed 2026-07-29.

- Slice 1 restored a 5,000 ms repository cooldown and then strengthened it
  into a runtime safety floor. Legacy config and process-local overrides below
  the floor remain readable but resolve to 5,000 ms; validation and user
  documentation disclose the effective behavior.
- Slice 2 added the persisted 15-minute budget with a default ceiling of four
  completed rebuilds or 4 GiB of estimated writes. A pause retains one dirty
  refresh, exposes its reason and retry time, survives process restart, and
  fails closed only when an existing ledger cannot be trusted.
- Slice 3 ties each reindex worker to the watcher's exact process identity and
  propagates owner-loss cancellation through indexer and SQLite-converter
  subprocess trees.
- Slice 4 replaced the five hot staging copies with clone-first publication,
  capability-only fallback, and separate reflink/fallback-copy telemetry.
- Slice 5 updated configuration initialization, schema, README, status output,
  the public API manifest/change record, and generated command documentation.

Live-operability proof used the real demand-started daemon and persisted
activity ledger. The watcher first reported `5/4`, then `4/4`, retained one
pending refresh without launching competing work, recalculated each retry from
the oldest contributing record, admitted exactly one refresh when consumption
fell below the ceiling, and returned idle. That refresh reported 44.7 MB
reflinked and no new byte-copy staging.

Verification:

- `npm run typecheck`: pass.
- Focused watcher/reindex/platform suite: 145 tests pass.
- `npm test`: 272 files and 2,148 tests pass.
- `npm run lint`: formatting, ESLint, build, public API digest
  `9939d4ad4dbb6414`, public consumer fixture, and skill-link checks pass.
- Fresh self-index generation `0bb55a2b8822`: TypeScript and Rust capabilities
  available.
- SCIP postchecks: no recent duplicate abstraction, no incomplete migration,
  no forbidden architecture edge, and complete full-reference consumers for
  clone and cancellation helpers.
- `scip-query diff-gate`: pass with five advisory-only historical citations.
  The sole blocking co-change false positive is recorded as the
  evidence-invalidating detector counterexample
  `.scipquery/suppressions/SQA94DC3F07D49.json`; generated command
  documentation was regenerated and correctly stayed unchanged because it
  records option names rather than option help text.
- The verified local `0.20.0` package is installed globally, all 27 shipped
  Claude/Codex/Agents skill links were refreshed, Vega's explicit zero
  cooldown was changed to 5,000 ms, and Vega's generated agent guidance was
  refreshed from this build.

Result: **IMPLEMENTED-COMPLETE**.
