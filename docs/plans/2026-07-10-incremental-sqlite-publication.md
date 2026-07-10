# Incremental SQLite Publication Plan

Date: 2026-07-10
Status: In progress; Phases 5.1–5.2 complete, Phase 5.3 operational compatibility next
Parent: [`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md)

## Outcome

Publish Phase 4's exact affected TypeScript documents without converting the
complete SCIP graph into a new SQLite database. Copy the last accepted
database to a private candidate, convert only the affected documents, replace
their owned rows in one transaction, validate the complete candidate, retain
the preceding database as a bounded recovery generation, and atomically make
the candidate the query database.

A **database generation** is one complete SQLite file whose documents,
chunks, definitions, mentions, and global-symbol rows were validated together;
its defining trait is that every reader bound to that file sees one internally
consistent graph. A **generation handoff** is the atomic filesystem rename
that changes which complete SQLite inode the stable database path names. An
already-open reader remains bound to the preceding inode while a later reader
opens the new one. A **document replacement transaction** is the database
operation that removes every row owned by the affected documents, reconciles
their shared symbols, inserts the new rows, and either commits all of those
changes or none of them.

These concepts refer to the actual `scip expt-convert` schema in this project:

- `documents` owns `chunks` and `defn_enclosing_ranges`;
- `chunks` owns `mentions`;
- `global_symbols` is shared by definitions and mentions across documents;
- the six current supporting indexes accelerate document/range/symbol reads.

## Measured Boundary

Phase 4 made local TypeScript document production 16.748ms median / 22.193ms
p95, yet complete watch publication remained 2,603ms and 2,546ms. The same
producer passed OpenCode at 2,324.730ms / 2,802.661ms versus a 48.24s clean
indexer oracle. The remaining local floor is complete SCIP merge plus
`scip expt-convert`, not compiler work.

The converter schema has five tables and no triggers. This permits an exact
patch without reimplementing protobuf-to-row conversion: construct a mini SCIP
index containing only affected documents, let the official `scip` binary
convert it, then attach that mini database to a copy of the accepted complete
database and merge by symbol/path inside one transaction.

## Architecture Decision

Use copy-on-write whole database files as generations rather than adding a
generation column to every query table. This preserves every existing query
and downgrade reader. The stable `index.db` path is the current-generation
pointer: replacing that one path is atomic, and SQLite readers already retain
their opened inode. Before replacement, retain the preceding complete DB under
`generations/<generation-id>/index.db` (hard link when available, copy
fallback). Bounded retention removes it only after the new generation and its
metadata are complete.

The combined `.scip` and `meta.json` files are rebuildable companions. Their
replacement remains ordered around the database handoff, but query consistency
depends only on the atomic DB rename. A crash after the DB flip leaves both the
new complete DB at the stable path and the preceding complete DB in recovery
storage. Freshness detects companion drift and the full rebuild remains the
repair oracle.

## Row-Replacement Contract

1. Incremental publication is eligible only when Phase 4 produced a complete,
   exact affected fragment set and every other language shard was reused.
2. Validate the prior and mini schemas against the exact expected table/index
   contract. Any drift selects full conversion.
3. Record symbols defined by affected old documents before deletion. If one
   such symbol is also defined by an unaffected document, fall back; ambiguous
   shared definition ownership is not patched.
4. Delete affected mentions, chunks, definition ranges, and documents in
   foreign-key order inside one transaction.
5. Clear metadata for old affected-owned symbols. Insert reference-only mini
   symbols without overwriting richer unaffected metadata. Replace metadata
   exactly for symbols defined by a new affected document, including deliberate
   documentation/relationship removal.
6. Insert documents/chunks/ranges with fresh IDs and map mentions to stable
   `global_symbols` IDs by the unique symbol string.
7. Delete only symbols that are now unreferenced and undefined. Never infer
   ownership from display names or occurrence order.
8. Run `foreign_key_check`, `integrity_check`, affected path/count checks,
   duplicate-symbol/path checks, and normalized document-fact comparison
   before handoff.
9. A missing row, schema mismatch, converter failure, lock, corrupt candidate,
   unsupported external symbol, or validation difference discards the
   candidate and runs the existing full conversion.

## Executable Steps

### 5.1 — Mini-index converter and transactional patcher

- Add affected-only SCIP serialization beside the full candidate shard.
- Convert the mini index with the same resolved `scip` binary and environment.
- Add a standalone patcher over injected/copy paths with exact schema
  validation and the row-replacement contract above.
- Compare a patched fixture DB to a clean full converted DB using the existing
  document-fact digests and direct table projections.
- Prove schema drift, shared-definition ownership, omitted document, corrupt
  mini DB, and injected mid-transaction failure all reject without changing
  the prior DB.

Commit boundary: patcher, focused tests, and machine evidence.

Result: complete. `assembleAffectedTypeScriptIndex` now emits an exact
affected-only SCIP index, the official `scip expt-convert` binary converts it,
and `patchIncrementalSqliteGeneration` copies and patches a private complete
database. The transaction validates the five core tables, six indexes, unique
path/symbol constraints, foreign keys, integrity, exact affected paths, row
counts, symbol ownership, and normalized affected facts. A real two-document
TypeScript fixture produced the same complete document/global fact digests as
a clean full conversion. Injected deletion-stage failure rolled back and
removed the candidate; schema drift, corrupt input, omitted documents, and a
symbol defined by affected and unaffected documents all rejected without
changing the accepted database.

### 5.2 — Generation handoff and publication fallback

- Thread Phase 4's affected mini index through `FreshIndexRun` to publication.
- Copy the accepted DB, patch the private candidate, then run existing
  post-index augmentation and shadow validation.
- Retain the preceding DB generation before the atomic stable-path rename.
- Add failpoints before/inside/after patch, before DB handoff, after DB handoff,
  and before companion metadata completion. At every point, one complete
  current DB and the preceding recovery DB must be readable.
- Fall back to complete conversion in the same run on any pre-handoff patch
  rejection; never fall back after the atomic DB handoff.

Commit boundary: publication authority, failpoints, recovery metadata, and
fallback tests.

Result: complete. Normal refresh now converts the affected-only SCIP index,
patches a copy of the accepted database, reruns augmentation, publishes the
new complete database by atomic rename, and retains the preceding complete
database under `.scipquery-generations/<identity>/index.db`. The route is
selected only when TypeScript is incremental, every other language shard is
reused, and no language is skipped; every rejection falls back to complete
conversion before handoff. Four handoff failpoints leave the stable database
or its retained predecessor readable, and the standalone patch transaction
still rolls back at each internal failure stage.

The local implementation also removed three full-file costs exposed by the
first 2.617s trial: previous fragment generations are validated rather than
reseeded, complete and affected SCIP outputs share one base parse, and merge
plus sanitization serialize once. Portable SCIP protobuf assembly is
byte-identical to the scip-typescript runtime while avoiding a roughly 150ms
compiler-runtime load in every reindex subprocess. The final post-fix local
distribution was 1,380 / 1,383 / 1,390 / 1,358 / 1,413ms (1,383ms median,
1,413ms p95), versus the 2,000ms gate. The warm service itself took 7–20ms.
The final candidate matched the official full-conversion oracle across all
321 normalized fact units. A pre-acceptance orphan `global_symbols` mismatch
was rejected and fixed by restoring the converter invariant that every
retained global symbol is mentioned or defined.

### 5.3 — Reader, retention, upgrade, and repair proof

- Hold an old SQLite reader open across handoff while new readers open the new
  DB; assert zero mixed facts and both exact generations.
- Retain current plus one preceding successful generation; prune abandoned
  temp/fragment generations only after complete publication.
- Test legacy DBs without recovery metadata, current package reinstall,
  previous-package read/downgrade, and schema mismatch fallback.
- Surface publication mode, generation IDs, affected counts, patch/converter
  duration, fallback reason, recovery path, and validation result in status.

Commit boundary: lifecycle/compatibility proof and operational status.

Progress: old/new reader isolation, bounded current-plus-previous retention,
all four handoff failpoints, and a legacy database without generation metadata
pass. Remaining work is package reinstall/previous-package compatibility,
schema-drift repair proof through the integrated route, and surfacing the
generation/publication record in `status`.

### 5.4 — Corpus calibration and Phase 5 closure

- Alternate five full controls with five incremental leaf edits on scip-query
  and OpenCode under the established heap/corpus identities.
- Require exact full SCIP shard and normalized SQLite/document-fact parity.
- Require complete edit-to-fresh p95 at most 2s locally and 5s on OpenCode,
  no-op regression at most 10%, and no unexplained fallback.
- Run full tests, typecheck, lint, build, package dry-run and packed-install
  smoke, reindex, diff-gate, crash/concurrency controls, and a clean worktree.

Commit boundary: accepted measurements, roadmap/ledger closure, and exact next
Phase 6 action.

## Verification Matrix

| Risk | Failure probe | Required result |
| --- | --- | --- |
| Partial row replacement | Throw after each delete/insert stage | Candidate transaction rolls back; published DB byte/fact digest unchanged |
| Shared symbol corruption | Same symbol defined in affected and unaffected docs | Incremental route rejects and full conversion runs |
| Reference-only metadata loss | Affected doc references an unaffected definition | Existing rich symbol metadata remains exact |
| Removed definition residue | Delete a definition while an unaffected ref remains | Symbol stays for the ref but stale definition metadata/range is gone |
| Reader mixing | Hold old reader while atomic rename completes | Old reader has old facts; new reader has new facts; neither mixes |
| Crash near handoff | Kill at every named failpoint | Stable or recovery path opens a complete preceding DB |
| Schema/package drift | Change expected schema/version | Full conversion; no incremental write |
| Companion drift | Crash after DB rename before metadata | New DB and recovery DB open; freshness requests repair/full oracle |

## Exact Next Action

```sh
SCIP_QUERY_SKIP_WATCH_SERVICE=1 node dist/cli.js plan-context \
  src/reindex/sqlite-generation-store.ts --json
```
