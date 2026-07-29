# Durability Remediation Plan

Date: 2026-07-27
Baseline revision: `9de38b98ac75fe0fa620d921c83911e7634e255c`
Audit: `docs/reviews/2026-07-27-durability-audit.md`
Mode: high assurance
Status: approved for execution

## Goal

Close DUR-01 through DUR-09 without calling process-visible filesystem state
crash-durable, without accepting a corrupted immutable generation, and without
weakening Windows support through a false POSIX guarantee.

The program is complete only when every successful publication reports what
the host actually achieved, every newly created authoritative path has a
durable name where the host exposes directory synchronization, immutable
artifacts are authenticated before use, and executable tests exercise the
filesystem operations that cross the persistence boundary.

This program does not edit `skills/**`. Concurrent skill work remains owned by
Claude. Source, tests, durability documentation, this plan, the audit, and
exact verification records are in scope.

## Definitions and invariants

A **persistence frontier** is the boundary between filesystem changes visible
to the current process and changes forced into the host's recoverable storage
state. File synchronization advances file contents and inode metadata across
that boundary; directory synchronization advances filename-to-inode mappings.

An **achieved durability** is a tagged result describing the strongest
guarantee established by the operations that actually succeeded:
`visibility`, `file-flushed`, or `directory-durable`. It differs from a
durability request because requesting a directory flush cannot make an
unsupported host perform one.

A **durable directory chain** is a path whose newly created directory names
have each been followed by synchronization of the directory that contains
that name. The causal fact that distinguishes it from recursive `mkdir` is
that every component, not merely the leaf directory's contents, has crossed
the persistence frontier.

An **immutable generation authority** is a manifest-selected artifact set
accepted for code-intelligence reads only after the stored bytes match the
manifest's size and SHA-256 identities. A read-only mode bit discourages
mutation, but the digest comparison is what authenticates the bytes.

A **destructive-safety credential** is the cache ownership record that permits
later code to remove a physical cache tree. It becomes authoritative only
after the complete record and the successfully hardened tree are associated
through a durably published filename.

The following invariants govern every slice:

1. `directory-durable` is returned if and only if every required file and
   directory synchronization succeeded.
2. `file-flushed` is returned when file contents were synchronized but any
   required directory synchronization was unsupported.
3. No newly created directory component is omitted from the synchronization
   sequence used by a durable publisher.
4. A mailbox source name is not durably removed before its complete
   destination hierarchy has a durable name.
5. A local immutable generation is never returned unless every manifest
   artifact's current bytes match its recorded digest.
6. A successful shared-generation publication follows final artifact mode and
   file synchronization, manifest publication, final rename, and
   `generations/` synchronization in that order.
7. A cache ownership credential is not publicly reachable until adoption and
   hardening have succeeded; short or zero-progress writes cannot publish it.
8. Every final read-only mode change precedes the artifact's final file
   synchronization.
9. Documentation and logs reserve unqualified crash durability for the
   `directory-durable` result.

## Premises

P1. `replaceFileAtomic` and `createFileAtomicExclusive` currently recursively
create the target parent, flush the staged file in durable mode, publish the
target, and synchronize only the leaf parent directory.

P2. The fully retrieved `plan-context replaceFileAtomic` result identifies
three direct callers, five direct reverse-dependent modules, and 41 bounded
transitive affected symbols. Its transport pages were all retrieved through
`complete: true`; command-level affected coverage remains bounded.

P3. The unbounded `refs writeJsonDurable --full` result identifies production
writers in health baselines, reindex metadata, local and shared generations,
watch state, Rust session state, bounded mailboxes, and watch-refresh records.

P4. `AtomicFileWriteResult.durability` currently echoes the requested mode
even when `directorySync` is `unsupported`. The type therefore cannot directly
answer what persistence guarantee was achieved.

P5. `readImmutableGeneration` is the sole internal immutable-generation
acceptance function beneath `resolveSqliteGeneration`; it currently validates
regular-file size but not the stored SHA-256 digest.

P6. Local generation publication records a digest for every database, SCIP,
and metadata artifact. Existing collision handling already hashes an existing
generation, providing a reusable correctness rule.

P7. `publishSharedGeneration` copies or reflinks each artifact, hashes the
visible bytes, durably writes the manifest, and renames the staging directory,
but its artifact clone and final publication do not synchronize the artifact
files or `generations/`.

P8. `claimBoundedMailboxRequestsUnlocked` creates a new owner directory,
publishes its owner record, renames a pending request into it, and synchronizes
the source and owner directories, but does not first synchronize `inflight/`
after the new owner-directory name appears.

