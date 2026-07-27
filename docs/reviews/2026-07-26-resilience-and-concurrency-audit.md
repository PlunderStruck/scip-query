# scip-query — Resilience and Concurrency Audit

Date: 2026-07-26
Audited revision: `0bc4af6d4563040fe8abaac70ea91a1d53155c1a`
Audited package version: `0.19.8`
SCIP generation: `9302312812b4` (fresh; 27,403 symbols in 388 indexed files)

Scope: the watch daemon and its TypeScript mailboxes, watcher shutdown, subprocess ownership, Rust semantic workers and rust-analyzer sessions, bounded-concurrency helpers, output and result pagination, caches, queues, timers, process locks, worker-thread signaling, and the native Rust crates.

Method: this was a read-only production-code audit. It applied the repository's `resilience` lens, `concurrency` lens, and `scip-audit` evidence discipline. Compiler-resolved `scip-query` results established symbol bodies and complete caller sets; narrow native reads established literal constants and test behavior; focused tests checked the current baseline; isolated disposable probes tested operating-system and Promise behavior. No sub-agents were used. No production code or test code was changed.

This report records **11 surviving findings**:

- **5 high-severity findings**: RC-01, RC-02, RC-04, RC-05, and RC-06;
- **6 medium-severity findings**: RC-03, RC-07, RC-08, RC-09, RC-10, and RC-11.

The findings describe allowed behavior in the audited revision. They do not claim that every failure has occurred in a user session. Where the current repository or an isolated probe supplied incidence evidence, the report says so explicitly.

---

## 1. Outcome

The system has strong coordination primitives around published generations, mailbox files, PID-reuse protection, Vue worker cleanup, frame-size limits, verified downloads, and single-flight watcher refreshes. The weakest boundaries are now narrower and more identifiable:

1. A TypeScript semantic or incremental-index request executes synchronously on the watch daemon's control-plane event loop. Its deadline is checked after the expensive call returns, so it cannot preserve heartbeats, shutdown responsiveness, or the other mailbox under a stalled computation.
2. Process owners terminate the process they spawned, not the process tree that work can create. This is demonstrably insufficient for indexers and worker-owned rust-analyzer processes.
3. Rust LSP request timeouts stop waiting without stopping the server's work. The reference path can immediately retry the same operation, so one timeout can create two simultaneous expensive computations.
4. Rust bounded-concurrency helpers are fail-fast but not fail-stop. After one lane rejects, sibling lanes continue dequeuing work while the caller unwinds, shuts down the client, or advances the durable worker queue.
5. Output pagination preserves every rendered character, but it does not bound total output bytes and it rereads the complete snapshot for every page. The transport can therefore turn a large answer into temporary-disk exhaustion or approximately quadratic continuation I/O.
6. Watch shutdown, Rust session caching, and `refs` result pagination each have finite ordinary-case behavior but retain an unbounded edge: a never-settling close, an unbounded session-key set, or complete result materialization before a limit is applied.

The most important cross-lens conclusion is that the CPU and orphan-process risks reinforce one another. A slow request can overrun its caller, the caller can retry while the original work continues, a worker timeout can discard only the worker thread, and a replacement worker can then create another rust-analyzer process. Each mechanism is independently bounded in one dimension, but the composition is not bounded end to end.

---

## 2. Terms, evidence grades, and severity

A **resilient operation** is a software operation that preserves a defined service boundary when a dependency becomes slow, silent, malformed, overloaded, or unavailable. The concrete referents here are reindex runs, semantic lookups, watcher loops, worker requests, and paginated output. What distinguishes a resilient operation from an ordinary successful call is enforced containment: failure consumes a bounded amount of time, memory, disk, queue capacity, and downstream work.

A **concurrent operation** is one of multiple computations whose lifetimes overlap, whether they run on separate CPU threads or merely interleave through asynchronous waits. The concrete referents here include worker-thread messages, parallel rust-analyzer requests, sibling Promise workers, watch callbacks, and separate CLI processes. Lifetime overlap—not simultaneous machine instructions—is what makes ordering and ownership necessary.

A **deadline** is an absolute latest completion point that prevents downstream work from outliving the time budget inherited from its caller. It differs from a post-hoc duration check because a real deadline can stop, cancel, or isolate work when the time is exhausted.

**Cancellation** is a state transition that causes work no longer needed by its caller to stop consuming the protected dependency. Rejecting a waiting Promise is not cancellation when rust-analyzer, a child process, or a sibling task continues running.

A **process tree** is one spawned process together with every descendant process it creates. It differs from a single child PID because shells, package managers, compilers, indexers, and language servers can delegate work to descendants that survive the original child's exit.

A **bulkhead** is an execution boundary that prevents one class of work from consuming another class's scheduler, memory, or failure budget. Separate worker processes for TypeScript indexing, TypeScript semantic queries, and watch control would be bulkheads because one stalled service could not stop the others' heartbeats or signal handling.

**Structured concurrency** is a lifetime rule under which a parent operation does not finish, fail, or hand shared resources to the next operation until all child operations have completed or acknowledged cancellation. It differs from `Promise.all` fail-fast behavior because `Promise.all` rejects without stopping or joining its remaining inputs.

**Backpressure** is an enforced admission rule that makes producers slow down or fail before accepted work exceeds consumer capacity. A mailbox item cap is backpressure for queued files; it is not a CPU budget for a handler that has already started.

Evidence grades:

- **Runtime-confirmed**: an isolated probe demonstrated the essential behavior using disposable processes or tasks.
- **Existing-test confirmation**: checked-in tests demonstrate the relevant behavior.
- **Source-confirmed ordering**: current code establishes every step and contains no ordering or cancellation edge that prevents the failure.
- **Source-confirmed capacity gap**: a resource can grow to an impractical platform limit or until external exhaustion because no operational limit is enforced.
- **Hardening gap**: an ordinary path is sound, but a named failure branch lacks a bounded guarantee.

