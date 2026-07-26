# Distributed State, Resilience, and Contract Remediation Plan

Date: 2026-07-25  
Status: approved for execution  
Issue register: `docs/reviews/2026-07-25-distributed-data-and-api-evolution-audit.md`  
Target revision at planning start: `bb02f0169bdda7b6598051a2b83caea454f684da`

## 1. Objective

Resolve every one of the 27 source-confirmed findings in the issue register without weakening the repository's existing private-candidate validation, immutable shared generations, fingerprinted evidence cache, immutable outcome-event identities, token-owned release checks, or TypeScript mailbox correlation.

Each finding is one implementation slice. A slice is a reviewable change unit distinguished from a phase by having one behavioral invariant, its own fault-injection or compatibility tests, its own documentation update, and a revertable commit. Shared infrastructure may be introduced by the earliest slice that needs it, but later findings do not disappear into that infrastructure: their own adverse behavior and acceptance condition must still be tested in their own slice.

## 2. High-assurance premises

The implementation may proceed only while these premises remain true:

1. One externally meaningful index response must derive every row, symbol identifier, metadata claim, cursor, and semantic request identity from one retained generation.
2. A process ID names a reusable operating-system slot, not a process instance. Destructive signaling therefore requires both a PID and evidence that the current occupant is the recorded process instance.
3. Accepted durable intent is complete only when acknowledged or still recoverably pending. A heartbeat or activity update is not an acknowledgment.
4. A writer that promises to preserve unrelated fields must either serialize its read with its write or prove that the input revision did not change.
5. A lock owner is the process instance and random token recorded by an exclusively created lock. Only that owner may release the lock, and partial creation must have a safe recovery rule.
6. Every subprocess, worker, download, queue, and framed byte stream must have enforced time, byte, count, and termination bounds appropriate to its boundary.
7. A public or durable contract must identify its schema version and producer. Readers must distinguish supported legacy data, current data, and unsupported future data.
8. Migration must preserve an overlap window: new readers accept supported old records, new writers emit the current format, and unsupported future records are reported rather than silently dropped.
9. An npm version is one immutable tarball identity. The Windows sidecar may be treated as already published only when local intended bytes equal registry bytes.
10. npm cannot atomically publish two packages. Release safety must come from preflight, ordered publication, identity verification, and explicit recoverable partial state rather than a false transaction claim.
11. Tests must observe public behavior or injected side-effect boundaries. Private field names, wall-clock sleeps, and decorative self-comparison are not correctness oracles.
12. Any newly discovered fact that contradicts a premise pauses the dependent slice and revises this plan and the issue register before code continues.

## 3. State-authority inventory

| Authority                         | Accepted writers                            | Dependent readers                                        | Required write model                                                 | Failure policy                                                        |
| --------------------------------- | ------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Current index generation pointer  | Reindex publisher and shared-cache hydrator | Database opener, freshness, cursors, semantic requesters | Build immutable generation, validate, then switch one pointer        | Retain prior generation; reject mixed or missing artifacts            |
| Watch process identity and state  | Watch server                                | Controller, command auto-start, cache GC                 | Versioned state plus verified process birth identity                 | Fail closed when identity cannot be verified                          |
| Reindex ownership                 | Manual or watch-triggered reindex           | Competing reindex, preemption                            | Exclusive token-owned lock with process identity                     | Reclaim only malformed/dead proven records; never signal on ambiguity |
| Watch refresh intent              | Command clients                             | Watch server                                             | Immutable pending request, atomic claim, explicit completion         | Leave pending or reclaim expired inflight work                        |
| User/project configuration        | User and setup/hook writers                 | Runtime and agents                                       | Revision-checked merge plus atomic/durable replacement               | Retry boundedly or report conflict with preserved file                |
| Suppression policy                | User and agents                             | Diff gate and health                                     | Exclusive create or identity-checked replace                         | Surface same-finding policy conflicts                                 |
| Worktree lease                    | Shared publisher, attach, touch             | Cache garbage collector                                  | Read and replace beneath repository lock                             | Newer generation ownership always wins                                |
| Finding outcome counters          | Health/diff-gate processes                  | Effectiveness reports                                    | SQLite atomic upsert/increment transaction                           | Busy retry within budget; never read/replace counters                 |
| TypeScript/Rust mailboxes         | CLI clients and services                    | Opposite process                                         | Versioned pending/inflight/response states with deadlines and quotas | Explicit backpressure, expiry, orphan recovery                        |
| CLI JSON envelope                 | Every JSON-emitting command                 | Agents, scripts, library users                           | Additive versioned envelope from one renderer                        | Compatibility fixture and schema checks                               |
| Reindex/config/record formats     | Current writer                              | Current and supported older/newer readers                | Central version-dispatch decoder                                     | Report unsupported future versions as incomplete                      |
| Published TypeScript declarations | Package build                               | npm consumers                                            | Generated committed API baseline                                     | Block unclassified signature drift                                    |
| Windows sidecar tarball           | Trusted release process                     | Main package installer                                   | Provenance manifest plus registry integrity equality                 | Require version bump on same-version byte drift                       |

## 4. Cross-slice architecture

The implementation introduces six narrowly owned primitives:

1. `process-identity` captures and verifies a PID plus operating-system birth identity. It does not decide whether a service is healthy.
2. `bounded-process` owns subprocess timeout, byte budget, termination, and reap behavior. It does not decide command-specific retry policy.
3. `versioned-json` owns strict record discrimination and supported-version dispatch. It does not own domain validation.
4. `atomic-json` exposes separate visibility-atomic and crash-durable writes and conflict-aware replacement. It does not silently merge domain objects.
5. `generation-handle` pins the immutable database, metadata, and generation identity used by a `ScipDatabase`.
6. Mailbox lifecycle helpers own pending/inflight/response movement, expiry, quotas, and cleanup while TypeScript and Rust protocols retain domain-specific request validation.

These primitives are introduced only when a slice proves at least two real consumers or an externally important invariant. They must remain small enough that their hostile-path tests can run without a real compiler, network, watch daemon, or npm registry.

## 5. Execution and commit protocol

For each slice:

1. Add the smallest deterministic test that reproduces the registered failure. The test must fail for the intended behavioral reason.
2. Implement the invariant at the owning boundary.
3. Run the slice's named focused tests, then `npm run typecheck`, `npm run lint`, and the applicable generated-doc/API checks.
4. Run `scip-query reindex --allow-partial` and `scip-query diff-gate`. Fix each finding or record a concrete acceptance reason.
5. Update the issue register or this plan if implementation evidence changes scope.
6. Commit only that slice's files with a message containing its finding ID. Do not push during the program unless the user separately asks.

At the end of every phase, run the full Vitest suite. At program end, run all release dry-runs and pack checks without publishing.

Rollback is commit-scoped. Durable-format slices additionally retain legacy readers, so reverting code does not make already-written current records silently unreadable. No slice deletes legacy data during this program.

## 6. Slice plan

### Slice 01 — DD-02 — Verify process instance identity before signaling

**Invariant:** watch stop/replacement and reindex preemption signal only the process instance that created the ownership record.

**Implementation:**

- Add a branded `ProcessIdentity` model and platform adapters in `src/platform/process-identity.ts`.
- On Linux read `/proc/<pid>/stat` start ticks; on macOS/BSD use bounded `ps`; on Windows use a bounded PowerShell process-start query. Normalize the result with platform and boot/process-start evidence.
- Add identity to watch state, watch lock, and reindex lock schemas. Accept legacy records for inspection but never signal from them.
- Extend injected runtimes in `src/runtime/watch-service.ts` and `src/reindex/index.ts` so tests can return alive/same, alive/different, dead, and unavailable.
- Replace group-first signaling with an explicitly recorded process-group identity only for detached watcher-owned reindex workers.

**Tests:** process adapter parsing per platform; PID reused with different birth identity; lookup unavailable; positive match; watch ensure/stop and manual preemption signal spies.

**Docs:** watch/reindex recovery messages and the process-safety section of the issue register.

**Dependencies:** none.  
**Rollback:** revert the slice; new record fields are additive and legacy readers ignore them.

### Slice 02 — RES-01 — Enforce bounded subprocess execution and reaping

**Invariant:** every production child has a declared deadline and output budget, and timeout completion proves the child exited.

**Implementation:**

- Add `src/platform/bounded-process.ts` with typed completion results and distinct timeout, output-limit, and spawn failures while preserving exit status and signal for command-specific policy.
- Require label, timeout, max stdout/stderr, and termination grace; provide reviewed constants for quick probes, Git operations, indexers, analyzers, installers, and builds.
- Migrate the production `spawn`, `spawnSync`, `execFile`, and `execFileSync` inventory, including the currently ignored `runIsolatedJsonProcess.timeoutMs`.
- Make async termination drain streams, wait for close, and escalate only while the original process identity still matches.
- Classify indexer failures and retry serially only when the failure indicates concurrency/resource contention.
- Add an AST/source inventory test that fails on an unbudgeted production subprocess unless the site carries a narrow reviewed exemption.

**Tests:** never-exiting child, TERM-ignoring child, output flood, exit-during-grace race, sync timeout forwarding, permanent indexer error not retried, transient error retried once.

**Docs:** operational timeout table and environment overrides.

**Dependencies:** Slice 01 for safe escalation identity.  
**Rollback:** revert helper and call-site migration together.

### Slice 03 — TEST-01 — Replace watcher private-member tests with injected ports

**Invariant:** watcher behavior is testable without casting to or replacing private members.

**Implementation:**

- Define injectable `ReindexRunner`, watcher-subscription factory, and clock/timer ports in `src/runtime/watch.ts`.
- Export pure path-ignore and refresh-transition policy only where the policy itself is useful outside the class test.
- Rewrite `tests/runtime/watch.test.ts` to drive `start`, `requestRefresh`, and `stop`, observing runner calls, status events, and cancellation.
- Add a source-contract test forbidding private-member casts in watcher tests.

**Tests:** preserve every current debounce, dirty-rerun, freshness-suppression, path-ignore, and worker-environment assertion through public/injected behavior.

**Docs:** testing seam rationale in the plan ledger.

**Dependencies:** none; it lands before lifecycle changes so later tests use the stable seam.  
**Rollback:** revert the seam and rewritten tests as one slice.

### Slice 04 — RES-02 — Drain watch children and subscriptions before releasing ownership

**Invariant:** watch ownership remains present until subscriptions are closed and the in-flight reindex operation has exited or is explicitly represented as degraded.

**Implementation:**

- Implement the default `ReindexRunner` over the bounded-process primitive.
- Continuously consume child stdout/stderr into bounded diagnostic tails.
- Retain the active operation and make `Watcher.stop()` return a promise that refuses new refreshes, cancels/drains the child, and awaits every Chokidar close.
- Await stop in `src/runtime/watch-server.ts` before removing state/activity or releasing the lock.
- Persist `draining`/failure status where shutdown cannot prove child exit within policy.

**Tests:** pipe-filling worker, stop during each child phase, TERM escalation, Chokidar close failure, second-service startup during drain, successful normal stop.

**Docs:** `watch stop` semantics and recovery output.

**Dependencies:** Slices 01–03.  
**Rollback:** protocol/state decoder accepts the prior watch state version during rollback.

### Slice 05 — RES-03 — Bound and fail closed on Rust LSP frames

**Invariant:** rust-analyzer stdout cannot cause memory use above the configured safe frame budget.

**Implementation:**