P9. `ensureOwnedCacheDir` publishes the ownership record before the final
adoption/hardening check. Its writer performs one unchecked `writeSync`, and
its rollback unlinks the credential without synchronizing the containing
directory.

P10. `materializeGeneration` currently synchronizes copied artifact bytes
before applying mode `0444`; no later file synchronization persists that mode
change.

P11. Existing tests exercise process exceptions and ordinary filesystem
visibility but do not consistently distinguish file synchronization from
directory synchronization or recursive parent publication.

P12. npm registry reconciliation is the release safety authority. The local
release state improves recovery, but its log currently calls the state
“durable” even when its own writer reports unsupported directory
synchronization.

## State-authority inventory

| State                                   | Writers                                          | Readers                                                   | Required recovery rule                                                                              |
| --------------------------------------- | ------------------------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Atomic target name                      | `replaceFileAtomic`, `createFileAtomicExclusive` | all atomic JSON/file consumers                            | old or new complete bytes; achieved result states whether the new name is crash-durable             |
| Local generation pointer                | generation-store `writeJsonDurable` calls        | `readSqliteGenerationState` → `resolveSqliteGeneration`   | a named immutable generation must authenticate before use; corrupt current fails closed             |
| Local immutable artifacts               | `materializeGeneration`                          | `readImmutableGeneration` and database/semantic consumers | digest mismatch invalidates the complete generation                                                 |
| Shared generation directory             | `publishSharedGeneration`                        | `readSharedGeneration`, hydration, peer import            | incomplete or corrupt data is a cache miss; successful publication is durably named where supported |
| Watch refresh records                   | `publishImmutableJson`, claim/completion cleanup | watch owner and status inspection                         | accepted intent remains observable or reports a bounded achieved guarantee                          |
| Mailbox pending/inflight/terminal names | enqueue, claim, complete, reject, maintenance    | TypeScript/Rust service lanes                             | work is recoverable in exactly one pending, inflight, or terminal state                             |
| Cache ownership record                  | `ensureOwnedCacheDir`                            | ownership assertions and destructive cache operations     | a public valid credential implies completed adoption and hardening                                  |
| npm release ledger                      | release-state writer                             | release coordinator                                       | registry is reconciled; logs state the local ledger's achieved guarantee                            |

The writer and reader sets above are grounded in the audit's complete
`refs --full` results and the current complete reference reruns for
`AtomicFileWriteResult`, `writeJsonDurable`, `readImmutableGeneration`,
`publishSharedGeneration`, `claimBoundedMailboxRequestsUnlocked`, and
`ensureOwnedCacheDir`.

## Reuse and compatibility audit

- Move generic directory synchronization and durable directory-chain
  initialization into `src/filesystem/**`, the existing common boundary that
  both `platform` and `storage` may depend on. Importing `storage` from
  `platform` would violate the repository's sibling-boundary rule.
- Extend `AtomicFileRuntime` from the shared directory runtime instead of
  creating a second atomic writer.
- Reuse `writeFileCompletely` for cache ownership; do not duplicate the
  short-write loop.
- Reuse one durable artifact-clone helper for local and shared generations so
  mode, file synchronization, and parent-entry synchronization cannot drift.
- Reuse manifest digests already written by local generation publication.
  Add a process-local validation cache keyed by generation plus stable file
  identity; do not create another manifest.
- Preserve the existing `directorySync` field during this release, but replace
  the ambiguous echo field with explicit `requestedDurability` and
  `achievedDurability`.
- Keep watch and release wire behavior additive where possible: add achieved
  durability to results and logs rather than removing valid outcomes.
- Do not turn Git-durable outcome events or rebuildable telemetry into
  per-write fsync workloads.

## Testability design

- A directory runtime exposes existence, mkdir, open, fsync, and close as the
  production side-effect boundary. A deterministic test runtime records both
  visible and persisted namespace state.
- A durable clone runtime exposes copy, chmod, open, fsync, close, and
  directory operations. Tests assert caller-visible failure and final mode,
  not private helper call counts alone.
- Local generation integrity tests mutate real generated artifacts to
  different same-size bytes and reopen through the public `ScipDatabase`
  boundary.
- Mailbox tests observe real pending and inflight names and use a stage seam
  only to stop execution at a persistence boundary.
- Cache ownership tests inject short writes through the same
  `writeFileCompletely` port production uses and independently reread the
  public credential.
- Release tests inject `synced`, `unsupported`, and failure outcomes through
  the production-shaped runtime and assert returned state plus operator logs.
- Platform-gated integration assertions check POSIX read-only modes. The
  deterministic model covers unsupported directory handles.

## Remediation slices

### Slice 1 — DUR-05: truthful achieved durability

