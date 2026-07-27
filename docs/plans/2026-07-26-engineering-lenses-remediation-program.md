# Engineering-Lenses Remediation Program

Date: 2026-07-26
Status: approved for implementation
Source review: `scip-query-engineering-lenses-peer-review-2026-07-26.md`

## Goal

Resolve every confirmed finding from the engineering-lenses review without weakening
SCIP evidence, losing work, deleting an artifact that a live reader can still use, or
changing a public behavior silently.

The implementation is complete only when:

- each of the sixteen findings has a focused regression test;
- the focused baseline remains green (141 tests passed before implementation);
- the full test, typecheck, lint, build, public-API, generated-doc, and diff-gate checks
  pass, or a pre-existing failure is isolated and recorded with reproducible evidence;
- watcher bursts no longer produce effectively continuous rebuilds under default
  settings;
- retained local generations have a visible, enforced bound while live readers remain
  protected;
- no command can claim complete evidence by summing unrelated arrays;
- ambiguous symbol resolution is distinguishable from an exact empty result;
- status output states when its activity history is incomplete;
- no files under `skills/**` are changed by this program.

## Essential concepts

A **refresh burst** is a group of filesystem changes belonging to one editing episode,
distinguished from unrelated later work by a shared quiet-time or minimum-spacing
window. Coalescing a refresh burst means turning those many notifications into one
reindex while still guaranteeing that the final dirty state is eventually indexed.

A **local generation** is one immutable SQLite artifact directory beneath the
project-local generation store, distinguished from other directories by the digest
that identifies the exact indexed bytes it contains. Immutability permits readers to
keep using an older generation while publication atomically selects a newer one.

A **reader lease** is a process-owned protection record for one immutable generation,
distinguished by a verifiable process identity and a bounded heartbeat. Its causal
purpose is to prove that deletion is unsafe while a live process can still open or
read the protected files.

An **invocation-coverage contract** is command-owned accounting for the result units an
agent must inspect before making a complete claim. It differs from transport
pagination: transport pagination says whether all bytes were delivered, while
invocation coverage says whether the semantic units defined by that command were
examined.

An **activity-confidence state** is a classification of how much of the reindex ledger
was successfully read and decoded. `complete` means every selected record was usable,
`partial` means status is based on a known subset, and `unavailable` means no reliable
activity summary could be formed.

An **operational root** is an executable module invoked by a package script, binary
entry, worker launcher, or process boundary rather than imported by another source
file. Its absence from the source reference graph is evidence of how it is launched,
not evidence that changing it is low risk.

## Pre-registered evidence

- The index was fresh before planning; the watcher was running and idle.
- No manual reindex was required.
- The focused baseline passed 12 files and 141 tests.
- SCIP evidence confirmed the production consumers of `Watcher`,
  `promoteReindexArtifacts`, both TypeScript mailbox processors, and the watch server.
- SCIP reported `runWatchServiceServer` as a high-complexity orchestration boundary and
  incorrectly assigned its entrypoint file low change risk because it has no source
  importers.
- Live status showed 901 reindex runs in 24 hours, 542 rebuilt, 359 reused, 19
  suppressed, and 30.9 GB of logical output.
- The peer review observed 278 retained local generations occupying about 11 GB.
- Pagination itself is a control that already works and must not regress.
- Diff-gate execution already has outer containment; this program improves attribution
  when an inner detector fails to yield.

## Premises

P1. A watcher remains correct only if it has at most one active reindex and guarantees
one later run whenever changes arrive during that reindex.

P2. The existing cooldown option is the narrowest reusable control for spacing rebuild
starts. An explicitly configured zero remains a supported opt-out; the default may be
made protective.

P3. A published immutable generation may be deleted only after proving that it is not
current, not the rollback predecessor, and not protected by a live reader.

P4. Shared-generation lease and process-identity code already establishes the
repository's model for distinguishing a live owner from an abandoned lease. Local
retention should reuse that model instead of inventing an incompatible ownership
system.

P5. Mailbox directory creation is initialization, not polling work. Repeating it during
an idle poll is avoidable filesystem traffic.

P6. A deadline is a boundary promise checked at the last safe moment before execution.
Checking only once before a batch cannot uphold that promise for later items.

P7. Replacing a native watcher transfers ownership of an asynchronous close operation.
Discarding its promise makes close failure and overlap invisible.

