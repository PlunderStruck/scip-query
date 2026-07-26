# scip-query — Distributed Data and API Evolution Audit

Date: 2026-07-25  
Audited revision: `bb02f0169bdda7b6598051a2b83caea454f684da`

Scope: the shared index generation, watch daemon, process locks, worktree cache, evidence cache, file mailboxes, repository-owned records, project and agent configuration, subprocess and worker lifecycles, remote binary downloads, Rust LSP framing, CLI JSON contract, published TypeScript package surface, metadata formats, and Windows sidecar release path.

Method: this audit applies the repository's `distributed-data` failure model, `api-evolution` compatibility model, `resilience` hostile-dependency and bounded-lifecycle model, and `unit-testing` observability model. Native source reads established literal behavior. Compiler-resolved scip-query exploration established entry-to-effect and consumer relationships where identity mattered. No production state was mutated and no findings were fixed in this pass.

Remediation status: all 27 findings now have implemented, tested slice
resolutions recorded beneath their original evidence. The original outcome
and severity counts remain unchanged as the audit snapshot; they describe the
pre-remediation revision rather than current unresolved debt.

---

## 1. Outcome

The core indexing algorithms are substantially stronger than the surrounding coordination protocols. Candidate SQLite generations are built privately and validated transactionally; shared clean-worktree generations are content-addressed, immutable, and hashed; cache hits are tied to input fingerprints; committed outcome events use independent immutable paths.

The highest-risk defects live at the boundaries between those mechanisms:

1. An open SQLite reader can continue reading generation A while the metadata path and cursor/session identity functions describe generation B. This can attach generation-B authority to generation-A rows or numeric symbol IDs.
2. Watch and reindex ownership is proven only by a process ID. After PID reuse, stop or preemption can signal an unrelated process.
3. Several read-modify-write protocols have no compare-and-swap step, so a concurrent writer can be silently erased.
4. Public data contracts are numerous but mostly unversioned. The CLI envelope, project configuration, committed records, Rust mailbox requests, and published TypeScript signatures have no complete compatibility baseline.
5. The Windows sidecar release script proves that files exist and a version exists on npm, but it does not prove that either set of bytes is the intended set.
6. Long-lived subprocess, worker, download, and LSP transport boundaries do not consistently impose deadlines, memory ceilings, output draining, or termination-and-reap semantics.

This report records **27 findings**:

- **2 S1** integrity or process-safety defects;
- **10 S2** lost-update or compatibility defects;
- **13 S3** availability, lifecycle, durability, or observability defects;
- **2 S4** low-risk operational or testability defects.

These counts describe source-confirmed mechanisms, not incident frequency. The audit found no evidence that all of these failures have occurred in production.

---

## 2. Terms, evidence grades, and severity

A **generation** is one accepted set of mutually corresponding index artifacts—principally `index.db`, `index.scip`, and `meta.json`—distinguished from other accepted sets by the fact that every artifact describes the same indexing run. That correspondence is what lets a reader treat separate files as one snapshot.

A **generation handle** is a reader-owned reference to one accepted generation, distinguished from a path lookup by retaining the identity and artifacts that were opened together. The retained association is what prevents later path replacement from changing the meaning of an in-flight read.

An **authority** is the store or process whose accepted value decides what the system will treat as true, distinguished from a cache or observation by being the value writers and readers must reconcile around. For example, the stable SQLite file is authoritative for graph rows, while the evidence database is rebuildable and therefore not authoritative for source truth.

A **lost update** is a completed write that disappears because a later writer derived its replacement from an older value, distinguished from ordinary last-writer-wins behavior by the later writer's promise or expectation that it preserved independent fields. The stale read used to construct the replacement is the causal feature.

An **idempotency key** is a stable operation identity that lets repeated delivery have the effect of one delivery, distinguished from a random request identifier by surviving retries of the same logical operation. Random IDs prevent response mix-ups; they do not prevent duplicate work after retry.

A **fencing token** is a monotonically ordered ownership value checked by the protected resource, distinguished from a lock token that only controls file deletion by preventing an older owner from publishing after a newer owner. Non-expiring, token-owned locks in this repository do not automatically need fencing; a protocol that expires or steals live ownership would.

A **compatibility contract** is the externally observable shape and meaning that an older or newer consumer depends on, distinguished from an internal TypeScript type by crossing a version or process boundary. CLI JSON, npm exports, config files, committed event files, and mailbox envelopes are compatibility contracts.

A **resource budget** is an enforced upper bound on time, memory, bytes, attempts, or queued work consumed by one operation, distinguished from a preferred target by causing an explicit failure when exhausted. Enforcement is what prevents a slow, silent, or hostile dependency from turning one request into process-wide exhaustion.

A **drain** is the orderly completion or cancellation of accepted in-flight work before an owner advertises itself as stopped, distinguished from merely refusing new work by retaining responsibility for work already started. That retained responsibility is what prevents two nominal owners or orphaned children from continuing the same operation.

Evidence grades used below:

- **Existing-test confirmation** means a checked-in test already demonstrates the key runtime fact.
- **Source-confirmed interleaving** means all steps are reachable in the current code and no synchronization orders them, but this audit did not run a deterministic scheduler test.
- **Contract gap** means a public or durable boundary lacks versioning, migration, or comparison machinery; it is a latent evolution defect rather than a claim that a current consumer has broken.
- **Hardening gap** means current behavior is acceptable under ordinary execution but lacks a stated crash, clock, queue, or release guarantee.

Severity:

- **S1** means an allowed execution can misattribute authoritative data or signal a process the tool does not own.
- **S2** means an allowed execution can silently lose requested or persisted state, or a routine version change can break or mislead consumers without detection.
- **S3** means the primary consequence is recoverable unavailability, recomputation, unbounded debris, misleading metrics, or a difficult release recovery.
- **S4** means a low-value operational record can be lost without affecting authoritative results.

---

## 3. Shared-state and contract map

| Boundary                    | Real authority                                    | Writers                                  | Readers                                           | Current coordination                                      | Audit result                                                               |
| --------------------------- | ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| Stable index                | One corresponding SQLite/SCIP/metadata generation | Reindex publisher, shared-cache hydrator | CLI commands, semantic services, freshness checks | Reindex lock; per-file atomic rename                      | Candidate construction is strong; multi-file reader binding is not         |
| Shared clean-worktree cache | Immutable content-addressed generation directory  | Reindex shared publisher                 | Hydrator, garbage collector                       | Build lock, repository GC lock, artifact hashes           | Publication is strong; lease touch has a stale write                       |
| Watch control plane         | Watch state, activity, PID lock                   | Watch process and command clients        | Watch controller and requesters                   | Atomic JSON replacement, PID liveness                     | Refresh RMW can lose requests; PID identity is insufficient                |
| Reindex ownership           | Reindex lock file                                 | Watcher or manual CLI                    | Competing reindex and preemption path             | `open("wx")`, PID liveness                                | Malformed locks wedge; PID reuse makes preemption unsafe                   |
| Evidence cache              | Rebuildable SQLite observations                   | Query processes                          | Query processes                                   | WAL, transactions, fingerprints                           | Result caching is sound; outcome counters lose increments                  |
| TypeScript mailbox          | Pending, inflight, response, and rejection files  | CLI clients and watch service            | Watch service and CLI clients                     | Stable operation identity, protocol v3, deadlines, quotas | Correlation, retry, claim recovery, cleanup, and backpressure are explicit |
| Rust mailbox                | Pending, inflight, response, and rejection files  | CLI clients and durable server           | Durable server and CLI clients                    | Stable operation identity, protocol v3, deadlines, quotas | Lifecycle now shares the TypeScript mailbox state machine                  |
| Subprocesses and workers    | Child exit plus bounded output                    | Reindex, analysis, watch, semantic paths | Parent coordinators                               | Per-call ad hoc timeouts and buffers                      | Deadlines, drain, and termination policy are incomplete                    |
| Rust LSP transport          | Framed JSON-RPC byte stream                       | rust-analyzer                            | Rust semantic client                              | Content-Length framing and request deadlines              | Header and body accumulation are unbounded                                 |
| Verified binary download    | Checksum-matching cached bytes                    | TLA/Windows fetch commands               | Tool resolvers                                    | SHA-256 and atomic rename                                 | Network duration, response size, and temp ownership are unbounded          |
| Project/agent config        | User-authored JSON or Markdown                    | User, setup, hook installer              | Agents and runtime                                | Revision-aware narrow merge and durable publication       | Conflicts are explicit; latest unrelated edits survive                     |
| Suppressions                | One committed JSON file per accepted finding      | Agents and users                         | Diff gate                                         | Deterministic filename                                    | Same-worktree writers silently overwrite                                   |
| Outcome events              | One immutable committed JSON file per event       | Diff gate                                | Reports and reconciliation                        | Content-derived name, exclusive create, read dedupe       | Good merge model; schema is unversioned                                    |
| CLI JSON                    | Printed process output                            | Current CLI                              | Agents, scripts, external callers                 | Descriptor metadata and coverage validation               | Shape is useful but unversioned                                            |
| npm TypeScript API          | Exported `.d.ts` surface                          | Package releases                         | Library consumers                                 | Export membership tests                                   | No signature compatibility baseline                                        |
| Windows sidecar             | Published npm tarball containing two PE binaries  | Release script                           | Windows installations                             | Provenance, exact pack identity, bounded registry compare | Local/registry identity is verified; cross-package recovery remains        |

---

## 4. Detailed distributed-data findings

### DD-01 — S1 — In-flight readers can combine old SQLite rows with new generation identity

**Evidence:** existing-test confirmation plus source-confirmed interleaving.

**Code:**

- `src/reindex/sqlite-generation-store.ts:85-110` replaces `index.scip`, `index.db`, and `meta.json` sequentially, then writes generation state.
- `src/storage/db.ts:44-60` opens a read-only SQLite connection by stable path.
- `tests/reindex/sqlite-generation-store.test.ts:36-62` explicitly proves that an existing reader remains on the old inode after the stable path is replaced, while a new reader sees the new generation.
- `src/semantic/typescript/session-protocol.ts:59-86` derives `publishedGenerationIdentity` from the current `meta.json` path.
- `src/semantic/typescript/remote-provider.ts:124-157` owns an already-open `ScipDatabase` but derives the request generation from the current metadata path.
- `src/runtime/result-pagination.ts:14-18` also derives cursor generation from the current metadata path, with a path-stat fallback.
- `src/runtime/query-commands/direct-navigation.ts:56-85` obtains `refs` rows from the open database and only afterward obtains the path-derived generation identity.

**Failure interleaving:**

1. Command C opens stable `index.db` generation A.
2. Reindex P retains A and renames generation B into the stable database and metadata paths.
3. C's SQLite connection correctly continues reading inode A.
4. C calls `publishedGenerationIdentity(dbPath)`, which now hashes metadata B.
5. A semantic request can therefore send numeric symbol IDs read from A under B's generation identity. The service opens B and can interpret those IDs as different symbols.
6. A paginated `refs` response can label A's sorted rows with generation B. The continuation request opens B, accepts the cursor as B, then applies A's offset to B's result set. Insertions or removals before that offset can produce omissions or duplicates.

There is also a shorter handoff window in which `index.db` and `meta.json` name different accepted generations because the files are replaced one at a time. Atomic rename protects the completeness of each file; it does not make the set atomic.

**Why this matters:** this is not merely a stale read. A stale reader is acceptable when it is honestly identified as generation A. The defect is attaching generation-B authority to generation-A facts.