- Add header and message-size options with conservative defaults and an absolute ceiling.
- Replace unbounded concatenation with a bounded frame accumulator.
- Validate exactly one non-negative safe-integer `Content-Length`; reject conflicting duplicates.
- On framing failure, clear state, kill transport once, and reject all pending/readiness waiters.

**Tests:** oversized header/body, invalid/duplicate length, safe-integer overflow, exact-boundary valid frames, every chunk split, multiple frames, one-shot transport failure.

**Docs:** Rust semantic limits and error wording.

**Dependencies:** none.  
**Rollback:** no durable state change.

### Slice 06 — RES-04 — Bound and serialize verified binary downloads

**Invariant:** a verified download consumes bounded time/bytes and concurrent callers cannot share or corrupt staging ownership.

**Implementation:**

- Stream response bytes through an incremental SHA-256 and byte counter.
- Enforce abort deadline, advertised length ceiling, observed length ceiling, and a configurable trusted maximum.
- Use exclusive random-token temp files, `finally` cleanup, and a token-owned per-cache-path fetch lock with post-lock cache recheck.
- Use the crash-durable install mode introduced by Slice 08 once available; until then keep this slice behind Slice 08 in merge order or land the visible/bounded portion and complete durability in Slice 08 without reopening semantics.

**Tests:** never-resolving fetch, abort, absent/false/oversized length, streamed overflow, checksum mismatch, two callers, write/rename failure, temp cleanup.

**Docs:** fetch budgets and cache recovery.

**Dependencies:** Slice 02 for timeout vocabulary; final merge depends on Slice 08 durability helper.  
**Rollback:** cached accepted binaries remain checksum-valid.

### Slice 07 — RES-05 — Own and terminate Vue workers

**Invariant:** the Vue coordinator never returns while a worker it created can still run.

**Implementation:**

- Retain worker handles and explicit worker/task IDs.
- Collect exit/error state and terminate unfinished workers on any timeout or peer failure.
- Wait for termination before removing the result directory.
- Limit result file size before parse and validate payload identity.

**Tests:** hanging worker, peer error, termination ordering, late message/write, oversized result, deterministic successful merge.

**Docs:** opt-in parallel-worker failure behavior.

**Dependencies:** Slice 02 terminology; worker implementation can use its own bounded port.  
**Rollback:** no durable format change.

### Slice 08 — DD-08 — Separate visibility-atomic and crash-durable JSON replacement

**Invariant:** callers explicitly choose complete-visibility or crash-durable replacement, and durable mode flushes file and containing directory before success.

**Implementation:**

- Replace timestamp temp names with exclusive random-token files.
- Add `visibility: "atomic" | "durable"` or distinct functions with clear return guarantees.
- Durable mode writes through an owned file descriptor, syncs the file, renames, then syncs the directory where supported; unsupported directory sync is classified and documented per platform.
- Always remove owned temporary files on failure.
- Migrate authoritative ownership, pointer, config, suppression, and release-state writes to durable mode; leave rebuildable telemetry/cache writes visibility-atomic.

**Tests:** injected failure at create/write/file-sync/rename/directory-sync, temp collision, old-or-new reader visibility, Windows directory-sync behavior.

**Docs:** durability matrix and call-site classification.

**Dependencies:** none.  
**Rollback:** durable files are ordinary JSON and remain readable by old code.

### Slice 09 — DD-04 — Recover partial locks and enforce token-owned release

**Invariant:** partial/malformed lock creation is recoverable without deleting or signaling a live ambiguous owner, and release removes only the current token owner.

**Implementation:**

- Standardize watch, reindex, repository-cache, and shared-generation lock records on one versioned parser.
- Write creator identity/token durably after exclusive create.
- Treat empty/malformed records with an observed raw identity and conservative age; reclaim only beneath an exclusive reclaim lock after unchanged recheck and no verifiable live owner.
- Make every release reread and match token plus process instance.
- Remove reindex's unconditional unlink and align all deadline arithmetic with injected monotonic time.

**Tests:** crash after create, truncated JSON, successor before old release, two reclaimers, unverifiable live PID, token mismatch, reclaim-file crash.

**Docs:** lock recovery diagnostics.

**Dependencies:** Slices 01 and 08.  
**Rollback:** version dispatcher continues accepting legacy lock records for non-destructive inspection.

### Slice 10 — DD-01 — Pin database, metadata, and identity in one generation handle

**Invariant:** an open database can expose only the metadata and identity retained with that database generation.

**Implementation:**

- Change local publication to materialize each accepted generation as an immutable directory containing database, SCIP companion state, metadata, and a manifest.
- Atomically switch one small current-generation pointer only after manifest validation.
- Keep compatibility stable paths as derived mirrors for external tools, but internal readers resolve and retain the immutable directory once.
- Make `ScipDatabase` own a `GenerationHandle` containing paths, manifest identity, and a close/release function.
- Replace fresh `meta.json` reads in cursor, semantic, evidence, freshness, TypeScript session, and query paths with handle data.
- Retain old generations while handles/leases can exist; collect only after conservative grace and no live lease.

**Tests:** publication barriers after every handoff, conflicting numeric symbol IDs, changed sorted refs between pages, metadata-only refresh, shared-cache hydration, old reader/new reader, crash before/after pointer switch.

**Docs:** index layout, recovery, status output, and generation invariants.

**Dependencies:** Slices 08 and 09.  
**Rollback:** stable compatibility paths remain; do not delete legacy layout during the overlap release.

### Slice 11 — DD-03 — Separate immutable refresh intent from watch activity

**Invariant:** no heartbeat/activity write can erase an accepted refresh request.

**Implementation:**

- Replace refresh fields in `watch-activity.json` with one immutable request file per logical refresh.
- Give requests protocol version, UUID, optional idempotency key, creation/deadline, and detail.
- Atomically claim pending requests, deliberately coalesce, and acknowledge only after the corresponding refresh result.
- Keep heartbeat/activity as an independent last-writer-wins observation.

**Tests:** exact stale-read crossing, duplicate key, distinct concurrent keys, crash before/after claim, retry, coalescing, expired request.

**Docs:** watch request lifecycle/status counters.

**Dependencies:** Slices 04, 08, and 09.  
**Rollback:** decoder continues observing legacy refresh fields during overlap.

### Slice 12 — DD-05 — Make config, hook, and managed-agent writes conflict aware

**Invariant:** a setup writer never reports success after overwriting an intervening independent user edit.

**Implementation:**

- Add a revision token based on raw bytes plus file identity.
- For JSON, reread beneath a short token-owned file lock, reapply the domain merge to the latest object, and durably replace only when the revision is unchanged.
- For managed Markdown blocks, preserve content outside exact markers and repeat the same revision check.
- Bound retries; surface a conflict with original/latest hashes and leave the latest file untouched.
- Apply to `.scipquery.json`, `.claude/settings*.json`, `.codex/hooks.json`, `AGENTS.md`, and `CLAUDE.md` writers.

**Tests:** user edit at read/merge/write barriers, independent-key merge, same-key conflict, malformed latest file, marker moved/removed, retry exhaustion.

**Docs:** setup conflict and recovery messages.

**Dependencies:** Slices 08 and 09.  
**Rollback:** no schema change; latest user bytes are preserved.

### Slice 13 — DD-06 — Make same-finding suppression conflicts explicit

**Invariant:** two different policy decisions for one suppression identity cannot silently replace one another.

**Implementation:**

- Use exclusive create for a new suppression identity.
- On existing file, parse/version it and allow idempotent same-content replay.
- Require an explicit `--replace` carrying the observed revision for reason/expiry changes.
- Write replacements durably and report a conflict when the revision changed.

**Tests:** concurrent different reasons, same replay, explicit replace, stale replace token, malformed existing file, branch-compatible distinct identities.

**Docs:** `suppress` command reference and agent skill guidance.

**Dependencies:** Slices 08, 09, and 23's schema can land later through a version-tolerant decoder.  
**Rollback:** existing files remain ordinary compatible JSON.

### Slice 14 — DD-07 — Move lease observation inside repository-cache serialization

**Invariant:** a stale touch cannot overwrite a lease that points to a newer generation.

**Implementation:** acquire the repository lock before reading the current lease, merge only liveness/touch fields into that current value, compare the ownership checksum, and durably replace. Treat generation-changing updates as separate operations with explicit preconditions.

**Tests:** barrier where G2 publishes while a G1 touch waits, deletion/recreation, checksum mismatch, concurrent touches.

**Docs:** cache lease invariant.

**Dependencies:** Slices 08 and 09.  
**Rollback:** lease schema remains compatible.

### Slice 15 — DD-09 — Make finding outcome increments database-native

**Invariant:** each committed distinct observation increments the outcome ledger exactly once under concurrent connections.

**Implementation:**

- Replace JavaScript read/modify/replace with one SQLite `INSERT ... ON CONFLICT DO UPDATE` expression for first/last seen, count, and outcome.
- Wrap one run's transition derivation and writes in an immediate transaction where required.
- Add a stable observation/run key if retries can replay one logical batch; record it in a dedupe table.

**Tests:** two connections interleaved at the prior read/write points, same-run retry, different-run increment, busy timeout, suppression transition.

**Docs:** effectiveness counter semantics.

**Dependencies:** none.  
**Rollback:** additive dedupe table can remain unused.

### Slice 16 — DD-10 — Add mailbox claim, expiry, cleanup, quotas, and replay policy

**Invariant:** accepted mailbox work is bounded and is either pending, owned inflight, completed, expired, or explicitly rejected.

**Implementation:**

- Add shared pending/inflight/response/dead-letter directories and atomic rename claim.
- Enforce per-mailbox item count and byte quotas before accepting a request; return typed backpressure.
- Add request deadline, operation idempotency key, claim owner identity, claim expiry, bounded batch processing, and orphan reclamation.
- Clean expired request/response/temp files on service loops without starving heartbeats.
- Keep TypeScript protocol correlation and generation checks.

**Tests:** client/server crash before and after claim/response, flood above count/bytes, duplicate logical request, orphan reclaim, bounded batch fairness, malformed/oversized file.

**Docs:** mailbox lifecycle, limits, status telemetry.

**Dependencies:** Slices 01, 08, 09, and 11's queue mechanics where reusable.  
**Rollback:** services read legacy flat mailbox files during overlap; no destructive migration.

**Implemented shape:** one storage-owned bounded-mailbox state machine now
backs TypeScript semantic, TypeScript index, and durable Rust requests.
Admission is serialized around immutable content identities and count/byte
limits; claims are atomic owner-specific renames with expiry; completions are
durable exclusive publications retained for idempotent retry; batches and
cleanup passes are capped; legacy flat requests remain readable; and current
pressure is present in watch/Rust status. Introducing the lifecycle required
advancing the three message protocols to version 3 and adding Rust
correlation fields here; Slice 24 still owns the complete public compatibility
fixture/schema audit rather than duplicating those lifecycle mechanics.

### Slice 17 — DD-11 — Use monotonic time for elapsed waits

**Invariant:** civil-clock adjustment cannot extend an in-process wait or alone authorize a destructive ownership action.

**Implementation:**

- Introduce an injected monotonic clock based on `performance.now()`/`process.hrtime.bigint()` for deadlines and elapsed durations.
- Retain wall-clock timestamps only for cross-process diagnostics and durable expiry hints.
- Update locks, watch start/stop, reindex waits, mailbox request waits, Rust session loops, cache sweep throttles, and worker deadlines.
- Combine cross-process stale classification with process identity/handshake; wall age alone yields degraded/unverified, not signal authority.

**Tests:** forward/backward wall jumps, monotonic advance, reboot/session identity change, timeout remains bounded.

**Docs:** timestamp versus deadline semantics.

