# Filesystem mailbox lifecycle

scip-query uses three local filesystem mailboxes to carry work between a
synchronous CLI process and a reusable service process:

- TypeScript semantic queries sent to the watch service;
- TypeScript document-emission requests sent to the watch service; and
- Rust semantic queries sent to the durable rust-analyzer helper.

A filesystem mailbox is a process-coordination queue whose units are complete
files and whose essential safety property is that each accepted logical
operation has one durable identity and one inspectable lifecycle across
process failure. It differs from an arbitrary request directory because
admission, ownership transfer, completion, expiry, and retention are explicit
states rather than consequences of whichever process happens to delete a
file.

A logical operation is a requested computation identified by the SHA-256 of
its answer-affecting protocol payload. That stable content identity is what
makes two independently attempted requests units of the same operation:
retries converge on one pending request, one inflight claim, or one retained
completion instead of executing under unrelated random IDs. `clientId`
identifies the attempt that first published the operation; it does not change
the operation's meaning.

## Layout and states

Each mailbox root has this layout:

```text
<mailbox>/
  pending/
  inflight/<encoded-owner>/
    .owner.json             # process-instance evidence for claim recovery
  responses/
  dead-letter/
  requests/                 # legacy v2 overlap reads only
  .admission.lock           # complete, exclusively published quota coordinator
```

| State     | Real file state                                                                  | Authority and transition                                                                     |
| --------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Pending   | `pending/<operation-id>.json`                                                    | The immutable request was admitted but no service owns it.                                   |
| Inflight  | `inflight/<owner>/<request>.<claim-expiry>.claim` plus `.owner.json`             | Atomic rename transferred this request to one recorded process instance for a bounded lease. |
| Completed | `responses/<operation-id>.json`                                                  | A response was durably and exclusively published before claim release.                       |
| Rejected  | Error response, with a bounded record under `dead-letter/` when capacity permits | The service explicitly refused malformed, expired, oversized, mismatched, or failed work.    |
| Expired   | Deadline has passed; the next bounded service batch rejects and collects it      | Expiry prevents abandoned requests from authorizing expensive work indefinitely.             |

The `requests/` directory is not a second current queue. It exists so a new
service can drain flat requests left by protocol v2. Current writers publish
only to `pending/`; no migration renames or deletes legacy data pre-emptively.

## Identity and protocol fields

Every current request contains:

- `mailboxVersion`, which versions the shared lifecycle fields;
- the domain protocol version;
- `operationKey`, the full SHA-256 logical-operation identity;
- `id`, deterministically derived as `op-<operationKey>`;
- `clientId`, the publishing attempt identity;
- `enqueuedAtMs` and `deadlineAtMs`; and
- the domain request plus its generation/session identity.

The TypeScript semantic and TypeScript index protocols are version 3. The Rust
durable-session protocol is also version 3. Current readers recompute the
operation key, require the ID derived from it, and retain the existing
generation/base-generation response checks. TypeScript services accept the
supported flat version-2 request shape during the overlap window. The Rust
service accepts its former unversioned `{id, request}` shape and the
immediately prior v3 envelope without a mailbox-session identity; an
explicitly versioned unknown Rust envelope is not treated as legacy.

Responses repeat the domain protocol, request ID, operation key, completion
time, authoritative request deadline, and retention expiry. The first
response published for an operation is authoritative. An old owner that
finishes after its lease was reclaimed cannot replace a newer response.
Duplicate admission returns the deadline from that authoritative pending,
inflight, or completed record, so a retry cannot relabel retained work with a
new time identity. Rust responses additionally echo the mailbox-session
identity and are accepted only when protocol, request, operation, session, and
deadline all match. See
[Durable Rust session protocol](RUST_DURABLE_SESSION_PROTOCOL.md).

## Admission and bounds

Admission is the act of adding one immutable operation after proving the
mailbox remains within its retained-resource budget. A short-lived,
token-checked admission file serializes the count-and-publish decision, which
prevents two processes from both observing the last free slot and
oversubscribing it. Its complete owner record is flushed under a private name
and hard-linked exclusively into the public name; an ownerless or malformed
public record fails closed and is never deleted from civil-clock age alone.

Default bounds are:

| Bound                              |                                                     Default |
| ---------------------------------- | ----------------------------------------------------------: |
| Retained files per mailbox         |                                                       1,024 |
| Retained bytes per mailbox         |                                                     512 MiB |
| One request or response            |                                                      64 MiB |
| Work claimed per service-loop pass |                                                          16 |
| Claim lease                        | 5 minutes, extended through request deadline plus 5 seconds |
| Response/idempotency retention     |                                                  10 minutes |
| Dead-letter retention              |                                                    24 hours |
| Orphan temporary-file retention    |                                                    1 minute |
| Maintenance actions per pass       |                                                          64 |

