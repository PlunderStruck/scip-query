# Large-repository edit latency and multi-worktree indexing

## Outcome

An ordinary source edit in a large repository derives the next immutable SCIP generation from the accepted generation, the exact changed paths, and the affected dependency closure. It does not enumerate or hash every repository file, rebuild every project shard, or restart every compiler session. Multiple worktrees share only an immutable clean repository base; each worktree keeps its uncommitted edits in a private overlay and publishes one atomic local SQLite generation.

This plan is the edit-latency continuation of [Persistent Incremental Index and Cache Lifecycle](./2026-08-05-incremental-index-and-cache-lifecycle.md). It narrows the remaining performance work without weakening that plan's correctness and publication conditions.

## Terms and referents

An **edit journal** is an ordered record of filesystem changes observed after one accepted index generation. Its real referents are watcher events such as adding, changing, deleting, or renaming `src/a.ts`. What makes it useful is that it preserves the exact paths and change kinds needed to derive the next state instead of collapsing them into a message such as `multiple changes`.

A **base generation** is an immutable repository index for one exact committed Git tree and indexing configuration. Its real referents are the accepted `.scip`, SQLite, metadata, and evidence-product files published for that tree. What distinguishes it from mutable cache state is that any worktree can read it, but no worktree can alter it.

A **worktree overlay** is a private derived index generation containing the effects of one worktree's uncommitted files on a base generation. Its real referents are the local metadata, patched SQLite generation, and compiler fragments beneath that worktree's cache identity. What makes it an overlay is that it records only divergence while preserving the base as its immutable parent.

An **invalidation closure** is the set of indexed documents whose facts can change because of an edit. Its real referents are the changed documents plus documents that directly or transitively depend on them. What distinguishes it from a shard is that membership follows proved dependency edges, not an arbitrary fixed partition count.

A **compiler session** is a live language-service process that retains a parsed program for one compiler configuration. Its real referents are the TypeScript worker and its `Program` state for a `tsconfig`. What makes it a session is the retained compiler state across edits; it is bounded by memory and idleness rather than restarted after every request.

A **soft memory mark** is a preventive resource threshold below the worker's fatal heap limit. Its real referents are the configured byte count and the V8 isolate's measured heap use after a response. What makes it preventive is that crossing it completes the current durable response and then retires the worker before a later request adds more retained compiler state.

A **cold worker retry** is a bounded recovery attempt that replays one unchanged request after its failed worker has fully terminated. Its real referents are the same mailbox claim, operation identity, deadline, and request payload sent to one newly created worker. What distinguishes it from a new indexing operation is that it cannot publish or settle independently; either the replay settles the original claim once or the caller receives the terminal failure.

## Invariants

1. The accepted SQLite generation remains the one query surface. Internal fragments, base generations, and overlays never become independently queryable partial indexes.
2. Incremental work is allowed only when the edit journal begins at the accepted generation and its observation is complete. Existing-source changes, additions, deletions, and rename-shaped delete/add pairs can update the fingerprint directly. Watcher errors, unknown event kinds, incompatible metadata, configuration or ambient changes, toolchain changes, and paths outside known compiler inputs take the named conservative full path.
3. Publication is staged and atomic. Interruption before promotion leaves the prior generation accepted; failed validation discards the candidate.
4. Dependency evidence is carried forward while the publication owner still holds the reindex lock, before another refresh can plan. A failed cache write is reported and makes the next graph consumer reconstruct the product; it never publishes stale dependency evidence as a hit.
5. A clean base may be shared by worktrees. Dirty overlays, watcher journals, compiler processes, and mutable generation leases remain scoped to one worktree.
6. Project boundaries follow compiler configuration. Invalidation follows dependencies. Stored output follows document identity. No fixed shard count is part of correctness.
7. Memory budgets evict or retire idle compiler sessions; they never silently replace an incremental request with an unreported whole-project rebuild.

## Baseline recorded before edits

- Repository index: 482 documents, 37,500 symbols, approximately 30.76 MB of SQLite/index artifacts.
- Observed three-document TypeScript edit: 10,521 ms total incremental materialization; 1,468 ms in the TypeScript producer/service, 405 ms conversion, and 299 ms SQLite patching. Approximately 8.35 seconds therefore remains outside those named phases and is the primary investigation target.
- Existing focused gate: 64 tests across watcher request handling, project fingerprints, and file dependency products pass in 1.06 seconds Vitest time / 1.66 seconds wall time.
- The existing working-tree change raising the TypeScript worker old-generation heap default to 8 GiB is user-owned. This program preserves it and measures around it.

## Execution program

### Step 1 — Preserve structured changes to the reindex boundary