**Recommended design:**

- Introduce a generation handle that opens the database and reads metadata/state as one validated snapshot.
- Bind semantic requests, result cursors, evidence fingerprints, and coverage claims to the handle, not to fresh path reads.
- One feasible protocol is: read generation state, open the database, obtain the opened file identity, reread generation state, and retry unless both observations agree and the open file matches the named generation.
- A stronger layout is an immutable generation directory plus one atomic pointer. Readers resolve the pointer once and open every artifact beneath that immutable directory.
- Keep old generation directories alive while handles exist or until a conservative grace/lease policy permits collection.

**Required tests:**

- Pause publication after each handoff stage with `onStage`; issue `refs`, semantic reference, and pagination requests from a reader opened before the pause.
- Assert every request's generation identity matches the rows' actual database inode or content identity.
- Change the sorted `refs` set between generations and prove a cursor either continues the original immutable generation or rejects the continuation.
- Assign deliberately conflicting numeric symbol IDs across A and B and prove remote semantic resolution cannot cross the generations.

**Acceptance condition:** no code path can construct one externally meaningful response from an open database and independently reread generation identity from a replaceable path.

**Resolution — Slice 10 (2026-07-25):** resolved. Local publication now
materializes a flushed immutable database/SCIP/metadata directory and switches
one durable pointer before updating compatibility mirrors.
`ScipDatabase.generation` retains that directory's identity, database path,
SCIP path, and metadata bytes. Result cursors, TypeScript requesters and
services, Rust SCIP occurrence fallbacks, evidence fingerprints, semantic
identity construction, and database statistics now consume that retained
handle. Legacy caches use a file-identity-checked open overlap path; new state
records fail closed if their named immutable set is missing or malformed.

Deterministic tests now stop publication after recovery retention, pointer
handoff, and each mirror handoff; every newly opened database sees either the
complete prior set or the complete candidate set. Separate tests retain an old
reader across two publications, reject a cursor before an old offset reaches a
changed result set, reject deliberately conflicting numeric symbol IDs at the
TypeScript service boundary, refresh metadata as a new generation, fail
closed on a missing manifest, and exercise shared-cache hydration followed by
private stable-path mutation. The stable mirrors remain available for older
tools, while internal database-backed operations no longer derive authority
from them.

### DD-02 — S1 — PID reuse can cause scip-query to terminate an unrelated process

**Evidence:** source-confirmed interleaving.

**Code:**

- `src/platform/process-liveness.ts:1-8` defines process identity as “`kill(pid, 0)` succeeds or returns `EPERM`.”
- `src/runtime/watch-service.ts:474-535` classifies watch state by PID, protocol fields, and heartbeat; stale or incompatible live-PID states plan replacement or signal-stop.
- `src/runtime/watch-service.ts:568-577` signals that PID.
- `src/reindex/index.ts:2034-2064` lets a manual reindex preempt a watcher-owned reindex lock.
- `src/reindex/index.ts:2137-2153` sends `SIGTERM` and then `SIGKILL`, first to the process group and then the PID.

**Failure interleaving:**

1. A watch or reindex owner writes PID P and dies without removing its state.
2. The operating system reuses P for an unrelated process.
3. `isProcessAlive(P)` returns true.
4. A stale heartbeat, CLI-version mismatch, manual preemption, or explicit stop causes scip-query to signal P or process group `-P`.

The heartbeat proves that the old record has not advanced. It does not prove that the currently living PID is the recorded process.

**Recommended design:**

- Record and verify a process birth identity in addition to the PID: OS process start time, platform process handle identity, or a nonce returned by an authenticated local control socket.
- Prefer asking the watch service to stop over its control channel and require a nonce-bearing acknowledgment.
- For reindex preemption, only signal after verifying that the process still has the recorded start identity and project/session token.
- If identity cannot be verified, fail closed and leave an explicit recovery instruction; never infer ownership from PID alone.

**Required tests:**

- Inject a liveness provider that reports the PID alive but a birth identity different from the recorded one.
- Assert `watch ensure`, `watch stop`, and manual reindex preemption never invoke the signal function.
- Test both positive identity verification and platforms where identity lookup fails.

**Acceptance condition:** every destructive signal is preceded by a proof that the live process is the same process instance that wrote the ownership record.

**Resolution:** Slice 01 adds a platform process-start identity to newly written watch state, watch locks, and reindex locks. Watch stop/replacement and reindex preemption fail closed for legacy, unavailable, or mismatched identity evidence; deterministic PID-reuse tests prove that neither the PID nor its process group is signaled.

### DD-03 — S2 — Watch refresh requests can be erased by activity recording

**Evidence:** source-confirmed interleaving.

**Code:**

- `src/runtime/watch-service.ts:341-352` reads the current activity object, then replaces it while preserving a refresh request only if that stale read observed one.
- `src/runtime/watch-service.ts:359-365` independently replaces the same file to request a refresh.
- `src/runtime/watch-server.ts:212-225` polls one refresh timestamp and acts only on a timestamp newer than its prior observation.

**Failure interleaving:**

1. Activity writer A reads a record without `refreshRequestedAt`.
2. Requester B writes a refresh request.
3. A replaces the file with its activity value, derived from the older read.
4. The refresh request disappears before the watch server observes it.

Two requesters can also overwrite each other's detail and timestamps, and an older delayed writer can regress `at` or `refreshRequestedAt`.

**Recommended design:**

- Represent refresh intent as immutable request files or append-only events, one per logical request.
- Give each logical refresh an idempotency key when callers may retry.
- Let the server atomically rename `pending/<id>` to `inflight/<id>`, coalesce requests deliberately, and remove them only after refresh completion.
- Keep activity/heartbeat in a separate last-writer-wins file; it should not share a replacement record with durable intent.

**Required tests:**

- Use barriers to force the exact stale-read/request/new-write order.
- Assert every accepted refresh is either processed or represented by a still-pending event.
- Test duplicate idempotency keys, distinct concurrent keys, server crash after claim, and retry after crash.

**Acceptance condition:** no activity update can erase an unacknowledged refresh request.

**Resolution — Slice 11 (2026-07-25):** resolved. New requesters publish a
complete immutable record under `watch-refresh-requests/requests/`; ordinary
activity writes now replace only a disposable timestamp. Stable request
identity provides idempotency, exclusive claim records prevent competing
consumers, and durable completion receipts are written before claim release.
The watch server claims only while its watcher is idle, deliberately coalesces
the claimed batch into one demand refresh, acknowledges it only from that
reindex completion callback, and releases it after failure with a bounded retry
delay. A successor recovers predecessor claims only after acquiring the watch
process lock.

Deterministic storage and coordinator tests cover the original stale-read
interleaving, duplicate and distinct idempotency keys, competing claimers,
crashes after claim and after completion, retry delay, deliberate coalescing,
expiry, history pruning, and the former activity-record race. Protocol version
5 state exposes pending, claimed, completed, expired, and invalid counters.
Legacy activity refresh fields remain readable and are converted to
deduplicated durable requests during the overlap release.

### DD-04 — S2 — Empty or malformed lock files can wedge watch, reindex, and cache operations indefinitely

**Evidence:** source-confirmed crash window.

**Code:**

- Watch lock acquisition opens with `wx` and then writes metadata at `src/runtime/watch-service.ts:394-436`; its reader returns `null` for malformed or incomplete content at `:455-470`, but acquisition only removes a parsed stale record at `:402-412`.
- Reindex has the same create-then-write window at `src/reindex/index.ts:2070-2092`; `readReindexLock` returns `null` at `:2103-2118`, and the caller then reports another reindex forever at `:2064`.
- `src/platform/repository-cache-lock.ts:32-70` reclaims a parsed dead or PID-less observation, but `readLockObservation` returns `null` for malformed JSON at `:79-88`, so a truncated record is never reclaimable.
- The shared-generation build lock follows the same observation pattern around `src/reindex/shared-generation-store.ts:537-546`.

A crash, disk-full condition, or forced termination between exclusive file creation and metadata write leaves an empty file. Exclusive creation then preserves the dead file exactly as designed, while the recovery path has no identity it is willing to reclaim.

The reindex release path has a related ownership weakness: `src/reindex/index.ts:2094-2099` unconditionally removes the path. Unlike the generic token-owned lock, it does not verify that the path still contains its own token before deletion.

**Recommended design:**

- Put a random ownership token in every lock and use token-checked release.
- Treat malformed/empty records as observations that can be reclaimed only through a second exclusive reclaim lock, after a short creation grace period and a raw-content/metadata recheck.
- Alternatively, write a complete ownership record to a uniquely named file and atomically link or rename it into the lock name with a protocol that preserves exclusivity.
- Preserve the generic lock's “never unlink a changed observed record” rule.

**Required tests:**

- Crash/fail after `open("wx")` and before the metadata write for every lock implementation.
- Start two reclaimers and prove only one removes the unchanged malformed file.
- Replace a lock path with a successor before an old owner releases; prove the old release cannot delete the successor.

**Acceptance condition:** a malformed lock is eventually recoverable without permitting two owners, and release is always ownership-checked.

**Resolution:** Slice 09 introduces one crash-durable, versioned process-lock
record with a random ownership token and optional process-start identity.
Watch, reindex, repository-cache, shared-generation, verified-binary fetch, and
durable Rust semantic-server ownership use the common parser and
token-checked release. Empty, truncated, and malformed records become
recoverable only after a five-second creation grace, beneath an exclusive
reclaim guard, and after unchanged raw-byte plus file-identity revalidation.
Live legacy or identity-unverifiable owners remain contended; a reused PID is
reclaimed without signaling its newer occupant. Deterministic fault tests
cover failure immediately after exclusive create, truncated records, two
reclaim attempts, abandoned reclaim guards, PID reuse, token mismatch, and a
successor appearing before removal. The operational state machine and manual
recovery guidance are recorded in `docs/LOCK_PROTOCOL.md`. The descriptor
write loop and Windows directory-handle classification are shared through the
dependency-free `src/filesystem/file-descriptor.ts` boundary, keeping
`platform` and `storage` independent while preventing durability-policy drift.

### DD-05 — S2 — Project, hook, and agent setup writers can overwrite concurrent user edits

**Evidence:** source-confirmed interleaving.

**Code:**

- `src/runtime/config.ts:670-690` checks whether `.scipquery.json` exists and then performs a non-exclusive plain write.
- `src/runtime/config.ts:700-733` accepts a previously read `ProjectConfig`, modifies one field, and writes the whole stale object.
- `src/runtime/agent-hooks.ts:340-373` and `:376-440` read, merge, and plainly replace Claude/Codex hook JSON.
- `src/runtime/agent-setup.ts:151-167` and `:170-197` read AGENTS/CLAUDE Markdown, transform the managed block, and plainly replace or delete the file.

**Failure interleaving:**

1. scip-query reads revision A.
2. A user, editor, or another agent writes independent revision B.
3. scip-query writes its transformation of A.
4. B's unrelated fields or prose disappear.

Plain writes also expose truncated JSON or Markdown if the process fails mid-write. `initProjectConfig` has an additional check-then-create race: a file created after `existsSync` can be overwritten.

**Recommended design:**

- Use atomic replacement for visibility and an optimistic revision check for preservation.
- Capture a content hash or file identity with the read, acquire a path-scoped lock, reread, and retry the merge if the input changed.
- Create absent configuration with `wx`.
- Apply narrow patch operations to the newest parsed object, preserving unknown fields.
- For human-authored Markdown, report a conflict rather than overwriting if non-managed content changed during the operation.