**Dependencies:** Slice 01.  
**Rollback:** durable wall timestamps remain present.

**Implemented shape:** the domain time boundary now separates persisted civil
timestamps from process-local monotonic deadlines. All cited lock, watch,
reindex, mailbox, Rust readiness/session, worker, throttle, sweep, and duration
paths use the appropriate clock. Cross-process replacement and reclamation
require protocol/project identity plus process liveness and matching
process-start identity when recorded. Complete process/admission lock records
are privately flushed before exclusive hard-link publication, malformed
public ownership fails closed, live old-heartbeat watch state cannot authorize
replacement, and inflight mailbox lease expiry cannot reclaim a live or
unverifiable owner. Durable Rust work carries a relative budget and creates
its readiness deadline in the receiving process's monotonic domain.

### Slice 18 — DD-12 — Serialize or segment JSONL rotation

**Invariant:** every successfully appended complete operational record remains discoverable across concurrent rotation.

**Implementation:** replace remove/rename rotation with immutable sequence/token-named segments and a bounded segment manifest, or serialize append/rotation beneath the standardized lock. Readers scan current plus ordered segments and tolerate one partial tail.

**Tests:** two writers at every rotation stage, crash with partial tail, segment retention budget, deterministic read order.

**Docs:** telemetry loss/retention contract.

**Dependencies:** Slices 08 and 09 if the lock/manifest design is chosen.  
**Rollback:** readers retain legacy `.previous` support.

**Implemented shape:** both reindex-activity and affected-shadow history use
one `rotating-jsonl` coordinator. A process-instance lock serializes current
tail repair, retention pruning, rotation, append, and retained-set reads.
Complete lines remain in deterministic previous-then-current order; one
incomplete final tail is trimmed before the next append and ignored with an
explicit byte count during reads. The two legacy segment names and their 1 MiB
and 8 MiB limits remain compatible.

### Slice 19 — API-04 — Centralize reindex metadata decoding

**Invariant:** every metadata consumer applies the same version, status, fingerprint, language, and companion validation.

**Implementation:**

- Add one dependency-free `decodeReindexMetadata` returning `supported`, `legacy`, `unsupported`, or `malformed`.
- Make the current domain model discriminate metadata v2/v3 and reserve v4 migration.
- Replace the duplicated casts in freshness, evidence cache, TypeScript protocol/session identity, incremental reuse, shared generation, and runtime status.
- Preserve consumer-specific policy only after shared decoding.

**Tests:** shared fixture matrix consumed by every boundary; mutation tests for omitted/wrong fields; future version visible.

**Docs:** metadata compatibility table.

**Dependencies:** none; land before other format version slices.  
**Rollback:** decoder accepts every currently supported record.

**Implemented shape:** `src/domain/reindex-metadata.ts` is the one
dependency-free v2/v3 decoding and capability boundary, with v4 reserved as an
explicit unsupported migration. Freshness, evidence and semantic cache
identity, TypeScript service/index identity, SQLite stable identity,
incremental shard reuse, last-refresh mutation, and shared-generation
admission consume decoded records. A shared fixture matrix and boundary
mutations cover partial/complete policy, wrong fields, stable canonical
identity, and future-version rejection. The compatibility table is in
`docs/REINDEX_METADATA_COMPATIBILITY.md`.

### Slice 20 — API-01 — Version the CLI JSON envelope

**Invariant:** every public `--json` response identifies envelope schema and producer version through the shared renderer.

**Implementation:**

- Add `schemaVersion` and `{name, version}` producer fields to `printJsonEnvelope`.
- Route remaining ad hoc public JSON output through the renderer or explicitly classify internal hook protocols.
- Publish a JSON Schema or TypeScript schema fixture for the envelope, keeping existing fields additive and unchanged.
- Add older-current compatibility fixtures and descriptor coverage assertions.

**Tests:** every public JSON command contains the fields; old fixture remains consumable; compact and pretty output are semantically identical; hook protocols retain their own version.

**Docs:** command reference and programmatic-consumption guide.

**Dependencies:** none.  
**Rollback:** additive fields do not break tolerant old consumers.

**Implemented shape:** the public v1 transport uses
`kind: "scip-query-result"`, `schemaVersion`, producer identity,
command-owned `resultSchemaVersion`, and the unchanged command/options/result
fields. `scip-query/runtime` exports the v0/v1 decoder and compatibility
guard. Hidden analysis children use a distinct, fail-closed v1 protocol;
host-owned hook JSON remains untouched. A packaged JSON Schema, two golden
fixtures, generated command-reference link, and consumer guide define the
evolution boundary.

### Slice 21 — API-02 — Generate and gate the npm declaration surface

**Invariant:** a change to any exported declaration is visible and must be intentionally accepted before release.

**Implementation:**

- Build declarations, resolve all package export paths, normalize them deterministically, and emit a committed API manifest.
- Include exported names, kinds, signatures, generic constraints, parameter optionality, return types, and referenced public types.
- Add `npm run api:check` and `api:update`; make prepublish and lint/check fail on drift.
- Classify accepted changes as additive, compatible correction, or breaking in a small changelog record. Use a conservative failure when automatic classification is uncertain.

**Tests:** remove export, require optional parameter, narrow/widen union, add optional field, add export, reordering/noise normalization, missing declaration path.

**Docs:** contributor API-evolution workflow.

**Dependencies:** none.  
**Rollback:** manifest/checker can be reverted without runtime state.

**Implemented shape:** one dependency-free contract script parses the built
declarations with the repository's TypeScript compiler, follows generated
re-exports, normalizes build noise, and emits a content-addressed manifest for
all 72 package paths. The current baseline contains 871 named exports and
eight referenced declaration chunks with no unresolved symbols. Every
accepted baseline has an immutable digest-named classification record.
`api:check` rebuilds first, compares the surface, validates the acceptance
record, and compiles a preserved downstream consumer before lint or
publication can continue.

### Slice 22 — API-03 — Version and migrate `.scipquery.json`

**Invariant:** config loading distinguishes legacy/current/future versions and never casts unsupported data to `ProjectConfig`.

**Implementation:**

- Add `schemaVersion` to the current config model and root-key validator.
- Decode unversioned files as supported legacy v1, migrate in memory, and write the current version on the next authorized mutation.
- Reject unsupported future versions with an actionable diagnostic while preserving the file byte-for-byte.
- Preserve unknown safe fields during conflict-aware rewrites where policy permits; never silently discard them.

**Tests:** unversioned/current/future/malformed, migration round trip, concurrent mutation, unknown field preservation, old CLI fixture.

**Docs:** config schema and migration policy.

**Dependencies:** Slice 12 for safe writers and Slice 19's decoder pattern.  
**Rollback:** keep unversioned legacy reader through at least one release.

**Implemented shape:** `src/domain/project-config.ts` classifies raw policy
before any option is used, migrates unversioned/explicit-v1 records to current
v2 in memory, retains unknown fields, and rejects malformed or unsupported
versions. All readers and the three complete writer paths use the boundary.
The revision-aware writers include schema migration in their no-op decision,
so current meaning is published on the next authorized edit without weakening
same-field conflict detection. The packaged JSON Schema, migrated repository
config, compatibility documentation, declaration-manifest acceptance, and
real-filesystem regression matrix close the format boundary.

#### Slice 22 high-assurance certificate

**Goal.** Make every persisted project configuration identify the format that
gives its fields meaning, while retaining unversioned repositories and refusing
to reinterpret bytes written by a newer scip-query.

**Definitions and invariants.**

A project configuration is a repository-owned JSON policy record whose fields
select indexing, watch, architecture, documentation, and detector behavior;
what distinguishes it from an arbitrary options object is that its committed
bytes outlive the process that reads them and control later processes. Sources:
`src/domain/config-types.ts:125-157`, `.scipquery.json`.

A configuration migration is a deterministic translation from one supported
persisted format to the current in-memory meaning; what makes it a migration
rather than permissive parsing is that the source version is identified before
any field is interpreted. Source: the decoder pattern in
`src/domain/reindex-metadata.ts:37-89`.

An authorized mutation is a caller-requested project-policy edit performed
through the revision-aware file boundary; what distinguishes it from an
automatic rewrite is that the user already asked a writer to change or
initialize the record. Source: `src/runtime/config.ts:659-766`.

- A supported file must always be decoded as legacy v1 or current v2 before
  any field is exposed as `ProjectConfig`.
- An unsupported older, future, malformed-version, or non-object file must
  always fail before a runtime consumer acts on it.
- A rejected file must always remain byte-for-byte unchanged.
- Every successful authorized mutation must always publish current v2 while
  preserving fields outside the writer's owned conflict domain.
- A writer may report `changed: false` iff both the requested field and the
  persisted schema are already current.

**Premises.**

- **P1.** The current loader parses arbitrary JSON and casts it directly to
  `ProjectConfig`; the type and root-key set have no version discriminator.
  Sources: `src/runtime/config.ts:34-115`,
  `src/domain/config-types.ts:125-157`.
- **P2.** The complete production reader set for `loadProjectConfig` is
  `agent-hooks`, `cli-context`, command handlers, `watch-server`, and `watch`;
  its direct references are complete at 17. Source:
  `scip-query refs loadProjectConfig --json --full`.
- **P3.** The complete production writer set is `initProjectConfig`,
  `configureProjectLanguages`, and `configureProjectAutomaticRefresh`.
  Their external references are complete at 3, 2, and 2 respectively. Source:
  `scip-query refs initProjectConfig --json --full`,
  `scip-query refs configureProjectLanguages --json --full`,
  `scip-query refs configureProjectAutomaticRefresh --json --full`, plus the
  only production `.scipquery.json` path writer in `src/runtime/config.ts`.
- **P4.** All three writers already use the durable,
  revision-checked `mutateTextFileRevisionAware` boundary. The two merge
  writers reread the latest object, preserve unrelated fields, and reject
  conflicting edits to their owned field. Sources:
  `src/runtime/config.ts:659-766`,
  `src/runtime/revisioned-file.ts:76-146`.
- **P5.** The current no-op decision compares only decoded object values. If a
  legacy file already contains the desired field, it returns unchanged and
  has no way to record that the persisted schema still needs migration.
  Source: `src/runtime/config.ts:685-738`.
- **P6.** The repository's own `.scipquery.json` is a valid unversioned record,
  establishing a real legacy fixture rather than a hypothetical one. Source:
  `.scipquery.json`.
- **P7.** `ProjectConfig` is reachable from the public declarations, and Slice
  21's `api:check` fails on unaccepted declaration drift. Sources:
  `scip-query refs ProjectConfig --json --full`,
  `docs/api/scip-query.api.json`.

**Current state.** Every CLI, hook, and watch entry reads the same loader
(P2), but that boundary cannot distinguish an old valid record from a future
record whose familiar field names have different meaning (P1). Setup writes
are already conflict-aware and durable (P4), so schema evolution should extend
that boundary rather than replace it. The no-op path is the only place where
otherwise safe writing would fail to migrate a legacy record (P5).

**Reuse audit.**

- Reuse `isRecordObject` and the discriminated decoder pattern from
  `reindex-metadata`; a project-config decoder is a new unit because reindex
  metadata and repository policy have different fields, versions, and
  compatibility outcomes (P1, P7).
- Reuse `mutateTextFileRevisionAware`, `FileContentConflictError`, and the
  existing three-way field merge; no parallel lock, atomic writer, or retry
  mechanism is justified (P3, P4).
- Extend `ProjectConfig` with optional format metadata so existing
  programmatic callers remain source-compatible. The loader and serializers,
  rather than every in-memory test object, enforce current persisted output
  (P7).
