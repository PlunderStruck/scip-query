# Configuration and setup write safety

scip-query updates files that people and other agents may edit at the same
time: `.scipquery.json`, provider hook JSON, `.git/info/exclude`,
`AGENTS.md`, `CLAUDE.md`, structured suppression records, and an owned
pre-commit hook. A conflict-aware writer is a file updater that transforms one
identified revision and refuses to claim success if an independent revision
wins before commit. Its defining behavior is preservation: it either applies
its narrow change to the newest valid input or leaves the newest input
untouched and reports why.

## Revision and commit protocol

Every participating writer:

1. acquires a short, token-owned process lock beside the target;
2. reads a stable snapshot and records its SHA-256 hash plus file identity;
3. computes only the domain change it owns;
4. rereads the target immediately before commit;
5. retries the merge when the revision changed and retry is safe, or reports a
   conflict when it is not;
6. stages and flushes complete bytes, atomically publishes them, and flushes
   the parent directory where the platform exposes that operation.

The lock serializes scip-query processes. Editors do not need to participate:
their byte or identity change is detected by the optimistic revision check.
The lock record is token-owned and carries process identity, so a live owner
cannot be displaced and a dead owner can be reclaimed by the shared process
lock protocol.

First creation uses a flushed staging inode plus an exclusive public hard
link. This is stronger than `exists` followed by replacement: only one creator
can publish, and a reader sees no public file until every byte is present.

## JSON merge rules

Project setup rereads the latest valid object and changes only the requested
field. Unknown current and future fields survive. A three-way check compares
the caller's observed value, the latest value, and the requested value:

- an unrelated latest edit is preserved and the owned field is updated;
- the requested value already present is idempotent;
- a different latest value for the same field is an explicit stale-field
  conflict.

Hook setup rereads the latest valid provider object on every bounded retry,
removes only scip-query-owned hook entries, and merges the current owned hook
groups. Unknown top-level fields and non-scip hook entries survive installation
and removal.

Malformed latest JSON is never repaired by replacement because doing so could
erase information the writer cannot classify. The command reports the parse
failure and leaves the exact bytes in place.

## Suppression policy rules

A suppression identity is the stable finding ID, or the deterministic hash of
a check-and-file target when no finding ID exists. It is a policy conflict
domain: decisions for different identities occupy different files, while two
decisions for the same identity must be reconciled.

The first decision uses exclusive durable creation. An identical replay
returns the existing revision without rewriting metadata. A different reason,
expiry, check, or file requires `--replace <revision>`, where the revision is
the full SHA-256 hash reported when the existing decision was rejected or
created. Replacement succeeds only if those exact reviewed bytes still occupy
the path. A stale token, a malformed record, an unsupported future schema, or
an edit at the commit boundary leaves the latest bytes untouched.

New records use suppression schema version 1 and include their stable identity
plus the `scip-query` writer version. Unversioned legacy records remain
readable. They remain byte-for-byte unchanged on an idempotent replay and are
upgraded only by an explicit compare-and-replace policy change.

## Managed text rules

Agent guidance changes only the text between the exact
`scip-query:agent-setup` markers. Text before and after the block is preserved.
Missing markers permit first installation, but incomplete, duplicated, or
reordered markers are a conflict because the intended ownership boundary is
ambiguous.

Managed Markdown and owned pre-commit operations use a strict final revision
check rather than silently recomputing across an intervening edit. The command
reports the expected and latest revision hashes and does not write.
`.git/info/exclude` can safely retry because its exact owned marker block is
recomputed from the newest text.

## Recovery

When a command reports a conflict:

1. open the named file and preserve the latest independent edit;
2. repair malformed JSON or marker structure deliberately, if reported;
3. for a suppression policy change, review the latest decision and rerun
   `suppress` with the reported `--replace <revision>`;
4. for setup/configuration, rerun the command so it reads the new revision.

Do not delete a live `.scip-query-write.lock`. If its owner crashed, the next
writer reclaims it only after the shared lock protocol proves the recorded
process identity is no longer live. A crash before publication leaves the
previous target intact; a failed first publication leaves no partial public
file.
