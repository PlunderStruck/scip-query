# Resilience and Concurrency Remediation Plan

Date: 2026-07-27
Mode: high assurance
Audit source: `docs/reviews/2026-07-26-resilience-and-concurrency-audit.md`
Audited revision: `0bc4af6d4563040fe8abaac70ea91a1d53155c1a`

## Goal

Remove every confirmed resilience and concurrency defect RC-01 through RC-11
without weakening scip-query's completeness claims, process-identity safety,
or existing command compatibility.

Done means:

1. Expensive TypeScript mailbox work cannot block watch control-plane
   transitions.
2. Every bounded child boundary owns and terminates the whole process tree, or
   returns a finite explicit failure proving that it could not.
3. Rust Worker replacement cannot overlap a predecessor whose Worker or
   rust-analyzer descendants are still alive.
4. A timed-out LSP request is cancelled and its old transport cannot race an
   immediate retry.
5. Parallel query helpers stop admitting work after the first failure, join all
   already-started work, and then report the first error.
6. Watch shutdown has a deadline, a degraded outcome, and identity-safe forced
   cleanup.
7. Output snapshots have bounded per-snapshot and aggregate storage, linear
   continuation cost, and readable human pagination.
8. Limited `refs` queries do work proportional to the requested page rather
   than the complete result set.
9. Rust semantic sessions use canonical identities, a finite capacity, and
   joined eviction.
10. The public API, command documentation, generated artifacts, and setup
    behavior accurately describe the changed contracts.
11. The complete pre-existing test suite remains green and focused regression
    tests exercise every repaired failure mode.

## Definitions and invariants

A **control plane** is the part of the watch service that accepts changes,
advances lifecycle state, observes deadlines, and coordinates shutdown. Its
essential property is responsiveness: bounded background work cannot occupy
the only execution lane on which control decisions depend.

A **process tree owner** is the component that starts an operating-system
process and remains responsible for that process plus every descendant created
under its execution identity. Ownership ends only after exit is observed or a
finite, explicit unreaped failure is returned.

A **join** is a synchronization boundary that waits for every operation already
admitted into a concurrent scope to settle. A fail-fast scope may stop admitting
new work immediately, but it cannot return while admitted work is still able to
mutate shared state.

A **snapshot reservation** is an atomic claim on finite temporary-storage
capacity made before bytes are accepted. It prevents individually valid writers
from collectively exceeding the process's output-storage budget.

A **keyset cursor** is an opaque continuation identity based on the last stable
sort key returned, rather than the number of preceding rows. Its essential
property is that continuing a page does not require rematerializing and
discarding every earlier result.

The implementation must preserve these invariants:

- I1. No signal is sent to a PID whose birth identity was not validated
  immediately before the signal.
- I2. Timeout and shutdown paths settle within a documented upper bound.
- I3. No replacement worker or language-server process begins while the
  predecessor's termination is unresolved.
- I4. After a parallel scope returns, none of its admitted operations can still
  mutate scope-owned state.
- I5. A continuation token is bound to the exact invocation, immutable output,
  page geometry, and repository generation that produced it.
- I6. Human output is multiline human text. A single-line JSON envelope appears
  only when JSON was explicitly requested.
- I7. A complete page sequence returns every result exactly once and in stable
  order, or marks its coverage incomplete.
- I8. Cache and snapshot limits are enforced across concurrent writers, not
  merely checked independently before each write.
- I9. Existing unpaginated library methods remain compatible unless an explicit
  API-versioned replacement is documented.

## Evidence and premises

- P1. The baseline at the audited revision is 247 passing test files and 1,934
  passing tests. Source: full `npm test` run on 2026-07-27.
- P2. `runBoundedProcess` has three production consumers: indexer execution,
  isolated analysis, and watch execution. Source: complete `scip-query refs`
  evidence for `src/platform/bounded-process.ts`.
- P3. TypeScript index and semantic mailbox processing are invoked directly by
  `watch-server.ts`; their handlers perform synchronous compiler and semantic
  work. Source: `plan-context` for `watch-server.ts` and complete refs for both
  mailbox processors.