- Extend `docs/CONFIGURATION_WRITE_SAFETY.md` and the existing packaged
  `docs/schemas/` surface; do not introduce a second configuration guide or
  schema publication path.

**Testability design.**

| Behavior                             | Test seam                                  | Dependencies              | Pure core                                  | Side-effect shell            | Contract                                                  |
| ------------------------------------ | ------------------------------------------ | ------------------------- | ------------------------------------------ | ---------------------------- | --------------------------------------------------------- |
| Classify/migrate config              | `decodeProjectConfig`                      | none                      | version and object classification          | none                         | discriminated legacy/current/unsupported/malformed result |
| Emit current config                  | `serializeProjectConfig` through writers   | none                      | canonical metadata plus field preservation | revision-aware file mutation | v2 JSON with stable schema hint                           |
| Reject unsafe bytes                  | `loadProjectConfig` and both merge writers | temporary filesystem      | decoder decision                           | read/stable snapshot         | actionable error, exact bytes retained                    |
| Preserve concurrent fields           | both merge writers                         | real temporary filesystem | three-way owned-field decision             | locked durable replace       | unrelated fields survive; same-field conflict fails       |
| Keep public declarations intentional | `npm run api:check`                        | TypeScript build          | declaration classifier                     | manifest update              | reviewed additive API record                              |

**Design phases.**

1. **22.1 — Add the pure format boundary.** Extend
   `src/domain/config-types.ts`, add `src/domain/project-config.ts`, and add
   the packaged JSON Schema. Decode absent version or explicit v1 as legacy,
   v2 as current, unsupported integers by direction, and invalid shapes as
   malformed. Preserve unknown fields in the current object. Tests call the
   decoder with real JSON values. **Deployable:** no, part of the single
   `api-03-config-v2` deploy group; readers are not routed yet. Premises:
   P1, P6, P7.
2. **22.2 — Route every reader and writer.** Make `loadProjectConfig` and
   snapshot parsing require a supported decoder result. Make initialization
   and both merge writers serialize canonical v2; carry a `needsMigration`
   fact so a same-value authorized call still upgrades legacy bytes. Retain
   revision-aware three-way merging and reject future or malformed latest
   bytes without writing. **Deployable:** yes, because every writer in P3
   enters the new enforcer in the same step. Premises: P2-P5.
3. **22.3 — Prove compatibility and publish the contract.** Expand
   `runtime-config` behavior tests, migrate this repository's config, update
   README/write-safety/durability guidance, validate the JSON Schema, and
   accept the additive `ProjectConfig` declaration through `api:update`.
   **Deployable:** yes. Premises: P6, P7.

**Attack record.**

- **A1 — Future writer, old reader.** A newer scip-query writes
  `schemaVersion: 3`; this version reads familiar `watch` fields and starts
  with the wrong meaning. **Outcome: HOLE — repaired by 22.1 and 22.2**, which
  reject before exposing a config (P1, P2).
- **A2 — Idempotent legacy mutation.** Setup reads an unversioned file whose
  requested `watch.enabled` value is already present and takes the unchanged
  branch forever. **Outcome: HOLE — repaired by 22.2** with an explicit
  persisted-migration bit (P5).
- **A3 — Concurrent additive field.** An editor adds a future-safe root field
  after setup's initial read; setup enables watch. **Outcome: HELD** by 22.2
  reusing the latest-snapshot merge and revision check, with a real
  interleaving regression (P4).
- **A4 — Malformed or future latest bytes.** Setup starts from a valid stale
  object, but an editor replaces the public file with an invalid version
  before mutation. **Outcome: HOLE — repaired by 22.2**, which decodes the
  stable latest snapshot and leaves rejected bytes untouched (P4).
- **A5 — Legacy and current processes overlap.** A current writer upgrades v1
  while another current process still holds the old in-memory object.
  **Outcome: HOLE — repaired by 22.2**: owned-field comparison uses the
  caller's value while schema metadata is excluded from the field conflict;
  the revision-aware writer retries against current bytes (P4).
- **A6 — Type and schema drift.** Runtime accepts a new known field but the
  editor schema or public declaration contract omits it. **Outcome: HOLE —
  repaired by 22.3** through schema assertions and the Slice 21 API gate (P7).
- **A7 — Explicit v1 producer.** A tool writes `schemaVersion: 1` rather than
  omitting the legacy discriminator. **Outcome: HOLE — repaired by 22.1** by
  treating both encodings as the same readable legacy meaning.

**Coverage matrix.**

| Surface or lens                                  | Attacks        |
| ------------------------------------------------ | -------------- |
| `loadProjectConfig` and all 17 direct references | A1, A4, A5     |
| `initProjectConfig`                              | A4, A6         |
| `configureProjectLanguages`                      | A2, A3, A4, A5 |
| `configureProjectAutomaticRefresh`               | A2, A3, A4, A5 |
| `ProjectConfig` public declaration               | A6             |
| Repository legacy bytes                          | A2, A7         |
| Valid intermediate state / enforcement window    | A1, A4, A5     |
| Reversibility and rollback                       | A2, A5, A7     |
| Observability and operator recovery              | A1, A4         |
| Testability and reuse                            | A3, A6         |

**Execution and ship order.** Phases 22.1 and 22.2 ship together so no reader
or writer sees an unrecognized current format. Phase 22.3 is part of the same
commit because the repository config and declaration manifest are enforced
inputs. Rollback keeps the v1 reader and can stop writing v2 without data
loss; v2 adds metadata and changes no existing option meaning.

**Verdict.** A plan is `PLANNED-COMPLETE` iff every state authority and
applicable lens has an attack, every attack ends in a cited defense or
recorded repair, and every premise reproduces. Result:
`PLANNED-COMPLETE` — 7 attacks, 6 holes repaired, 0 holes accepted, no blank
coverage rows.

### Slice 23 — API-05 — Version suppression and outcome-event records

**Invariant:** readers distinguish absent, malformed, supported legacy/current, and unsupported future records; future records affect completeness reporting.

**Implementation:**

- Add discriminators and schema versions to new suppression and outcome-event files.
- Decode legacy unversioned files into the current model.
- Return records plus compatibility warnings/incomplete counts instead of silently skipping.
- Preserve immutable event filenames and deduplication identity.

**Tests:** mixed old/current/future repository, unknown event kind, malformed file, round trip, dedupe across versions, future-record coverage warning.

**Docs:** committed-record schema and merge guidance.

**Dependencies:** Slices 13 and 19's decoder pattern.  
**Rollback:** current writers' records remain readable through a compatibility adapter retained in the revert window.

**Plan revision after Slice 13:** suppression records are no longer
unversioned-only. Slice 13 shipped an unversioned-v0 reader, a v1 writer and
validator, stable suppression identity, writer metadata, and explicit
compare-and-replace. This slice must retain that work rather than introduce a
second suppression protocol. It will add a discriminator to new compatible-v1
writes, keep v0 and already-written v1 readable, and add explicit
compatibility accounting. Outcome-event records remain unversioned and are
the primary schema migration in this slice.

#### Slice 23 high-assurance certificate

**Goal.** Make every committed suppression or outcome file either contribute
to a result or contribute to an explicit incomplete-coverage count, without
changing the Git-distributed one-file identities that make branch merges safe.

**Definitions and invariants.**

A committed evidence record is a repository-owned JSON fact or policy whose
bytes are shared through Git and interpreted by multiple versions of the CLI;
what distinguishes it from a local cache row is that an incompatible reader
cannot rebuild or silently discard the team-shared observation. Referents:
`.scipquery/suppressions/*.json`, `.scipquery/events/*.json`, and the legacy
`.scipquery/ledger/events.jsonl`.

Record compatibility is the classification of one persisted candidate as
readable legacy, readable current, unsupported older, unsupported future, or
malformed; what makes it an operational contract is that every candidate is
counted before accepted records are used to claim complete suppression or
effectiveness history.

An outcome-event identity is the stable tuple of detector, finding, transition,
and observed commit; what distinguishes it from an observation file is that
timestamps, producer metadata, and verification evidence may vary while
read-side deduplication still recognizes the same underlying transition fact.

- Every JSON record candidate must always produce one compatibility
  classification.
- A reader may report complete coverage iff every candidate is readable
  legacy or current.
- Unsupported or malformed records must never authorize a suppression,
  verified fix, or legacy-ledger deletion.
- New suppression and event writes must identify their record kind and schema
  while remaining readable by the immediately prior permissive readers.
- Adding wire metadata must never change suppression filename identity,
  outcome dedupe identity, exclusive-create behavior, or immutable event
  history.
- Accepted partial reads may support conservative output only when their
  incomplete counts and path-specific reasons are returned with that output.

**Premises.**

- **P1.** Suppression writes are current schema v1 and reads accept
  unversioned v0 plus v1, but v1 has no record-kind discriminator and
  `readSuppressionDir` returns only free-text warnings, not accepted/omitted
  counts. Sources: `src/storage/suppression-store.ts:20-153`,
  `src/runtime/suppression-writer.ts:53-177`.
- **P2.** All 30 committed suppression files in this repository are
  unversioned v0, proving that overlap support is a live compatibility
  requirement rather than a fixture-only concern. Source:
  `.scipquery/suppressions/*.json`.
- **P3.** Outcome-event writers serialize the semantic `OutcomeEvent` object
  directly. All 484 committed event files are unversioned, and the parser
  collapses invalid JSON, unknown event kinds, and incompatible shapes to
  `null`. Sources: `src/storage/outcome-events.ts:43-180`,
  `.scipquery/events/*.json`.
- **P4.** The complete production suppression reader set is the diff gate;
  the complete writer is `handleSuppress` through `writeSuppressionFile`.
  Sources: complete `refs` results for `readSuppressionDir` and
  `writeSuppressionFile`.
- **P5.** The complete production outcome reader set is the effectiveness
  command and cross-HEAD reconciliation; the sole writer path is
  `recordDiffGateOutcomes` through `appendOutcomeEvents`. Sources: complete
  `refs` results for `readOutcomeEvents` and `appendOutcomeEvents`.
- **P6.** Event deduplication intentionally keys
  `(check, findingId, event, commit)` and prefers stronger verification
  evidence, then the earliest timestamp. Wire metadata must not enter this
  identity. Source: `src/storage/outcome-events.ts:144-162`.
- **P7.** Legacy JSONL migration currently parses only recognized events,
  writes that subset as independent files, and then removes the shared ledger.
  A future or malformed line can therefore be erased on the next append.
  Source: `src/storage/outcome-events.ts:43-99`.
- **P8.** Cross-HEAD reconciliation uses committed history to decide whether
  an apparently missing finding may resolve. It currently cannot distinguish
  a genuinely absent anchor from an omitted incompatible event. Source:
  `src/runtime/diff-gate-outcomes.ts:161-289`.

**Current state.** Suppression conflict safety and v0/v1 overlap already hold
(P1, P2), so replacing that protocol would add risk without closing a gap.
The remaining systemic defect is missing compatibility accounting: both
stores can return a plausible subset, effectiveness can present it as the
whole history, and reconciliation or legacy cleanup can act on an omitted
record (P3, P7, P8).

**Reuse audit.**

- Extend `decodeSuppressionFile`, `readSuppressionDir`, and the current v1
  writer. Add the discriminator as an optional-compatible v1 field so old v1
  binaries continue accepting new files; do not mint an unnecessary v2.
- Keep semantic `OutcomeEvent`, `deriveOutcomeEvents`, and
  `latestOutcomeLifecycleAnchor` independent of persistence metadata. Add one
  pure outcome-record decoder/encoder beside that domain model.
