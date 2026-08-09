# Filesystem Publication and Durability

This document classifies scip-query's file-backed state by the guarantee a
writer must provide. The classification is part of the storage contract: a
caller must choose a writer whose failure semantics match the record's role.

## Guarantees

A **visibility-atomic replacement** is a filesystem publication operation that
writes complete bytes to a private staging file and renames that file over the
target. The rename is the decisive characteristic: concurrent readers can
observe the old complete file or the new complete file, but never the
writer's partial staging bytes. It does not promise that the new bytes or
directory entry survive power loss.

A **crash-durable replacement** is a visibility-atomic replacement that also
flushes the complete staging file before rename and flushes the containing
directory after rename. When the writer creates a missing directory path, it
also creates each component from the nearest existing ancestor outward and
flushes the directory that names each new component. Those ordered flushes are
what make acknowledged file contents and the complete path that reaches them
recoverable after an operating-system or machine crash, subject to the host
filesystem and device honoring their flush contract.

An **authoritative record** is file-backed state whose loss can change which
generation, owner, policy, or accepted decision the program treats as current.
Its causal role in choosing later behavior makes silent rollback unsafe, so it
uses crash-durable replacement.

A **rebuildable record** is file-backed state whose loss can cost time,
diagnostics, or a retry but cannot make unverified facts authoritative. Because
another computation or bounded request can reconstruct it, complete
old-or-new visibility is sufficient.

A **directory flush** is a request to persist a directory entry—the mapping
from a filename to its file—after the file itself has been flushed. Flushing
only file contents is insufficient because a crash can otherwise lose the
rename that made those contents current.

An **achieved durability result** is the guarantee established by the
operations that actually completed, not the guarantee the caller requested.
`visibility` means only old-or-new complete process visibility;
`file-flushed` means the final file bytes were flushed but at least one
directory namespace could not be synchronized; and `directory-durable` means
the file plus every newly created ancestor and final directory entry crossed
the supported persistence frontier.

## APIs

| API                                                                        | Staging identity                                | File flush            | Rename/link                       | New-ancestor flush  | Final-directory flush |
| -------------------------------------------------------------------------- | ----------------------------------------------- | --------------------- | --------------------------------- | ------------------- | --------------------- |
| `writeJsonAtomic` / `replaceFileAtomic(..., { durability: "visibility" })` | Exclusive random token                          | No                    | Yes                               | No                  | No                    |
| `writeJsonDurable` / `replaceFileAtomic(..., { durability: "durable" })`   | Exclusive random token                          | Yes                   | Yes                               | Yes where supported | Yes where supported   |
| `createFileAtomicExclusive(..., { durability: "durable" })`                | Exclusive random token                          | Yes                   | Exclusive hard link               | Yes where supported | Yes where supported   |
| `cloneFileDurable`                                                         | Final target inside an unpublished staging tree | Yes, after final mode | Caller publishes the staging tree | Yes where supported | Yes where supported   |

`writeJsonAtomic` retains its original `void` return contract for compatibility.
`writeJsonDurable`, `replaceFileAtomic`, and `createFileAtomicExclusive`
return `requestedDurability`, `achievedDurability`, and `directorySync`.
Callers must use the achieved fields when logging or forwarding a durability
claim. Verified binary installation owns an equivalent platform-local
flush/rename sequence because the enforced architecture forbids dependencies
between the sibling `platform` and `storage` boundaries.

On Windows, Node can reject attempts to open or flush a directory handle.
Known Windows "directory handles unsupported" errors produce
`directorySync: "unsupported"` after the staged file itself has been flushed
and renamed. That result means complete visibility plus flushed file contents,
not the full POSIX directory-entry durability guarantee. Other directory-sync
errors remain failures. An API that returns only a path or value makes no
machine-crash claim; protocol APIs that acknowledge work expose the achieved
result explicitly.

## Failure Outcomes

| Failure point                       | Target visible after return/throw                               | Owned staging file               |
| ----------------------------------- | --------------------------------------------------------------- | -------------------------------- |
| Exclusive create                    | Previous target                                                 | No owned file was created        |
| Write or short/invalid progress     | Previous target                                                 | Closed and removed               |
| File flush                          | Previous target                                                 | Closed and removed               |
| Rename                              | Previous target                                                 | Removed by the writer            |
| POSIX directory flush               | New complete target; durability unconfirmed and the call throws | Already renamed; no staging path |
| Unsupported Windows directory flush | New complete target; result reports the limitation              | Already renamed; no staging path |

When a parent chain is new, a failure while creating or flushing any ancestor
also throws before a durable result is returned. The incomplete path can be
visible to the running process, but recovery may discard every component that
has not yet been named by a flushed parent.

The post-rename failure row is deliberately explicit. Once rename succeeds,
rolling back would be another publication with its own crash window. The
writer therefore leaves the verified new value visible and reports that it
could not confirm the stronger durability guarantee.

## Call-Site Classification