- P4. Rust session Workers are synchronously requested through `Atomics.wait`,
  while `Worker.terminate()` currently returns a Promise that is neither joined
  nor used to gate replacement. Source: `plan-context` for
  `lsp-session-worker.ts`.
- P5. Rust LSP request timeout removes the pending request and rejects it, but
  does not cancel server-side work; reference lookup then retries immediately.
  Source: SCIP code evidence for `rust-lsp-client.ts` and
  `rust-lsp-session.ts`.
- P6. The production Rust concurrency helper has eight references and returns
  on the first rejected lane without explicitly joining all admitted siblings.
  Source: complete refs for the helper and its consumers.
- P7. Watcher close and forced external stop both cross process-identity and
  deadline boundaries. Source: `plan-context` for watch runtime files and the
  audit's fault trace.
- P8. Output continuation currently rereads and rehashes the snapshot prefix
  from byte zero, while the maximum tracked output is effectively unbounded.
  Source: `plan-context` and SCIP code evidence for
  `output-pagination.ts`.
- P9. Supplying `--output-page-size` currently forces a one-line JSON envelope
  even for human output. The observed 6,032-character response was wrapped in a
  30,000-character page selected by the caller, not by an output requirement.
  Source: the reproduced CLI output and `finalizeOutputForTransport`.
- P10. `refs --limit` materializes, sorts, and often semantically enriches the
  complete result set before slicing. Source: `plan-context` for `refs.ts` and
  the command handler.
- P11. Rust sessions are keyed by order-sensitive linked-project arrays and
  retained in an unbounded Map. Source: SCIP dataflow for `sessions` and
  `lsp-session-worker.ts`.
- P12. The watch service ordinarily refreshes the SCIP index automatically.
  Manual reindexing is therefore allowed only when freshness evidence reports
  stale or disabled state. Source: current repository agent contract.

## State-authority map

| State | Sole authority | Readers | Commit / release rule |
| --- | --- | --- | --- |
| Child process-tree identity | process-tree owner | bounded runner, Rust transport, watch stop | Validate immediately before every signal; release after observed exit or explicit unreaped result |
| TypeScript mailbox claim | watch parent | TS worker controller | Parent claims and commits/rejects; Worker only computes |
| Rust Worker lifecycle | session requester | synchronous request facade | Replacement waits for predecessor termination and descendant reap |
| LSP pending requests | one transport instance | session operations | Timeout cancels and poisons the transport before caller regains control |
| Parallel work admission | structured-concurrency scope | worker lanes | First error closes admission; scope joins admitted lanes before return |
| Watch lifecycle state | Watcher / watch server | CLI and health reporting | Stop reaches stopped or degraded by deadline |
| Snapshot capacity | locked snapshot registry | snapshot writers and continuations | Reserve before write; release after cleanup; never exceed aggregate budget |
| Snapshot page geometry | immutable metadata | continuation reader | Fixed at capture completion; cursor must match it |
| Refs continuation order | query producer | CLI formatter | Cursor records last stable key and source generation |
| Rust session cache | session Worker | request dispatcher | Canonical key, bounded LRU, joined eviction |

## Reuse audit

The implementation should extend these existing authorities rather than create
parallel mechanisms:

- `src/platform/process-identity.ts` for PID birth identities and revalidation.
- `src/platform/bounded-process.ts` for budget semantics and error reporting.
- `src/platform/process-file-lock.ts` for cross-process snapshot quota
  serialization.
- `src/runtime/watch-service.ts` and its injected `WatchClock` for deterministic
  shutdown deadlines.
- Existing output cursors and CLI JSON-envelope conventions for versioned
  compatibility.
- Existing repository generation identities for rejecting stale `refs`
  continuations.
- Existing Rust durable-session protocol instead of adding a second request
  channel.

The two private `runWithConcurrency` implementations are intentional audit
targets. If one shared helper can express both consumers without coupling query
domain policy to process execution, consolidate them. Otherwise give each the
same explicit join contract and a contract test.

## Testability design

Each side-effect boundary receives an injectable adapter:

- process group creation, identity reads, signals, and exit observation;
- Worker construction and asynchronous termination;
- Rust transport writes, cancellation, close, and process-tree reap;
- watch clock and watcher close;
- snapshot quotas, filesystem identity, and cleanup clock;
- reference-page producers and scan counters.

