# Durable Rust session protocol

The durable Rust session protocol is the versioned filesystem-message contract
between a synchronous scip-query process and the reusable process that owns
rust-analyzer. Its essential safety property is correlation: a result becomes
usable only after it proves that it belongs to the same logical operation,
mailbox namespace, and absolute processing interval that the caller admitted.

A mailbox-session identity is a SHA-256 value derived from the absolute
durable-session directory and protocol version. The directory is already
separated by canonical project root and helper-binary fingerprint; the
explicit identity makes that separation part of every message rather than an
assumption inherited from its pathname. A response copied from another
project or helper directory therefore cannot satisfy the reader.

An operation identity is the SHA-256 of the answer-affecting Rust request. It
is wider than one client attempt: an exact retry joins the same pending,
inflight, or retained completion. The authoritative deadline is the absolute
deadline on the first admitted copy of that operation. Later duplicate
attempts read that retained deadline instead of substituting a new one, which
keeps the response's time identity stable.

## Current v3 request

Every newly written request contains:

- `mailboxVersion: 1`;
- `protocolVersion: 3`;
- `operationKey` and the derived `id: op-<operationKey>`;
- a non-empty `clientId`;
- finite `enqueuedAtMs` and `deadlineAtMs`, where their difference equals the
  domain request's positive `timeoutMs`;
- `sessionIdentity`; and
- one strictly decoded `semantic` or `import-definitions` request.

The server recomputes the operation key after validating the domain request.
It validates all required definition or import-position fields and every
optional timeout, concurrency, boolean, and worker-environment field before
calling rust-analyzer. Unknown additive object members remain allowed; a
wrong discriminant or wrong field type does not.

The civil timestamps are shared-record facts, not wait-loop clocks. Before
work, the server requires `now <= deadlineAtMs`. After rust-analyzer returns,
it checks the absolute deadline again and publishes an `expired-request`
rejection instead of a success if work crossed it. Process-local waits and
readiness bounds continue to use monotonic time as documented in
[Time Semantics](TIME_SEMANTICS.md).

## Current v3 response

The bounded mailbox supplies `mailboxVersion`, `operationKey`, `clientId`,
`completedAtMs`, `expiresAtMs`, and the authoritative `deadlineAtMs`. The Rust
server adds:

- `protocolVersion: 3`;
- the request `id`;
- the request's `sessionIdentity`;
- either `ok: true`, the session disposition, and the kind-specific response;
  or
- `ok: false`, a typed `errorCode`, and a diagnostic message.

The client accepts a success or rejection only when protocol version, mailbox
version, request ID, operation key, session identity, and authoritative
deadline exactly match its admitted operation. It also requires both the
helper's completion time and the observation time to be no later than that
deadline. A semantic request cannot consume an import-definition response,
and the reverse is also rejected.

Typed rejection codes are:

| Code                   | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `unsupported-protocol` | The outer lifecycle was correlatable, but its domain protocol is newer. |
| `malformed-request`    | Identity, lifecycle, kind, or domain payload validation failed.         |
| `expired-request`      | Work was already expired or crossed its deadline.                       |
| `handler-error`        | A validated request reached the Rust host and the host failed.          |

When malformed bytes do not contain enough trustworthy identity to correlate
a response, the server still retains the rejection and dead-letter evidence,
but a current client will not accept that uncorrelated file as the answer to a
request.

## Compatibility matrix

| Writer or peer                        | Current reader/server behavior                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unversioned v2 `{id, request}` client | Accepted during the bounded overlap window after strict request-kind validation. The server synthesizes lifecycle/session fields and writes an additive response.  |
| Prior v3 client without session field | Accepted as `prior-v3` when every other v3 lifecycle field and the recomputed operation identity are valid. The server supplies and echoes the namespace identity. |
| Current v3 client                     | Fully correlated current path.                                                                                                                                     |
| Future explicitly versioned client    | Never treated as legacy. A safely correlated envelope receives `unsupported-protocol`; an uncorrelatable envelope receives a generic malformed rejection.          |
| Prior v3 server response              | Rejected by the current client as an incompatible uncorrelated response because it lacks session/deadline proof.                                                   |
| Current v3 server to prior v3 client  | Additive: the prior reader's established root fields remain in place, and it ignores the new correlation/error metadata.                                           |
| Future server response                | Rejected before response data is exposed.                                                                                                                          |

The server executable's content fingerprint is part of the mailbox directory,
so normal upgrades select a new namespace rather than pairing a current client
with a prior helper. The explicit compatibility behavior still matters for
retained files, rollback, test fixtures, and manual recovery.

## Replay, retry, and recovery

An exact retry keeps its operation key and request ID. The mailbox returns the
deadline of the authoritative pending, inflight, or completed record, so the
retry validates the original response rather than relabeling it with the new
attempt's deadline. A retained completion observed after that deadline is
rejected even if the retention window has not yet collected its bytes.

A response with the right request ID but a different operation key is a
different operation. A response with both identities but a different
mailbox-session identity is a cross-session replay. A response whose echoed
deadline differs is a different lifecycle. All three fail before payload
decoding.

If the current client reports an incompatible prior-server response, remove
only the specific durable session directory after confirming no current
scip-query process owns it, then retry so the content-addressed current helper
creates a fresh namespace. Do not delete a broad cache root.

Executable coverage lives in:

- `tests/semantic/rust/durable-session-protocol.test.ts`;
- `tests/semantic/rust/rust-durable-session.test.ts`; and
- `tests/storage/bounded-mailbox.test.ts`.

The shared pending/inflight/completion state machine remains documented in
[Filesystem mailbox lifecycle](MAILBOX_LIFECYCLE.md).