Severity:

- **High** means one allowed failure can keep expensive work alive after its owner, block the watch control plane, duplicate dependency work, or violate isolation between requests.
- **Medium** means the primary result is recoverable unavailability, capacity amplification, cleanup debris, or a scale-dependent resource cliff.

---

## 3. Execution and ownership map

| Boundary | Owner and shared resource | Current ordering or limit | Audit result |
| --- | --- | --- | --- |
| Watch control plane | One Node event loop owns heartbeats, activity polling, refresh coordination, TypeScript index mailbox, TypeScript semantic mailbox, cache sweep, signals, and shutdown | Mailbox batch cap 16; per-request wall-clock deadline | Count is bounded; one synchronous handler can block every responsibility and overrun its deadline |
| Watch reindex child | `Watcher` owns a direct reindex child through `runBoundedProcess` | Timeout, TERM, KILL, bounded stdout/stderr, direct-child `close` | Direct child is bounded; descendants are not |
| Indexer children | Parallel indexer runner owns tool processes | Configured concurrency and 10-minute direct-child timeout | Tool wrappers and descendants can survive direct-child termination |
| Rust durable server | One helper process owns a Worker requester and a file mailbox | Mailbox quotas, request timeout, ten-minute clean-idle timeout | Server is bounded; forced Worker termination does not own rust-analyzer children |
| Rust Worker | One thread serializes messages and owns a map of rust-analyzer clients | Promise message queue, per-LSP request timers, batch concurrency default 8 | Request queue is serial only until a child Promise rejects; abandoned sibling tasks can overlap the next message |
| Rust LSP client | One client multiplexes request IDs over one rust-analyzer process | Per-request timer and frame byte limits | Response waiting is bounded; server computation is not cancelled |
| Vue workers | Parent owns every Worker and result file | Whole-pool deadline, bounded result bytes, awaited `terminate()` settlements | Strong control; use as the model for Rust Worker cleanup |
| Bounded mailbox | Files shared by clients and service processes | 1,024 items, 512 MiB total, 64 MiB/item, batch 16, five-minute lease | Strong queue backpressure; it cannot preempt a claimed synchronous handler |
| Output pagination | CLI process streams rendered output to a private snapshot | Page 12,000 chars by default; one-hour logical expiry | Page memory is bounded; total bytes and aggregate temporary storage are not |
| `refs` result pagination | Command reconstructs and sorts logical rows | Result `--limit` and cursor | Limit applies after complete materialization; every result-cursor page recomputes the complete set |
| Native Rust crates | No shared-memory primitives found | No `Atomic*`, `Mutex`, `RwLock`, channels, or thread-spawn sites in `crates/**/*.rs` | No native Rust data-race surface in the audited crates |

---

## 4. Detailed findings

### RC-01 — High — Synchronous TypeScript mailbox work can freeze the complete watch control plane

**Lenses:** resilience, concurrency, operability, blast radius.
**Evidence:** source-confirmed ordering; existing tests confirm only post-hoc expiry.

**Code and SCIP relationships:**

- `src/runtime/watch-server.ts:86-114` runs `processIndexRequests()` and then `processSemanticRequests()` synchronously in `runWatchServiceLoopIteration`.
- `src/runtime/watch-server.ts:121-392` gives that same loop responsibility for watcher refresh, heartbeats, activity polling, refresh requests, mailbox maintenance, cache sweeps, idle shutdown, and signal-observed shutdown.
- The complete SCIP reference set for `processTypeScriptIndexMailbox` contains only `src/runtime/watch-server.ts:31,292`.
- The complete SCIP reference set for `processTypeScriptSemanticMailbox` contains only `src/runtime/watch-server.ts:21,303`.
- `src/reindex/typescript-index-service.ts:163-234` invokes synchronous `host.handle(...)`, then reads the clock and rejects the result if the deadline has passed.
- `src/semantic/typescript/session-service.ts:159-234` has the same ordering.
- `TypeScriptIndexServiceHost.handle` advances a TypeScript document emitter and serializes fragments at `src/reindex/typescript-index-service.ts:70-107`.
- `TypeScriptSemanticServiceHost.handle` can build or synchronize the provider and compute imports, references, reference fragments, callees, or signatures at `src/semantic/typescript/session-service.ts:69-100`.

**Failure sequence:**

1. The watch loop claims up to 16 TypeScript index requests.
2. A claimed request is still before its deadline.
3. `host.handle` performs a long TypeScript program update, reference computation, or fragment serialization.
4. The JavaScript event loop cannot run the semantic mailbox, watcher callbacks, heartbeat persistence, cache maintenance, refresh coordinator, `SIGTERM` handler, or idle check during that call.
5. The caller can time out, but the daemon continues the computation.
6. The after-call deadline check discards the late result; it does not recover the time or control-plane availability already consumed.
7. An external `watch stop` waits two seconds and can report failure even though the live daemon is merely stuck inside the synchronous operation.

**Attempted refutation:**

- The batch cap of 16 bounds the number claimed in one poll, but it does not bound one handler's duration.
- `beforeRequest` records `busyUntil`, but telemetry does not interrupt work or keep the event loop responsive.
- The before-call deadline prevents already-expired work from starting. It does not enforce the deadline after work starts.
- `tests/semantic/typescript/typescript-session-mailbox.test.ts:156-190` and `tests/reindex/typescript-index-mailbox.test.ts:253-288` advance an injected clock and prove late-result rejection. They do not run a non-preemptible handler or prove concurrent heartbeat/shutdown progress.
- The 183-test focused suite passed, so this is not a regression exposed by current tests; it is a missing isolation guarantee.