- Keep `appendOutcomeEvents`, exclusive filenames, and `dedupeEvents`; define
  the stable event identity once and reuse it for envelope validation and
  dedupe.
- Add one dependency-free compatibility-summary type shared by both stores.
  Storage modules classify candidates; commands and hooks decide how to
  disclose incomplete results.
- Extend the current diff-gate result and effectiveness JSON rather than
  creating a separate diagnostic command.

**Testability design.**

| Behavior                      | Test seam                                             | Dependencies            | Pure core                                  | Side-effect shell                          | Contract                                               |
| ----------------------------- | ----------------------------------------------------- | ----------------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------------------ |
| Classify persisted candidates | suppression and event decoders                        | none                    | version/kind/shape/identity classification | none                                       | one classification per candidate                       |
| Summarize compatibility       | shared summary function                               | none                    | exact counts and issue paths               | directory/JSONL enumeration                | `complete` iff omitted count is zero                   |
| Write current records         | existing suppression/event writers                    | clock/tool version      | canonical compatible envelope              | revision-aware replace or exclusive create | new bytes carry kind/version without changing identity |
| Preserve distributed identity | `suppressionFileName`, event identity, `dedupeEvents` | none                    | target/fact identity                       | immutable paths                            | v0/current duplicates collapse under existing rules    |
| Prevent unsafe cleanup        | legacy-ledger append fixture                          | temporary filesystem    | compatibility decision                     | migrate/remove                             | incompatible legacy bytes survive                      |
| Fail closed in reconciliation | `recordDiffGateOutcomes` injected event reader        | injected history result | missing-finding decision                   | replay/append shell                        | incomplete history cannot prove a fix                  |
| Disclose partial conclusions  | diff-gate, Stop hook, effectiveness handler           | captured output         | compatibility renderer                     | JSON/text/hook output                      | counts and paths are visible                           |

**Design phases.**

1. **23.1 — Define compatible record envelopes.** Add the shared compatibility
   summary and pure outcome-event record decoder. Add a record-kind field to
   new suppression v1 records while accepting existing v1 without it; add a
   kind/schema/identity/writer envelope to new outcome v1 records while
   accepting unversioned v0. **Deployable:** yes; previous readers ignore
   additive fields and current readers accept both generations. Premises:
   P1-P3, P6.
2. **23.2 — Make store reads complete-by-construction.** Return accepted
   records plus exact legacy/current/unsupported/malformed counts and
   path-specific issues. Keep non-JSON side files outside the candidate set.
   Preserve a legacy JSONL file whenever any non-empty line is incompatible.
   **Deployable:** yes; writers and identities remain unchanged. Premises:
   P2, P3, P7.
3. **23.3 — Route every conclusion through compatibility.** Attach
   suppression completeness to diff-gate JSON/text/hook feedback. Attach event
   completeness to effectiveness results. Make cross-HEAD reconciliation
   retain missing findings rather than resolve them when event history is
   incomplete. **Deployable:** yes. Premises: P4, P5, P8.
4. **23.4 — Publish and prove the contract.** Add current-record JSON Schemas,
   a compatibility/merge guide, mixed real-format tests, and API acceptance
   if the additive diff-gate result field reaches public declarations. Do not
   rewrite the 514 committed legacy files merely to make counters look
   current. **Deployable:** yes. Premises: P2, P3.

**Attack record.**

- **A1 — Future suppression.** A newer branch adds a suppression schema this
  binary cannot interpret. The current reader ignores it and the gate appears
  complete. **Outcome: HOLE — repaired by 23.2 and 23.3** with an unsupported
  future count and visible path; the finding remains conservatively
  unsuppressed (P1, P4).
- **A2 — Unknown event kind.** A future producer adds a transition and an
  older effectiveness reader returns `null`, lowering totals. **Outcome: HOLE
  — repaired by 23.1-23.3**: the record is omitted but explicitly counted and
  the report is incomplete (P3, P5).
- **A3 — Future legacy-ledger line.** A mixed branch retains JSONL and contains
  one unfamiliar record; a new event triggers migration and deletes the
  source. **Outcome: HOLE — repaired by 23.2**: accepted rows may be copied,
  but any incompatible row fences deletion and produces a warning (P7).
- **A4 — Cross-HEAD false resolution.** The lifecycle anchor exists only in an
  incompatible event file, so reconciliation treats a missing finding as
  resolved. **Outcome: HOLE — repaired by 23.3**: incomplete history retains
  all missing ledger rows and defers proof (P8).
- **A5 — v0/v1 duplicate fact.** The same outcome exists in a legacy object and
  a current envelope with different timestamps or writer versions.
  **Outcome: HELD by 23.1 and P6**: envelope fields are excluded from identity,
  stronger proof wins, then earliest time.
- **A6 — Old reader, new writer.** The immediately prior CLI encounters a new
  event envelope or suppression discriminator. **Outcome: HELD** because both
  are additive fields on shapes whose old validators permit unknown members;
  suppression stays schema v1 and event semantic fields remain at the root
  (P1, P3).
- **A7 — Malformed current identity.** A record claims the current schema but
  its stable identity does not match its body. **Outcome: HOLE — repaired by
  23.1** with deterministic identity validation and a malformed count (P6).
- **A8 — Partial metric mistaken for an oracle.** Effectiveness has valid
  events plus one future record and still prints exact-looking precision.
  **Outcome: HOLE — repaired by 23.3** with `complete: false`, accepted and
  omitted totals, and human/hook warnings beside the metric.
- **A9 — Metadata changes filenames.** Producer version or schema metadata
  causes suppression conflicts or changes event dedupe. **Outcome: HELD**:
  suppression filenames remain policy-target based; event filenames remain
  immutable content hashes, while semantic dedupe uses P6.

**Coverage matrix.**

| Surface or lens                  | Attacks                |
| -------------------------------- | ---------------------- |
| Suppression decoder/store/writer | A1, A6, A7, A9         |
| Outcome decoder/store/writer     | A2, A3, A5, A6, A7, A9 |
| Diff gate and Stop hook          | A1, A8                 |
| Effectiveness command            | A2, A5, A8             |
| Cross-HEAD reconciliation        | A2, A4, A5             |
| Legacy repository records        | A3, A5, A6             |
| Concurrent Git branches          | A1, A5, A9             |
| Failure/data preservation        | A3, A4, A7             |
| Rollback/old client              | A6, A9                 |
| Observability                    | A1-A4, A7, A8          |

**Execution and ship order.** Phases 23.1 and 23.2 land together so no current
writer produces a format the current reader cannot classify. Phase 23.3 must
land in the same slice so accepted subsets are never presented without their
coverage. Schemas and docs ship with those bytes. Rollback remains able to
read new records because the envelope is additive and semantic fields stay
at their established locations.

**Verdict.** `PLANNED-COMPLETE` — 9 attacks, 7 holes repaired, 0 holes
accepted, every production reader/writer and state authority covered.

### Slice 24 — API-06 — Version and correlate Rust mailbox envelopes

**Invariant:** a Rust response is accepted only when protocol, request ID, operation ID, session identity, and deadline match.

**Implementation:**

- Retain Slice 16's explicit v3 request/response versions, request ID,
  operation ID, deadline, and prior-unversioned overlap reader.
- Add strict request-kind validators and echo durable server/session identity.
- Enforce absolute expiry before work and before response acceptance.
- Emit explicit unsupported-protocol and malformed-request responses where safe.
- Use Slice 16 lifecycle states and quotas.

**Tests:** wrong/missing version, ID/session mismatch, expired request/response, old/new client-server pairs, malformed kind, replayed response.

**Docs:** Rust protocol compatibility matrix.

**Dependencies:** Slice 16.  
**Rollback:** overlap server accepts the immediately prior request format and clients understand an explicit incompatible response.

### Slice 25 — REL-01 — Bind Windows binaries to reproducible provenance

**Invariant:** binary presence never authorizes publication; hashes, target architecture, and source/build provenance must match.

**Implementation:**

- Refactor build/release logic into injected functions testable without network/npm.
- Generate a committed sidecar manifest containing schema version, immutable source commit, SCIP tag, Go version, build flags, target, filename, size, PE machine type, and SHA-256.
- Verify the manifest and PE architecture during build, pack, and prepublish.
- Prefer clean trusted-CI rebuild evidence; local prepublish accepts only a matching manifest.

**Tests:** stale hash, wrong architecture, changed source/tag/flags, missing/malformed manifest, correct x64/arm64 fixtures.

**Docs:** sidecar README and release procedure.

**Dependencies:** Slice 08 for durable manifest writes.  
**Rollback:** package still contains binaries; manifest is additive.

### Slice 26 — REL-02 — Compare local and registry tarball identity

**Invariant:** an existing sidecar version is skipped only when registry bytes equal the locally packed intended package.

**Implementation:**

- Pack the local sidecar before mutation and capture npm integrity/shasum plus provenance manifest.
- Query or download registry metadata with bounded process/network policy and distinguish not-found, auth, timeout, corruption, and server failure.
- On existing version, compare integrity and manifest; continue only on equality, otherwise require a version bump.
- Recheck equality after a publish conflict.

**Tests:** same bytes, different bytes, 404, auth error, timeout, corrupt response, matching/different concurrent-publish conflict.

**Docs:** version-bump diagnostic and registry ambiguity policy.

**Dependencies:** Slices 02 and 25.  
**Rollback:** no registry mutation in tests; release script remains retryable.

### Slice 27 — REL-03 — Preflight and record the two-package release workflow

**Invariant:** both packages are built, tested, and packed before the first publish; every partial registry state is explicit and safely retryable.

**Implementation:**

- Move the main build/test/API/provenance/pack preflight ahead of sidecar publication.
- Publish sidecar, verify registry identity, then allow main npm publication last.
- Record a versioned local release-state artifact outside the package tarball with intended integrities and completed stages.
- On retry, reconcile registry facts with the record and continue only when identities match.
- Change documentation and output from “one command ships both atomically” to the truthful ordered workflow.

**Tests:** sidecar success/main failure, sidecar conflict match/mismatch, retry after crash at every stage, main pack failure before mutation, release-state corruption.

**Docs:** complete release runbook and recovery table.

**Dependencies:** Slices 21, 25, and 26.  
**Rollback:** publication cannot be undone; rollback means stop and follow recorded recovery rather than reverting registry state.

## 7. Phase gates

| Gate                                          | Slices | Required evidence                                                                                           |
| --------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Process and hostile-boundary safety           | 01–07  | Focused hostile-process/worker/network tests, full suite, no unbudgeted production child inventory          |
| Durable coordination and generation integrity | 08–18  | FI-01 through FI-17 and FI-31, full suite, generation/pagination semantic integration tests                 |
| Versioned contracts                           | 19–24  | Old/current/future fixture matrix, API manifest check, command JSON contract suite                          |
| Release provenance                            | 25–27  | No-publish simulated registry suite, deterministic pack/provenance checks, recovery dry-run                 |
| Final                                         | 01–27  | Build, typecheck, lint, full tests, docs generation/check, API check, npm pack dry-runs, reindex, diff-gate |

## 8. Adversarial review

