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

### Slice 18 — DD-12 — Serialize or segment JSONL rotation

**Invariant:** every successfully appended complete operational record remains discoverable across concurrent rotation.

**Implementation:** replace remove/rename rotation with immutable sequence/token-named segments and a bounded segment manifest, or serialize append/rotation beneath the standardized lock. Readers scan current plus ordered segments and tolerate one partial tail.

**Tests:** two writers at every rotation stage, crash with partial tail, segment retention budget, deterministic read order.

**Docs:** telemetry loss/retention contract.

**Dependencies:** Slices 08 and 09 if the lock/manifest design is chosen.  
**Rollback:** readers retain legacy `.previous` support.

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

### Slice 24 — API-06 — Version and correlate Rust mailbox envelopes

**Invariant:** a Rust response is accepted only when protocol, request ID, operation ID, session identity, and deadline match.

**Implementation:**

- Add explicit request/response envelope versions and strict kind validators.
- Echo request and operation IDs plus durable server/session identity.
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

| Slice | Finding | Status   | Commit     | Focused tests                       | Notes                                                           |
| ----: | ------- | -------- | ---------- | ----------------------------------- | --------------------------------------------------------------- |
|    01 | DD-02   | complete | `d8b62fce` | 60 focused tests                    | PID reuse, legacy records, and per-worktree lifecycle verified  |
|    02 | RES-01  | complete | `17ea60bd` | 230 regression + 2 contract tests   | Reap, byte/time budgets, transient retry, and inventory verified |
|    03 | TEST-01 | complete | `6fbe2a9a` | 20 behavior + 1 contract test       | Runner, subscription, clock, and launch-policy seams verified    |
|    04 | RES-02  | complete | `7eaab92e` | 61 focused tests                    | Child reap, output drain, close failures, and ownership verified |
|    05 | RES-03  | complete | `63ec2cc0` | 163 Rust semantic tests             | Frame bounds, sticky failure, waiters, and one-shot kill verified |
|    06 | RES-04  | complete | this slice | 34 focused tests                    | Time/byte bounds, lock/recheck, staging cleanup, and TLA verified |
|    07 | RES-05  | pending  |            |                                     |                                                                 |
|    08 | DD-08   | pending  |            |                                     |                                                                 |
|    09 | DD-04   | pending  |            |                                     |                                                                 |
|    10 | DD-01   | pending  |            |                                     |                                                                 |
|    11 | DD-03   | pending  |            |                                     |                                                                 |
|    12 | DD-05   | pending  |            |                                     |                                                                 |
|    13 | DD-06   | pending  |            |                                     |                                                                 |
|    14 | DD-07   | pending  |            |                                     |                                                                 |
|    15 | DD-09   | pending  |            |                                     |                                                                 |
|    16 | DD-10   | pending  |            |                                     |                                                                 |
|    17 | DD-11   | pending  |            |                                     |                                                                 |
|    18 | DD-12   | pending  |            |                                     |                                                                 |
|    19 | API-04  | pending  |            |                                     |                                                                 |
|    20 | API-01  | pending  |            |                                     |                                                                 |
|    21 | API-02  | pending  |            |                                     |                                                                 |
|    22 | API-03  | pending  |            |                                     |                                                                 |
|    23 | API-05  | pending  |            |                                     |                                                                 |
|    24 | API-06  | pending  |            |                                     |                                                                 |
|    25 | REL-01  | pending  |            |                                     |                                                                 |
|    26 | REL-02  | pending  |            |                                     |                                                                 |
|    27 | REL-03  | pending  |            |                                     |                                                                 |