**Consequences:**

- A semantic query can delay indexing, and an indexing request can delay semantic queries.
- A stalled dependency can make the daemon look stale while it remains alive.
- Shutdown and watcher responsiveness inherit the worst TypeScript computation time.
- Timed-out work still consumes CPU and can fill the bounded mailbox with later requests that expire before service.

**Recommended design:**

- Put the TypeScript incremental-index host and semantic host behind separate worker processes or Worker threads, leaving the watch control plane as a scheduler and heartbeat owner.
- Prefer processes when a hard deadline must terminate CPU-bound TypeScript work; a Worker thread is acceptable only if termination and child/resource cleanup are fully owned.
- Pass one absolute monotonic deadline into the isolated operation.
- On deadline, stop the worker, join its exit, reject the claim, and create a fresh host. Do not keep a host whose operation was forcibly interrupted.
- Poll at most one item per service turn or use a small time-slice budget so neither mailbox monopolizes scheduling even when requests are individually healthy.
- Keep mailbox item and byte quotas; isolation complements rather than replaces them.

**Required tests:**

- Block the index host beyond its deadline and prove semantic service, heartbeat writes, and `SIGTERM` observation continue.
- Block the semantic host and prove index requests continue.
- Prove a timed-out host process or Worker has exited before the claim is rejected and before a replacement accepts work.
- Saturate both mailboxes and assert a fairness bound for the oldest accepted request in each.

**Acceptance condition:** no TypeScript request can prevent the watch control plane or the other TypeScript service from making progress beyond a documented scheduling interval.

---

### RC-02 — High — Process deadlines terminate only the direct child, not the work's process tree

**Lenses:** resilience, blast radius, operability.
**Evidence:** runtime-confirmed; complete SCIP caller set.

**Code and SCIP relationships:**

- `src/platform/bounded-process.ts:120-291` spawns a direct child and calls `child.kill('SIGTERM')`, followed by `child.kill('SIGKILL')`.
- The optional `detached` field is passed to `spawn`, but termination never targets a POSIX process group or a Windows job object.
- The complete production reference set for `runBoundedProcess` is:
  - `src/reindex/indexer-runner.ts:166`;
  - `src/runtime/isolated-analysis-runner.ts:95`;
  - `src/runtime/watch.ts:685`;
  - plus their three imports.
- `tests/platform/bounded-process.test.ts:19-122` covers a direct child that ignores TERM, output overflow, cancellation, and direct-child reap. It has no grandchild fixture.
- The subprocess inventory also contains synchronous Git, package-manager, Java, compiler, release, and worker boundaries. Their finite `timeout` options likewise govern the process passed to Node, not descendants that process creates.

**Runtime probe:**

A disposable Node parent spawned a long-lived Node grandchild. The audit sent `SIGTERM` to the direct parent, awaited the parent's `close`, and then checked the exact grandchild PID. The result was:

```json
{"grandchildPid":58812,"aliveAfterDirectParentKill":true}
```

The probe then killed the exact disposable grandchild. No probe process was intentionally left running.

**Why the production call graph matters:**

- A watch-owned reindex child can start language indexers.
- An indexer command can be a wrapper that starts a compiler or language server.
- Isolated analysis can invoke commands that start semantic helpers.
- Reaping the wrapper therefore does not prove that CPU, file writes, or cache mutation stopped.

This mechanism is a plausible explanation for a user observing that the named scip-query command is gone while related CPU work continues. The audit did not establish that it caused a particular historical CPU incident.

**Recommended design:**

- Introduce one cross-platform process-tree owner used by every long-lived or deadline-bound subprocess.
- On POSIX, start an owned process group and signal the verified group, with direct-child `wait`/`close` as the final join.
- On Windows, assign the process and descendants to a Job Object configured for kill-on-close. The sidecar is an appropriate place for platform-specific ownership if Node cannot provide it safely.
- Preserve PID birth-identity checks for destructive external signals, but distinguish an externally discovered PID from a direct child handle the current process just spawned.
- Record termination outcome as direct child reaped, tree terminated, or tree ownership degraded.

**Required tests:**

- A direct child spawns one TERM-ignoring grandchild; timeout and abort must leave neither alive.
- Repeat through the indexer runner, watcher reindex runner, and isolated-analysis runner.
- Cover a wrapper that exits before its grandchild.
- Run equivalent POSIX process-group and Windows Job Object integration tests.

**Acceptance condition:** a bounded operation settles only after every process it started, directly or transitively, has exited or the result explicitly reports degraded tree ownership.

---

### RC-03 — Medium — `runBoundedProcess` can wait forever when escalation identity cannot be refreshed

**Lenses:** resilience, liveness.
**Evidence:** source-confirmed hardening gap.

**Code:**

- `src/platform/bounded-process.ts:99-111` allows KILL escalation only when the initial process identity is absent or a second identity lookup succeeds and matches.
- `src/platform/bounded-process.ts:165-170` runs that escalation check once.
- After that timer, settlement still depends exclusively on the child's `close` event.

**Failure sequence:**

1. Initial process identity lookup succeeds.
2. The child ignores TERM.
3. At escalation time, the process identity lookup transiently returns `null` even though the retained direct child is alive.
4. `shouldEscalate` returns false.
5. There is no second escalation attempt and no final reap deadline.
6. The function named and documented as bounded waits indefinitely for `close`.

**Attempted refutation:**

- On a healthy supported platform, a live direct child's start identity should normally remain readable.
- If the process already exited, Node should advance `exitCode` or `signalCode`, and `close` should follow.
- The branch therefore appears low-frequency.

Those facts reduce likely incidence; they do not restore a bound when process-table access fails transiently. The current function has no injected identity reader, so the checked-in tests cannot deterministically exercise this branch.

