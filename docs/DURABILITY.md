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
directory after rename. Those ordered flushes are what make acknowledged file
contents and the name that reaches them recoverable after an operating-system
or machine crash, subject to the host filesystem and device honoring their
flush contract.

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

## APIs

| API | Staging identity | File flush | Rename | Parent-directory flush |
| --- | --- | --- | --- | --- |
| `writeJsonAtomic` / `replaceFileAtomic(..., { durability: "visibility" })` | Exclusive random token | No | Yes | No |
| `writeJsonDurable` / `replaceFileAtomic(..., { durability: "durable" })` | Exclusive random token | Yes | Yes | Yes where supported |

`writeJsonAtomic` retains its original `void` return contract for compatibility.
`writeJsonDurable` and `replaceFileAtomic` return the achieved directory-sync
status. Verified binary installation owns an equivalent platform-local
flush/rename sequence because the enforced architecture forbids dependencies
between the sibling `platform` and `storage` boundaries.

On Windows, Node can reject attempts to open or flush a directory handle.
Known Windows "directory handles unsupported" errors produce
`directorySync: "unsupported"` after the staged file itself has been flushed
and renamed. That result means complete visibility plus flushed file contents,
not the full POSIX directory-entry durability guarantee. Other directory-sync
errors remain failures.

## Failure Outcomes

| Failure point | Target visible after return/throw | Owned staging file |
| --- | --- | --- |
| Exclusive create | Previous target | No owned file was created |
| Write or short/invalid progress | Previous target | Closed and removed |
| File flush | Previous target | Closed and removed |
| Rename | Previous target | Removed by the writer |
| POSIX directory flush | New complete target; durability unconfirmed and the call throws | Already renamed; no staging path |
| Unsupported Windows directory flush | New complete target; result reports the limitation | Already renamed; no staging path |

The post-rename failure row is deliberately explicit. Once rename succeeds,
rolling back would be another publication with its own crash window. The
writer therefore leaves the verified new value visible and reports that it
could not confirm the stronger durability guarantee.

## Call-Site Classification

| Record | Contract | Reason |
| --- | --- | --- |
| Reindex `meta.json` | Durable | Names the accepted index status, fingerprint, and generation metadata |
| SQLite generation `state.json` | Durable | Selects current and recovery generations |
| Shared-generation manifest | Durable file within staging | Authenticates immutable artifacts; the later generation-directory publication remains a separate generation-store operation |
| Worktree lease and local cache pointer | Durable | Protect generations from collection and bind a worktree to repository cache identity |
| Watch service state | Durable | Publishes the process instance and index generation accepted as current |
| Rust semantic session `server.json` | Durable | Publishes the live server process and mailbox identity |
| Project `.scipquery.json` | Durable | Controls indexing, watch, architecture, and detector policy |
| Codex/Claude hook JSON | Durable | Controls whether and when agent hooks execute |
| Structured suppression file | Durable | Records an accepted finding and its reason |
| Health baseline | Durable | Acts as a committed regression policy |
| Verified binary cache promotion | Durable | Makes checksum-accepted executable or tool bytes current |
| TypeScript/Rust request and response mailboxes | Visibility-atomic | A timeout or retry reconstructs the ephemeral message |
| Watch activity/refresh activity | Visibility-atomic pending Slice 11 | Operational activity is rebuildable; refresh intent will move to immutable request records |
| TypeScript fragment/overlay manifests | Visibility-atomic | Content-addressed cache artifacts are validated and rebuildable |
| Repository GC state | Visibility-atomic | Sweep history can be reconstructed conservatively |
| Affected-set shadow latest record | Visibility-atomic | Calibration telemetry does not control publication |

Process locks use exclusive descriptor creation rather than replacement. Their
durable token ownership, malformed-creation grace, guarded recovery, and
legacy compatibility are defined in
[Process Lock Ownership and Recovery](LOCK_PROTOCOL.md). Generation directories
and stable compatibility files have a wider multi-file publication contract;
Slice 10 defines their generation handle and pointer handoff.