1. **Attack: immutable local generations may double large database storage.** Mitigation: prefer same-filesystem hard links or move-then-derived stable mirrors where safe; expose bytes in status; retain only current plus leased/grace generations. The generation invariant outranks a silent mixed snapshot.
2. **Attack: process birth identity may be unavailable on a platform.** Verdict: inability to verify changes behavior from destructive automation to explicit recovery. Availability degrades; ownership safety does not.
3. **Attack: generalized locking could serialize unrelated work.** Mitigation: locks remain resource-scoped—one config path, one suppression identity, one repository reachability set, one mailbox claim—not global.
4. **Attack: a conflict-aware writer could livelock under active edits.** Mitigation: bounded retries followed by a non-destructive conflict result. Never “solve” contention by overwriting the latest bytes.
5. **Attack: queue idempotency can return stale results after source changes.** Mitigation: operation keys include generation/base-generation and request kind; a retry with different source authority is a different logical operation.
6. **Attack: version fields alone create ceremonial compatibility.** Mitigation: every versioned boundary has legacy/current/future fixtures and an unsupported count or explicit error; no decoder ends in an unchecked cast.
7. **Attack: declaration snapshots can block harmless formatting.** Mitigation: compare a normalized semantic manifest rather than raw `.d.ts` text, but fail conservatively on uncertain changes.
8. **Attack: registry integrity comparison may differ because local packing is nondeterministic.** Mitigation: compare npm's packed integrity produced by the same pack path and the internal provenance manifest; investigate nondeterminism rather than weakening equality.
9. **Attack: two-package publication still is not atomic.** Verdict: accepted. The plan guarantees detectable identity-safe partial state and retry, not atomicity npm cannot provide.
10. **Attack: mocks could merely restate implementation.** Mitigation: fault tests inject barriers at side-effect boundaries and assert external invariants—no signal, pending intent retained, child exited, bytes bounded, old/current/future behavior—not internal call sequences.

## 9. Decision certificate

1. The issue register identifies reachable defects at state, process, protocol, and release boundaries; the implementation units above correspond one-to-one with those 27 findings.
2. Slices 01, 08, 09, and 19 establish identity, durable replacement, lock ownership, and decoding infrastructure before dependent behavior uses it.
3. Slices 03 and 04 make watcher lifecycle observable before changing its shutdown semantics.
4. Slice 10 changes only publication/reader binding and explicitly preserves private candidate validation and shared immutable generation validation.
5. Slices 11–18 remove lost updates and unbounded lifecycle behavior with resource-scoped coordination, not a global lock.
6. Slices 20–24 use additive overlap migrations and visible unsupported-version behavior, so current consumers are not forced through a flag day.
7. Slices 25–27 acknowledge registry irreversibility and place all fallible local work before publication.
8. Every destructive or irreversible boundary has a fail-closed rule and a deterministic adverse-path test.

**Verdict:** ready to implement in the stated dependency order. The user has pre-approved this plan, but any contradiction of the numbered premises requires a documented revision before the affected code change.

## 10. Implementation ledger

| Slice | Finding | Status   | Commit     | Focused tests                       | Notes                                                                                                                                        |
| ----: | ------- | -------- | ---------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
|    01 | DD-02   | complete | `d8b62fce` | 60 focused tests                    | PID reuse, legacy records, and per-worktree lifecycle verified                                                                               |
|    02 | RES-01  | complete | `17ea60bd` | 230 regression + 2 contract tests   | Reap, byte/time budgets, transient retry, and inventory verified                                                                             |
|    03 | TEST-01 | complete | `6fbe2a9a` | 20 behavior + 1 contract test       | Runner, subscription, clock, and launch-policy seams verified                                                                                |
|    04 | RES-02  | complete | `7eaab92e` | 61 focused tests                    | Child reap, output drain, close failures, and ownership verified                                                                             |
|    05 | RES-03  | complete | `63ec2cc0` | 163 Rust semantic tests             | Frame bounds, sticky failure, waiters, and one-shot kill verified                                                                            |
|    06 | RES-04  | complete | `8587125e` | 34 focused tests                    | Time/byte bounds, lock/recheck, staging cleanup, and TLA verified                                                                            |
|    07 | RES-05  | complete | `b9cb9aa3` | 20 focused + 25 contract tests      | Exit/error/timeout ownership, result identity, and cache verified                                                                            |
|    08 | DD-08   | complete | `2a4d62b4` | 180 focused + contract tests        | Fault phases, platform limits, callers, and binary promotion verified                                                                        |
|    09 | DD-04   | complete | `437dc042` | 181 focused tests                   | Partial creation, guarded reclaim, shared I/O, PID reuse, legacy, and release verified                                                       |
|    10 | DD-01   | complete | `c58c28df` | 112 focused; 1,558 full-suite tests | Immutable pointer, retained companions, cursor/semantic isolation, architecture gate verified                                                |
|    11 | DD-03   | complete | `a13f6808` | 120 focused; 1,574 full-suite tests | Immutable admission, exclusive claims, completion receipts, retry, expiry, and status verified                                               |
|    12 | DD-05   | complete | `aff8685c` | 53 focused; 1,590 full-suite tests  | Revision checks, narrow merges, exclusive create, strict Markdown conflicts, and crash boundaries verified                                   |
|    13 | DD-06   | complete | `5bc743ed` | 39 focused; 1,598 full-suite tests  | Exclusive create, idempotent replay, compare-and-replace, schema decoding, and crash boundaries verified                                     |
|    14 | DD-07   | complete | `5fd33ab0` | 24 focused; 1,603 full-suite tests  | G2 publication, deletion/recreation, ownership, and touch ordering verified                                                                  |
|    15 | DD-09   | complete | `adfded36` | 48 focused; 1,606 full-suite tests  | Serialized UPSERT, exact retry, collision, timeout, and suppression verified                                                                 |
|    16 | DD-10   | complete | `d577a205` | 68 focused mailbox/identity tests   | Atomic claims, first-completion fencing, retry, quotas, crash recovery, legacy overlap, fairness, cleanup, and telemetry verified            |
|    17 | DD-11   | complete | `7c00267c` | 244 focused; 1,625 full-suite tests | Monotonic waits, conservative ownership, PID reuse, civil jumps, relative Rust budget, and atomic lock publication verified                  |
|    18 | DD-12   | complete | `45676dd4` | 92 focused; 1,637 full-suite tests  | Locked tail repair, two-segment rotation, deterministic reads, contention, crash phases, and watch exclusions verified                       |
|    19 | API-04  | complete | `e6637774` | 179 focused; 1,671 full-suite tests | Shared v2/v3 matrix, malformed fields, partial policy, v4 rejection, identity, reuse, publication, and additive fields verified              |
|    20 | API-01  | complete | `bbb0db24` | 126 focused passing tests           | v0/v1 decode, future rejection, result versions, all JSON descriptors, private protocol, config/metadata reuse, schema, and package verified |
|    21 | API-02  | complete | `80cb260d` | 13 contract + consumer compile      | 72 paths, 871 exports, shared declaration closure, conservative classification, immutable acceptance, and release gate verified              |
|    22 | API-03  | complete | `777d09c9` | 95 config/API/revision assertions   | Legacy/current/future/malformed decoding, no-op migration, unknown-field preservation, conflict safety, and packaged schema verified         |
|    23 | API-05  | complete |            | 65 focused; 1,717 full-suite tests  | Exact compatibility accounting, overlap readers, safe migration, incomplete-history fencing, disclosure, schemas, and package verified       |
|    24 | API-06  | pending  |            |                                     |                                                                                                                                              |
|    25 | REL-01  | pending  |            |                                     |                                                                                                                                              |
|    26 | REL-02  | pending  |            |                                     |                                                                                                                                              |
|    27 | REL-03  | pending  |            |                                     |                                                                                                                                              |

### Slice 10 verification record

- The 112-test focused matrix covers local and shared generation publication,
  reader retention, cursor rejection, conflicting semantic symbol IDs,
  metadata refresh, freshness, Rust companion reads, and evidence identity.
- The complete suite passes: 210 test files and 1,558 tests.
- `pnpm run lint`, `pnpm run build`, and `git diff --check` pass.
- A real local rebuild reports an immutable current generation and a retained
  recovery generation; stable `index.db`, `index.scip`, and `meta.json` are
  explicitly reported as compatibility mirrors.
- The first diff-gate run caught a new `reindex -> filesystem` dependency and
  its same-name directory-sync twin. The fix moved the reusable durable
  directory-sync operation behind `src/storage/atomic-file.ts`; the final gate
  must contain no blocking architecture finding.
- Full-suite verification also exposed two inaccurate test doubles: setup's
  mocked `node:fs` omitted descriptor-level durable-write operations, and the
  linked-worktree watcher test treated duplicate OS notifications as a
  correctness failure. Both now assert the actual durability and worktree
  isolation contracts.

### Slice 11 verification record

- Durable request storage tests force admission acknowledgement loss,
  competing claims, predecessor crash recovery, failure release/retry,
  completion-before-release crash, expiration, and retention pruning.
- The runtime coordinator proves requests are claimed only from the idle
  watcher state and are acknowledged only by the corresponding completion
  callback. A dedicated watch-service regression recreates the former
  activity-replacement race and retains the request.
- Protocol version 5 status parsing and both JSON and human watch status expose
  request lifecycle counts. The legacy activity decoder converts an observed
  overlap-format request into a stable idempotent admission.
- The complete suite passes: 212 test files and 1,574 tests. Lint, typecheck,
  build, whitespace validation, reindex, and diff-gate also pass; the final
  gate reports no blocking or advisory findings.

### Slice 12 verification record

- Storage fault tests inject independent writes at the read/commit barrier,
  continuous edits through retry exhaustion, a simultaneous first creator, and
  a crash before publication. The winning/latest bytes remain intact and the
  token-owned lock is released for recovery.
- Runtime tests cover unrelated and unknown JSON fields, stale same-field
  choices, malformed latest JSON, incomplete/reordered Markdown markers,
  managed prose preservation, and hook installation/removal against real Git
  checkout-local files.
- The revision protocol also covers the managed `.git/info/exclude` block and
  owned pre-commit hook found during the implementation pass, closing the
  writer class rather than only the originally cited call sites.
- The complete suite passes: 213 test files and 1,590 tests. Lint, typecheck,
  production build, and whitespace validation also pass.

### Slice 13 verification record

- The suppression identity is now an explicit conflict domain. First
  publication is exclusive, exact replay is byte-idempotent, and a different
  policy requires the full observed SHA-256 revision.
- New schema-versioned records carry stable identity and writer provenance.
  Legacy records remain readable and upgrade only after an explicit policy
  replacement; future, malformed, and identity-drifted records are diagnosed.
- Fault injection publishes a competing first decision, changes an existing
  record at the commit boundary, and throws before publication. Every test
  asserts that the winning or prior bytes survive and the lock remains
  recoverable.
- The CLI and generated command reference expose `--replace <revision>`, while
  README and write-safety documentation define the review/retry protocol.
- A built-CLI smoke test exercised create, same replay, rejected policy change,
  successful reviewed replacement, and stale-token rejection against a real
  temporary Git repository.
- The complete suite passes: 213 test files and 1,598 tests. Typecheck, lint,
  production build, generated-command-reference checks, and whitespace
  validation also pass.
- Fresh SCIP references resolve the writer and decoder through their complete
  consumer sets. The final diff gate reports zero blocking and zero advisory
  findings.

### Slice 14 verification record

- The initial pointer read now selects a repository-cache lock; every
  authoritative pointer, lease, context, metadata, generation, and artifact
  observation happens again while that lock excludes generation publication
  and cleanup.
- The touch constructs a new record by changing only `lastSeenAt`. It never
  mutates or republishes the pre-lock object.
- Deterministic barriers publish G2 while a G1 touch waits, delete a lease,
  recreate it with different ownership, corrupt its checksum, and complete a
  newer touch before an older one. G2/current bytes survive every case and
  liveness does not regress.