P8. Command descriptors know which returned fields are semantic result units. A
generic traversal of arbitrary arrays does not.

P9. “No methods” is a fact about one exact symbol. It cannot be concluded from a
same-named candidate chosen without exposing ambiguity.

P10. Watch heartbeat and telemetry files are observations, not publication authority.
Atomic visibility is required; forcing stable storage for every one-second update is
not.

P11. A redundant SQLite index consumes bytes and write work without creating a new
access path. Removal is justified only after query-plan tests show the retained index
serves the relevant predicates.

P12. A least-recently-used cache must record accesses, not only writes. The write
frequency of that record must nevertheless be bounded so reads do not become a new
contention path.

P13. A timeout can identify an uncooperative detector only if detector start and
completion progress cross the worker boundary before the worker finishes.

P14. A service loop is testable when one iteration's clock, mailbox, persistence, and
wait boundaries can be injected and observed without starting a real daemon.

P15. Status is trustworthy when it reports the limits of its evidence. Silently
discarding malformed activity records creates false precision.

P16. Change risk includes operational launch surfaces and external consumers; source
reference count alone is not a complete proxy.

## State-authority inventory

| State                       | Authoritative writer                     | Readers               | Transition rule                                                   |
| --------------------------- | ---------------------------------------- | --------------------- | ----------------------------------------------------------------- |
| Watch dirty/running state   | `Watcher` instance                       | watch command/server  | one active run; dirty work schedules a successor                  |
| Current local generation    | publication pointer                      | database open/status  | atomic pointer change after complete artifact publication         |
| Local reader protection     | database-open lifecycle                  | local GC/status       | acquire before use; release after close; reclaim only dead owners |
| Mailbox request ownership   | atomic claim/rename                      | one service processor | execute only after live deadline check                            |
| Watch service authority     | service state transition writer          | status/stop/start     | transition records durable; heartbeat observational               |
| Shared evidence recency     | cache access path                        | maintenance eviction  | bounded access touch precedes LRU selection                       |
| Diff-gate detector progress | worker immediately before/after detector | timeout parent        | last-started and last-completed records are monotonic             |
| Reindex activity summary    | append ledger plus tolerant reader       | status                | corrupt input downgrades confidence and increments counters       |

## Reuse audit

Reuse:

- `Watcher`'s existing debounce, cooldown, dirty, and active-run state;
- shared-generation process identity, lease validation, and GC decision patterns;
- existing atomic JSON writers with durability/visibility modes;
- descriptor-owned `AgentContract` metadata;
- exact symbol-match and ambiguity-reporting primitives;
- SQLite schema migration and query-plan test helpers;
- current diff-gate profiling/progress channels;
- existing fake clocks and temporary mailbox/generation fixtures.

Do not introduce:

- a second watcher scheduler;
- a second process-liveness format;
- a command-independent coverage heuristic;
- a separate status database;
- a cache-maintenance daemon;
- a broad rewrite of the watch server.

## Dependency graph

The following ordering is real:

```text
EL-02 reader safety ──> EL-14 local-generation status
EL-10 access recency ─> EL-11 eviction index
EL-06 result contract ─> truthful coverage for every converted command
```

All other slices may be implemented and verified independently.

## Implementation slices

### Slice 1 — EL-01: Bound default watcher rebuild frequency

Change the default watcher cooldown to a documented protective interval while
preserving an explicitly configured zero. Keep leading responsiveness and guarantee a
trailing rebuild for changes that occur during the interval or during an active run.

Files:

- `src/watch/watch.ts`
- watcher option/configuration call sites
- watcher tests and README/configuration documentation

Tests:

- a large serial burst produces a bounded number of rebuilds;
- a change during an active run produces exactly one successor;
- explicit cooldown zero preserves immediate scheduling;
- stopping cancels pending timers and never starts later work.

Deployable result: yes.

### Slice 2 — EL-02: Protect readers and garbage-collect local generations

Acquire a local reader lease when a resolved generation is opened and release it when
the database closes. Add bounded retention that protects current, predecessor, and
live-reader generations, and that recognizes abandoned leases using the repository's
process-identity rules. Collection must be lock-safe and idempotent after crashes.

Files:

- `src/storage/sqlite-generation.ts`
- `src/storage/db.ts`
- `src/reindex/sqlite-generation-store.ts`
- local generation and database lifecycle tests