Change:

- Introduce `visibility | file-flushed | directory-durable`.
- Replace the requested-mode echo in atomic write results.
- Preserve directory-sync detail and propagate the achieved result through
  watch-refresh and npm release protocol boundaries.

Validation:

- Atomic-file Windows and POSIX result tests.
- Watch-refresh admission result test.
- npm-release unsupported logging test.

Deployable: yes; the result shape and all internal consumers change together.

### Slice 2 — DUR-01: durable directory-chain initialization

Change:

- Add the shared directory runtime and durable initializer.
- Synchronize the containing directory after each newly created component.
- Route atomic publication and authoritative fixed-directory initialization
  through it.

Validation:

- Existing-parent, one-new-parent, nested-parent, unsupported-host, and
  injected-sync-failure tests.

Deployable: yes after Slice 1.

### Slice 3 — DUR-04: mailbox namespace ordering

Change:

- Durably initialize the fixed mailbox skeleton.
- Synchronize `inflight/` after owner-directory creation and before owner
  record or request rename.

Validation:

- First-owner versus existing-owner traces and crash-stage recovery tests.

Deployable: yes after Slice 2.

### Slice 4 — DUR-02: local generation integrity

Change:

- Authenticate database, SCIP, and metadata bytes before returning a handle.
- Cache successful validation by manifest identity and stable inode evidence.
- Fail closed on corrupt current even when a previous generation remains.

Validation:

- Same-size corruption for all three artifact classes, including corruption
  after a cached successful open.

Deployable: yes; corruption becomes a stale/invalid index instead of evidence.

### Slice 5 — DUR-03: shared-generation durability

Change:

- Use the durable clone helper for every artifact.
- Synchronize nested artifact directories, staging, the final rename, and
  `generations/`.

Validation:

- Artifact, manifest, rename, and final-directory failure tests plus existing
  corruption-to-cache-miss coverage.

Deployable: yes after Slice 2.

### Slice 6 — DUR-06: cache ownership transaction

Change:

- Complete and flush a private credential candidate with the shared
  short-write-safe writer.
- Harden and revalidate the cache before exclusive public credential
  publication.
- Synchronize credential publication; remove the unsafe post-publication
  rollback requirement.

Validation:

- One-byte writes, zero progress, hardening failure, publication collision,
  and directory-sync outcomes.

Deployable: yes after Slice 2.

### Slice 7 — DUR-07: final mode before final flush

Change:

- Apply final immutable mode before the durable clone's file synchronization.
- Make chmod or post-chmod synchronization failure abort publication.

Validation:

- Operation-order trace, injected failures, and POSIX mode assertion.

Deployable: yes with Slices 4 and 5.

### Slice 8 — DUR-08: persistence-frontier tests

Change:

- Add a deterministic visible-versus-persisted filesystem model for the
  shared directory and atomic publication ports.
- Add protocol-stage tests for local/shared generations, mailbox, watch
  refresh, ownership, and release state.

Validation:

- Execute the audit's crash matrix and prove each recovered state satisfies
  the relevant invariant.

Deployable: tests only, after Slices 1–7 expose the required seams.

### Slice 9 — DUR-09: documentation reconciliation

Change:

- Update durability, watch-refresh, generation, mailbox, release, and outcome
  event wording.
- Document newly created parent chains and achieved platform outcomes.
- Mark the audit findings resolved with exact tests and implementation
  anchors.

Validation:

- Prettier, link checks, `doc-drift`, and literal terminology search.

Deployable: yes after Slices 1–8.

## Attack record

A1 — Invariants 1–3, failure lens. Another process creates a missing parent
after the writer observes it absent. Outcome: **HOLE — repaired by Slice 2**;
the writer treats a raced mkdir as success but still synchronizes the
containing directory.

A2 — Invariants 1 and 9, platform lens. Windows rejects directory handles
after the file flush. Outcome: **HOLE — repaired by Slice 1**; the result and
protocol logs say `file-flushed`, never `directory-durable`.

A3 — Invariant 5, integrity lens. An immutable artifact changes to same-size
bytes after one successful validation. Outcome: **HOLE — repaired by Slice
4**; stable identity includes inode, size, mtime, and ctime and invalidates the
digest cache.

A4 — Invariant 5, recovery lens. Current is corrupt while previous is valid.
Outcome: **HELD by Slice 4 and P5**; resolution fails closed and requires
reindex instead of silently rolling authority backward.

A5 — Invariant 6, failure lens. One shared artifact flush fails after other
artifacts are visible in staging. Outcome: **HOLE — repaired by Slice 5**;
publication aborts before final rename and readers cannot select staging.