- **Source**: `Watcher.startSourceWatcher`, `Watcher.handleFileChange`, `Watcher.scheduleReindex`, `Watcher.reindexRequest`, `resolveReindexWorkerLaunch`, and `src/reindex/worker.ts`.
- **Change**: Add a versioned change-journal request containing base generation, completeness, ordered/coalesced path entries, and add/change/delete kind. Serialize it through the worker environment. Keep `RefreshTrigger` as human-facing cause metadata instead of using it as the machine invalidation input.
- **Preserve**: Debounce, rebuild-budget enforcement, cancellation, dirty-during-run follow-up, public runner injection, and existing trigger messages.
- **Retire**: Incremental decisions inferred from `RefreshTrigger.detail` and loss of path identity when triggers merge.
- **Prove**: Watcher tests cover coalescing, a change during an active run, source-watcher failure marking the journal incomplete, environment round-trip, and legacy requests with no journal.

### Step 2 — Derive fingerprints from safe file deltas

- **Source**: `buildProjectInputFingerprint`, `fingerprintProjectFiles`, `previousProjectInputSnapshot`, and `reindex` before reuse/incremental planning.
- **Change**: When a complete journal is based on the accepted generation, update the prior sorted file fingerprint by revalidating only changed source inputs. Existing changes replace one entry, additions insert one, deletions remove one, and a transient add/delete pair becomes a net-empty journal. Produce an explicit decision describing delta use or the exact full-scan fallback reason.
- **Preserve**: The byte-for-byte fingerprint shape, source-size limits, ignored/artifact paths, compiler-selected TypeScript inputs, language/configuration identity, and full enumeration as authority for unsupported cases.
- **Retire**: Whole-repository enumeration and `lstat` on every ordinary existing-file edit.
- **Prove**: Unit tests compare change/add/delete/no-op delta output with a clean full fingerprint and exercise wrong-base, incomplete, configuration, unreadable, and identity-mismatch fallbacks. Runtime status reports changed paths, accepted entries reused, and accepted input count.

### Step 3 — Carry dependency state into the next generation

- **Source**: `buildFileDepGraph`, project evidence products, `tryMaterializeTypeScriptIncrementalIndex`, incremental SQLite publication, and published metadata construction.
- **Change**: Capture the complete dependency product used to plan the update, replace outgoing SCIP and source-import edges for every affected document, retain unaffected edges, and write the resulting product under the accepted next generation's evidence fingerprint while the publication lock is still held.
- **Preserve**: SCIP and source edge bases, imports-only versus all-references modes, scope-specific products, exact document identity, and full reconstruction when the accepted product is absent or incompatible.
- **Retire**: Rebuilding the repository-wide dependency graph merely because the project fingerprint changed after an edit.
- **Prove**: Clean and carried graphs are equal after dependency addition/removal and ordinary body edits; a second edit to a newly imported dependency reaches the first changed document; product absence falls back without publishing stale state.

### Step 4 — Share immutable bases, isolate overlays, and coordinate duplicate work

- **Source**: shared-generation store, Git worktree identity, local generation leases, reindex lock, and worktree cache integration tests.
- **Change**: Represent the accepted local generation's immutable parent explicitly; attach/fork the exact clean `HEAD` base; coordinate construction of an absent base under the existing repository-scoped build lock; let each dirty worktree apply its own journal and dependency closure to its private overlay.
- **Preserve**: No dirty publication to the shared store, exact Git/config/toolchain identity, reader leases, staged durable publication, reflink/copy fallback, and dead-worktree lifecycle cleanup.
- **Retire**: Repeating the same clean base build in concurrent worktrees and treating another worktree's dirty cache as reusable state.
- **Prove**: Two cold worktrees produce one base build; two dirty worktrees diverge without cross-contamination; returning clean reattaches an exact shared generation; cancellation and lock-owner death leave a recoverable state.

### Step 5 — Bound warm compiler sessions by actual resources

- **Source**: TypeScript mailbox lanes, TypeScript index service host, watch-service idle policy, service activity/budget telemetry, and project-shard discovery.
- **Change**: Keep compiler sessions warm per `tsconfig`, refresh recency on reuse, and evict the least-recently-used session before allocating its successor so the worker never intentionally holds a cap-plus-one compiler graph. Expose active/maximum/eviction and V8 heap counts in service status. Retire an index worker after a configurable idle window or after a completed response crosses a configurable soft heap mark. Replay one failed in-flight request on a new worker with the same operation identity.
- **Preserve**: The user-owned 8 GiB worker heap default, per-project compiler identity, request deadline, mailbox claim, parent-death cleanup, and explicit fallback diagnostics. A memory failure that survives the cold retry preserves the accepted generation and pending edit journal; it does not invoke the more memory-hungry whole-project indexer.
- **Retire**: A universal three-minute watcher lifetime, indefinitely resident compiler workers, transient cap-plus-one compiler graphs, and OOM-to-full-rebuild loops.
- **Prove**: Repeated nearby edits reuse one compiler worker; exceeding the session budget releases the least-recently-used graph before creation; idle and high-water retirement occur only outside an active request; the cold retry settles the original mailbox claim exactly once; terminal memory pressure aborts while leaving the accepted index intact.

### Step 6 — Instrument and certify the complete path