**Required tests:**

- Inject a concurrent edit between read and write for every writer.
- Assert unknown JSON fields and unrelated Markdown survive.
- Test a simultaneous first-time config creation and a crash during replacement.

**Acceptance condition:** setup and hook operations either preserve the latest unrelated edits or return an explicit conflict without changing the file.

**Resolution — Slice 12 (2026-07-25):** resolved. A shared revision-aware
mutation primitive now identifies snapshots by raw-byte hash and file identity,
serializes cooperating writers with token-owned process locks, performs a final
revision check, bounds retries, and publishes complete bytes durably. Absent
files use exclusive staged publication. Project config updates perform a
three-way check on the owned field, preserve unknown latest fields, and reject
stale same-field decisions. Hook JSON remerges only scip-query-owned groups
against the latest valid provider object. Managed agent Markdown, the owned
pre-commit hook, and `.git/info/exclude` preserve independent text; ambiguous
markers and strict revision conflicts are reported without modification.
Fault-injection tests cover the read/commit barrier, retry exhaustion,
simultaneous creation, pre-publication crashes, malformed latest inputs, marker
corruption, unknown-field preservation, and same-field conflicts.

### DD-06 — S2 — Same-worktree suppression writers silently overwrite policy decisions

**Evidence:** source-confirmed interleaving.

**Code:** `src/storage/suppression-store.ts:33-65` derives a deterministic path from finding identity and plainly replaces it. The header correctly explains why independent files merge across branches, but the same path is intentionally reused when suppressing the same finding.

Two agents can suppress the same finding with different reasons or expiration policy. The later write silently erases the first. A crash during the plain write can leave malformed JSON, which `readSuppressionDir` warns about and ignores at `:68-99`; the accepted policy then disappears from gate behavior.

**Recommended design:**

- Make the policy transition explicit: exclusive create for first acceptance; compare-and-replace with expected prior hash for an update.
- If independent reasons must coexist, store immutable revision events and derive current policy with deterministic conflict rules.
- Add `schemaVersion`, writer/tool version, and a stable suppression identity to the record.
- Use durable atomic replacement for policy state.

**Required tests:**

- Concurrent first creation with distinct reasons.
- Concurrent replacement from the same prior hash.
- Crash during write and read of an unsupported future schema.

**Acceptance condition:** conflicting policy writes cannot silently erase one another, and a torn write cannot make an accepted suppression disappear without a diagnostic.

**Resolution — Slice 13 (2026-07-25):** resolved. The runtime suppression
writer now publishes a first identity exclusively, treats the same policy as
an idempotent replay, and rejects every different reason, expiry, check, or
file until the caller supplies the full SHA-256 revision through
`--replace`. Replacement rechecks that reviewed revision at the commit
boundary and uses durable publication; stale tokens and uncooperative edits
leave the newer bytes untouched. New records declare schema version 1, their
stable suppression identity, and the writer tool/version. The decoder keeps
unversioned records readable and diagnoses malformed, mismatched, or
unsupported future records instead of overwriting them. Fault tests cover
competing first decisions, same replay, explicit and stale replacement,
independent identities, pre-commit failure, commit-boundary edits, legacy
upgrade, malformed data, identity drift, and future schemas.

### DD-07 — S3 — Worktree lease touch can overwrite a newer generation lease

**Evidence:** source-confirmed interleaving.

**Code:** `src/reindex/shared-generation-store.ts:620-678` reads and validates the pointer, lease, metadata, and artifacts before acquiring the repository lock at `:674`. It then updates and writes the previously read lease at `:677-678`. Generation publication writes a fresh lease through `writeWorktreeLease` at `:552-575`.

**Failure interleaving:**

1. Touch A reads lease for generation G and validates G.
2. Reindex B publishes generation G2 and writes a G2 lease under the repository lock.
3. A later acquires the lock and rewrites its stale G lease with a newer `lastSeenAt`.

This can make the new shared generation appear unreferenced and regress status metadata. A later touch is likely to reject and repair the mismatch, so the primary effect is cache availability and extra work rather than incorrect query facts.

**Recommended design:** acquire the repository lock before reading the lease, or reread and compare the lease generation and ownership checksum after acquiring it. Update only `lastSeenAt` with a compare-and-swap predicate over the prior generation identity.

**Required tests:** pause touch before lock acquisition, publish G2, resume touch, and assert the final lease remains G2.

**Acceptance condition:** a touch can advance liveness only for the generation that is still current when the write lock is held.

**Resolution — Slice 14 (2026-07-25):** resolved. A lease touch now uses its
first local pointer observation only to select the repository-cache lock. Once
serialized with generation attachment and cleanup, it rereads the pointer and
current lease, verifies the pointer identity, ownership checksum, Git tree,
local-cache path, metadata fingerprint, generation IDs, and artifacts, then
merges only `lastSeenAt`. It never writes the pre-lock lease object. Barrier
tests publish G2 while a G1 touch waits, delete or recreate the lease before
the touch acquires ownership, corrupt the ownership checksum, and complete a
newer concurrent touch first. In every case the current lease remains intact
and liveness never moves backward.

### DD-08 — S3 — Atomic JSON writes guarantee complete visibility but not crash durability

**Evidence:** hardening gap.

**Code:** `src/storage/atomic-json.ts:9-19` writes a temporary file and renames it, but does not `fsync` the file descriptor or parent directory.

Readers in a normally running process observe either the old or new complete JSON document. After power loss or kernel crash, however, the latest file contents or directory rename can be absent. That distinction is appropriate for rebuildable heartbeat and cache metadata, but not necessarily for policy records, ownership transitions, or a release ledger. The helper's phrase “durable enough” does not state which guarantee callers receive.

The temporary name is also only `path + pid + Date.now()`. Two writes from the same process in the same millisecond could target the same temporary path; most current calls are synchronous, so this is a narrow risk, but a UUID removes the assumption cheaply.

**Recommended design:**

- Split the API into a visibility-atomic helper and an explicitly durable helper.
- The durable helper should write through an open descriptor, flush it, rename, and flush the parent directory where the platform supports it.
- Use a random temporary suffix.
- Classify every caller by whether loss after power failure is acceptable.

**Required tests:** injected failures before write, after write, after file flush, after rename, and after directory flush; document platform limitations.

**Acceptance condition:** each caller chooses a named durability contract rather than inheriting an ambiguous one.

**Resolution:** Slice 08 introduces one exclusive random-token atomic-file
primitive with two explicit modes. Visibility mode stages complete bytes and
renames them, guaranteeing old-or-new complete observations without claiming
crash survival. Durable mode flushes the staging descriptor before rename and
the containing directory after rename. Known Windows directory-handle
limitations return `directorySync: "unsupported"` after the file flush and
rename; all other sync errors fail explicitly. Create, partial write, file
flush, and rename failures remove only the writer's owned staging file and
preserve the previous target. A POSIX directory-flush failure occurs after
rename, so the verified new file remains visible while the call reports
unconfirmed durability.

`writeJsonAtomic` retains its visibility-atomic `void` API.
`writeJsonDurable` is additive and returns the achieved directory-sync status.
Verified binary downloads apply the same ordered file-flush, rename, and
directory-flush contract inside the independent platform boundary. Reindex metadata, SQLite
generation state, shared-generation manifests, worktree leases and pointers,
watch service ownership, Rust session discovery, project configuration, agent
hook configuration, structured suppressions, and health baselines now choose
durable replacement. Ephemeral mailboxes, watch activity, content-addressed
TypeScript caches, GC history, and shadow telemetry remain visibility-atomic.
`docs/DURABILITY.md` records the guarantee, post-rename ambiguity, Windows
limitation, and full call-site matrix. Fault tests cover exclusive-create
collision, partial write, file flush, rename after flush, POSIX directory
flush, Windows unsupported directory sync, old-or-new visibility, staging
ownership, JSON compatibility, and durable binary promotion.

### DD-09 — S3 — Concurrent health runs can lose finding-outcome increments

**Evidence:** source-confirmed interleaving.

**Code:** `src/storage/evidence-cache.ts:733-792` reads the full outcome ledger, while the writer groups the caller-computed state, deletes each check's rows, and reinserts the replacement in a transaction.

SQLite makes each replacement atomic, but it does not make the earlier read and later replacement one serializable transition:

1. Processes A and B read `timesShown = 4`.
2. Each computes `5`.
3. A writes 5; B deletes and writes 5.
4. One observation is lost.

This affects detector-effectiveness metrics and local history, not source or index correctness.

**Recommended design:** update counters and timestamps with SQL `UPSERT` expressions inside one transaction, or add a revision and retry compare-and-swap. If observations may be retried, give each observation a stable ID and record it exactly once.

**Required tests:** two database connections update the same finding behind a barrier; final count must reflect both distinct observations and one retried observation only once.

**Acceptance condition:** distinct observations commute without loss, and retry semantics are declared.

**Resolution:** Slice 15 removes the read/replace writer. Each logical
diff-gate observation now has a stable ID, a fingerprint of its normalized
findings/checks/retained identities and captured time, and an additive record
in `finding_outcome_observations`. SQLite claims that ID, derives the
transition from the latest committed rows, applies count deltas with
`INSERT ... ON CONFLICT DO UPDATE`, and enforces the per-check recency cap
inside one immediate transaction. An exact retry is a no-op, ID reuse for
different evidence is a reported conflict, and transient writer-lock timeout
does not consume the ID or disable the rest of the evidence cache. Two real
connections reproduce the former stale-read interleaving and retain both
increments; additional tests cover retry, collision, suppression, duplicate
findings within one run, lock timeout, and successful retry after lock release.

### DD-10 — S3 — File mailboxes have no claim state, orphan collection, or backpressure — resolved in Slice 16

**Evidence:** source-confirmed lifecycle gap.

**Code:**

- TypeScript requesters create UUID request/response paths and remove both in `finally`: `src/semantic/typescript/remote-provider.ts:144-173` and `src/reindex/typescript-index-requester.ts:70-105`.
- TypeScript services scan sorted request names, write a response, then remove the request: `src/semantic/typescript/session-service.ts:142-196` and `src/reindex/typescript-index-service.ts:142-191`.
- Rust follows the same requester lifecycle at `src/semantic/rust/durable-session.ts:358-405` and service lifecycle at `src/semantic/rust/durable-session-server.ts:24-55`.
- Mailbox initialization creates directories only; it does not collect stale requests or responses.

**Failure and accumulation cases:**

- A client times out and deletes its paths while the service is processing; the service later writes an orphan response.
- A client dies after writing a request; TypeScript eventually writes an expired-error response with no reader. Rust requests have no per-envelope absolute expiry and can still cause expensive work.
- A server dies after reading a request but before deleting or responding; the next server replays it.
- UUID sort order is not FIFO or deadline order. Under load, a newer long-deadline request can run before an older near-deadline request.
- There is no queue length or byte limit, so a stalled service can accumulate files without backpressure.

Unique IDs correctly prevent response correlation mistakes. The work is read-only or rebuildable, so replay is usually safe. Those strengths do not solve queue lifecycle.

**Recommended design:**

- Add `pending`, `inflight`, and `responses` states; claim with atomic rename.
- Put protocol version, absolute expiry, client/session identity, and request identity in every envelope.
- Decide explicitly whether retries share an idempotency key or are new operations.
- Periodically collect expired pending, abandoned inflight, and orphan responses.
- Add queue count/byte limits and return a clear overload error.
- Process by deadline or enqueue sequence, not random UUID order.

