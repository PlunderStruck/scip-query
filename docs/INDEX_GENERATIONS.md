# Local Index Generations

`scip-query` treats `index.db`, `index.scip`, and `meta.json` as one local
index generation. A local index generation is an accepted set of compiler
artifacts whose database rows, SCIP occurrences, and metadata describe the
same indexing result. Keeping those files associated is what lets a query
attach one truthful identity to every row and downstream semantic request.

A generation handle is the storage-owned reference retained by one
`ScipDatabase`. It differs from a group of cache paths by resolving the
published pointer once, opening the database beneath that immutable
generation directory, and retaining the corresponding metadata bytes and SCIP
path for the connection's entire lifetime.

## Layout

The worktree cache keeps this internal layout:

```text
<cache>/
  index.db                         compatibility mirror
  index.scip                       compatibility mirror
  meta.json                        compatibility mirror
  .scipquery-generations/
    state.json                     atomic current-generation pointer
    gc.json                        last bounded-collection observation
    gc.lock                        collection/reader-admission coordinator
    readers/
      <pid>-<token>.json           live process-generation leases
    <generation-sha256>/
      manifest.json
      index.db
      index.scip
      meta.json
```

The files inside a named generation directory are immutable. The SHA-256
identity incorporates the database bytes, SCIP bytes when present, and the
generation-bearing metadata fields. `manifest.json` records the exact size and
digest of each stored artifact. `state.json` names the accepted directory and
is the only publication decision read by internal database consumers.

The top-level files remain for the SCIP CLI, indexers, older scip-query
versions, and external inspection. They are derived mirrors, not the internal
read authority. A current scip-query process never combines rows from a
generation directory with metadata or SCIP bytes freshly reread through those
replaceable paths.

## Publication and crash behavior

Publication proceeds in this order:

1. Retain the previously published stable artifacts as an immutable
   generation when upgrading a legacy cache.
2. Copy-on-write clone or copy every accepted candidate artifact into a
   private staging directory.
3. Flush the artifact files and manifest, rename the complete staging
   directory into its content-derived identity, and flush the generation
   directory entry.
4. Remove known redundant SQLite indexes only when schema inspection proves a
   retained equivalent: the unique symbol index can replace the duplicate
   symbol index, and a wider document-leading chunk index can replace the
   single-column document index. Query-plan tests hold those proofs.
5. Durably replace `state.json` so new internal readers select the complete
   new directory.
6. Replace the three compatibility mirrors and durably record their file
   identities for drift diagnostics.

A crash before step 5 leaves the prior pointer authoritative. A crash after
step 5 leaves the new immutable generation authoritative even if one or more
compatibility mirrors are old. `scip-query status` and freshness inspection
report that mirror drift and a later refresh repairs it; database-backed
queries remain generation-consistent throughout.

Metadata-only refreshes create a new immutable generation and switch the same
pointer. Old database handles retain their old metadata bytes. Result cursors
and TypeScript semantic mailbox requests carry the handle identity, so a
continuation or numeric symbol identifier from an older generation is rejected
when a service has moved to a newer one.

Mailbox protocol version 3 additionally binds that generation identity into a
content-derived logical-operation key. The deterministic request ID lets a
retry join an already pending, inflight, or retained completed operation,
while the service still recomputes the key and rejects a path, payload, or
generation mismatch. See
[`MAILBOX_LIFECYCLE.md`](MAILBOX_LIFECYCLE.md) for ownership, expiry, limits,
and legacy overlap.

## Legacy overlap and retention

A cache without `state.json` remains readable through a bounded legacy
open-and-file-identity recheck. A state record written by the earlier local
generation implementation, which did not name an immutable artifact set, also
uses this compatibility path. New publications upgrade either layout without
deleting the stable files.

Published local generation directories are retained by a bounded,
reader-aware collector. Opening an immutable `ScipDatabase` first acquires the
generation GC lock, resolves the current pointer, and visibility-atomically
publishes a lease containing its random token, generation identity, PID, and
operating-system process-start identity when available. Closing the database
removes that exact lease idempotently.

Publication and collection use the same token-owned process lock. Collection
always protects the current generation, the named recovery generation, and
every live reader generation. It removes only oldest unprotected generations
until both default limits hold: at most eight retained generations and at most
2 GiB of logical artifact bytes. A lease whose recorded process instance is
provably dead is reclaimed. A malformed lease protects every generation and
defers deletion; uncertainty cannot authorize reclamation.

`gc.json` is a visibility-atomic diagnostic containing retained counts, logical
bytes, protected/readers counts, removed counts, limits, state, time, and any
reason. `scip-query status` reports that observation together with the current
retained set and oldest generation age. Collection failure does not invalidate
the accepted index; it remains explicit bounded-storage debt for the operator.

The repository-wide shared generation store is a separate cache layer. It
warms a worktree by copying a complete generation into the worktree's private
cache; the local publisher then creates the local immutable directory and
pointer described here. Later worktree writes cannot mutate either the shared
source or a retained local reader.

## Shared worktree lease invariant

A worktree lease is a repository-cache reachability record whose generation
IDs keep an immutable shared generation from collection while that worktree
uses it. Its essential ownership fields bind the repository, worktree,
project path, and local cache path through a checksum; `lastSeenAt` is only a
liveness observation.

Generation attachment, lease liveness touches, and repository cleanup
serialize through one repository-cache lock. A touch may inspect the local
pointer before waiting only to identify that lock. Once it owns the lock, it
rereads the pointer and lease, validates the ownership checksum, current Git
tree, local metadata fingerprint, generation IDs, and source artifacts, then
merges only a newer `lastSeenAt`. It never writes a lease assembled from the
pre-lock observation.

Consequently, a touch waiting behind a new generation attaches to or rejects
the new lease; it cannot restore the old generation. A deleted lease stays
deleted, a recreated lease with different ownership stays intact, and a touch
whose clock is behind another completed touch cannot move liveness backward.