- **Source**: reindex phase telemetry, watch-service activity, affected-set shadow records, cache lifecycle soak, and repository verification commands.
- **Change**: Report revalidated paths, accepted fingerprint entries reused, dependency-product carry/rebuild, affected documents/projects, compiler-session reuse/eviction, SQLite patch duration, and publication status. Add a repeatable edit-latency benchmark command.
- **Preserve**: Existing output compatibility; new detail is additive diagnostics or persisted telemetry with a versioned schema.
- **Retire**: Aggregate timing that cannot identify whether a slow edit scanned files, rebuilt dependency state, restarted a compiler, or patched too much output.
- **Prove**: Focused tests, typecheck, build, full tests, API compatibility, `scip-query diff-impact`, `scip-query architecture`, cache-lifecycle soak, and repeated cold/warm edit measurements.

## Acceptance gates

The program is complete when all gates hold:

1. An existing one-file TypeScript edit hashes only that file, updates only its dependency closure, reuses the warm compiler session, and atomically publishes an equivalent generation.
2. A second edit is planned from the dependency graph written by the first incremental generation, including a newly introduced dependency.
3. A watcher error or unsupported mutation takes a named full-scan/full-rebuild fallback and never claims an incremental result.
4. Concurrent clean worktrees build or attach one immutable base; dirty worktrees publish only private overlays.
5. Repeated nearby edits reuse the compiler within its warm window; inactive or high-water workers retire without stopping the persistent watcher, and a terminal Worker OOM never starts a full rebuild.
6. The benchmark reports work avoided as counts as well as time. On the current repository, the ordinary three-document case should remove repository-wide fingerprint and dependency reconstruction; wall-clock improvement is reported from repeated measurements, not inferred from the implementation.
7. Full repository verification passes and incremental-versus-clean SQLite/document/dependency equality fixtures remain exact.

## Working agreement and live record

- Work directly on `main` as required by the repository instructions.
- Preserve unrelated/user-owned working-tree changes; do not fold them into implementation commits.
- Complete one coherent slice at a time with its focused tests. Run broader gates after the path is connected.
- If a slice exposes a correctness gap, keep the conservative fallback and record the reason here; do not spend correctness for a latency claim.
- Update this section with completed slices, measured results, fallbacks retained, and any remaining blocker before calling the program complete.

Status on 2026-08-18: Steps 1-6 are implemented and all task-owned gates pass. The structured journal crosses watcher/worker boundaries; safe source changes/additions/deletions/no-ops derive exact fingerprints; language fingerprints filter the already-complete project snapshot instead of rescanning; immediate post-publication freshness avoids a second source scan; the default dependency product is carried under the publication lock; the existing immutable shared-base/private-overlay mechanism passed its concurrent-worktree integration suite; and TypeScript compiler sessions use an eight-entry LRU budget. This repository's watcher is configured persistent.

Memory-hardening continuation on 2026-08-18: TypeScript session eviction now occurs before replacement allocation. The worker reports isolate heap use and retires after a response reaches its soft mark; it also retires after an idle window while the watcher remains persistent. One worker crash replays the identical request on a cold worker. If memory pressure survives that retry, the reindex fails closed, restores the edit journal, and leaves the prior generation accepted instead of launching the whole-project fallback. This repository limits warm TypeScript sessions to 2, worker idleness to 5 minutes, the worker soft mark to 6 GiB, and whole-project indexer concurrency to 2.

Current-repository steady-state fingerprint benchmark (`npm run bench:edit-latency`): 496 accepted inputs; one path revalidated; 495 accepted fingerprints reused. Five warm full enumerations had a 39.536 ms median; 25 delta derivations had a 0.117 ms median, a measured 337.9× ratio for this phase. This is a fingerprint-phase measurement, not a claim that the entire reindex is 337.9× faster.

Verification record: 209 focused tests passed, including shared-worktree concurrency and repeated incremental publication; typecheck, build, API compatibility, task-file Prettier/ESLint, `scip-query diff-impact`, and `scip-query architecture` passed. The eight-cycle cache-lifecycle soak kept two local SQLite generations and one live TypeScript overlay, removed every disposable-worktree cache after its lease ended, aged every unreferenced shared generation, and returned to the exact 404,346-byte managed-state plateau after every cycle. The full suite reached 2,419 passing tests. Its task-owned bounded-I/O failure was corrected and the affected 20-test rerun passed; one concurrency-sensitive CLI test also passed alone. One unrelated pre-existing generated command-reference mismatch remains outside this program's files. The repository-wide format command also encounters 31 pre-existing files outside this change; every file in this program passes both formatting and lint checks.

Memory-continuation verification: typecheck, build, the API contract/consumer, task-file formatting/lint, 88 focused lifecycle/configuration tests, 118 wider watcher/reindex tests, `diff-impact`, and architecture policy pass. The one-worker full suite passed 2,426 of 2,427 tests; its only failure is the same pre-existing generated command-reference mismatch. A fresh eight-cycle cache soak published one-document incremental updates in every cycle and returned to the exact 404,347-byte plateau. After rebuilding and restarting the live daemon, a reversible edit published an incremental generation for five affected documents. Status reported 593.1 MiB used from an 8.1 GiB worker heap, a 6 GiB retirement mark, and two warm compiler sessions under this repository's two-session cap. The probe source bytes were then restored.
