# Time Semantics

scip-query separates shared timestamps from local elapsed-time control so a
system-clock correction cannot prolong a wait or impersonate ownership.

A **civil timestamp** is a calendar coordinate produced by the host's system
clock and written so different processes and later executions can compare
records. ISO dates, `enqueuedAtMs`, `deadlineAtMs`, heartbeat times, retention
times, and diagnostic start/completion times refer to this clock. Network time
synchronization, administrator changes, suspend/resume behavior, virtual
machine migration, and a reboot can move its observed value forward or
backward.

A **monotonic clock reading** is a process-local elapsed-time coordinate whose
ordering does not move backward while that process runs. `performance.now()`
is the JavaScript implementation used here. A monotonic reading is suitable
for durations and local deadlines because a civil-clock adjustment cannot add
time to or remove time from the measured interval. Its numeric value is not a
portable timestamp and is never persisted as cross-process evidence.

A **deadline** is the boundary that ends an operation when its resource budget
is consumed. Local request waits, lock waits, service startup and stop waits,
Rust readiness work, heartbeat throttles, activity polling, cache sweeps,
idle shutdown, and reported elapsed durations use monotonic readings. Timer
delivery can be late if the process is not scheduled, but moving the civil
clock cannot make the deadline later.

A **durable expiry hint** is a persisted civil timestamp that lets another
process classify old work for bounded cleanup or rejection. It is weaker than
ownership evidence because timestamp age cannot identify the process that
created a record. Mailbox request deadlines, response retention, dead-letter
retention, and heartbeat times remain durable hints. They may reject or clean
rebuildable retained data according to the documented retention contract, but
they do not alone authorize signaling a process, replacing a live service, or
reclaiming an inflight claim.

## Decision table

| Decision                                                                 | Clock/evidence used                                                                                 | Why                                                                                 |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Stop waiting for a lock, response, startup, shutdown, or readiness phase | Process-local monotonic deadline                                                                    | The wait remains bounded across forward and backward civil-clock jumps.             |
| Report a duration                                                        | Difference between monotonic readings                                                               | A clock correction cannot create a negative or inflated elapsed duration.           |
| Publish a heartbeat, start time, completion time, or request expiry      | Civil timestamp                                                                                     | Other processes and later executions need an inspectable shared coordinate.         |
| Accept a watch or mailbox service as the same owner                      | Protocol/project identity, live PID, and matching process-start identity when recorded              | A timestamp cannot distinguish PID reuse or a different executable instance.        |
| Replace or signal a watch service                                        | Matching process-start identity plus the explicit stop/start protocol                               | An old heartbeat alone never grants process-signal authority.                       |
| Reclaim an inflight mailbox claim                                        | Lease expired and recorded process instance is dead or replaced                                     | The civil lease is a delay hint; process-instance loss supplies ownership evidence. |
| Reclaim a process lock                                                   | Dead recorded process or mismatched process-start identity, followed by a guarded unchanged recheck | Valid locks do not expire; malformed public locks fail closed.                      |

## Cross-process handoff

Absolute monotonic readings are not sent between independent processes.
Portable mailbox requests carry relative timeout budgets and civil diagnostic
times. The receiving Rust service converts the relative budget into a new
deadline in its own monotonic clock domain before it hands work to its worker
thread. TypeScript and Rust clients likewise use their own monotonic deadline
while polling for a retained response.

Legacy state without a process-start identity remains readable. A live legacy
PID is treated conservatively: it can support availability where no process
mutation is attempted, but it cannot authorize a signal or deletion. An
unparseable public ownership record fails closed and requires operator review.

## Verification

The clock contract is covered by injected-clock tests that independently move
civil time forward and backward, advance monotonic time, reuse a PID with a
different process-start identity, and hold a live owner beyond a civil lease.
Focused suites include:

- `tests/domain/time.test.ts`;
- `tests/platform/process-file-lock.test.ts`;
- `tests/runtime/repository-cache-lifecycle.test.ts`;
- `tests/runtime/revisioned-file.test.ts`;
- `tests/runtime/watch-service.test.ts`;
- `tests/storage/bounded-mailbox.test.ts`;
- the TypeScript semantic and index mailbox suites; and
- the durable Rust and rust-analyzer readiness suites.