Tests:

- current and predecessor survive pressure;
- an old generation with a live reader survives;
- it becomes collectable after close;
- a dead-owner lease is reclaimed;
- a collector crash can be retried without losing a protected generation;
- two collectors cannot violate the retained bound or protection invariant.

Deployable result: yes, with conservative defaults.

### Slice 3 — EL-03: Remove idle mailbox syscall amplification

Initialize mailbox directories once per processor lifecycle, remove nested
initialization from polling helpers, and back off idle polling without delaying active
drain. Keep request claiming filesystem-atomic.

Files:

- `src/storage/bounded-mailbox.ts`
- TypeScript index/semantic service loops
- Rust mailbox loop where the same initialization pattern exists
- mailbox tests

Tests:

- repeated empty polls perform no repeated directory creation;
- idle polling backs off to the documented ceiling;
- arrival resets backoff and drains promptly;
- shutdown interrupts waiting;
- both TypeScript services share the same behavior.

Deployable result: yes.

### Slice 4 — EL-04: Enforce mailbox deadlines per request

Inject a clock and read it immediately before and after each claim. Never execute a
request whose deadline expires while an earlier item is handled.

Files:

- TypeScript mailbox processors and tests

Tests:

- the first handler advances time and the second request expires without execution;
- a request expiring between listing and claim does not execute;
- a live request executes once;
- Rust's existing correct semantics remain green.

Deployable result: yes.

### Slice 5 — EL-05: Own and observe native-watcher shutdown

Track the closing native subscription when falling back after `EMFILE`. Await or drain
it at a defined ownership boundary, surface close failure as degraded telemetry/error,
and make overlap explicit.

Files:

- `src/watch/watch.ts`
- watcher lifecycle tests

Tests:

- fallback records and awaits native close;
- close rejection is observed;
- stop waits for both current and retiring subscriptions;
- no post-stop callback schedules work.

Deployable result: yes.

### Slice 6 — EL-06: Make invocation coverage descriptor-owned

Replace arbitrary-array counting with a command contract that extracts semantic result
units. Record resolution completeness separately from result transport and evidence
coverage. Reject newly registered object-returning commands without an explicit
contract.

Files:

- command descriptor types/registry
- `src/runtime/command-kit/command-execution.ts`
- contract and command-accuracy tests
- generated command reference

Tests:

- `code` counts one resolved definition, not nested arrays;
- paginated relationship commands count their declared rows;
- ambiguous and missing resolutions cannot report complete semantic coverage;
- the registration gate rejects an object command without a contract.

Deployable result: yes; public output additions remain backward compatible.

### Slice 7 — EL-07: Preserve method-query ambiguity

Resolve an exact symbol identity or return an explicit ambiguous result with
candidates. Distinguish exact-zero-methods from missing and ambiguous symbols.

Files:

- `src/queries/navigation/methods.ts`
- navigation command formatting and tests

Tests:

- exact class with no methods is complete and empty;
- ambiguous short name returns candidates and is incomplete;
- missing symbol is explicit;
- fully qualified identity selects the intended symbol.

Deployable result: yes.

### Slice 8 — EL-08: Separate durable authority from visible telemetry

Keep publication/transition authority durably synced. Write one-second heartbeat and
rich telemetry atomically but without a forced storage flush. Apply the same
classification to Rust session telemetry where relevant.

Files:

- watch-service state/persistence modules
- Rust session persistence if it writes equivalent observational records
- persistence tests

Tests:

- authority transitions invoke durable sync;
- heartbeat/telemetry do not;
- either write is atomically visible;
- partial temporary files are ignored/recovered.

Deployable result: yes; no CLI UX change.

### Slice 9 — EL-09: Remove redundant SQLite indexes

Drop the explicit `global_symbols(symbol)` index already covered by the unique
autoindex. Remove the chunk prefix index only if `EXPLAIN QUERY PLAN` proves the
retained composite index serves every production predicate.

Files:

- SQLite schema/migration
- schema fixtures and query-plan tests

Tests:

- symbol lookup uses the unique autoindex;
- document chunk lookup uses a retained index;
- migration works for an existing database;
- schema no longer creates byte-for-byte redundant structures.

Deployable result: yes; database artifacts rebuild through existing schema identity.

### Slice 10 — EL-10: Implement actual bounded-cost LRU access semantics