- The 24-test focused matrix covers the shared-generation store and repository
  cache lifecycle; TypeScript validation passes.
- The complete suite passes: 213 test files and 1,603 tests. Lint, production
  build, and whitespace validation also pass.
- Fresh SCIP references report the touch's complete consumer set. The first
  diff gate identified two architecture documents that cite the changed shared
  generation owner; both lease/ownership claims were reconciled, and the final
  gate reports zero blocking and zero advisory findings.

### Slice 15 verification record

- `finding_outcome_observations` is the exact-retry memory for the local
  metric. A logical run claims one ID and fingerprint in the same immediate
  transaction that derives and publishes its ledger transition.
- Existing findings increment through SQLite `UPSERT`; state-only resolutions
  use identity-scoped updates. The transition callback runs only after SQLite
  reserves the writer, so it cannot derive from the former stale pre-lock
  snapshot.
- Two independent `ScipDatabase` connections interleave at the former
  read/write gap and retain both increments. Exact retry, different-evidence
  ID collision, distinct-run increment, duplicate-in-one-run normalization,
  suppression, recency eviction, writer-lock timeout, and post-timeout retry
  are deterministic tests.
- Runtime event derivation compares the previous/current pair returned by the
  committed transaction. A retried logical run therefore emits neither a
  second counter increment nor a second caught event.
- The 48-test focused matrix passes. The full suite passes with 213 files,
  1,606 tests, and 2 intentional skips when `XDG_CACHE_HOME` is redirected to
  a writable temporary root; the unredirected sandbox run reached all changed
  tests but denied eight unrelated `~/.cache` directory creations.
- Typecheck, lint, production build, and whitespace validation pass.

### Slice 16 verification record

- The common mailbox is a bounded state machine with `pending`,
  owner-specific `inflight`, retained `responses`, and bounded `dead-letter`
  state. Admission, claim transfer, reclaim, first completion, and maintenance
  share one token-owned coordinator so a quota scan cannot miss a concurrent
  rename between lifecycle directories.
- A SHA-256 operation key and deterministic request ID make retry a join over
  pending, inflight, or completed state. The canonical JSON identity encoder
  is shared by mailbox and durable Rust session identities, with explicit
  tests for key-order convergence and array-order significance.
- TypeScript semantic, TypeScript index, and durable Rust transports publish
  version 3 request envelopes with client identity, enqueue time, deadline,
  and operation identity. They drain the immediately prior request layout,
  reject malformed, expired, oversized, and explicitly future-version work,
  and retain authoritative responses instead of deleting evidence on client
  timeout.
- The 68-test focused matrix covers the shared state machine plus all three
  transports, watch-state parsing, watch-service telemetry, canonical
  identity, item/count/byte backpressure, bounded batch fairness, claim expiry,
  owner fencing, crash-before/after-response recovery, legacy overlap, and
  bounded cleanup.
- A complete SCIP affected-consumer pass identified TypeScript incremental
  indexing and the Rust LSP session/readiness consumers. Their 62 tests pass
  independently of the focused mailbox suites.
- Refutation R1 followed every affected consumer outside the directly changed
  tests and found no generation, requester, or LSP readiness regression.
  Refutation R2 forced an expired owner to complete after its owner directory
  had been reclaimed; it exposed a real missing-directory fsync defect. The
  completion path now syncs the surviving inflight root, and a permanent
  first-completion-fencing race test covers the repaired boundary.
- The health-baseline lens reported accumulated heuristic deltas across the
  remediation program. One DD-10 duplicate was real: Rust and mailbox identity
  code had separate canonical JSON encoders. That implementation was unified
  in the dependency-free domain boundary. The retained DD-10 signals are
  expected extraction pressure inside one cohesive state machine, typed
  backpressure/wire contracts whose purpose is cross-process behavior, and
  thin protocol adapters.
- The diff gate's directory-enumeration echo was reviewed and suppressed
  narrowly: the mailbox must enumerate malformed and legacy retained records,
  while the older refresh queue intentionally filters a suffix. The
  watch-server/watch-service co-change signal was also suppressed narrowly:
  DD-10 changes mailbox processing and telemetry publication, while
  `watch-service.ts` owns unchanged external lifecycle control. The complete
  watch-service suite verifies that boundary.
- Production build, TypeScript validation, ESLint, formatting, whitespace,
  and all 68 focused tests pass. The complete suite reaches 215 files: 214
  files and 1,613 tests pass, with 2 intentional skips. Its remaining 2
  failures are the concurrent skill-consolidation command-catalog assertions
  in `tests/runtime/cli-contract.test.ts`; they do not execute DD-10 code and
  are assigned to the skill owner in `HEY.md`. The same concurrent edit is the
  only blocking finding left in the combined diff gate, and the two broken
  repo-local wrapper links are the only remaining full-lint failure. These
  integration failures must be closed and the full suite/gate rerun before
  the durable-coordination phase gate.

### Slice 17 verification record

- `src/domain/time.ts` is the shared control-time boundary: process-local
  deadlines and elapsed measurements use a monotonic clock, while persisted
  civil timestamps remain available for diagnostics, retention, and
  conservative cross-process expiry hints.
- Lock, watch, reindex, TypeScript mailbox, Rust mailbox/LSP, cache sweep,
  debounce, heartbeat throttle, and duration consumers were followed
  end-to-end. A relative Rust readiness budget crosses the process boundary;
  the receiver constructs its own monotonic deadline.
- Cross-process destruction now requires evidence beyond wall age. Process and
  admission locks first flush a private complete candidate and publish it
  exclusively. Watch replacement requires the recorded process-start identity.
  Inflight mailbox reclaim requires lease expiry plus proof that the recorded
  process instance is dead or replaced; a live or unverifiable owner remains
  authoritative.
- The final 18-file affected matrix passes 244 tests, including forward and
  backward civil-clock jumps, independent monotonic advance, PID reuse,
  malformed ownership, live expired claims, admission interleavings, and
  response/readiness timeout bounds. Typecheck and the production build pass.
- With `XDG_CACHE_HOME` redirected to an isolated writable directory, the full
  suite passes 215 of 216 files and 1,625 tests, with 2 intentional skips. The
  only 2 failures are the concurrently edited skill router's command-catalog
  assertions (`is` plus 40 uncovered public commands); they execute no DD-11
  source and remain assigned to the skill owner in `HEY.md`.
- Formatting and ESLint pass. Full lint stops only on the same concurrent skill
  consolidation's two broken `.agents` wrapper links.
- The first full diff gate caught two forbidden dependency directions and a
  duplicated exclusive-publication mechanism. Process identity parsing moved
  into the pure domain boundary, service coordinators now inject host liveness,
  post-index augmentation uses its native monotonic clock directly, and mailbox
  admission reuses `createFileAtomicExclusive`. The final source gate has no
  unsuppressed blocking finding. One Rust worker co-change was reviewed and
  narrowly suppressed because the worker already consumes the readiness
  helper's monotonic default and its complete worker/readiness suites pass.
  The remaining blocking gate findings are solely the uncommitted skill router.
- `health --baseline` reports 65 accumulated heuristic deltas from the
  remediation program. DD-11-related entries are extraction pressure in
  cohesive ownership/readiness workflows, public cross-process contracts, and
  thin adapters; no baseline ratchet or heuristic suppression was written.

### Slice 18 verification record

- `src/reindex/rotating-jsonl.ts` is now the single owner of the operational
  two-segment JSONL protocol. Its process-instance lock serializes incomplete
  tail repair, previous-segment pruning, current rotation, append, and
  retained-set reads. The established `.previous` name and each caller's
  configured byte budget remain compatible.
- The affected matrix passes 92 tests across the shared coordinator,
  reindex-activity integration, affected-shadow integration, reindex
  reliability, and watch exclusions. It exercises contention after every
  mutation phase, a crash after rename, partial-tail recovery, a live
  zero-budget contender, three-record retention, deterministic
  previous-then-current reads, serialization rejection, release-ownership
  change, and preservation of a primary append failure.
- Typecheck and the production build pass. With an isolated cache, the full
  suite passes 216 of 217 files and 1,637 tests, with 2 intentional skips. The
  only 2 failures are the concurrently edited consolidated skill router's
  command-catalog assertions (`is` plus 40 uncovered public commands); they
  execute no DD-12 source and remain assigned to the skill owner in `HEY.md`.
- Formatting and ESLint pass. Full lint stops only on the same concurrent
  skill consolidation's two removed `.agents` wrapper targets.
- The complete source diff gate has no DD-12 blocking finding. Its one source
  advisory points from the unchanged TLA-model skill reference to
  `src/runtime/watch.ts`; the cited `Watcher` class still exists and DD-12
  changed only which generated telemetry filenames it ignores. The two
  blocking findings are caused by Claude's uncommitted
  `skills/scip-query/SKILL.md` preview and remain in that owner's scope.
- `health --baseline` reports 66 accumulated heuristic deltas from the
  remediation program. The sole new DD-12 entry is extraction pressure in the
  cohesive append/repair/rotate transaction; no baseline ratchet or heuristic
  suppression was written.
- `docs/TELEMETRY_RETENTION.md` defines the retained referents, authority,
  locking, crash, completeness, and durability limits. Successful writes are
  process-visible complete records; the files remain bounded operational
  evidence rather than authoritative or fsync-durable state.

### Slice 19 verification record

- `src/domain/reindex-metadata.ts` is the single dependency-free decoder for
  every `meta.json` consumer. It distinguishes readable legacy v2, current v3,
  unsupported older/future versions, and malformed records; version 4 is an
  explicit reserved migration boundary.
- The shared fixture matrix covers complete and partial v2/v3 records,
  identity-only records, opaque legacy producer keys, object fingerprints,
  v3 language/project shard capabilities, and future v4. Field mutations
  cover JSON/version/status/timestamp/language/skipped/companion/shard errors.
- The final 13-file affected matrix passes 179 tests. Boundary cases prove v4
  cannot drive freshness, evidence keys, TypeScript generation identity,
  reindex shard reuse, or shared publication. Complete/partial evidence keys
  remain distinct, stable identities use one canonical projection, and an
  additive producer field survives a refresh-only metadata rewrite.
- The first full run exposed that the original evidence-cache contract treated
  a fingerprint as an opaque JSON identity; several Rust fixtures use a
  string. The decoder now preserves that v2/v3 evidence and stable-identity
  compatibility while requiring an object fingerprint for freshness and
  publication. The focused Rust cache gate and the second full run confirm
  the correction.
- Typecheck and the production build pass. With an isolated cache, the second
  full suite passes 218 of 219 files and 1,671 tests, with 2 intentional skips.
  The only 2 failures are the concurrent skill router's `is` token and 40
  uncovered-command catalog assertions; no API-04 source executes in them.
- Formatting and ESLint pass. Full lint stops only on the same concurrent
  skill consolidation's two removed `.agents` wrapper links.
- The complete source diff gate has zero blocking or advisory findings. Its
  only two blockers are the uncommitted `skills/scip-query/SKILL.md`
  co-change records owned by Claude.
- `health --baseline` reports 70 accumulated heuristic deltas. API-04 adds
  extraction pressure for the cohesive metadata validator and shard reuse,
  plus public-contract/thin-validator signals for the decoded union and shared
  project-file predicate. They are intentional contract boundaries; no
  baseline ratchet or heuristic suppression was written.
- `docs/REINDEX_METADATA_COMPATIBILITY.md` records the version table,
  capability matrix, consumer policies, unknown-field preservation, and the
  reviewed procedure required to enable v4.