| Record                                               | Contract                                                           | Reason                                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reindex `meta.json`                                  | Durable                                                            | Names the accepted index status, fingerprint, and generation metadata                                                                                                                          |
| SQLite generation manifest and `state.json`          | Directory-durable where supported                                  | Durably establishes the generation root, flushes final read-only artifact bytes and metadata, publishes the immutable directory, then selects it for new readers                               |
| Shared generation                                    | Directory-durable where supported                                  | Flushes every read-only artifact and manifest, the staging namespace, the final generation rename, and the shared `generations/` namespace                                                     |
| Worktree lease and local cache pointer               | Durable                                                            | Protect generations from collection and bind a worktree to repository cache identity; generation changes, liveness touches, and cleanup serialize through the repository-cache lock            |
| Watch service state                                  | Durable                                                            | Publishes the process instance and index generation accepted as current                                                                                                                        |
| Rust semantic session `server.json`                  | Durable                                                            | Publishes the live server process and mailbox identity                                                                                                                                         |
| Project `.scipquery.json`                            | Durable                                                            | Controls indexing, watch, architecture, and detector policy; versioned reads reject unsupported meaning before use, and authorized writes migrate legacy bytes without dropping unknown fields |
| Codex/Claude hook JSON                               | Durable                                                            | Controls whether and when agent hooks execute                                                                                                                                                  |
| Structured suppression file                          | Durable                                                            | Records an accepted finding and its reason                                                                                                                                                     |
| Health baseline                                      | Durable                                                            | Acts as a committed regression policy                                                                                                                                                          |
| Verified binary cache promotion                      | Durable                                                            | Makes checksum-accepted executable or tool bytes current                                                                                                                                       |
| TypeScript/Rust request and response mailboxes       | Directory-durable where supported                                  | Admission is acknowledged only after the pending name is flushed; a new owner directory is durably named before a request moves from pending to inflight; responses precede claim release      |
| Watch activity                                       | Visibility-atomic                                                  | A newer timestamp supersedes an older idle-lifetime observation; it carries no durable intent                                                                                                  |
| Watch refresh request, claim, and completion records | Durable immutable admission and acknowledgement                    | Accepted intent survives activity replacement and owner crashes; exclusive claims may be recovered only by the next lock owner                                                                 |
| Cache ownership credential                           | Directory-durable where supported                                  | A complete file is flushed privately, hardening is revalidated, the public credential is linked exclusively, and its directory is flushed before detailed publication success                  |
| npm release state                                    | Directory-durable where supported; file-flushed on bounded hosts   | The registry is freshly reconciled and remains external authority; the local coordinate-pair recovery record reports its exact achieved guarantee                                              |
| TypeScript fragment/overlay manifests                | Visibility-atomic                                                  | Content-addressed cache artifacts are validated and rebuildable                                                                                                                                |
| Repository GC state                                  | Visibility-atomic                                                  | Sweep history can be reconstructed conservatively                                                                                                                                              |
| Affected-set shadow latest record                    | Visibility-atomic                                                  | Calibration telemetry does not control publication                                                                                                                                             |

Process locks use exclusive descriptor creation rather than replacement. Their
durable token ownership, malformed-creation grace, guarded recovery, and
legacy compatibility are defined in
[Process Lock Ownership and Recovery](LOCK_PROTOCOL.md). Generation directories,
stable compatibility mirrors, and their crash ordering are defined in
[Local Index Generations](INDEX_GENERATIONS.md). Durable watch demand,
idempotency, claim recovery, and acknowledgement ordering are defined in
[Watch Refresh Requests](WATCH_REFRESH_REQUESTS.md).

The outcome-event journal was retired in version `0.20.0` together with
autonomous completion state. Current scip-query neither writes nor reads those
records and therefore makes no current durability claim for them. Git history
retains the removed repository records; deprecated record-shape types remain
temporarily available only for consumer-owned historical data. See
[Workflow API retirement compatibility](api/compatibility/2026-08-09-workflow-retirement.md).

## Executable crash model

`tests/helpers/persistence-frontier.ts` models the two states a normal
filesystem test otherwise conflates. Writes, links, renames, and removals first
change process-visible state. File synchronization advances persisted inode
bytes and mode; directory synchronization advances persisted names. A modeled
power loss discards everything beyond those frontiers.

`tests/storage/atomic-file-crash.test.ts` replays replacement, exclusive
publication, new ancestor creation, and durable artifact cloning after every
relevant phase. Boundary-specific tests then hold the higher-level protocol
order:

- local generation stage and same-size corruption tests;
- shared-generation artifact, manifest, staging, rename, and final-directory
  stage tests;
- watch admission, claim, completion, and retry tests;
- mailbox owner-directory, claim-transfer, response, and recovery tests;
- ownership short-write, unsupported-sync, and failed-sync tests; and
- release-state synchronized, unsupported, and failed-write tests.

The deterministic model proves the filesystem primitive’s persisted-state
semantics. The boundary tests prove each protocol invokes those primitives in
the required order. Neither an exception callback alone nor a successful live
filesystem read is described as a simulated power loss.