**Recommended design:**

- For a retained direct child, use the OS child handle or process-group/job ownership obtained at spawn so escalation does not depend on a second process-table lookup.
- If a platform cannot provide safe handle-based escalation, add a final ownership deadline that settles with `reaped: false` and an explicit degraded-lifecycle error instead of waiting forever.
- Make identity lookup injectable and report why escalation was withheld.

**Required tests:**

- Initial identity succeeds; escalation identity returns `null`; child ignores TERM.
- Initial identity succeeds; escalation identity mismatches.
- In both cases, the API must settle within a documented upper bound and must not signal an unrelated process.

**Acceptance condition:** every path through `runBoundedProcess` has a finite settlement bound, including identity-observation failure.

---

### RC-04 — High — Rust Worker termination does not join the Worker or reap its rust-analyzer child

**Lenses:** resilience, concurrency, process ownership.
**Evidence:** runtime-confirmed and source-confirmed ordering.

**Code and SCIP relationships:**

- `src/semantic/rust/lsp-session.ts:638-770` implements `createWorkerRustAnalyzerSessionRequester`.
- Its `terminate()` sets `worker = null`, calls `void currentWorker.terminate()`, and immediately removes `resultDir`.
- The requester installs no Worker `error` or `exit` listener.
- A timed-out request calls `terminate()` and throws; a later request can immediately create a replacement Worker.
- The Worker creates rust-analyzer with `spawn(binary, ...)` in `src/semantic/rust/lsp-client.ts:647-677`.
- Graceful Worker shutdown calls `shutdownSessions` at `src/semantic/rust/lsp-session-worker.ts:836-840`.
- `RustAnalyzerLspClient.shutdown` sends `shutdown`, sends `exit`, and returns without waiting for the transport's `close` event at `src/semantic/rust/lsp-client.ts:276-287`.
- The complete SCIP reference set for the Worker requester leads to the durable Rust server at `src/semantic/rust/durable-session-server.ts:176` and its default factory.

**Runtime probe:**

A disposable Worker spawned a long-lived Node child. The audit awaited `Worker.terminate()`—a stronger wait than production performs—and then checked the exact child PID:

```json
{"childPid":58446,"aliveAfterWorkerTerminate":true}
```

The audit sent `SIGKILL` to that exact disposable PID and subsequently confirmed it disappeared. The immediate post-kill liveness check briefly observed the terminating/zombie process, which is why a real owner must join process exit rather than equate signal delivery with cleanup.

**Failure sequence in production:**

1. rust-analyzer stalls beyond the synchronous Worker request timeout.
2. The parent initiates Worker termination but does not await it.
3. The parent deletes the result directory while the old Worker may still write its response.
4. The same requester can create a replacement Worker and replacement rust-analyzer.
5. Terminating the old thread does not terminate its spawned rust-analyzer process.
6. The old language server can survive without a Worker that owns its transport.

Even the graceful path lacks an exit join: the Worker reports shutdown after sending the LSP `exit` notification, not after the OS process closes.

**Recommended design:**

- Make Worker lifecycle completion an owned asynchronous operation, or move the Rust semantic owner into a helper process whose process tree can be synchronously controlled by the durable server.
- On graceful shutdown, wait for every Rust transport `close`; escalate through the process-tree owner if the server does not exit.
- Wait for the Worker `exit` event before removing result files or admitting a replacement.
- Install `error` and `exit` handlers that settle every pending request exactly once and preserve diagnostic cause.
- If the public requester must remain synchronous, use the shared-memory response only as a completion signal from an owner that has already joined its children; do not use unawaited `Worker.terminate()` as the ownership boundary.

**Required tests:**

- Use a fake rust-analyzer executable that remains alive after its Worker is terminated; prove requester timeout removes both.
- Delay a Worker response write while timeout starts; prove result-directory cleanup occurs only after Worker exit.
- Prove a replacement cannot be created until prior Worker and rust-analyzer ownership is resolved.
- Prove normal shutdown waits for the transport close, with TERM-to-KILL escalation for a server that ignores `exit`.

**Acceptance condition:** Worker timeout and shutdown leave no Worker, rust-analyzer process, descendant, result file, or pending error event after the requester reports completion.

---

### RC-05 — High — Rust LSP timeouts abandon server work and can immediately duplicate it

**Lenses:** resilience, cancellation, overload.
**Evidence:** source-confirmed ordering; existing tests codify non-cancellation.

**Code:**

- `RustAnalyzerLspClient.request` at `src/semantic/rust/lsp-client.ts:290-317` starts a timer. On expiry it removes the request from `pending` and rejects the Promise.
- It does not send LSP `$/cancelRequest`, stop the transport, invalidate the session, or wait for late completion.
- `dispatchMessage` at `src/semantic/rust/lsp-client.ts:411-432` ignores a late response because its pending entry is gone.
- `referencesWithCompletion` at `src/semantic/rust/lsp-batch-worker.ts:376-406` treats a request timeout as a reason to call `retryTimedOutReferenceLookup` immediately.
- `retryTimedOutReferenceLookup` at `src/semantic/rust/lsp-batch-worker.ts:408-421` issues the same references request again when a retry timeout is configured.
- `tests/semantic/rust/rust-lsp-client.test.ts:530-578` explicitly expects a stalled references request to time out while leaving the transport un-killed so shutdown can proceed.

**Failure sequence:**

1. rust-analyzer accepts expensive reference request A.
2. The client timer expires and removes A from `pending`.
3. rust-analyzer continues A because no cancellation was sent.
4. The retry path sends equivalent request B to the same server.
5. A and B can consume CPU concurrently or queue behind one another.
6. A late response is discarded; only B can affect the returned result.