`MailboxBackpressureError` is the typed overload result. Its code distinguishes
`item-too-large`, `item-capacity`, `byte-capacity`, and `admission-busy`, and
its status reports the observed retained state and configured limits. A
duplicate logical operation is checked before capacity rejection, so a retry
can join work that already owns the last slot.

TypeScript semantic callers retain their established correctness fallback:
service failure or backpressure selects the in-process provider. Index and
Rust requester errors propagate to their existing higher-level fallback
boundaries.

## Ownership, crash recovery, and replay

A claim is a time-bounded service ownership record made real by renaming one
pending file into an owner-specific inflight directory. Rename is the
ownership compare-and-set: only the process whose rename succeeds owns that
file. The directory's owner record binds the random owner ID to a PID and,
when the operating system exposes it, a process-start identity. A process-start
identity is the operating-system fact that distinguishes successive
executions occupying the same numeric PID slot.

The recovery rules are:

| Failure point                                         | Surviving evidence                               | Recovery                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Client exits after admission                          | Pending file                                     | A later service batch claims it or explicitly expires it. The client does not delete shared work in `finally`.         |
| Service exits before claim                            | Pending file                                     | Another owner can claim immediately.                                                                                   |
| Service exits after claim, before response            | Inflight file, expiry, and dead process identity | After lease expiry and proof that the recorded process instance is gone, maintenance atomically returns it to pending. |
| Service publishes response, then exits before release | Response plus inflight file                      | Maintenance treats the response as completion and removes the stale claim without re-execution.                        |
| Old owner finishes after reclamation                  | Competing exclusive response publication         | The first response remains authoritative; the late owner cannot replace it.                                            |
| Same logical request is retried                       | Same deterministic operation ID                  | The caller joins pending/inflight/completed state.                                                                     |
| Malformed, expired, or oversized file                 | Claimed input                                    | The service emits an explicit error response and a bounded rejection record.                                           |

These are crash-recoverable claim semantics with first-completion
idempotency. Civil-clock lease expiry is only a durable recovery hint: it does
not authorize reclamation while the recorded process instance is live or
unverifiable. Work can be retried after both lease expiry and owner death. The
answer-affecting operations are read-only or rebuildable, the response
identity is stable, and exclusive completion remains a final defense against
two observable answers.

## Fairness and maintenance

Pending work is ordered by `enqueuedAtMs`, then stable request identity.
Legacy and malformed files fall back to filesystem modification time. Random
UUID filename order no longer determines service priority.

Each process call claims at most 16 files, and each maintenance call performs
at most 64 removals or reclaims. Those caps are what let the watch and Rust
server loops regain control to update heartbeats, observe stop signals, and
run unrelated maintenance even when a mailbox was flooded.

Maintenance:

- reclaims expired inflight ownership only after the recorded process instance
  is dead or its PID has been reused by a different process instance;
- removes a claim whose response proves it already completed;
- removes expired responses and dead-letter records;
- removes abandoned atomic-write staging files after their retention window;
- preserves non-expired pending and inflight work; and
- never depends on a client being alive to finish cleanup.

## Telemetry and diagnosis

TypeScript watch state exposes a `mailbox` snapshot under both
`typescriptSemantic` and `typescriptIndex`. Rust helper state exposes the same
snapshot. It contains:

- `pending`, `inflight`, `responses`, and `deadLetters`;
- `invalid`;
- `totalItems` and `totalBytes`; and
- `oldestPendingAt` when pending work exists.

This snapshot identifies current retained pressure; it is not a cumulative
success counter. A rising pending count with a live heartbeat indicates
service throughput pressure. Inflight work older than its valid lease is
reclaimed on the next loop only when the owner record proves the process
instance is gone. Responses are expected during the ten-minute idempotency
window. Clock-domain rules for these records are documented in
[Time Semantics](TIME_SEMANTICS.md).

Focused contract coverage lives in:

- `tests/storage/bounded-mailbox.test.ts`;
- `tests/semantic/typescript/typescript-session-mailbox.test.ts`;
- `tests/reindex/typescript-index-mailbox.test.ts`;
- `tests/semantic/rust/durable-session-protocol.test.ts`;
- `tests/semantic/rust/rust-durable-session.test.ts`; and
- `tests/platform/watch-service-state.test.ts`.