### Slice 20 verification record

- Every descriptor-backed public command that advertises `--json` is exercised
  through the shared renderer matrix. The emitted v1 envelope identifies the
  transport kind/version, package producer/version, command, and independent
  result schema before preserving the established evidence, budget, args,
  options, result, coverage, and agent-result fields.
- The newest decoder accepts the committed unversioned v0 and current v1
  fixtures, preserves an unknown additive fixture field, and rejects malformed
  identities, unsupported outer versions, and unsupported per-command result
  versions with actionable context. A legacy tolerant consumer still reads the
  additive v1 record.
- Pretty and compact serialization parse to the same record. The JSON Schema
  constants and required keys are checked against the runtime constants, and
  the package file allowlist includes the schema directory.
- The two private analysis children now send a separately identified v1
  protocol. Both synchronous and asynchronous parent paths validate protocol,
  producer, version, command, and result; invalid JSON, future versions,
  command mismatch, timeouts, and reaping remain fail-closed. Host-owned hook
  outputs are explicitly classified and are not changed.
- The 126 passing focused assertions include the envelope, isolated runner,
  reindex JSON, CLI support, shared metadata/config record validation, and all
  API-01 portions of the CLI contract. The CLI contract's only two failures
  remain Claude's concurrently edited skill catalog (`is` and 40 commands not
  yet covered).
- With an isolated cache, the full suite passes 219 of 220 files and 1,681
  tests, with 2 intentional skips. Its only 2 failures are those same
  skill-owned catalog assertions; all API-01 tests pass.
- Typecheck and the production build pass. The programmatic-consumption guide,
  generated command-reference link, schema, and runtime decoder export are
  present in the built declarations and packaged file surface.
- Formatting and ESLint pass. Full lint stops only on Claude's two broken
  `.agents/skills` links to the removed `scip-maintainability` directory.
- The final source diff gate has zero blocking or advisory findings after the
  producer-version dependency was routed through the existing runtime boundary
  and decoded-record object checks were centralized in the domain validator.
  Its sole blocking finding is Claude's uncommitted router co-change.
- `health --baseline` reports 72 accumulated remediation-program deltas.
  API-01 adds extraction pressure for the cohesive envelope renderer and a
  thin serialization boundary; no baseline ratchet or heuristic suppression
  was written.

### Slice 21 verification record

- The generated declaration contract covers all 72 `package.json` TypeScript
  export targets, 871 named exports, and the eight generated declaration
  chunks reachable from those entries. No exported signature remains
  unresolved.
- The committed manifest is bound to an immutable acceptance record by its
  SHA-256 digest. A missing target, missing acceptance, edited manifest,
  declaration drift, or stale package-export list fails closed.
- Thirteen contract tests cover deterministic normalization, transitive
  re-export resolution, additive exports and optional fields, removals,
  optional-to-required parameters, union changes, required fields, moved
  declaration targets, explicit first acceptance, and conservative
  reclassification. The preserved downstream fixture compiles the root,
  `queries/refs`, `reindex`, and `runtime` package paths.
- `api:update` requires a meaningful reason and one of the reviewed
  classifications. It refuses to label known breaking or uncertain changes
  as additive, while an explicitly reviewed breaking acceptance receives its
  own content-addressed record.
- `npm run lint` reaches and passes formatting, ESLint, the production
  declaration build, `api:check`, and the downstream consumer compilation. It
  stops only on Claude's two concurrently removed
  `scip-maintainability` wrapper links.
- With an isolated cache, the full suite passes 220 of 221 files and 1,694
  tests, with 2 intentional skips. The only 2 failures remain Claude's
  concurrently edited skill catalog (`is` and 40 commands not yet covered).
  The API contract and Windows sidecar lifecycle tests pass.
- `npm pack --dry-run --ignore-scripts` succeeds with 356 package entries. The
  contributor-only baseline stays in the repository, while every declaration
  it verifies is present in the packed public surface.
- The postchecks report no new API-02 source duplicates, unused parameters, or
  affected consumers. The final diff gate has no API-02 blocking or advisory
  finding; its blockers are Claude's uncommitted skill-router co-change
  records. No suppression or health-baseline ratchet was written.

### Slice 22 verification record

- `src/domain/project-config.ts` is the single dependency-free format
  boundary. It classifies unversioned/explicit-v1 records as legacy, v2 as
  current, unsupported integers by direction, and invalid JSON, top-level
  shapes, discriminators, or editor hints as malformed before runtime options
  are exposed.
- Initialization and both revision-aware setup writers publish v2. Their
  latest-snapshot merge preserves unknown fields, rejects concurrent
  same-field changes, and treats pending schema migration as a real write even
  when the requested field is already present. Future or malformed latest
  bytes remain byte-for-byte unchanged.
- The focused matrix passes 95 tests across the pure decoder, runtime config,
  project setup, revision-aware mutation, and TypeScript declaration contract.
  It includes legacy/current/future/malformed records, no-op migration,
  unknown-field preservation, initialization metadata, validation diagnostics,
  concurrent mutation, and transitive declaration classification.
- The real `ProjectConfig` declaration change exposed an overly conservative
  Slice 21 classifier: every referenced declaration chunk had been marked
  uncertain. The gate now resolves aliased exports inside each changed chunk,
  recognizes this optional-field addition as additive, remains breaking for
  removal or incompatible signatures, and remains uncertain when changed
  non-exported text cannot be explained. Fourteen contract tests cover the
  refined behavior.
- The additive public change has the immutable acceptance digest
  `fe238d8ffe284634`, a reviewed reason, and a successful downstream consumer
  compile. Typecheck, formatting, ESLint, the production build, and
  `api:check` pass.
- `npm pack --dry-run` reports 357 package entries and includes
  `docs/schemas/project-config.schema.json`. The runtime/schema alignment test
  checks the discriminator, required metadata, and forward-field policy.
- With an isolated cache, the complete suite passes 221 of 222 files and 1,706
  tests, with 2 intentional skips. Its only 2 failures are Claude's
  concurrently edited `skills/scip-query/SKILL.md` command token and
  40-command coverage assertions; the API-03 documentation wording that first
  triggered a third failure was corrected and its assertion now passes.
- Complete postchecks found no recent duplicate or unused parameter. The pure
  decoder deliberately follows the existing reindex-decoder pattern while
  retaining a separate domain contract because the persisted records,
  supported versions, and compatibility outcomes differ. The single-consumer
  decoded union remains the explicit testable contract between classification
  and runtime enforcement.
- The built CLI accepts `$schema` and `schemaVersion`; the globally installed
  pre-change CLI reports them as unknown until this slice is published.
  Remaining config warnings and broken wrapper links belong to Claude's
  concurrent skill consolidation. One exact echo finding is suppressed by
  stable ID with the domain-separation rationale above; no broad suppression
  or health-baseline ratchet was written.

### Slice 23 verification record

- One dependency-free compatibility summary classifies every persisted
  candidate as readable legacy/current, unsupported older/future, or
  malformed. Its exact accounting conserves `accepted + omitted = total` and
  retains a path and reason for every omission.
- Suppression writes retain schema v1 and add the
  `scip-query-suppression` discriminator. The reader accepts unversioned v0,
  pre-discriminator v1, and current v1, while malformed or unsupported records
  cannot authorize a suppression. `diff-gate` consults the store even for an
  empty source diff and includes the compatibility summary in its public
  result.
- Outcome writes use an additive v1 envelope with a discriminator, semantic
  event identity, and producer metadata while keeping the prior semantic
  fields at the root. The previous permissive reader can consume the new
  shape, the current reader accepts all existing unversioned records, and
  producer metadata does not change semantic deduplication.
- Legacy JSONL migration copies compatible lines through exclusive,
  content-addressed writes but retains the source ledger and reports a warning
  if any non-empty line is incompatible. A retry does not create duplicate
  files. Cross-HEAD reconciliation retains all missing findings when committed
  event history is incomplete, so partial history can delay a verified repair
  but cannot manufacture one.
- Human diff-gate/effectiveness output, JSON results, and Stop-hook feedback
  disclose incomplete coverage without making record incompatibility alone a
  detector failure. `effectiveness --json` carries the exact accepted and
  omitted event counts beside its partial metrics.
- The 65-test focused matrix covers count conservation, old/current/future
  records, partial envelopes, unknown event kinds, mismatched identities,
  mixed repositories, prior-reader visibility, dedupe across versions,
  repeated partial migration, empty-diff disclosure, non-blocking hook
  feedback, and fail-closed cross-HEAD behavior. Typecheck and scoped ESLint
  pass.
- The additive `DiffGateResult` declaration change has immutable acceptance
  digest `1e1c3f6d3d4f341b`, a reviewed reason, a successful 72-path
  `api:check`, and a passing downstream consumer compilation.
- With an isolated `XDG_CACHE_HOME`, the full suite passes 223 of 224 files
  and 1,717 tests, with 2 intentional skips. The only 2 failures are Claude's
  concurrently edited skill catalog (`is` and 40 commands not yet covered);
  every Slice 23 test passes.
- `npm pack --dry-run` reports 360 entries and includes
  `docs/COMMITTED_RECORD_COMPATIBILITY.md`,
  `docs/schemas/suppression-record.schema.json`, and
  `docs/schemas/outcome-event-record.schema.json`. No existing legacy record
  was rewritten merely to change its compatibility label.
- The first source diff gate caught two real implementation defects: a
  duplicated record-object validator and a stale analyzer-validation contract
  that still described the old diff-gate check set. The shared validator now
  owns that boundary, the ledger names the complete current check family
  without fragile line anchors, and the final source gate reports neither
  finding.
- The final gate's only blockers are the command-reference and `_shared`
  co-change signals for Claude's concurrently edited
  `skills/scip-query/SKILL.md`. Two advisory bare-file citations were reviewed:
  `docs/COMMAND_REFERENCE.md` still points to the runtime command surface and
  `docs/analyzer-inventory.md` still points to `DIFF_GATE_CHECKS`; neither
  claim changed in this slice.
- `scip-query health --baseline` reports 79 accumulated heuristic deltas from
  the full 23-slice working history rather than Slice 23 regressions. The only
  Slice 23 entries are expected extraction/single-consumer signals around the
  cohesive event append/read result contracts; no baseline was ratcheted.

### Slice 09 verification note

- The final focused matrix passed 181 tests. Three linked-worktree watcher
  integrations also passed, exercising real per-worktree ownership and source
  refresh rather than only injected lock runtimes.
- An additional `tests/runtime/runtime-config.test.ts` run passed 38 cases and
  was environment-blocked in five cases before reaching the changed code:
  workspace sandboxing denied those tests permission to create their normal
  project directories under `~/.cache/scip-query/projects`.
- `scip-query diff-gate --json --compact` passed with zero blocking or
  advisory findings after its first run caught two exact durability-mechanics
  duplicates. Those duplicates were removed through the dependency-free
  `filesystem` boundary; the corresponding caught/resolved event records are
  committed with the slice.
- `scip-query health --baseline` reports 23 accumulated heuristic deltas from
  Slices 01–09, not 23 Slice 09 regressions. The Slice 09 entries are
  extraction signals for cohesive lock acquisition/reclaim workflows, an
  access-scaffolding similarity between the two halves of that state machine,
  and a single-production-consumer signal for `ProcessFileLockRuntime`. The
  runtime is retained because deterministic crash, filesystem, liveness,
  identity, and interleaving injection is its purpose; test consumers are not
  counted by that detector. No health-baseline ratchet or suppression was
  written at this per-slice gate.