The timeout bounds how long the JavaScript caller waits. It does not bound dependency work, which is the resource that matters during overload.

**Recommended design:**

- Send `$/cancelRequest` with the timed-out request ID before rejecting.
- Treat cancellation as best effort: if the server does not reach a known quiescent state within a short cancellation grace period, invalidate and terminate the session through the process-tree owner.
- Do not retry a timed-out expensive request on the same unproven session. Retry only after cancellation acknowledgment, quiescence, or fresh-session replacement, and cap retry from the caller's original absolute deadline.
- Record timeout, cancellation sent, late response, cancellation grace expiry, session invalidation, and retry as separate profile events.

**Required tests:**

- The scripted transport must observe `$/cancelRequest` with the original ID.
- A server that ignores cancellation must be terminated and replaced before retry.
- A late response after cancellation must not resurrect or satisfy another request.
- The sum of initial attempt, cancellation grace, and retry must not exceed the inherited deadline.

**Acceptance condition:** after a Rust LSP request times out, either the server acknowledges cancellation/quiescence or the owning session exits before equivalent work is retried.

---

### RC-06 — High — Fail-fast concurrency helpers let failed batches continue behind the caller

**Lenses:** concurrency, resilience, structured lifetimes.
**Evidence:** runtime-confirmed and source-confirmed ordering.

**Code and SCIP relationships:**

- `src/semantic/rust/lsp-batch-worker.ts:525-542` starts multiple async loops over one shared `nextIndex` and awaits them with `Promise.all`.
- Its complete SCIP reference set contains eight sites across the direct Rust batch worker and durable Rust session worker.
- `src/semantic/rust/lsp-session-worker.ts:113-115` serializes top-level messages with `queue = queue.then(...).catch(...)`.
- `runSessionRequest` uses the helper for references, callees, signatures, and import positions and can also run reference and callee batches in parallel.
- `runRustAnalyzerReferenceBatch` at `src/semantic/rust/lsp-batch-worker.ts:77-201` shuts down the shared client in `finally`.
- A structurally identical private helper exists at `src/reindex/indexer-runner.ts:260-280`. Its ordinary callback catches most tool failures, which reduces but does not eliminate the same lifetime defect for pre-try filesystem or callback errors.

**Why `Promise.all` is insufficient:**

When one worker Promise rejects, `Promise.all` rejects immediately. JavaScript does not cancel the other worker Promises. Their loops retain `nextIndex`, continue awaiting the shared rust-analyzer client, and continue taking unstarted items.

In the direct batch path, `finally` can begin client shutdown while sibling lanes still use that client. In the durable Worker path, `handleMessage` can catch the error, write an error response, and let the top-level message queue start the next request while old sibling lanes still run.

**Runtime probe:**

The audit executed the exact helper structure with four items and concurrency two. Item 0 rejected after about 10 ms; the sibling completed items 1, 2, and 3 after the parent had already observed rejection:

```json
{"rejectedAtMs":13,"startedAtReject":[{"item":0,"atMs":0},{"item":1,"atMs":0}],"completedAtReject":[]}
{"nextRequestStartedAtMs":14,"finalStarted":[{"item":0,"atMs":0},{"item":1,"atMs":0},{"item":2,"atMs":38},{"item":3,"atMs":75}],"finalCompleted":[{"item":1,"atMs":38},{"item":2,"atMs":75},{"item":3,"atMs":113}]}
```

This proves both facts that matter: the parent can advance at 14 ms, and abandoned sibling work can still dequeue new items through 75 ms.

**Attempted refutation:**

- Many ordinary Rust lookup errors are converted to empty or incomplete results inside per-item helpers.
- The most likely propagated failures are readiness-deadline failures, protocol/transport failures, mapping errors, or unexpected exceptions.
- Near a common absolute deadline, sibling timers may reject soon after the first lane.

Those conditions narrow the window but do not establish structured completion. The exact helpers have no stop-dequeue flag, abort signal, or all-settled join after failure.

**Recommended design:**

- On first failure, atomically record the primary error and stop every lane from taking another item.
- Propagate one `AbortSignal` to every cancellable item operation.
- Await `Promise.allSettled(workers)` before rejecting the parent.
- Preserve the first error as primary and aggregate cleanup/cancellation failures separately.
- Do not advance the Worker message queue or shut down/reuse the shared LSP client until the failed batch is fully drained.
- Centralize one tested structured-concurrency helper instead of retaining divergent copies.

**Required tests:**

- One lane rejects while another is blocked; assert no item after the already-started set begins.
- Assert the parent Promise does not settle until the blocked sibling acknowledges cancellation.
- Assert the next Worker message cannot start while any prior lane remains active.
- Assert direct-batch shutdown begins only after all lanes settle.
- Repeat for the indexer helper with a pre-try callback or filesystem failure.

**Acceptance condition:** a batch does not settle and shared resources are not reused or shut down until every lane has completed or acknowledged cancellation.

---

### RC-07 — Medium — A watcher subscription that never closes can wedge daemon shutdown indefinitely

**Lenses:** resilience, liveness, operability.
**Evidence:** source-confirmed ordering; existing tests demonstrate the open-ended wait.

**Code:**

- `Watcher.stop` at `src/runtime/watch.ts:211-233` records one `stopPromise` and enters draining.
- `Watcher.finishStop` at `src/runtime/watch.ts:436-474` awaits `Promise.allSettled` for every subscription close and retirement, then awaits every retirement closure again.
- No deadline bounds either await.
- `runWatchServiceServer` awaits `watcher.stop()` in `finally` before removing state and releasing the lock.
- `stopLiveWatchProcess` at `src/runtime/watch-service.ts:636-653` sends one graceful signal, polls for two seconds by default, and throws if the daemon remains alive. It does not perform identity-revalidated KILL escalation.
- `tests/runtime/watch.test.ts:354-405` deliberately proves stop stays unsettled until a deferred close and deferred reindex cancellation resolve.