**Required tests:** client death, server death before and after claim, timeout during processing, replay, duplicate logical request, queue overload, and cleanup after restart.

**Acceptance condition:** every mailbox file has a bounded lifecycle and every replayable operation has declared duplicate semantics.

**Resolution:** `src/storage/bounded-mailbox.ts` now owns the shared
filesystem state machine used by both TypeScript mailboxes and the durable Rust
mailbox. Current writers publish immutable requests under `pending/` only
after a token-checked admission coordinator proves the retained item, byte,
and per-item limits. Each request carries a recomputed SHA-256 operation key,
deterministic request ID, client identity, enqueue time, and deadline.
Services claim a bounded enqueue-ordered batch by atomically renaming work into
an owner-specific `inflight/` directory whose filename records claim expiry.
Expired ownership is reclaimed after its recorded process instance is gone; a
response is durably and exclusively published before claim release; a retained
response makes retry idempotent and also closes the crash-after-response
window without re-execution.

Response, dead-letter, and atomic-staging history is collected under bounded
per-pass maintenance. Malformed, expired, oversized, and failed work receives
an explicit error response and a bounded rejection record. The watch service
and Rust helper state expose pending, inflight, response, dead-letter, invalid,
item, byte, and oldest-pending telemetry. New services drain TypeScript v2
flat request files and the former unversioned Rust request shape during the
overlap window; current writers never publish into the legacy directory.
Crash-before-claim, crash-after-claim, crash-after-response, exact retry,
admission interleaving, count/byte/per-item overload, FIFO batch fairness,
orphan reclaim, malformed/oversized input, retention, and protocol integration
are covered by the shared and three transport suites. The operational
contract and default limits are in `docs/MAILBOX_LIFECYCLE.md`.

### DD-11 — S3 — Wall-clock jumps can distort ownership, timeout, and heartbeat decisions — resolved in Slice 17

**Evidence:** hardening gap.

**Code:**

- `src/platform/repository-cache-lock.ts:38-70` accepts an injected `now` function but computes and compares the wait deadline with `Date.now()`, making the time abstraction internally inconsistent.
- Watch classification compares ISO wall-clock heartbeat time against wall-clock `now` at `src/runtime/watch-service.ts:474-499`.
- Watch stop/start waits use absolute wall-clock deadlines at `:553-577`.
- TypeScript mailbox deadlines and heartbeat checks use wall-clock milliseconds, including `src/reindex/typescript-index-requester.ts:73-118`.
- Rust requester and server loops use wall-clock deadlines and heartbeat ages at `src/semantic/rust/durable-session.ts:366-427` and `src/semantic/rust/durable-session-server.ts:69-107`.

A forward clock jump can expire valid requests or classify a healthy service stale. A backward jump can prolong waits and make an old heartbeat appear fresh. Wall time is necessary for cross-process diagnostics, but elapsed duration inside one process should not depend on civil-clock adjustment.

**Recommended design:** use a monotonic clock for same-process elapsed time. For cross-process liveness, combine wall timestamps with process birth identity, boot/session identity, and an active handshake; treat wall time as a diagnostic and conservative timeout hint.

**Required tests:** inject forward and backward jumps around every deadline and heartbeat boundary.

**Acceptance condition:** clock adjustment cannot cause an unrelated process signal, an unbounded local wait, or silent acceptance of an incompatible session.

**Resolution:** `src/domain/time.ts` now names the two clock domains.
Process-local waits and elapsed measurements use monotonic readings; persisted
heartbeats, request times, retention times, and diagnostic dates remain civil
timestamps. Repository-cache and revision locks, shared-generation waits,
watch debounce/cooldown/start/stop/idle control, TypeScript and Rust response
polling, rust-analyzer readiness, reindex phase durations, heartbeat
throttling, activity polling, and cache sweeps no longer derive elapsed
control from `Date.now()`.

Cross-process ownership no longer follows timestamp age alone. Process locks
assemble and flush a private complete record before an exclusive hard-link
publication; malformed public locks therefore fail closed instead of becoming
deletable after a wall-clock grace period. Watch startup refuses to replace or
signal a live owner merely because its heartbeat appears old. TypeScript and
Rust requesters match a recorded process-start identity when one is available,
so PID reuse is not accepted as the same service. Each inflight mailbox owner
directory also records its process instance; an expired claim is returned to
pending only after that instance is dead or replaced. An ownerless or
unverifiable claim remains inflight.

Portable Rust requests no longer carry an absolute readiness deadline from a
different process clock. The durable server converts the relative request
budget into its own monotonic deadline before dispatching to its worker
thread. Injected tests move civil time forward and backward independently,
advance monotonic time through bounded waits, reuse live PID slots with a new
start identity, hold a live claim beyond an apparent civil lease, and verify
that only the ownership evidence changes the result. The complete decision
table and compatibility policy are in `docs/TIME_SEMANTICS.md`.

### DD-12 — S4 — Rotating operational JSONL files can lose records under concurrent writers — resolved in Slice 18

**Evidence:** source-confirmed interleaving, qualified by low authority.

**Code:** `src/reindex/reindex-activity.ts:92-119` and `src/reindex/affected-shadow.ts:633-652` use size-check/remove/rename/append sequences without their own lock.

Two writers that both decide to rotate can rename or delete different generations of the log and split or lose records. Reindex serialization prevents most contention, and these files are operational evidence rather than source or index authority, so impact is limited.

**Recommended design:** use immutable sequence-named segments, or hold a token-owned rotation lock. Make readers tolerate a set of segments and partial final records.

**Required tests:** two writers cross at each rotation step; all complete records should remain readable or loss should be explicitly accepted and counted.

**Acceptance condition:** either rotation is serialized or the file is explicitly documented as lossy telemetry.

**Resolution:** `src/reindex/rotating-jsonl.ts` now owns the two-segment
protocol used by reindex activity and affected-set shadow history. One
process-instance lock serializes incomplete-tail repair, previous-segment
pruning, current rotation, append, and default retained-set reads. The wait is
monotonic and bounded; timeout and ownership-changed release are typed
failures. A configured limit smaller than one complete record expands to that
record's size, so a successful append remains a complete retained line.

The current segment is repaired only to its last newline after a partial
append. Readers scan legacy-compatible `.previous` and current segments in
that order, ignore an incomplete final tail, and report its byte count.
Injected phase tests attempt a second writer after tail repair, prior-segment
pruning, rename, and append; every attempt is excluded and succeeds on retry
without losing a complete retained line. Additional tests stop after rename,
recover a partial append, rotate three segments through the budget, and hold a
live lock through a zero-budget contender. The authority, crash, and
retention limits are documented in `docs/TELEMETRY_RETENTION.md`.

---

## 5. Detailed resilience and testability findings

### RES-01 — S3 — Production subprocesses do not share an enforced timeout and reap policy

**Evidence:** source-confirmed hostile-dependency path.

**Code:**

- `src/reindex/indexer-runner.ts:143-227` invokes every language indexer with a 50 MiB output buffer but no timeout. A silent indexer can hold both a manual reindex and the watch refresh state machine forever.
- `src/runtime/isolated-analysis-runner.ts:26-38` accepts `timeoutMs` for the synchronous JSON runner but never passes it to `spawnSync`. Its asynchronous sibling at `:50-108` treats the timeout as optional, sends one default termination signal, rejects immediately, and does not wait for process exit or escalate if the child ignores it.
- `src/analysis/git-history.ts:246-251`, `src/platform/git-worktree.ts:242-248`, `src/platform/project-files.ts:108-119`, `src/runtime/health-report-cache.ts:175-180`, and several `src/runtime/cleanup-verify.ts` Git calls have output ceilings in some cases but no execution deadline.
- Other subprocess boundaries already demonstrate the intended local policy: diff-impact Git calls, source-fileset discovery, project readiness, checker execution, TLA tools, and Rust worker subprocesses pass explicit timeouts.

The current API therefore permits a caller to believe it supplied a deadline that is not enforced, while semantically equivalent commands have different liveness guarantees depending on which helper they happen to use.

**Recommended design:**

- Define one production subprocess policy with a required operation label, timeout, stdout/stderr budget, and termination grace.
- Provide synchronous and asynchronous adapters that classify timeout, output-budget, spawn, signal, and exit failures distinctly.
- On asynchronous timeout, send the platform-appropriate graceful signal, drain output, wait a bounded grace period, escalate only after process-instance verification, and resolve only after the child is reaped.
- Give installation/build commands explicitly longer budgets rather than making absence of a budget mean infinity.
- Retry only operations whose error is classified as transient; do not serially retry every failed parallel indexer.

**Required tests:**

- Hostile child that never exits.
- Child that ignores the first termination signal.
- Child that fills stdout or stderr.
- Child that exits during the termination grace race.
- Synchronous runner assertion that the supplied timeout reaches `spawnSync`.
- Inventory test that every production subprocess call declares a timeout or an explicit reviewed exemption.

**Acceptance condition:** no production child process can consume unbounded wall time or remain unreaped after its parent reports timeout completion.

**Resolution:** Slice 02 adds a shared asynchronous bounded-process owner with
required time and independent stdout/stderr budgets, process-identity-aware
TERM-to-KILL escalation, continuous draining, and settlement only after
`close`. The isolated synchronous runner now forwards a hard timeout; the
asynchronous runner always has a finite default; indexers use a configurable
600-second deadline and retry only transient resource failures. Direct
production child-process calls now carry an inline timeout or an exact
lifetime-owner annotation, enforced by an AST inventory test. Hostile fixtures
cover ignored TERM, grace-period exit, stdout and stderr floods, spawn failure,
and sync timeout forwarding.

### RES-02 — S3 — Watch shutdown can strand or overlap an in-flight reindex child

**Evidence:** source-confirmed lifecycle gap.

**Code:**

- `src/runtime/watch.ts:330-367` forks a detached reindex worker with `stdio: "pipe"` but installs no stdout or stderr data handlers. Enough child output can fill an OS pipe and block the worker before exit.
- The watcher does not retain the active `ChildProcess`, impose a worker timeout, or record a bounded output tail for errors.
- `src/runtime/watch.ts:121-130` closes Chokidar watchers without awaiting them and immediately reports idle, while an accepted reindex promise can still be active.
- `src/runtime/watch-server.ts:244-253` then removes service state and activity and releases the watch lock. Another watch service can start while the prior detached child is still running. The reindex lock limits simultaneous publication but does not make the advertised service lifecycle truthful.

**Recommended design:**

- Inject a `ReindexRunner` boundary that returns an owned operation with a completion promise and cancellation/drain method.
- Consume stdout and stderr continuously with bounded tails.
- Make `Watcher.stop()` asynchronous: refuse new refreshes, close subscriptions, cancel or drain the current reindex according to an explicit shutdown budget, and report stopped only afterward.
- Keep watch state and ownership until drain completes. If forced cancellation cannot prove exit, retain an explicit degraded state rather than advertising no owner.

**Required tests:**

- Worker emits more than a pipe buffer before exit.
- Shutdown while the worker is running and while it is between TERM and exit.
- Worker ignores TERM and requires escalation.
- A second watcher attempts startup during drain.
- Chokidar close rejects.

**Acceptance condition:** releasing watch ownership proves that every accepted reindex child exited or remains represented by an explicit recoverable ownership record.