Tests use controlled promises and fake clocks instead of timing races. Every
timeout test proves both observable failure and quiescence after return. Every
pagination test validates concatenated page contents against an unpaginated
oracle.

## Implementation slices

### Slice 1 — RC-02: own and terminate complete process trees

Create a shared process-tree abstraction used by bounded children and
rust-analyzer transports. On POSIX, start a distinct process group and signal
the validated group. On Windows, use the finite tree-termination facility
available to Node-based CLI processes. Preserve direct-child exit metadata.

Tests:

- a child that spawns a descendant cannot leave the descendant alive;
- graceful termination is attempted before force;
- every signal follows a fresh identity check;
- ordinary successful children retain current behavior.

### Slice 2 — RC-03: make escalation finite under missing identity

Represent termination as a finite state machine with an absolute deadline.
Retry only within that deadline. If identity cannot be obtained or no longer
matches, settle with an explicit `reaped: false` outcome and never signal an
unverified PID.

Tests:

- identity reader permanently fails;
- identity changes between graceful and forced termination;
- child close races the escalation timer;
- no timeout path can remain pending indefinitely.

### Slice 3 — RC-04: join Rust Worker and rust-analyzer teardown

Track Worker termination as owned asynchronous state. Keep descendant ownership
visible to the parent so forced Worker teardown can still reap rust-analyzer.
Delay result-directory cleanup and replacement until Worker termination and
descendant cleanup settle.

Tests:

- restart waits for predecessor termination;
- shutdown waits for rust-analyzer exit;
- forced Worker termination reaps registered descendants;
- cleanup never removes live ownership evidence.

### Slice 4 — RC-05: cancel and poison timed-out LSP work

On request timeout, send `$/cancelRequest`, close the old request scope, and
poison or replace the transport only after its process tree is reaped. Do not
immediately retry a timed-out reference request on the same server. Retain the
bounded retry for the protocol's explicit content-modified response.

Tests:

- timeout emits the exact cancellation ID;
- late responses cannot resolve a newer request;
- timed-out references are incomplete rather than duplicated;
- content-modified retry remains bounded and functional.

### Slice 5 — RC-06: join admitted concurrent work

Implement structured fail-fast execution: record the first error, stop taking
new items, allow admitted operations to settle, join every lane, then throw the
first error. Apply the same rule where refs and callees are launched together.

Tests:

- no new item starts after the first observed failure;
- already-started siblings finish before the helper rejects;
- the first error remains the reported error;
- success preserves ordering and concurrency limits.

### Slice 6 — RC-01: isolate TypeScript mailbox computation

Keep claim ownership and result commit in the watch parent. Move TypeScript
compiler/index and semantic computation to independently replaceable worker
lanes so one workload cannot block watch state transitions or the other lane.
Give each request an absolute deadline and join termination before replacement.

Tests:

- a blocked index worker does not prevent stop or semantic status;
- a blocked semantic worker does not prevent index mailbox progress;
- claims are committed exactly once by the parent;
- replacement waits for predecessor termination.

### Slice 7 — RC-07: bound watcher shutdown

Race watcher close against an injected absolute deadline. Return a degraded
shutdown reason on expiry. In the dedicated watch-server process, terminate the
process after reporting degradation so the operating system closes stuck
descriptors. Revalidate process birth identity immediately before forced
external stop and observe exit before cleanup.

Tests:

- never-settling watcher close reaches degraded state by deadline;
- a library caller receives the degraded failure;
- dedicated server exits after reporting it;
- PID reuse between TERM and KILL prevents the KILL.

### Slice 8 — RC-08: bound output snapshot storage

Introduce documented per-snapshot bytes/characters, aggregate bytes, and
snapshot-count limits. Reserve capacity atomically under a process lock before
accepting output. Clean expired snapshots and abandoned temporary files during
reservation. Fail explicitly with guidance to narrow the query when capacity is
unavailable.

Tests:

- exact-boundary success and one-byte-over failure;
- concurrent writers cannot overcommit aggregate capacity;
- stale temporary files release capacity;
- cleanup does not remove active snapshots.

