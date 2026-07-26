# Operational Telemetry Retention

Operational telemetry is observational history produced while scip-query
works. Its concrete referents here are `reindex-activity.jsonl`, which records
refresh frequency and estimated logical output, and `affected-shadow.jsonl`,
which records compact affected-set calibration outcomes. It differs from an
authoritative record because no index generation, policy decision, ownership
claim, or completed user operation is reconstructed from it.

## Retained segment set

Each history has two ordered segments:

1. `<history>.previous` is the older retained segment.
2. `<history>` is the current append segment.

The reindex-activity limit is 1 MiB per segment. The affected-shadow limit is
8 MiB per segment. A single JSON record larger than its configured limit
expands that segment's effective limit to the complete record size; a
successful append is never made immediately ineligible by its own size.
Rotation removes the former previous segment, renames the complete current
segment to previous, and then creates the new current segment. Readers scan
previous before current.

Retention deliberately permits deletion of records older than those two
segments. That bounded-history deletion is different from concurrency loss:
which segment is pruned is decided while the append/rotation lock excludes
other writers.

The retained-set reader also has a 256 MiB byte budget across the files it
opens. It validates each segment as the same regular file before and after the
read. Exceeding that operational budget is an explicit read failure; it does
not silently return a prefix and present it as complete telemetry.

## Serialization and crash recovery

The rotation lock is `<history>.rotation.lock`. It is a process-instance lock:
its record contains a PID, an operating-system process-start identity when
available, and a random token, and only that owner can release it. Lock
acquisition, incomplete-tail repair, retention pruning, rename, append, and
the default retained-set read all occur beneath that lock. Waits use a
process-local monotonic two-second budget.

Every append is one newline-terminated JSON value. If a process stops during
the append, the current segment can end in one incomplete tail. The next
writer truncates only the bytes after the last newline before it rotates or
appends. Readers ignore and count incomplete tail bytes. A stop after current
is renamed but before the new append leaves the old complete segment at
`.previous`; a later writer creates a new current segment.

These files are process-visible but not crash-durable. They are not fsynced,
so a kernel or power failure may lose the newest observation even after the
write call returned. That is acceptable only because the histories are
operational evidence. Authoritative index, lock, suppression, configuration,
mailbox-response, and release records use their own durable protocols.

## Failure contract

Lock timeout and ownership-changed release are typed failures at the shared
helper boundary. The reindex-activity and affected-shadow production writers
remain best effort: they catch telemetry failure so an observation cannot
change the authoritative reindex result. Callers that invoke the shared helper
directly can distinguish lock timeout, count repaired tail bytes, and count
partial bytes ignored during reads.

The regression suite forces:

- a competing writer at tail repair, prior-segment pruning, current rotation,
  and append;
- a stop after rotation and a partial append tail;
- bounded retention across three rotations;
- deterministic previous-then-current reads;
- partial legacy tails; and
- bounded live-owner contention.

The implementation is `src/reindex/rotating-jsonl.ts`; its direct contract
tests are `tests/reindex/rotating-jsonl.test.ts`.