**Failure sequence:**

1. A native or polling watcher enters a dependency failure mode and its `close()` Promise never settles.
2. The daemon receives SIGTERM and reaches `watcher.stop()`.
3. The stop Promise remains pending forever.
4. The daemon retains state, lock, watcher handles, and process lifetime.
5. The controller reports failure after two seconds but leaves the verified stuck owner running.

Retaining the lock is safer than advertising a false stop. The missing part is a bounded recovery path after that safe refusal.

**Recommended design:**

- Give each close and the aggregate drain an absolute shutdown deadline.
- After the deadline, persist a degraded reason and allow the top-level daemon to terminate so the operating system closes watcher descriptors.
- In the external controller, revalidate process birth identity immediately before TERM-to-KILL escalation and wait for actual exit before cleanup.
- Never delete the ownership lock merely because the graceful timer expired.

**Required tests:**

- A subscription `close()` returns a never-settling Promise.
- Internal shutdown must reach a documented fatal/degraded outcome in bounded time.
- External stop must revalidate identity, escalate, observe exit, and then clean state.
- An identity mismatch at escalation must fail closed without signaling.

**Acceptance condition:** a broken watcher implementation cannot keep the daemon alive beyond the documented graceful-plus-forced shutdown budget.

---

### RC-08 — Medium — Output pagination has no operational total-output or aggregate temporary-disk limit

**Lenses:** resilience, unbounded growth, overload.
**Evidence:** source-confirmed capacity gap; local observation.

**Code:**

- `src/runtime/output-pagination.ts:30` defines `MAX_TRACKED_OUTPUT_CHARACTERS = Number.MAX_SAFE_INTEGER`.
- `runWithCliOutputPagination` uses that value whenever the internal-only `maxOutputCharacters` option is absent.
- `registerCommandDescriptors` at `src/runtime/commands/command-registry.ts:15-80` never supplies `maxOutputCharacters`, so every public command receives the safe-integer default.
- `OutputSnapshotWriter` at `src/runtime/output-pagination.ts:419-491` synchronously writes every rendered byte to a private temporary file.
- `pruneExpiredOutputSnapshots` at `src/runtime/output-pagination.ts:588-598` removes files older than one hour only when another snapshot writer starts.
- There is no aggregate byte quota, snapshot-count quota, free-space reserve, or per-user admission check.

**What is bounded and what is not:**

- The in-memory page string is bounded.
- Cursor length and page size are bounded.
- Metadata reads are bounded.
- The complete rendered output, one snapshot's bytes, and the sum of unfinished snapshots are not operationally bounded.

A command will encounter filesystem exhaustion, process death, or another external limit long before it reaches `Number.MAX_SAFE_INTEGER`.

**Local observation:**

At audit time, the private snapshot directory contained 12 files totaling 107,365 bytes; the oldest was about 58 minutes old. This is not an active disk incident. It confirms that incomplete traversals leave resumable snapshot files until completion or later pruning.

**Recommended design:**

- Replace the safe-integer sentinel with an explicit per-command snapshot byte ceiling.
- Enforce aggregate per-user bytes and snapshot count under a lock or atomic reservation protocol.
- Refuse a new snapshot when the remaining filesystem reserve would fall below a safe threshold.
- Prune expired and abandoned temporary files before reservation, but do not rely on pruning as admission control.
- Let descriptors declare smaller output budgets for commands whose logical unit size is known.
- Keep the current abort cleanup on output overflow and surface the exact narrowing or result-pagination command.

**Required tests:**

- A command exceeding the production default cap aborts and removes temporary and metadata files.
- Multiple concurrent snapshots cannot collectively exceed aggregate quota.
- A crashed writer's `.tmp` file is reclaimed after expiry.
- Quota accounting survives process races and partial metadata publication.

**Acceptance condition:** one user or command cannot consume unbounded temporary storage through paginated output.

---

### RC-09 — Medium — Every output continuation rereads and rehashes the complete snapshot

**Lenses:** resilience, network/storage performance, overload.
**Evidence:** source-confirmed complexity.

**Code:**

- `captureOutputSnapshotPage` at `src/runtime/output-pagination.ts:488-543` opens the snapshot and starts `position` at zero.
- Its loop reads every byte through the file's final size into `OutputPageCapture`, even though only the requested page is retained.
- It recomputes the complete SHA-256 and character count for every continuation.

For total output `N` and page size `P`, approximately `ceil(N/P) - 1` continuations each read `N` bytes. Continuation I/O is therefore approximately `N²/P`, not `N`.

Illustratively, a 10 MiB answer at the 12,000-character default requires roughly 874 pages and on the order of 8.5 GiB of repeated snapshot reads. Exact bytes depend on UTF-8 character width. The agent instruction correctly requires reading every page, so the transport itself encourages this amplification when an answer is large.

**Attempted refutation:**

- Snapshot immutability and complete-hash validation prevent page mixing and are correctness strengths.
- A 1 MiB reusable buffer bounds memory.
- Ordinary outputs in this repository are much smaller.

Those controls do not alter the repeated-I/O growth rate.

**Recommended design:**

- Store a page or chunk index containing character offset, byte offset, byte length, and chunk hash while the initial stream is written.
- Read only the chunk range needed for the requested page.
- Validate immutable file identity and the requested chunk hash; retain the complete hash in metadata for whole-output identity.
- Alternatively store page-sized immutable chunks directly and make the cursor identify the next chunk.
- Preserve UTF-8 boundary handling in the writer so continuations do not need to rescan from byte zero to find a character offset.

**Required tests:**