### Slice 9 — RC-09: make continuation linear and human-readable

Build immutable page byte offsets and page hashes once when capture completes.
Bind page size to cursor metadata. Read and verify only the requested page plus
fixed metadata during continuation. Preserve Unicode scalar boundaries.

For non-JSON commands, render the existing compact multiline header, literal
multiline body, and exact continuation command. Emit the object envelope only
when `--json` was explicitly requested. A page-size override must not itself
select JSON.

Tests:

- N pages perform O(total output) byte reads rather than O(N × output);
- corruption of the requested page is detected;
- page-size mismatch is rejected;
- surrogate pairs and multibyte characters cross pages losslessly;
- a fitting human result is raw text;
- an oversized human result and an explicit human page are readable multiline
  text;
- explicit JSON pagination retains the machine envelope.

### Slice 10 — RC-10: page refs at the producer

Add a versioned keyset page producer ordered by normalized path and location.
For a limited request, stop after `limit + 1` eligible rows rather than sorting
the complete corpus. Preserve the existing unpaginated library method. Decode
legacy offset cursors for compatibility while emitting the new keyset cursor.
If an evidence provider cannot page without full materialization, expose that
bounded coverage honestly instead of implying a complete total.

Tests:

- `--limit 1` scans a bounded prefix in an instrumented corpus;
- concatenated pages equal the complete reference oracle;
- pages contain no duplicates or omissions;
- legacy cursor decoding remains valid;
- a generation change rejects continuation.

### Slice 11 — RC-11: canonicalize and bound Rust sessions

Resolve, deduplicate, and stable-sort linked projects before computing session
identity. Use a small documented LRU capacity. Because the Worker dispatches
messages serially, evict between requests and await the victim's shutdown and
process-tree reap before admitting a replacement.

Tests:

- project order does not change session identity;
- duplicate paths do not produce a second session;
- capacity is never exceeded;
- eviction is least-recently-used and joined;
- shutdown joins every retained session.

### Slice 12 — contracts, documentation, and generated surfaces

Update README/setup/command documentation only where behavior is externally
observable: process deadline failures, human pagination, cursor compatibility,
snapshot quotas, and bounded session reuse. Regenerate public API and command
artifacts. Do not edit or stage `skills/**`; Claude owns that concurrent
surface.

## Dependency and ship order

True dependencies:

- Slice 1 precedes slices 2, 3, 4, and 7.
- Slice 3 precedes final validation of slice 4.
- Slice 8 precedes slice 9.

Slices 5, 6, 7, 10, and 11 are otherwise independent and may be implemented in
the listed order for reviewability. Each numbered slice receives focused tests,
the relevant full gate, and one explicit-path commit. Documentation is updated
with the owning slice when practical, then reconciled in slice 12.

## Adversarial attacks and repaired holes

| Attack | Expected defense | Slice |
| --- | --- | --- |
| Child spawns a grandchild and ignores TERM | validated group/tree kill and observed reap | 1 |
| PID disappears or is reused during escalation | finite unreaped result; never signal mismatched identity | 2 |
| Worker exits while rust-analyzer survives | parent-visible ownership and joined descendant reap | 3 |
| LSP response arrives after timeout | cancelled request ID and poisoned old transport | 4 |
| One concurrent lane fails while another writes | admission closes, admitted lane joins before return | 5 |
| TS analysis never yields the JS thread | compute Worker isolation and deadline replacement | 6 |
| Watcher close Promise never settles | degraded deadline outcome and process exit | 7 |
| Two snapshot writers each pass an unlocked quota check | atomic reservation serializes admission | 8 |
| Agent requests page two of a huge Unicode result | indexed byte range, fixed geometry, exact reconstruction | 9 |
| `refs --limit 1` has a million matches | producer stops after the bounded page frontier | 10 |
| Same Rust projects arrive in different orders indefinitely | canonical key, LRU cap, joined eviction | 11 |

Solo falsification coverage is complete when each attack above has an executed
regression test and at least two final manual refutation attempts are run:

1. descendant survival after a forced timeout;
2. concatenated paginated output versus its complete raw oracle.