Record a coarse or sampled last-access touch when shared evidence is read. Coalesce
touches so repeated hot reads cause bounded writes. Eviction uses access recency, not
creation/write recency.

Files:

- `src/storage/evidence-cache.ts`
- cache tests

Tests:

- reading an old item before pressure keeps it over an untouched newer item;
- repeated reads within the touch interval cause at most one metadata write;
- a failed touch does not make the evidence read fail;
- concurrent reads preserve a valid timestamp.

Deployable result: yes.

### Slice 11 — EL-11: Index the eviction order

Add an index whose leading keys match the maintenance eviction predicate/order, then
assert the planner uses it. Keep deletion batched and bounded.

Files:

- evidence-cache schema/migration
- maintenance tests

Tests:

- `EXPLAIN QUERY PLAN` selects the eviction index;
- maintenance deletes the correct least-recent units;
- a large fixture is processed in bounded batches;
- migration preserves existing evidence.

Deployable result: yes.

### Slice 12 — EL-12: Name the detector active at diff-gate timeout

Publish detector start and completion progress to the parent before each detector
runs/after it returns. Include the last-started and last-completed identities in a
timeout error.

Files:

- `src/runtime/diff-gate-execution.ts`
- worker/progress protocol
- diff-gate tests

Tests:

- a non-yielding detector times out with its name;
- a completed predecessor and active successor are both reported correctly;
- stale progress from an earlier run is not attributed;
- successful output remains unchanged except additive timing metadata if documented.

Deployable result: yes.

### Slice 13 — EL-13: Extract a watch-loop test seam

Extract one watch-server iteration or a small runtime object with injected clock,
mailbox processors, persistence, and wait. Preserve orchestration order and public
behavior; do not redesign the daemon.

Files:

- `src/runtime/watch-server.ts`
- watch-server tests

Tests:

- one iteration processes the expected mailboxes and persists state;
- an idle iteration waits through the injected boundary;
- processor failure records degraded state and preserves cleanup;
- shutdown exits without another iteration.

Deployable result: yes.

### Slice 14 — EL-14: Report local-generation retention in status

Add count, physical/logical bytes, oldest age, protected count, collection thresholds,
last GC outcome, and a reason when collection is disabled/deferred.

Files:

- local generation inventory helper
- status model/formatter and tests
- README/status documentation

Tests:

- healthy bounded inventory;
- over-threshold inventory with live protections;
- absent/corrupt generation directory degrades status without crashing;
- byte/count/age calculations use deterministic fixtures.

Deployable result: yes; additive status output.

### Slice 15 — EL-15: Expose reindex-ledger confidence

Count read, decode, validation, and write failures. Return `complete`, `partial`, or
`unavailable`, including invalid/skipped counts. Preserve status availability.

Files:

- `src/reindex/reindex-activity.ts`
- status model/formatter and tests
- activity documentation

Tests:

- valid ledger is complete;
- malformed tail and malformed interior records are partial with exact counts;
- unreadable ledger is unavailable;
- a valid subset still produces bounded metrics;
- append failure is surfaced to the caller/telemetry.

Deployable result: yes; additive status output.

### Slice 16 — EL-16: Account for operational roots in change-surface risk

Separate external-consumer risk from aggregate change risk, or add operational-root
evidence to the latter. Discover roots from package binaries/scripts and known worker
launch conventions. Explain risk factors in output.

Files:

- `src/queries/impact/change-surface.ts`
- package/entrypoint metadata helper
- change-surface tests and command reference

Tests:

- `watch-server.ts` is an operational root and not low risk solely for zero importers;
- an internal leaf remains low when no other factor applies;
- an exported API and an operational root show distinct reasons;
- unknown metadata cannot falsely lower risk.

Deployable result: yes; additive/explanatory output.

## Adversarial attack record