**Resolution:** Slice 04 replaces the detached fire-and-forget worker with an
owned `ReindexOperation`. The shared bounded-process runner continuously drains
both streams, retains independently bounded diagnostic tails, applies a
15-minute worker deadline, and makes cancellation settle only after child
`close`, including TERM-to-KILL escalation. `Watcher.stop()` is now a
single-flight asynchronous drain: it rejects new refresh requests, cancels the
active operation, awaits every subscription close (including synchronous
throws), and reports either `stopped` or a reason-bearing degraded result. The
background service persists `draining` before shutdown and removes state,
activity, and lock ownership only after a successful drain; a live draining
record is reused instead of replaced by a second service. Foreground SIGINT and
SIGTERM use the same drain and retain the lock on degraded shutdown. Tests cover
pipe-filling workers, bounded diagnostic tails, normal and TERM-resistant
children, concurrent child/subscription drain, synchronous and asynchronous
subscription failures, ignored post-stop refreshes, restart refusal during
drain, state decoding, and second-service reuse.

### RES-03 — S3 — Rust LSP framing accepts unbounded headers and bodies into process memory

**Evidence:** source-confirmed hostile-stream path.

**Code:** `src/semantic/rust/lsp-client.ts:292-313` concatenates every stdout chunk into one buffer. Before `\r\n\r\n` appears there is no header ceiling. After a `Content-Length` is parsed there is no maximum body length, finite-integer check, or total-buffer ceiling. A misbehaving or compromised `rust-analyzer` can therefore send an infinite header, declare a huge body and drip bytes indefinitely, or make `bodyStart + contentLength` exceed the safe numeric range. Request timeouts reject callers but do not clear the accumulated transport buffer or terminate the producer.

**Recommended design:**

- Define explicit maximum LSP header and message sizes, chosen above known rust-analyzer responses and configurable only within a safe overall ceiling.
- Parse `Content-Length` as a finite safe integer.
- Reject the transport once on malformed or oversized framing, clear buffered bytes, terminate the producer, and reject every pending and readiness waiter.
- Avoid repeated `Buffer.concat` growth by consuming a bounded chunk queue or preallocated frame body.

**Required tests:**

- Header exceeding the ceiling without a delimiter.
- Negative, non-numeric, duplicate-conflicting, and unsafe-integer lengths.
- Body length above the ceiling.
- Chunked frame exactly at the ceiling.
- Multiple valid frames split at every header/body boundary.
- Rejection proves the transport is killed and pending maps are drained.

**Acceptance condition:** rust-analyzer output has a hard memory bound independent of the bytes the child attempts to send.

**Resolution:** Slice 05 replaces repeated unbounded concatenation with a
two-phase fixed-capacity accumulator. It retains at most one 16 KiB header and
one declared 64 MiB message by default; constructor overrides are positive safe
integers and cannot exceed a 64 KiB header or 256 MiB combined wire-buffer
ceiling. The decoder accepts exactly one non-negative safe-integer
`Content-Length`, rejects duplicate or conflicting fields before body
allocation, and rejects declared bodies above the configured limit. Any
framing or JSON-object failure clears both phases, kills the transport once,
rejects pending requests and readiness waiters, resolves diagnostic waiters as
unavailable, and makes later requests fail without another write. Tests cover
unterminated headers, body declarations, negative/non-numeric/duplicate/
conflicting/unsafe lengths, invalid JSON, exact header and body boundaries,
multiple frames split one byte at a time, sticky rejection, waiter drainage,
and one-shot termination. The complete 163-test Rust semantic suite remains
green across batch, durable-session, mapping, cache, and provider consumers.

### RES-04 — S3 — Verified binary downloads have no deadline, byte ceiling, or collision-safe staging owner

**Evidence:** source-confirmed hostile-network and concurrent-call path.

**Code:** `src/platform/verified-binary-fetch.ts:49-75` calls `fetch` without an abort deadline, materializes the entire response with `arrayBuffer()` without checking `Content-Length` or streamed bytes, and stages at `${cachePath}.tmp-${process.pid}`. Two concurrent calls in one process target the same temporary path. A timeout, checksum failure after staging changes, write error, or rename failure has no `finally` cleanup. SHA-256 verification and atomic rename protect accepted bytes but do not bound the work needed to reach acceptance.

**Recommended design:**

- Require a download deadline and maximum byte count with conservative defaults.
- Stream the response while hashing and enforcing both advertised and observed byte limits.
- Use an exclusive unique temporary file containing a random operation token, flush it according to the durable-install contract, and remove it in `finally`.
- Coordinate concurrent fetches for one cache path with a token-owned lock or in-process single flight plus cross-process recheck.
- Preserve the checksum recheck after acquiring ownership so a winner can be reused.

**Required tests:**

- Never-resolving fetch aborted at the deadline.
- Missing, false, and oversized `Content-Length`.
- Stream exceeds the byte budget.
- Two callers fetch the same path concurrently.
- Crash/failure at write, flush, checksum, and rename stages leaves no accepted corrupt file and only reclaimable temp debris.

**Acceptance condition:** one download has bounded time and bytes, and concurrent callers cannot corrupt or steal each other's staging file.

**Resolution:** Slice 06 gives every verified fetch a five-minute deadline and
256 MiB default byte ceiling, both overridable through validated positive
options. Fetch and reader waits race the abort signal even when an injected
dependency ignores it. Successful bodies must be readable byte streams;
`Content-Length` may be absent, but if present it must be a non-negative safe
integer no larger than the configured ceiling and must equal the observed byte
count. Each chunk updates one incremental SHA-256 and is written through an
exclusive random-token staging descriptor, so no complete response is retained
in memory. A token-owned per-cache-path process lock serializes callers without
blocking the event loop; the winner's cache is checksum-rechecked under that
lock. All timeout, abort, HTTP, length, stream, checksum, write, and rename
paths close the descriptor, remove only the owned staging path, and release the
lock. The final promotion is visibility-atomic in this slice; Slice 08 will
switch it to the shared crash-durable install primitive. Tests cover ignored
abort signals, missing/malformed/oversized/short lengths, streamed overflow,
successful and timed-out contention, checksum failure, injected write/rename
failure, artifact cleanup, cache reuse, and the TLA consumer.

### RES-05 — S3 — Timed-out Vue workers are neither retained nor terminated

**Evidence:** source-confirmed opt-in failure path.

**Code:** `src/reindex/vue/augment-vue-workers.ts:19-66` constructs worker threads without storing their handles. On timeout or a worker-reported error, the `finally` block removes the result directory but cannot terminate the still-running workers. Those workers remain referenced, can keep the process alive, and can race writes into a removed directory. Parallel workers are opt-in today, but the advertised option has no safe failure lifecycle.

**Recommended design:**

- Retain every `Worker` handle and result identity.
- Make worker completion explicit rather than inferred solely from a shared counter.
- On any failure or timeout, terminate all unfinished workers and wait for their termination before deleting the result directory.
- Bound each result file before parsing and include worker/task identity in every payload.

**Required tests:**

- One worker hangs while peers finish.
- One worker reports an error while peers continue.
- Timeout terminates every worker before result-directory cleanup.
- Late worker message or write cannot affect a subsequent run.
- Successful multi-worker merge remains deterministic.

**Acceptance condition:** the coordinator cannot return or throw while an owned Vue worker can still run.

**Resolution:** Slice 07 replaces the synchronous `Atomics.wait` coordinator
with an event-driven async worker path used by the CLI. The established
`augmentVueResolvedReferences` export retains its synchronous result contract
and uses the reliable in-process computation; the additive
`augmentVueResolvedReferencesAsync` entry point activates calibrated parallel
workers. Each spawned handle is retained with a random run identity, stable
worker number, exact task identities, and a private result path. Exit, error,
peer failure, timeout, parse failure, and successful merge all converge on one
`Promise.allSettled(worker.terminate())` ownership barrier, and the result
directory is removed only after every termination settles. Result files are
bounded to 64 MiB by default before parsing, decoded structurally, and rejected
unless their run/worker/task identities match the coordinator's assignment.
Results merge in worker-number order. Real worker-thread tests cover success,
hang timeout, peer error, termination-before-removal, prevented late writes,
oversized output, wrong identity, and worker-reported failure; async
fingerprint-cache tests prove only settled successful computation is cached.

### TEST-01 — S4 — Watcher tests depend on private implementation members instead of an observable side-effect boundary

**Evidence:** unit-test design gap.

**Code:** `tests/runtime/watch.test.ts:47-49`, `:81-83`, `:112-114`, and `:137-139` replace the private `runReindex` method through casts. Other cases invoke `handleFileChange` and inspect `pendingTrigger` and `changedFiles` through private-member casts. This makes the suite sensitive to field names while leaving child drain, cancellation, and ownership behavior hard to drive deterministically.

**Recommended design:** introduce the `ReindexRunner`, clock/timer, and watcher-subscription boundaries required by RES-02; drive public refresh/start/stop behavior through those injected ports; observe calls, status, cancellation, and completion rather than private fields.

**Required tests:** rewrite every private-member test through the public API or a named exported pure policy function. Add an architecture test that rejects new private-member casts in watcher tests.

**Acceptance condition:** watcher lifecycle and state-machine behavior can be tested deterministically without accessing or replacing a private class member.

**Resolution:** Slice 03 adds explicit `ReindexRunner`,
`WatchSubscriptionFactory`, and `WatchClock` ports to `WatcherOptions`. The
runner receives a typed high-level request, while the named
`resolveReindexWorkerLaunch` adapter converts that request to the canonical
worker path and environment. Unit tests now drive refreshes through
`requestRefresh`, source events through injected subscriptions, and Git
polling through `start`; they observe runner requests, status, suppression,
errors, and public subscription handles rather than watcher fields. The linked
worktree integration tests use the same seam. A source contract fails on any
new `as unknown as` cast in either watcher test suite.

---

## 6. Detailed API-evolution findings

### API-01 — S2 — CLI JSON has no schema or producer version — resolved

**Evidence:** contract gap.

**Code:** `src/runtime/command-kit/command-execution.ts:334-365` emits `command`, evidence metadata, analysis budget, args, options, result, coverage, and optional agent result. It emits no envelope schema version or producer package version.

The coverage additions are useful and internally validated, but an agent or external script cannot distinguish an old result shape from a new one, cannot negotiate a breaking result change, and cannot explain differing output from two installed CLI versions.

**Recommended design:**

- Add a top-level envelope discriminator and integer `schemaVersion`.
- Add `producer: { name, version }`.
- Version command result payloads where their semantics can evolve independently.
- Treat additions as additive, preserve deprecated aliases for a stated window, and reserve breaking removal for a major contract version.
- Publish a machine-readable schema and keep fixtures from at least the previous supported version.

**Required tests:** parse current and previous-version golden outputs with the newest consumer; ensure an older fixture consumer ignores additive fields; reject unsupported major schema versions with an actionable error.

**Acceptance condition:** every JSON consumer can identify the producer and determine whether it understands the contract.

**Resolution (Slice 20):** `printJsonEnvelope` now emits
`kind: "scip-query-result"`, envelope `schemaVersion: 1`,
`producer: { name: "scip-query", version }`, and an independently evolvable
`resultSchemaVersion`. The public `scip-query/runtime` surface exports a
tolerant decoder that reads the previous unversioned envelope, preserves
unknown additive fields, rejects unknown envelope or command-result versions,
and reports producer context in compatibility errors.

The hidden health-phase and diff-impact batch messages no longer masquerade as
public CLI results. Their parent and child share a separately versioned
`scip-query-isolated-analysis` protocol whose decoder validates protocol,
schema, producer, command, and result before admission. Codex/Claude hook
messages remain on the host-defined hook schemas rather than receiving
unrecognized CLI fields.