- Instrument snapshot reads across all pages and assert total bytes read are linear in output size plus small metadata overhead.
- Cover multi-byte UTF-8 characters and surrogate pairs at every chunk boundary.
- Concurrent continuations must either return the same immutable page or fail with the existing restart instruction.

**Acceptance condition:** retrieving every output page performs `O(N)` total snapshot I/O, not `O(N × pages)`.

---

### RC-10 — Medium — `refs --limit` bounds returned rows only after complete reference materialization

**Lenses:** resilience, unbounded result sets.
**Evidence:** source-confirmed capacity gap; current-repository refutation of immediate incidence.

**Code:**

- `refs` at `src/queries/navigation/refs.ts:13-42` materializes definition rows, every graph/semantic reference site, Ruby reference sites, a dedupe set, and a final output array.
- `handleRefs` at `src/runtime/query-commands/direct-navigation.ts:55-98` calls `refs(...)`, sorts the complete array, and only then parses `--cursor` and `--limit` and slices the requested rows.
- A result cursor stores an offset and index generation, not a materialized snapshot or database key.
- Every `refs --cursor ...` invocation therefore recomputes and sorts the complete result set before applying its offset.

**Attempted refutation:**

- The current repository's top `fan-in -n 10` result was `ScipDatabase` with 176 indexed references. This is not a present capacity incident in scip-query itself.
- The global `--output-cursor` transport snapshots rendered output and does not rerun the command, so callers that paginate transport output rather than logical `refs` rows avoid repeated analysis.

The command contract still presents `--limit` as a bounded result mechanism, and high-fanout symbols in large monorepos can be orders of magnitude larger than this repository's top row.

**Recommended design:**

- Push ordering and keyset pagination into the indexed reference query.
- Use a stable key such as `(relativePath, line, tieBreaker)` bound to the retained generation handle.
- Obtain exact total count separately when needed; do not require all result objects to report it.
- Add bounded semantic-reference pagination or explicitly label semantic enrichment as complete-only when it cannot page.
- Consider deprecating the separate result cursor in favor of one producer-aware pagination contract if two cursor systems cannot offer consistent cost guarantees.

**Required tests:**

- Seed a high-fanout symbol and instrument rows scanned/objects constructed for `--limit 1`.
- The second page must not reconstruct the first page or sort the complete result.
- Results across page boundaries must have no omissions or duplicates.
- A generation change must reject the cursor.

**Acceptance condition:** the time and memory required for a bounded `refs` page scale with the requested page and indexed seek cost, not the complete reference count.

---

### RC-11 — Medium — Rust session caching is unbounded and its key is sensitive to manifest order

**Lenses:** resilience, concurrency, unbounded growth.
**Evidence:** source-confirmed capacity gap.

**Code:**

- `src/semantic/rust/lsp-session-worker.ts:110` declares one module-level `Map<string, RustAnalyzerSessionState>`.
- `sessionForPaths` at `src/semantic/rust/lsp-session-worker.ts:485-557` creates a new rust-analyzer client for every unseen key and stores it without a size or idle limit.
- `sessionKey` at `src/semantic/rust/lsp-session-worker.ts:851-853` serializes `{ binary, sessionRoot, linkedProjects }`.
- `cargoManifestsForDefinitions` at `src/semantic/rust/lsp-batch-worker.ts:306-330` preserves first-encounter order; it does not sort manifests.
- `rustAnalyzerSessionRoot` at `src/semantic/rust/lsp-batch-worker.ts:302-304` uses the project root whenever more than one manifest is present.
- Sessions are removed only on readiness invalidation or whole-Worker shutdown. The durable server's default clean-idle lifetime is ten minutes.

**Failure shape:**

For two manifests A and B:

- `[A]` and `[B]` create distinct single-project sessions;
- `[A,B]` creates a multi-project session;
- `[B,A]` produces the same semantic project set and same root but a different JSON key;
- further subsets in a larger workspace create more sessions.

Each entry owns a rust-analyzer process and an `openedPaths` set. The theoretical key space grows with manifest subsets and permutations, while the registry has no admission limit.

**Attempted refutation:**

- A single-crate project normally creates one key.
- Stable definition ordering can make repeated commands reuse the same key.
- The durable server eventually shuts down after clean idleness.

Those facts make the common case efficient, but multi-crate and multi-workspace repositories are first-class Rust configurations. The worker can retain every distinct session simultaneously for its full active lifetime.

**Recommended design:**

- Canonicalize linked projects with resolved-path dedupe and stable sorting before initialization and key construction.
- Prefer one session per Cargo workspace root when rust-analyzer can represent the requested linked projects in one stable configuration.
- Enforce a small session count and memory/process budget.
- Use LRU or idle eviction, but await graceful client close and process-tree reap before deleting an entry.
- Include current and peak session counts, rust-analyzer PIDs, evictions, and reuse in durable server status.

**Required tests:**

- `[A,B]` and `[B,A]` resolve to one key and one rust-analyzer.
- More distinct keys than the configured cap evict and fully reap the least-recently-used session.
- An in-flight session cannot be evicted until its request drains or cancels.
- Shutdown joins every session process before clearing the registry.

**Acceptance condition:** the number of simultaneous rust-analyzer processes has a small enforced bound independent of the number and ordering of prior query subsets.

---

## 5. Cross-lens cascade

The findings can combine into one overload sequence:

1. A high-cost query creates a TypeScript or Rust semantic request.
2. TypeScript can block the watch control plane; Rust can exceed an LSP timer without cancelling server work.
3. A Rust reference timeout can issue a duplicate retry on the same busy language server.
4. A sibling task failure can let the parent queue advance while old lanes continue.
5. The whole Worker wait can time out; the parent starts unawaited Worker termination and removes its response directory.
6. The rust-analyzer child survives Worker termination.
7. A later request starts a replacement Worker, another session, and potentially another rust-analyzer.
8. If output is very large, the caller can then consume unbounded snapshot disk and repeated continuation I/O while trying to retrieve every required page.