| Attack                                           | Initial exposure                               | Repair required by plan                                     |
| ------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------- |
| Continuous edits never become quiet              | debounce alone may starve trailing work        | minimum start spacing plus persistent dirty successor       |
| Explicit zero silently changes meaning           | default change could override operators        | distinguish absent option from configured zero              |
| GC deletes the database beneath a reader         | immutable readers outlive publication          | acquire/release reader lease around database lifecycle      |
| PID reuse makes a stale lease look live          | PID alone is not identity                      | reuse process birth/identity validation                     |
| Collector crashes after selecting victims        | partial deletion leaves inconsistent metadata  | idempotent per-generation deletion and recomputed inventory |
| Second mailbox item expires during first handler | batch clock is stale                           | fresh clock immediately before/after claim                  |
| Native watcher close rejects                     | discarded promise becomes unhandled/invisible  | tracked retirement promise and degraded error path          |
| Nested arrays inflate command coverage           | generic traversal confuses shape with evidence | descriptor-owned unit extractor                             |
| Same-named class has no chosen identity          | first match fabricates exact emptiness         | ambiguity candidates and incomplete result                  |
| Heartbeat fsync saturates disk                   | observational data treated as authority        | visibility-atomic, non-durable heartbeat                    |
| “LRU” writes on every hot read                   | correctness fix creates contention             | coarse/sampled touch                                        |
| Eviction query sorts the whole cache             | no compatible index                            | plan-tested eviction index and bounded batch                |
| Worker blocks the event loop forever             | in-memory progress cannot escape               | progress channel written before detector invocation         |
| Refactor changes watch-loop order                | broad extraction creates semantic drift        | characterize order, extract only one iteration boundary     |
| Corrupt ledger looks like complete history       | tolerant parser drops evidence silently        | confidence state and exact error counters                   |
| Executable entrypoint has no importers           | graph heuristic labels it low risk             | operational-root factor with explicit reason                |

## Coverage matrix

| Invariant                                             | Source test                | Integration test           | Failure test                    |
| ----------------------------------------------------- | -------------------------- | -------------------------- | ------------------------------- |
| One active watcher rebuild and eventual trailing work | watcher scheduler          | watch command/server       | stop/close races                |
| No protected generation deleted                       | lease/GC units             | open DB across publication | dead PID, crash, dual collector |
| No expired request executes                           | mailbox processor          | both TS services           | clock advances mid-batch        |
| Coverage is semantically truthful                     | descriptor contracts       | representative commands    | ambiguous/missing resolution    |
| Durable writes reserved for authority                 | persistence classification | watch state lifecycle      | partial write/recovery          |
| Eviction is access-recency ordered and indexed        | cache units/plan           | maintenance pressure       | touch failure/concurrency       |
| Timeout attributes active detector                    | progress protocol          | diff-gate worker           | non-yielding detector           |
| Status states its evidence limits                     | summary/inventory units    | formatted status           | corruption/unreadable files     |
| Risk recognizes launch surfaces                       | root discovery             | change-surface command     | missing metadata                |

## Documentation and compatibility

Update the README and command reference for:

- protective watcher defaults and explicit zero override;
- local-generation retention/status fields;
- additive activity confidence fields;
- exact/ambiguous method resolution;
- additive change-risk reasons;
- descriptor-defined completeness terminology.

No command name or positional argument changes are planned. Additive JSON fields follow
the existing API-evolution policy. Any unavoidable output-shape change must receive a
fixture update and explicit compatibility note before implementation proceeds.

## Verification

After each slice:

1. run the narrowest focused tests;
2. inspect the working tree for concurrent edits;
3. let the existing watcher refresh the index;
4. use SCIP references/affected/diff evidence for completeness;
5. do not manually reindex unless status proves the index stale and the watcher cannot
   refresh it.

At program completion:

- focused regression suites;
- full `vitest`;
- typecheck;
- lint;
- build;
- public API snapshot/check;
- generated documentation check;
- `scip-query status`;
- paginated `scip-query diff-gate` until its evidence is complete.

## Implementation completion

**IMPLEMENTED-COMPLETE.** All sixteen confirmed findings were implemented as bounded
slices with regression coverage. The chunk prefix index was removed only after query
plan tests proved that the retained composite index covers every production lookup.

Final verification:

- the full Vitest suite passed: 247 test files and 1,934 tests;
- TypeScript typechecking, formatting, ESLint, build, public API consumer checks, and
  skill-link checks passed through `npm run lint`;
- the public TypeScript API matches baseline `90000d70704eaf23` across 72 paths; the
  unchanged `DiffGateCheck` union relocation is recorded as a compatible correction;
- the fully paginated `scip-query diff-gate --full` completed with exit code 0, all
  nine checks run, and zero blocking or advisory findings;
- the storage and query-internal architecture scopes have no forbidden dependency
  edges and no cycles; and
- `skills/**` remained untouched so concurrent skill work was preserved.