The committed v0/v1 fixtures, descriptor-wide renderer matrix, internal
protocol tests, compact/pretty equivalence test, additive-field test, and
machine-readable JSON Schema make the compatibility claim executable. The
schema and consumer guide ship in the npm tarball.

### API-02 — S2 — The 72 npm export paths have no signature compatibility baseline — resolved in Slice 21

**Evidence:** contract gap.

**Code:**

- `package.json:23-312` publishes 72 export paths: the root, `./queries`, `./reindex`, `./runtime`, and 68 individual query subpaths.
- `tests/runtime/cli-contract.test.ts:395-445` correctly keeps query export membership synchronized with the public-query manifest.
- The test does not compare exported function signatures, required object fields, discriminated unions, or declaration meaning against a prior release.

A result field can become required, a union member can disappear, or a parameter can change while the export membership test remains green.

**Recommended design:**

- Generate and commit an API declaration report from the built `.d.ts` files.
- Compare it in CI and require an explicit semver classification for differences.
- Keep compile fixtures for representative downstream imports from root, query subpaths, reindex, and runtime.
- Define a deprecation window before removals and preserve aliases or adapters where feasible.

**Required tests:** compile the prior-release consumer fixture against the new package; prove additive changes pass and breaking signatures require an approved baseline update.

**Acceptance condition:** a release cannot change a public TypeScript signature without a reviewed compatibility diff.

**Resolution:** `scripts/api-surface-contract.mjs` now builds the declaration
surface behind all 72 package export paths. It resolves generated re-exports
through tsup's shared declaration chunks, records 871 exported declarations
with their actual value/type/class/function/constant kind and normalized
signature, and retains the eight shared chunks that define referenced public
types. Comments, whitespace, named import/export order, path separators, and
generated chunk hashes are normalized before the surface is hashed.

`docs/api/scip-query.api.json` is the content-addressed baseline. Its matching
record under `docs/api/changes/` binds the digest, package version, automatic
classification, reviewed classification, reason, and exact change list.
`api:check` rejects a missing declaration target, malformed or hand-edited
manifest, missing acceptance record, removed export/path, changed signature,
or referenced declaration drift. `api:update` requires an explicit
`additive`, `compatible-correction`, or `breaking` decision and refuses to
launder known or uncertain drift as additive.

The hostile contract matrix covers export removal/addition, optional-to-
required parameters, union narrowing and widening, optional and required
interface fields, declaration-target movement, normalization noise, transitive
re-export resolution, missing declaration files, missing baselines, and
unclassified drift. A preserved downstream fixture compiles imports from the
root, `queries/refs`, `reindex`, and `runtime` against each newly built package.
Both lint and `prepublishOnly` run the API check, so release cannot proceed on
an unreviewed declaration change.

### API-03 — S3 — `.scipquery.json` has no schema version or migration boundary — resolved in Slice 22

**Evidence:** contract gap.

**Code:**

- `src/runtime/config.ts:105-126` parses JSON and casts it directly to `ProjectConfig`.
- `src/domain/config-types.ts:106-137` defines no schema/version field.
- `src/runtime/config.ts:736-750` and its key sets reject or diagnose unknown fields.
- Most writers spread the existing object, which is a good unknown-field preservation habit when parsing succeeds.

Mixed-version teams cannot distinguish a typo from a valid field introduced by a newer client, and the runtime cannot migrate a field whose meaning changes. A future additive field may be treated as invalid by an older client even when it could safely ignore it.

**Recommended design:** add `$schema` and an integer format version, route all reads through one decoder, migrate old supported versions to a current internal model, and state whether unknown future fields are preserved, warned, or rejected by context.

**Required tests:** oldest supported config, current config, future additive unknown field, malformed version, and round-trip preservation by every config writer.

**Acceptance condition:** config meaning changes only through an explicit versioned migration.

**Resolution:** `.scipquery.json` now has a pure format decoder with readable
legacy v1 (unversioned or explicit), current v2, unsupported older/future, and
malformed outcomes. Every runtime reader enters through that boundary before
using a field. Current in-memory records retain unknown fields and receive the
packaged editor-schema hint; every authorized writer publishes v2 through the
existing revision-aware durable mutation boundary.

The migration fact participates in the write decision, so a setup action
upgrades a legacy record even when its requested field is already present.
Unrelated concurrent fields survive the latest-snapshot merge, while
same-field conflicts, malformed bytes, invalid discriminators, and future
versions leave the latest file byte-for-byte unchanged. The repository's own
config is migrated, the JSON Schema is packaged, and the public declaration
change is accepted through the TypeScript API contract.

### API-04 — S2 — Reindex metadata compatibility logic is duplicated across at least seven consumers — resolved in Slice 19

**Evidence:** source-confirmed contract drift.

**Code:** raw version-2/version-3 checks appear independently in:

- `src/storage/evidence-cache.ts:175-179`;
- `src/semantic/typescript/session-protocol.ts:59-86`;
- `src/reindex/typescript-index-protocol.ts:100-116`;
- `src/reindex/sqlite-generation-store.ts:266-278`;
- `src/reindex/index.ts:2243-2263`;
- `src/runtime/index-freshness.ts:57-61`;
- additional metadata paths in `src/reindex/index.ts`.

These consumers already apply different completeness rules: evidence caching accepts complete or partial metadata, while generation and freshness paths require complete metadata. The policy differences may be intentional, but version decoding and capability recognition are repeated.

A future version 4 can therefore make freshness accept a generation that semantic sessions reject, or make evidence fingerprinting disagree with shared publication.

**Recommended design:**

- Introduce one `parseReindexMetadata` decoder that validates and migrates every supported format.
- Return a current semantic model plus named capabilities such as `usableForQuery`, `usableForEvidenceCache`, and `publishableGeneration`.
- Keep intentional completeness differences as named policy predicates, not repeated raw version checks.

**Required tests:** a matrix of every supported metadata version/status against every consumer capability, plus an unsupported-future-version case.

**Acceptance condition:** adding a metadata version requires one decoder update and one reviewed capability matrix, not edits to scattered readers.

**Resolution:** `src/domain/reindex-metadata.ts` now classifies raw metadata as
legacy v2, supported v3, unsupported older/future, or malformed. It validates
status, timestamps, unique supported language sets,
skipped-language rows, SCIP companion state, and v3 shard maps before a
consumer receives a typed record. Version 4 is reserved and remains visibly
unsupported.

Named capabilities preserve the intentional policy differences: evidence and
semantic cache identities can use complete or partial records with a
fingerprint; freshness, unchanged reuse, and shared publication require a
complete object fingerprint plus indexed languages; stable service/generation
identities additionally require `updatedAt`; v3 shard maps separately enable
language and project reuse. Freshness, evidence cache, TypeScript semantic
identity/session state, TypeScript index generation, SQLite generation
identity, reindex reuse, and shared-generation admission now enter through the
decoder. The shared fixture matrix, wrong-field mutations, future-version
consumer tests, and compatibility policy are in
`docs/REINDEX_METADATA_COMPATIBILITY.md`.

### API-05 — S2 — Committed suppression and outcome records are unversioned

**Evidence:** contract gap.

**Code:**

- `src/storage/suppression-store.ts:46-99` writes and parses suppression objects without a schema version.
- `src/storage/outcome-events.ts:58-82` writes immutable event files without a version.
- `src/storage/outcome-events.ts:133-180` silently returns `null` for malformed or unknown event kinds.
- `src/domain/finding-outcomes.ts:30-46` defines the current event union but no wire-format version.

The immutable one-file-per-event design is excellent for Git merging and replay idempotency. The evolution problem is that an older binary silently drops an event introduced by a newer binary, making team-shared effectiveness history look complete while undercounting it. Suppressions have the same ambiguity between malformed, future, and current records.

**Recommended design:**

- Add a record discriminator and schema version to each committed file.
- Decode through version-specific validators and migrate to the current model.
- Report unsupported versions as explicit incomplete coverage; do not silently omit them from totals.
- Preserve immutable event paths and read-side deduplication.

**Required tests:** old/current/future records, unknown event kinds, mixed-version repositories, and round-trip preservation.

**Acceptance condition:** readers can distinguish “no event” from “event exists but this binary cannot interpret it.”

**Resolution:** Slice 13 had already moved suppression files to a v1 writer
with an unversioned overlap reader, stable identity, producer metadata, and
compare-and-replace. API-05 retained that protocol and added the
`scip-query-suppression` discriminator as an additive v1 field; current
readers continue to accept unversioned records and pre-discriminator v1
records.

Outcome events now use an additive v1 envelope containing the
`scip-query-outcome-event` discriminator, stable semantic event identity, and
producer metadata while retaining the old semantic fields at the root. The
immediately prior permissive reader can therefore consume new files, and the
current reader accepts all 484 existing unversioned repository events without
rewriting them.

Both stores classify every JSON candidate as readable legacy/current,
unsupported older/future, or malformed. Their exact summaries conserve
`accepted + omitted = total` and carry path-specific issues. `diff-gate`
includes suppression compatibility even for an empty source diff and surfaces
partial policy coverage in JSON, human output, and Stop-hook feedback without
letting an incompatible file authorize suppression. `effectiveness` publishes
outcome compatibility beside partial metrics. Cross-HEAD verification retains
missing findings whenever event history is incomplete, so an omitted event
can delay a verified repair but cannot manufacture one.

Legacy JSONL migration now copies compatible rows idempotently but preserves
the source ledger and reports a warning if any non-empty line is incompatible;
the merge attribute is removed only after complete migration. The schemas,
overlap window, merge rules, and recovery process are documented in
`docs/COMMITTED_RECORD_COMPATIBILITY.md` and the two packaged schemas under
`docs/schemas/`. Mixed old/current/future, unknown-kind, malformed-identity,
partial-migration, empty-diff disclosure, dedupe, rollback-shape, and
fail-closed reconciliation tests cover the acceptance condition.

### API-06 — S3 — Rust mailbox needs a complete session-identity and compatibility contract

**Evidence:** pre-Slice-16 contract gap, partially resolved by the shared
mailbox lifecycle.

**Code:**

- `src/semantic/rust/durable-session.ts:358-405` writes `{ id, request }` and parses a response without checking an echoed request ID or protocol version.
- `src/semantic/rust/durable-session-server.ts:19-55` validates only enough to cast a `DurableRustSessionRequest`; responses contain no protocol version, request ID, or server/session identity.
- The durable server's `server.json` is versioned and the session directory is tied to a server binary fingerprint elsewhere, which reduces mixed-binary risk.
- TypeScript envelopes, by contrast, validate protocol, ID, deadline, and generation/base generation.

Slice 16 advanced Rust requests and responses to protocol version 3, added
absolute request deadlines and stable operation/request correlation, rejects
explicit unknown protocol versions, and retained the former unversioned
request as a bounded legacy read. The remaining gap is strict domain-kind
validation, echoed durable-session identity, response-expiry acceptance, and
an executable old/current/future compatibility matrix—not queue lifecycle.

**Recommended design:** validate every Rust request kind and required field,
echo durable-session identity alongside the already versioned request and
operation IDs, enforce response expiry, and make supported legacy/current and
unsupported future behavior an explicit compatibility fixture.

**Required tests:** malformed kind, wrong ID, wrong protocol, stale response, newer server/older client, and older server/newer client.

**Acceptance condition:** a Rust response is accepted only when it proves which request and protocol produced it.