## Verification

Per slice:

1. Run the focused regression tests.
2. Run TypeScript type checking and lint for changed production surfaces.
3. Use SCIP impact evidence and the routed postcheck for new helpers,
   interfaces, options, or docs.
4. Stage explicit paths only and inspect the staged diff.
5. Commit one slice.

Final:

1. `scip-query doctor`
2. one `scip-query status --capabilities` freshness check
3. `scip-query diff-impact --json`
4. routed SCIP postchecks, followed by `scip-query diff-gate`
5. public API contract verification
6. command/document generation verification
7. lint, type check, build, and package checks
8. full `npm test`, with at least 247 files and 1,934 pre-existing tests plus all
   new regressions passing
9. inspect `git diff --check`, ignored `HEY.md`, and all unstaged concurrent
   changes before the final commit

## Completion record

All implementation slices are complete. The program landed in reviewable
commits rather than one cumulative mutation:

| Slice | Finding(s) | Commit | Result |
| --- | --- | --- | --- |
| 1–2 | RC-02, RC-03 | `a142bf52` | Shared process-tree ownership, identity-safe TERM/KILL escalation, finite unreaped outcomes |
| 3–4 | RC-04, RC-05 | `0e39a25f` | Joined Rust Worker/analyzer teardown, timeout cancellation, poisoned transport replacement |
| 5 | RC-06 | `21fcf9a0` | Fail-fast admission with a full join of already-started work |
| 6 | RC-01 | `800093ae` | Independent, bounded TypeScript index and semantic Worker lanes |
| 7 | RC-07 | `556e5bc5` | Deadline-bounded watcher drain and identity-safe external stop |
| 8–9 | RC-08, RC-09 | `b5c5cf22` | Atomic output quotas, linear page reads, and readable human pagination |
| 10 | RC-10 | `11894a56` | Versioned keyset reference pages with bounded source scanning and legacy-cursor compatibility |
| 11 | RC-11 | `41b4182a` | Canonical four-entry Rust session LRU with joined eviction and shutdown |
| 12 | Contracts and docs | owning commits plus `eb1cb748` | Public/API docs, setup guidance, and no-preemptive-page-size instructions reconciled with behavior |

`7d53d4b3` closes the only issue found by final whole-suite verification: the
watcher deadline test now uses an actual typed inert timer handle rather than a
double type assertion.

Final verification on 2026-07-27:

- `scip-query doctor`: OK; TypeScript and Rust graph, semantic, cleanup, and
  verification capabilities available.
- Cumulative `diff-impact` from `4945ec9b`: 23 changed source files, 200
  changed indexed symbols, and 10 returned affected-consumer files. Its
  command-level coverage is bounded/unknown, so this is an impact snapshot,
  not a claim that no additional transitive consumer exists.
- Every slice's self-hosted `diff-gate`: pass after fixes or narrow,
  reasoned committed suppressions. The RC-11 gate removed one genuinely dead
  test-only accessor and accepted two non-contractual co-change signals.
- `npm run lint`: pass, including formatting, ESLint, build, 72-path public
  TypeScript API compatibility, public consumer compilation, and skill-link
  validation.
- `cargo check --quiet --manifest-path Cargo.toml`: pass.
- `npm test`: 253 test files and 1,975 tests pass. This exceeds the audited
  baseline by 6 files and 41 tests.
- Focused adversarial regressions cover every attack in the table above,
  including descendant survival, missing/reused identities, teardown joins,
  late LSP responses, concurrent sibling quiescence, isolated mailbox lanes,
  stuck watcher close, concurrent snapshot admission, Unicode page
  reconstruction, producer scan bounds, and joined LRU eviction.
- `git diff --check`: pass. `HEY.md` remains ignored through
  `.gitignore:21`; no `skills/**` path was edited or staged by this program.

## Verdict

**IMPLEMENTED-COMPLETE**

- Confirmed findings repaired: 11 / 11
- Implementation slices completed: 12 / 12
- Registered adversarial attacks tested: 11 / 11
- Blocking verification failures: 0
- Known plan holes: 0
- Final suite: 253 files, 1,975 tests passing
