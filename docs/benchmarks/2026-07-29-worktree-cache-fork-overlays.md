# Worktree cache fork validation

Date: 2026-07-29
Host: macOS / APFS development machine
Package version under test: `scip-query@0.20.0`

## Question

Can a Git or Conductor-style sibling worktree that is edited before its first
scip-query refresh reuse the immutable cache for its committed `HEAD`, rebuild
only the affected parts, and keep both shared and sibling state isolated?

## Fixture

`tests/reindex/shared-worktree-cache.integration.test.ts` creates a temporary
repository with TypeScript and Python source, builds and publishes the primary
checkout's clean generation, creates a detached linked worktree at the same
commit, edits only the linked TypeScript file before any linked cache exists,
and runs the linked reindex.

The fixture records behavior rather than assuming clone support:

- the linked cache does not exist before reindex;
- status must report `Forked shared baseline`;
- the Python shard must be reused;
- the TypeScript shard must be rebuilt;
- the shared SQLite SHA-256 must remain unchanged;
- primary and linked indexes must both be fresh;
- the linked lease must report the shared generation as `base`, no shared
  `active` generation, the `overlay` action, and one protected generation.

## Result

```text
Test Files  1 passed (1)
Tests       1 passed | 4 skipped (5)
Test body   2.05s
Vitest      2.67s
Wall clock  2.95s
```

Command:

```bash
/usr/bin/time -p npm test -- \
  tests/reindex/shared-worktree-cache.integration.test.ts \
  -t "forks the committed baseline"
```

The acceptance probe passed. The linked reindex reused the unchanged Python
SCIP shard, rebuilt the changed TypeScript shard, left the shared database hash
unchanged, and published a fresh private overlay. A separate integration case
proved that a usable pre-existing local generation takes precedence and is not
replaced by the shared baseline.

The complete repository suite also passed:

```text
Test Files  272 passed (272)
Tests       2189 passed | 2 skipped (2191)
Duration    38.17s
```

## Disk interpretation

Every manifest artifact is logically cloned into a private staging namespace
and validated before publication. Logical bytes are therefore the sum of
manifest artifact sizes, not a claim that the same number of new physical bytes
was written. On this host the durable clone path requests the filesystem's
copy-on-write clone behavior; APFS may share unchanged blocks and allocate new
blocks only after either copy is modified. Per-file `stat` and `du` account
logical ownership and cannot reliably identify how many APFS blocks remain
physically shared, so this run does not publish a misleading physical-byte
number.

If the filesystem cannot clone, the implementation intentionally falls back to
a normal private copy. Correctness and isolation are identical, but disk I/O is
not. The existing reindex activity telemetry remains the appropriate place to
observe reflinked versus byte-copied staging work where the operation reports
that distinction.

## Verdict

Ship the disk-backed cache fork. It removes the avoidable all-language cold
start for edited newborn worktrees while preserving one complete local
generation per reader, immutable shared baselines, private watcher state, and
existing fallback behavior. Redis is not needed for this result: adding it
would introduce another availability, eviction, and consistency protocol
without improving the correctness of cache lineage.