**Resolution:** Slice 24 moved the Rust wire contract into a dependency-light
decoder shared by the requester and helper. A current request is accepted only
after mailbox version, protocol version, request ID, operation key, client,
enqueue/deadline pair, mailbox-session identity, request kind, inner payload,
and timeout/deadline congruence validate. The helper derives the namespace
identity independently from its absolute session directory and recomputes the
operation key from the validated request before calling rust-analyzer.

The response now echoes the mailbox-session identity and authoritative
deadline. The client checks protocol, mailbox, request, operation, session,
deadline, completion time, observation time, session disposition, and
kind-specific response shape before exposing a result. `unsupported-protocol`,
`malformed-request`, `expired-request`, and `handler-error` make safely
correlated rejections executable rather than free-text casts. Work is checked
against the absolute deadline both before and after the host call.

Exact retries still converge on one logical operation. The bounded mailbox now
returns the deadline from the authoritative pending, inflight, or completed
record, and every current completion preserves that deadline, so a duplicate
caller cannot substitute its later attempt deadline. This retained Slice 16's
idempotency contract while making deadline equality enforceable.

The overlap reader accepts the former unversioned request and the immediately
prior v3 request without a session field; partial version metadata is
rejected, explicit future versions are never treated as legacy, and a prior
v3 server response is rejected by the current client as uncorrelated. The
compatibility and recovery matrix is documented in
`docs/RUST_DURABLE_SESSION_PROTOCOL.md`. Pure request/response mutation tests,
server-shell tests, and the shared mailbox suite cover every required case.

---

## 7. Windows sidecar release findings

### REL-01 — S2 — Existing Windows binaries can be stale and still pass prepublish

**Evidence:** source-confirmed release gap.

**Code:**

- `scripts/publish-scip-windows.ts:32-38` builds only when either expected filename is absent.
- `scripts/build-scip-windows.mjs:8-9` selects source repository and SCIP tag, currently defaulting to `v0.8.1`.
- `packages/scip-windows/package.json:1-19` includes the two binaries, license, and README but no provenance or checksum manifest.

At the audited revision, the files are valid Windows PE binaries, and their observed SHA-256 values were:

- x64: `891ebc6315f8b50371a70b3d677c47dc3c1d097f3002d5b96658c2f3393d531b`
- arm64: `ba2c566d4e820fe38e51695849bf2de3d003294b8f8f272befbfa9c59e97ceb0`

Those facts prove file type and identity, not provenance. If `SCIP_VERSION`, source, build flags, or the sidecar package version changes while the old files remain, prepublish skips the build and publishes the old bytes.

**Recommended design:**

- Generate a committed provenance manifest containing source URL, immutable source commit, tag, Go version, build flags, target, file size, and SHA-256.
- Verify the manifest, PE machine architecture, and hashes during prepublish.
- Prefer a clean trusted-CI rebuild for releases; otherwise verify an attestation produced by that build.

**Required tests:** wrong architecture, stale hash, changed source version with existing binaries, missing manifest, and correct reproducible manifest.

**Acceptance condition:** file presence alone can never authorize publication.

**Resolution:** Slice 25 replaced the presence check with a versioned executable
provenance contract. `packages/scip-windows/provenance.json` binds sidecar
package name/version, upstream repository and tag, immutable source commit,
pinned Go version, command, build flags, environment, target triples, PE
machine codes, sizes, and SHA-256 values for both ignored executable files.
The dependency-light decoder rejects malformed and future records, while the
verifier requires the current repository/tag/toolchain/build contract and
observes the PE32+ header and exact bytes itself.

The build now checks the pinned Go toolchain before cloning, builds both
targets in private staging, generates the manifest from staged bytes, promotes
only after both targets exist, and verifies the installed result. A failed
second target promotes nothing; an interrupted per-file promotion cannot
authorize release because the next complete verification rejects any mixed
set.

`npm run verify:scip-windows`, the sidecar package's `prepack`, and the main
prepublish release entry all execute the same verifier. Existing filenames no
longer trigger an automatic trust path or rebuild: stale or missing evidence
fails before any registry command. The checked-in current record is grounded
in the executables' observed SCIP `v0.8.1`/commit
`bf70486060b71bed40f3d6dd19c96da4b3239ead`, Go `1.26.4`, clean VCS state,
Windows target, PE machine, file size, and SHA-256 evidence.

The public schema, authority, trusted-rebuild procedure, failure/recovery
matrix, and unsigned-attestation limit are documented in
`docs/WINDOWS_SIDECAR_RELEASE.md`. Mutation tests cover stale bytes, swapped
architectures, source/tag/toolchain/flag/package drift, malformed and future
records, build failure, and release-time failure before registry access.

### REL-02 — S2 — “Already published” checks version existence, not content identity

**Evidence:** source-confirmed release gap.

**Code:** `scripts/publish-scip-windows.ts:47-64` runs `npm view <name>@<version> version` and skips publication when the returned string equals the local version.

If local package bytes differ from the already-published immutable npm version, the script reports the sidecar ready and continues. The changed local bytes cannot ship without a version bump, but the release command does not surface that fact.

**Recommended design:**

- Pack the local sidecar deterministically.
- Compare its npm integrity/shasum and provenance manifest with registry metadata or the downloaded registry tarball.
- Skip only when identities match. Fail with “sidecar content changed; bump its version” when they do not.
- On registry/network ambiguity, fail rather than converting every error into “not published.”

**Required tests:** same version/same bytes, same version/different bytes, 404, auth error, timeout, and registry response corruption.

**Acceptance condition:** an existing version is accepted only when its published content is the intended content.

**Resolution (Slice 26):** `scripts/scip-windows-package-identity.ts` now
decodes one npm pack report, rereads the named tarball, recomputes its
SHA-1/SHA-512/size, extracts and decodes the packed provenance under a bounded
gzip/tar reader, and binds the manifest's package coordinate to the tarball
coordinate. `scripts/scip-windows-release.ts` packs the local sidecar before
registry work, verifies that the packed manifest bytes equal the reviewed
local manifest, reads exact npm `dist` metadata under a finite deadline, and
downloads an existing tarball with lifecycle scripts disabled. It skips only
when registry metadata, downloaded hashes, local hashes, package coordinate,
and manifest bytes all agree.

Only an explicit npm `E404` is absence. Authentication, timeout, output-limit,
spawn, generic “not found,” corrupt JSON, invalid metadata, and downloaded
hash mismatches fail closed. The absent branch publishes the already verified
local `.tgz`; a publish failure rereads registry state and continues only
when a concurrent winner has the identical complete identity.

The implementation found this exact defect in current release state:
published `scip-query-scip-windows@0.13.0` contains five entries and no
`provenance.json`, while the reviewed local pack contains six entries. The
gate rejected same-version reuse, so the first provenance-bearing package and
the main optional-dependency pin are now `0.13.1`. A read-only live npm check
then proved `0.13.1` absent and ready for its first publish; direct and npm
dry-run paths pack locally without reading or mutating the registry.

The 21 identity/release tests plus 13 provenance and 3 package-lifecycle
assertions cover honest and dishonest npm reports, same/different/missing
provenance, corrupt downloads, bounded gzip/tar parsing, exact `E404`,
ambiguous failures, absent publication, identical/different conflict winners,
explicit verification-only authority, inherited-environment isolation, and
real subprocess exit/timeout/output-limit classification.

### REL-03 — S3 — Main and sidecar publication is an ordered workflow, not one atomic release

**Evidence:** hardening gap.

**Code:**

- `package.json:327` runs `vite-node scripts/publish-scip-windows.ts && npm run build` in `prepublishOnly`.
- `scripts/publish-scip-windows.ts:47-53` publishes the sidecar before allowing the main package's build and npm publication to continue.

If sidecar publication succeeds and the main build or main publication fails, the sidecar version remains published without its intended main consumer. This is recoverable because the sidecar is independently versioned, but the comment “ship BOTH packages in one command” can be mistaken for an all-or-nothing guarantee.

Two concurrent release processes can both observe the version as absent; one publishes successfully, the other fails its sidecar publish and aborts the main release even though the desired version now exists.

**Recommended design:**

- Build, test, and pack both packages before any registry mutation.
- Publish the sidecar first, then verify its registry integrity, then publish the main package last.
- On a publish conflict, reread registry state and continue only if content identity matches.
- Record partial release state and make retry instructions explicit.
- Do not claim transactionality; npm cannot atomically publish two packages.

**Required tests:** simulated registry with sidecar success/main failure, concurrent publisher conflict, sidecar conflict with matching bytes, conflict with different bytes, and retry.

**Acceptance condition:** every partial state is detectable, safe to retry, and incapable of pairing a main version with unintended sidecar bytes.

**Resolution (Slice 27):** `scripts/npm-release.ts` is now the sole
publishing CLI and owns the complete pair. It acquires the shared release
lock; requires one clean, unchanged Git revision and an empty complete
tracked/untracked status; runs typecheck, the full suite, and the
lint/build/API/consumer/skill-link gate; verifies sidecar provenance; and packs
both artifacts before any registry read or mutation. It extracts the packed
package manifests and proves that the packed main tarball pins the packed
sidecar coordinate.

Before the first registry observation, the coordinator resolves one canonical
credential-free HTTPS npm registry and durably writes a schema-v1 local record
that binds that registry, the source revision, both exact tarball sizes and
digests, writer identity, and completed facts. Every registry view, download,
and publish receives the retained URL explicitly. The path is stable for the
coordinate pair, so changed registry, source, or bytes under the same
immutable versions conflict before registry work. Stage advancement is
canonical and clock-rollback safe. Every run freshly reconciles both registry
coordinates; the record describes recovery history but never authorizes
skipping registry truth.

Publication is sidecar first and main last. Each publish is followed by
bounded visibility retries and a complete metadata/download/local identity
comparison. A failed command is accepted only when an identical concurrent
winner becomes visible. The sidecar-verification helper no longer infers
publication authority from npm lifecycle environment: local-only,
registry-verification, and publish capabilities are explicit, and no
sidecar-only publishing CLI remains. Root `prepublishOnly` refuses direct
`npm publish`; the coordinator publishes its already verified tarballs with
lifecycle scripts disabled.

The recovery matrix covers both packages absent, either package already
exact, both exact, sidecar success/main failure, failed durable writes before
and after registry mutation, five crash points, matching and mismatching
concurrent winners, corrupt/future state, changed same-version source,
registry, or bytes, dirty or changing Git state, registry ambiguity, bounded
post-publication visibility, tracked and untracked package inputs, lock
contention/ownership loss, and cleanup failure without diagnostic masking.
The local state schema, operator sequence, trust boundary, and every
partial-state recovery are documented in `docs/WINDOWS_SIDECAR_RELEASE.md`.

---

## 8. Designs that should be preserved

### 8.1 Incremental SQLite candidate publication

`src/reindex/incremental-sqlite-publication.ts:102-171` validates source databases, copies the prior accepted generation into a private candidate, patches through an immediate SQLite transaction, checks schema and uniqueness, runs `integrity_check` and `foreign_key_check`, and compares affected-fact digests before acceptance. Concurrent work cannot partially mutate the stable accepted database.

The fix for DD-01 should change the stable handoff and reader binding, not weaken private candidate construction.

### 8.2 Content-addressed shared generations

`src/reindex/shared-generation-store.ts:209-294` hashes every artifact, builds in a unique staging directory, writes a manifest, and atomically renames the complete directory. A raced publisher validates and accepts the winner. Manifest parsing at `:688-727` validates version, producer identity, paths, checksums, uniqueness, and required artifacts.