A6 — Invariant 4, concurrency lens. The source directory is synchronized after
rename while the new owner name is still volatile. Outcome: **HOLE — repaired
by Slice 3**; `inflight/` synchronization precedes the claim rename.

A7 — Invariant 7, failure lens. Cache hardening fails after a valid credential
becomes public. Outcome: **HOLE — repaired by Slice 6**; public publication is
the final adoption step.

A8 — Invariant 7, I/O lens. The first ownership write advances one byte.
Outcome: **HOLE — repaired by Slice 6** using `writeFileCompletely`; zero
progress is a failure.

A9 — Invariant 8, persistence lens. A crash follows chmod but precedes any
later metadata flush. Outcome: **HOLE — repaired by Slice 7**; chmod precedes
the artifact's final fsync.

A10 — Documentation lens. A caller ignores the detailed directory status and
prints “durable.” Outcome: **HOLE — repaired by Slices 1 and 9**; logs format
the achieved discriminant.

## Coverage matrix

| Authority/writer  | Failure                   | Concurrency                     | Integrity               | Platform bound | Human-visible claim |
| ----------------- | ------------------------- | ------------------------------- | ----------------------- | -------------- | ------------------- |
| Atomic writer     | A1                        | A1                              | Slice 8 frontier model  | A2             | A10                 |
| Local generation  | Slice 4 corrupt current   | pointer/reader tests            | A3/A4                   | Slice 1 result | Slice 9             |
| Shared generation | A5                        | existing publication race tests | existing rehash tests   | Slice 1 result | Slice 9             |
| Watch refresh     | Slice 8 stage matrix      | idempotency tests               | immutable record parser | A2             | A10                 |
| Mailbox           | Slice 8 stage matrix      | A6                              | owner/response parsers  | Slice 1 result | Slice 9             |
| Cache ownership   | A7/A8                     | exclusive publication race      | independent reread      | A2             | Slice 9             |
| npm release       | state-write failure tests | registry reconciliation         | exact tarball identity  | A2             | A10                 |

No matrix row is blank. Existing concurrency and integrity tests remain named
where this program does not change their mechanism.

## Execution and ship order

The real dependency chain is Slice 1 → Slice 2 → Slices 3, 5, and 6.
Slice 4 can proceed independently. Slice 7 lands through the clone helper used
by Slices 4 and 5. Slice 8 closes only after the production seams exist. Slice
9 describes the shipped result and therefore lands last.

All slices ship in one release because the atomic result type and its internal
consumers compile together. There is no persistent-data migration: existing
manifests already carry the digests the new reader enforces.

## Verdict

A plan is PLANNED-COMPLETE if and only if every state authority has named
writers and readers, every attack ends in a cited held or repaired outcome,
every slice has a production seam and observable validation, and no premise
fails reverification.

Result: **IMPLEMENTED-COMPLETE** — all nine slices were implemented; 10
attacks end in held or repaired outcomes, 0 accepted holes remain, and 0
coverage rows are blank. The implementation additionally narrowed the shared
generation rename-race catch after its crash-stage test proved that a
post-rename fault could otherwise be mistaken for an existing-winner success.

The persistence-frontier oracle now lives in
`tests/helpers/persistence-frontier.ts`. It distinguishes volatile file bytes
and namespace mutations from inode and directory state advanced by
synchronization, then discards uncommitted state on modeled power loss.
Boundary suites compose that primitive proof with stage-level recovery tests
for generations, watch refresh, mailboxes, cache ownership, and release state.

## Verification result

- `npm run typecheck -- --pretty false`: passed.
- Durability-focused suite: 10 files and 151 tests passed.
- Complete repository suite: 259 files and 2,052 tests passed.
- `npm run lint`: formatting, ESLint, build, public API contract, public
  consumer fixture, and skill-link checks passed.
- Complete SCIP references: `ensureDirectoryDurable` returned 18/18,
  `AtomicFileWriteResult` 6/6, `promoteReindexArtifacts` 4/4, and
  `publishSharedGeneration` 4/4.
- Full SCIP postchecks reported no incomplete migration, unused parameter, or
  recent duplicate finding in the changed scopes. The stale-abstraction scan
  retained one pre-existing medium-confidence `CompleteWritePort` signal; it
  is the shared test/runtime boundary used by the short-write-safe writer and
  is not a durability regression.
- Final `scip-query diff-gate --full --json --compact` completed with exact
  coverage, zero blocking findings, and zero advisory findings. Its first run
  correctly rejected a direct `reindex -> filesystem` dependency; routing the
  primitives through storage and updating the two cited architecture records
  made the rerun pass without suppression.