This is why fixing only caller timeouts would be insufficient. The corrective boundary must extend from request deadline through cancellation, child join, process-tree reap, and bounded result transport.

---

## 6. Candidates rejected or retained only as secondary evidence

### Controls that held

- **Worker response memory ordering:** `writeWorkerResponse` writes the response file synchronously before `Atomics.store` and `Atomics.notify`. A parent that reaches `Atomics.wait` late observes a nonzero value rather than losing the wakeup. No memory-ordering defect survived.
- **Vue worker lifecycle:** `awaitVueReferenceWorkers` awaits all termination settlements before deleting its result directory and aggregates cleanup failures. It is materially stronger than the Rust requester and should be reused as the lifecycle pattern.
- **Watcher refresh coalescing:** `Watcher.triggerReindex` has one in-flight operation, merges later triggers, and checks `stopped` before scheduling follow-up work. The reviewed state transitions did not expose a duplicate in-process reindex race.
- **Mailbox file coordination:** pending-to-inflight claims use atomic rename, owner identity, leases, stable operation keys, per-item and aggregate quotas, and maintenance. No new mailbox lost-update defect survived this pass.
- **Output snapshot identity:** snapshots use private per-user storage, UUID names, exclusive temporary creation, atomic metadata publication, invocation binding, complete output hashes, and final-page deletion. The findings concern resource bounds and read amplification, not page mixing.
- **Rust session replacement guard:** `discardRustAnalyzerSession` deletes a registry entry only if it still refers to the poisoned session. This prevents an older cleanup from deleting a replacement with the same key.
- **Native Rust shared memory:** no atomic, mutex, read/write lock, channel, or thread-spawn primitive was found in the native crates. Their audited risks remain parsing, FFI, and bounded-input concerns rather than data races.

### Secondary or lower-confidence observations

- The reindex indexer runner has the same unstructured `runWithConcurrency` form as the Rust helper. Its normal callback catches subprocess and output failures, so RC-06 treats it as secondary exposure rather than a separate finding.
- Module-level `WeakMap` caches and the one-entry source-strip cache are mutated only on a single JavaScript event loop and are bounded by object lifetime or one entry. They did not survive as concurrency findings.
- Process birth identities substantially reduce PID-reuse risk for external stop and preemption. RC-02 is different: it concerns descendants that never had ownership records.
- Health reported score 94/risk 97, but health coverage was bounded and total unknown. It was used as a routing hint, not as proof that unreported boundaries were clean.

---

## 7. Focused verification

The focused baseline suite passed:

```text
10 test files passed
183 tests passed
```

Suites:

- `tests/platform/bounded-process.test.ts`
- `tests/runtime/watch.test.ts`
- `tests/runtime/watch-service.test.ts`
- `tests/runtime/watch-server.test.ts`
- `tests/runtime/output-pagination.test.ts`
- `tests/semantic/rust/rust-lsp-client.test.ts`
- `tests/semantic/rust/rust-lsp-session-readiness.test.ts`
- `tests/semantic/rust/rust-durable-session.test.ts`
- `tests/semantic/typescript/typescript-session-mailbox.test.ts`
- `tests/reindex/typescript-index-mailbox.test.ts`

The green baseline establishes that the documented mechanisms coexist with the current intended behavior. It does not convert missing process-tree, cancellation, structured-join, aggregate-quota, or hard-deadline assertions into guarantees.

---

## 8. Recommended remediation order

1. **Process and Worker ownership:** RC-02 and RC-04. Introduce one process-tree owner, make Rust Worker exit joinable, and prove no language-server child survives timeout or shutdown.
2. **Watch control-plane isolation:** RC-01 and RC-07. Move TypeScript work behind bulkheads and make daemon shutdown bounded with identity-safe escalation.
3. **Rust cancellation and structured concurrency:** RC-05 and RC-06. Cancel timed-out LSP work, stop dequeue on first failure, and join every lane before reuse or shutdown.
4. **Output capacity:** RC-08 and RC-09. Add per-snapshot and aggregate quotas, then make full traversal linear in snapshot bytes.
5. **Rust session capacity:** RC-11. Canonicalize keys and add joined LRU/idle eviction.
6. **Producer-aware result pagination:** RC-10. Push `refs` ordering and keyset limits into the indexed query.
7. **Bounded-process terminal branch:** RC-03. Remove the transient identity-read path that can make a bounded API wait forever, or return an explicit finite degraded result.

Slices 1 through 3 should be treated as one lifecycle program even if they land in separate commits. Their shared invariant is: after a request has timed out or failed, no prior computation, Worker, process, descendant, response write, or sibling task remains active when replacement work starts.

---

## 9. Completion criteria for the remediation program

The resilience and concurrency program is complete only when all of the following are mechanically tested:

- every external operation inherits one absolute deadline;
- deadline expiry initiates cancellation of dependency work, not only caller rejection;
- every spawned process tree and Worker is joined before ownership is released;
- no failed parallel batch settles before every lane stops or drains;
- watch heartbeats and signals remain responsive during semantic and indexing work;
- watcher shutdown reaches a finite stopped or identity-safe forced-exit outcome;
- accepted queue work, active sessions, output bytes, snapshot count, and continuation I/O all have enforced limits;
- result pagination limits producer work as well as rendered output;
- metrics expose current and peak active work, cancellation, forced termination, late responses, orphan prevention, session count, snapshot bytes, and quota rejections.

Until those properties hold together, the system has several strong local bounds but no complete end-to-end bound from agent command to dependency cleanup.