This is the strongest distributed-data design in the audited surface. The DD-07 lease fix should retain immutable generation directories and the repository GC lock.

### 8.3 Rebuildable evidence-cache contract

`src/storage/evidence-cache.ts:204-210` uses WAL, a busy timeout, and `synchronous = NORMAL` under an explicit rebuildable-cache rationale. Writes use transactions, and result reads are tied to content and project fingerprints. Concurrent obsolete writes generally reduce hit rate rather than returning wrong-key evidence.

DD-09 concerns the mutable observational ledger inside the same database, not the fingerprinted evidence rows.

### 8.4 Immutable outcome-event identities

`src/storage/outcome-events.ts:44-82` writes one file per event with exclusive create and a content-derived filename; exact replay is idempotent, and `dedupeEvents` collapses merged duplicates. This is a sound Git-distributed event model. API-05 should add versioned envelopes without replacing the independent-file structure.

### 8.5 Token-owned generic lock release

`src/platform/repository-cache-lock.ts:91-125` uses an exclusive reclaim file, rechecks raw observed content, refuses to reclaim a changed/live record, and deletes a lock on release only when PID and random token still match. That is the correct ownership shape for a non-expiring file lock.

The missing case is malformed observation recovery, and PID birth identity remains necessary where the tool sends signals.

### 8.6 Mailbox correlation and retained completion

TypeScript request and response envelopes include protocol version, stable
operation and request identity, deadline, and generation or base generation.
Responses are parsed against expected identity. Slice 16 extended the same
correlation fields and lifecycle states to Rust because a retained completion
cannot be safe without them. API-06 still owns the formal compatibility
fixture, schema inventory, and supported-version policy audit; it no longer
needs to invent a separate Rust queue mechanism.

### 8.7 Conservative shared-cache garbage collection

The shared cache serializes lease reachability changes and collection, validates ownership checksums, constrains deletion to managed paths, and treats artifacts as rebuildable. The identified stale touch can cause unnecessary recomputation, but the collector's conservative path checks materially limit destructive scope.

---

## 9. Rejected or qualified suspicions

These items were investigated and should not be filed as defects without new evidence:

1. **No generic fencing-token defect was found.** The principal process-file locks do not expire a live owner. Token-checked release prevents an old owner from deleting a successor. Fencing becomes necessary only if the design starts expiring/stealing live ownership or if a protected publisher does not check current ownership.
2. **Old SQLite readers are not themselves unsafe.** SQLite retaining the old inode is a useful snapshot property. DD-01 arises only because other files are reread from the new stable path and attributed to that old snapshot.
3. **Fingerprint-keyed evidence cache writes do not normally return stale evidence.** A stale writer can waste storage or reduce hit rate; current reads compare the relevant content/project identity before accepting a hit.
4. **The shared generation publisher is not a partial-directory publication path.** It stages, hashes, and renames an immutable directory, and validates a race winner.
5. **JSONL append without rotation was not shown to corrupt authoritative data.** DD-12 is limited to the uncoordinated rotation path and operational telemetry.
6. **Random mailbox IDs solve correlation, not idempotency.** They are a positive property, but a retried logical operation receives a new ID and can run twice unless the protocol adds a stable operation key.
7. **`synchronous = NORMAL` is appropriate for rebuildable cache rows.** The durability concern applies only when the same helper or database stores non-rebuildable policy or ownership state.
8. **The shared repository cache is not unbounded by design.** Automatic sweeps run on CLI/watch activity, use a one-hour generation TTL and a two-GiB default budget, and preserve live leases. A currently unreferenced generation inside the grace period is expected, not a leak.
9. **Per-database semantic maps are scoped to an open database/session.** The inspected maps are keyed by indexed symbols or files from that repository and are released with the database or service; no cross-repository process-global query-key cache was found.

---

## 10. Required fault-injection and compatibility test matrix

| Test ID | Boundary              | Forced event                                            | Invariant                                                                    |
| ------- | --------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| FI-01   | Stable generation     | Pause after SCIP, DB, and metadata handoff stages       | One response never combines artifacts or identity from different generations |
| FI-02   | Result cursor         | Publish changed sorted refs between pages               | Continue immutable generation or reject; never skip/duplicate silently       |
| FI-03   | Semantic request      | Reuse numeric symbol IDs differently across generations | Remote service resolves only the requester's pinned generation               |
| FI-04   | Watch process         | Reuse PID with different birth identity                 | No signal is sent                                                            |
| FI-05   | Reindex preemption    | Reuse PID/process group                                 | No TERM/KILL is sent                                                         |
| FI-06   | Watch refresh         | Activity stale-read crosses refresh write               | Refresh remains pending or is acknowledged                                   |
| FI-07   | Lock creation         | Crash after exclusive create, before metadata write     | One recovery owner reclaims safely                                           |
| FI-08   | Lock release          | Successor replaces lock before old release              | Old owner cannot remove successor                                            |
| FI-09   | Config/hook setup     | User edit between read and write                        | Latest unrelated content survives or explicit conflict                       |
| FI-10   | Suppression           | Two distinct reasons target same finding concurrently   | Conflict is visible; neither is silently erased                              |
| FI-11   | Worktree lease        | Publish G2 while G touch waits for lock                 | Final lease remains G2                                                       |
| FI-12   | Atomic JSON           | Failure at each write/flush/rename stage                | Stated visibility/durability contract holds                                  |
| FI-13   | Outcome counter       | Two connections observe same finding                    | Both distinct observations count                                             |
| FI-14   | Mailbox               | Client dies before/after claim                          | Work is bounded and debris is collected                                      |
| FI-15   | Mailbox               | Server dies before/after response                       | Replay semantics are explicit and correlation holds                          |
| FI-16   | Mailbox               | Queue exceeds count/byte budget                         | New work receives explicit backpressure                                      |
| FI-17   | Clock                 | Forward/backward wall-clock jump                        | Monotonic waits remain bounded; no ownership signal follows                  |
| FI-18   | CLI JSON              | New producer adds fields                                | Supported older fixture remains parseable                                    |
| FI-19   | npm API               | Required field or union member changes                  | Compatibility diff blocks unclassified release                               |
| FI-20   | Config/metadata       | Read old/current/future schema                          | Migrate supported, report unsupported, preserve safe unknowns                |
| FI-21   | Committed records     | Older client sees future event/suppression              | Reports incomplete compatibility instead of silently dropping                |
| FI-22   | Rust mailbox          | Wrong version, ID, session, or expired request          | Reject with explicit protocol error                                          |
| FI-23   | Sidecar build         | Existing binary hash mismatches provenance              | Prepublish fails                                                             |
| FI-24   | Registry              | Existing version has different tarball identity         | Release fails and demands version bump                                       |
| FI-25   | Multi-package release | Sidecar succeeds, main fails                            | Partial state is recorded and retry is safe                                  |
| FI-26   | Subprocess policy     | Child hangs, floods output, or ignores TERM             | Parent times out, bounds output, escalates safely, and reaps                 |
| FI-27   | Watch lifecycle       | Stop during reindex and Chokidar shutdown               | Ownership remains until child/subscriptions are drained                      |
| FI-28   | Rust LSP framing      | Oversized or malformed header/body                      | Transport fails once within a fixed memory budget                            |
| FI-29   | Binary download       | Slow, oversized, or concurrent response                 | Deadline/byte limits hold and accepted cache remains checksum-valid          |
| FI-30   | Vue workers           | One worker hangs while peers finish                     | Every worker terminates before coordinator cleanup                           |
| FI-31   | Watcher tests         | Internal field and method names change                  | Behavior tests remain stable and use only public/injected boundaries         |

The concurrency tests should use explicit barriers or injected stage callbacks, not timing sleeps. A barrier makes the harmful order a deterministic unit test rather than a probabilistic stress test.

---

## 11. Recommended remediation order

The order below follows causal risk and shared infrastructure, not file proximity.

### Phase 0 — Process safety

1. Add process birth identity/control-channel authentication.
2. Require it before watch stop/replacement and reindex preemption.
3. Add PID-reuse tests before changing any lock-stealing behavior.

### Phase 1 — Bounded execution and truthful shutdown

1. Introduce the shared subprocess timeout, output-budget, termination, and reap policy.
2. Give the watch reindex child an owned runner and asynchronous drain.
3. Bound Rust LSP frames and verified binary downloads.
4. Retain and terminate Vue workers on every failure path.
5. Rewrite watcher tests around the injected runner and observable status.

### Phase 2 — Generation integrity

1. Define the generation handle and its invariants.
2. Bind `ScipDatabase`, metadata, semantic requests, evidence fingerprints, and pagination to it.
3. Replace multi-file stable-path observation with an immutable-generation pointer or a validated open/retry protocol.
4. Run FI-01 through FI-03 at every publication stage.

### Phase 3 — Lost-update removal

1. Separate refresh intent from watch activity.
2. Add optimistic revision/lock/retry helpers for config, hook, and managed Markdown changes.
3. Make suppression changes conflict-aware.
4. Move worktree lease reads inside the repository lock.
5. Replace outcome ledger read/replace transitions with database-native atomic updates.

### Phase 4 — Lock, durability, and mailbox lifecycle

1. Standardize token-owned lock records and malformed-record recovery.
2. Split visibility-atomic and durable JSON helpers.
3. Add pending/inflight/response mailbox states, expiry, cleanup, ordering, and backpressure.
4. Move same-process elapsed waits to monotonic time.

### Phase 5 — Versioned contracts

1. Version CLI JSON first because it is the broadest agent-facing boundary.
2. Centralize reindex metadata decoding.
3. Version `.scipquery.json`, suppressions, outcome events, and Rust envelopes.
4. Generate the TypeScript declaration compatibility baseline.

### Phase 6 — Release provenance

1. Produce and verify the Windows binary provenance manifest.
2. Compare local tarball identity with npm before accepting an existing version.
3. Build and pack both packages before publishing either.
4. Test and document the recoverable partial-release states.

### Phase 7 — Low-risk operational hardening

1. Make JSONL rotation serial or segment-based.
2. Add telemetry for reclaimed locks, expired mailbox work, queue pressure, config conflicts, and partial releases.

---

## 12. Definition of done for the remediation program

The program is complete when all of the following are true:

- Every authoritative index response is bound to one retained generation.
- No process is signaled from PID evidence alone.
- Every durable intent has an acknowledgment or remains recoverably pending.
- Every read-modify-write boundary either serializes the read with the write or checks that its input revision is still current.
- Every lock is recoverable after partial creation and can only be released by its owner.
- Every mailbox item has a version, identity, expiry, bounded lifecycle, and declared replay behavior.
- Every externally consumed JSON/file contract declares a version and unsupported records are visible.
- Every published TypeScript signature change receives a compatibility classification.
- Every Windows binary is tied to source and build provenance, and registry equality means byte equality.
- Every subprocess, worker, download, and framed transport has an enforced time/byte/lifecycle budget.
- Watch ownership is released only after subscriptions and in-flight reindex work are drained.
- Watcher lifecycle tests observe public behavior and injected side-effect boundaries rather than private members.
- Fault-injection tests cover the adverse interleavings listed in §10 without relying on sleep timing.
- Existing strong mechanisms—private SQLite candidate validation, immutable shared generations, fingerprinted cache reads, immutable outcome-event files, and token-owned release—remain intact.

With DD-02 resolved, the repository should treat DD-01
generation-sensitive pagination/semantic delegation as the highest-risk
remaining operational surface. Process preemption now fails closed on missing
or mismatched process-instance evidence.
