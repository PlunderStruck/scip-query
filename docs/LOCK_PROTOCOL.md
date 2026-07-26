# Process Lock Ownership and Recovery

scip-query uses one process-lock protocol for watch ownership, reindex
publication, repository-cache garbage collection, shared-generation builds,
verified-binary fetches, and the durable Rust semantic server.

A **process lock** is a filesystem ownership record created exclusively at one
resource path. Exclusive creation makes competing processes observe one
winner; the recorded random token and operating-system process-start identity
distinguish that winner from later processes and later lock records that reuse
the same PID or pathname.

A **process instance** is one execution occupying an operating-system PID
slot. The PID locates the slot, while the process-start identity distinguishes
successive executions that occupy it. A PID by itself is therefore accepted
for conservative legacy inspection but never treated as proof that a live
process is the original owner.

A **reclaim guard** is a second exclusive, token-owned process lock at
`<lock>.reclaim`. It serializes recovery attempts so that only one process may
remove an unchanged abandoned record. The guard does not make an ambiguous
live owner safe to remove.

## Current Record

New writers emit protocol version 1:

```json
{
  "protocol": "scip-query-process-lock",
  "version": 1,
  "kind": "reindex",
  "pid": 41001,
  "token": "random-owner-token",
  "processIdentity": {
    "version": 1,
    "pid": 41001,
    "platform": "linux",
    "startToken": "9147752"
  },
  "startedAt": "2026-07-25T19:00:00.000Z",
  "detail": {
    "projectRoot": "/repo"
  }
}
```

`kind` identifies the resource protocol using the lock. `detail` carries only
that protocol's diagnostic metadata; it is not ownership evidence. Ownership
is the combination of PID, random token, and process identity when the host can
obtain one.

The creator uses exclusive descriptor creation, writes the complete record,
flushes the file, closes it, and flushes the containing directory where the
platform supports directory handles. A failure before the complete record is
written can leave an empty or truncated path; recovery treats that as an
observable state rather than an eternal lock.

## Observation and Recovery

| Observed state | Recovery decision |
| --- | --- |
| Current record; process instance is live and matches | Contended; never remove |
| Current record; PID is dead | Reclaim after guarded unchanged recheck |
| Current record; PID is live but its process-start identity differs | Reclaim the old record without signaling the new PID occupant |
| Current record; PID is live but identity cannot be read | Contended; fail closed |
| Supported legacy record; PID is live | Contended because the process instance cannot be verified |
| Supported legacy record; PID is dead | Reclaim after guarded unchanged recheck |
| Empty, truncated, or malformed record younger than five seconds | Contended during creation grace |
| Empty, truncated, or malformed record at least five seconds old | Reclaim after guarded byte-and-file-identity recheck |
| Record changes before the guarded recheck | Do not remove; report contention |
| Empty or malformed reclaim guard younger than grace | Do not remove |
| Empty or malformed reclaim guard older than grace | Recover the guard conservatively, then retry once |

The unchanged recheck compares the original bytes, device, inode, size, and
modification time. Recovery is limited to one retry: persistent ambiguity
remains contention instead of becoming an unbounded delete loop.

The five-second creation grace protects a creator that has exclusively opened
the path but has not yet completed its durable ownership write. It is a
wall-clock age rule for malformed files, not a lease: valid locks never expire
because of age.

## Release

Release rereads the current record and removes it only when PID and token still
match the owner's retained record. When the owner recorded a process identity,
that identity must match as well. A missing path, malformed record, legacy
record, token mismatch, or successor record makes release a no-op. Successful
removal flushes the containing directory where supported so an acknowledged
release does not resurrect the prior directory entry after a crash.

This protocol does not expire live ownership and therefore does not require a
monotonically increasing fencing token. A **fencing token** is an ordered
ownership value checked by the protected resource before it accepts a write;
it is necessary when an old live owner can outlast a lease and attempt
publication after a newer owner. scip-query instead refuses to steal a
verifiably live lock.

## Legacy Compatibility

Readers retain narrow decoders for the prior formats:

- watch and reindex JSON ownership records;
- generic repository-cache and shared-build `{ "pid": ... }` records;
- the durable Rust semantic server's numeric PID record.

New writers always emit the current common format. A live legacy owner remains
contended because its process instance cannot be proven. A dead legacy owner
can be reclaimed. Unsupported or malformed JSON is never guessed into a
legacy owner.

## Diagnostics and Manual Recovery

Successful reindex recovery reports that it recovered an abandoned or
incomplete lock. A manual refresh that encounters an already-stale
watcher-owned reindex record retains the existing “preempting watcher refresh”
diagnostic while stating that the prior owner was already stale.

For other lock users, normal recovery is silent and contention reports the
resource-specific lock path. If a lock remains contended:

1. inspect the JSON without editing it;
2. verify whether its PID and process-start identity name the current process;
3. wait at least the creation-grace interval for a malformed record;
4. retry the operation so the guarded recovery path can run.

Do not manually delete a valid lock whose process instance is live. If host
permissions prevent process-identity verification, stop the owning process or
move the record aside only after establishing ownership outside scip-query.
