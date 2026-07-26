# Evidence Cache Invalidation

An evidence product is a stored analysis result for source code, index rows,
configuration, tool behavior, or git history; it is correct only while the
identity fields listed for that product still name the facts that produced it.

Invalidation is the miss rule for those stored results: when any identity field
changes, the old row must stop satisfying reads and the product must be rebuilt
from current evidence.

## Product Matrix

| Product                                  | Referent                                                                                                                                                                                                                                                                                                                                                                                                                                             | Table              | Payload Owner                                          | Key Parts                                                                                    | Invalidation Trigger                                                                                                                                         | Staleness Test                                                               | Branch / Worktree / Clone / Workspace / Multi-Language                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file:source-facts`                      | Parsed callable, call-site, identifier, and container facts for one source file.                                                                                                                                                                                                                                                                                                                                                                     | `file_evidence`    | `src/source/facts/source-facts.ts`                     | kind, relative path, content hash, payload version                                           | Source bytes or source-fact payload version change.                                                                                                          | `tests/storage/evidence-cache.test.ts`                                       | Safe when content hash changes; workspace and language changes matter only through the source bytes and parser behavior.                                                      |
| `file:file-definitions`                  | Definitions derived for one file and interpreted against the current project index, including line ranges and SCIP column spans when the index provides them. `getDefinitionsForFile(db, file, { includeClassMemberFallbacks: true })` (docs/plans/2026-07-02-catalog-class-members.md) bypasses this product entirely — neither reads nor writes it — so the opt-in path is always recomputed and never subject to (or a source of) staleness here. | `file_evidence`    | `src/symbols/definition-catalog.ts`                    | kind, relative path, content hash, project fingerprint, payload version                      | Source bytes, project fingerprint, indexed languages, or payload version change.                                                                             | `tests/storage/evidence-cache.test.ts`                                       | Safe across branch/worktree/clone when project fingerprint and content hash match; workspace and language-set changes are covered by project fingerprint.                     |
| `file:definition-exclusions`             | Framework and test-pattern exclusions for one source file.                                                                                                                                                                                                                                                                                                                                                                                           | `file_evidence`    | `src/analysis/framework-patterns.ts`                   | kind, relative path, content hash, payload version                                           | Source bytes or exclusion parser version change.                                                                                                             | `tests/storage/evidence-cache.test.ts`                                       | Safe when content hash matches; branch and workspace identity do not add facts beyond source bytes.                                                                           |
| `file:doc-path-tokens`                   | Test-only typed file product used to verify product wrapper behavior.                                                                                                                                                                                                                                                                                                                                                                                | `file_evidence`    | `tests/storage/evidence-cache.test.ts`                 | kind, relative path, content hash, payload version                                           | Source bytes or payload version change.                                                                                                                      | `tests/storage/evidence-products.test.ts`                                    | Test-only product; not shared across real checkouts.                                                                                                                          |
| `file:doc-path-evidence`                 | Candidate code-path references found inside one documentation file.                                                                                                                                                                                                                                                                                                                                                                                  | `file_evidence`    | `src/queries/cleanup/doc-drift.ts`                     | kind, relative path, content hash, tracked files, git history window, payload version        | Doc bytes, tracked-file set, relevant git history, or payload version change.                                                                                | `tests/storage/evidence-cache.test.ts`                                       | Branch/worktree/clone safety depends on the git-history key; workspace changes matter when tracked path evidence changes.                                                     |
| `file:source-imports`                    | Parsed import edges for one source file plus import-resolution identity.                                                                                                                                                                                                                                                                                                                                                                             | `file_evidence`    | `src/language-parsers/index.ts`                        | kind, relative path, content hash, import-resolution fingerprint, payload version            | Source bytes, import resolution config, or payload version change.                                                                                           | `tests/storage/evidence-cache.test.ts`                                       | Safe across branch/worktree/clone when source and resolver identity match; workspace package edits are covered when resolver fingerprint changes.                             |
| `file:source-reexports`                  | Parsed re-export edges for one source file plus import-resolution identity.                                                                                                                                                                                                                                                                                                                                                                          | `file_evidence`    | `src/language-parsers/index.ts`                        | kind, relative path, content hash, import-resolution fingerprint, payload version            | Source bytes, import resolution config, or payload version change.                                                                                           | `tests/storage/evidence-cache.test.ts`                                       | Same sharing rule as source imports.                                                                                                                                          |
| `file:source-fingerprints`               | Source-token fingerprints used by similarity analysis for definitions in one file.                                                                                                                                                                                                                                                                                                                                                                   | `file_evidence`    | `src/queries/cleanup/similar.ts`                       | kind, relative path, content hash, project fingerprint, payload version                      | Source bytes, project fingerprint, indexed languages, or payload version change.                                                                             | `tests/symbols/definition-catalog.test.ts`                                   | Safe when source and project identity match; workspace and multi-language changes are project-shaped.                                                                         |
| `file:consumer-file-usage`               | Imported and used leaf names for one consumer file.                                                                                                                                                                                                                                                                                                                                                                                                  | `file_evidence`    | `src/queries/internal/consumer-evidence.ts`            | kind, relative path, content hash, project fingerprint, payload version                      | Source bytes, project fingerprint, indexed languages, or payload version change.                                                                             | `tests/storage/evidence-cache.test.ts`                                       | Safe when source and project identity match; workspace dependency changes must alter project identity when they affect usage evidence.                                        |
| `file:react-component-behavior-profiles` | JSX and behavior-token profile for one React component file.                                                                                                                                                                                                                                                                                                                                                                                         | `file_evidence`    | `src/source/react-profile.ts`                          | kind, relative path, content hash, payload version                                           | Source bytes or React profile parser version change.                                                                                                         | `tests/storage/evidence-cache.test.ts`                                       | Safe when content hash matches; workspace identity is not otherwise part of the payload.                                                                                      |
| `file:git-file-adds`                     | File-first-added records derived from bounded git history.                                                                                                                                                                                                                                                                                                                                                                                           | `file_evidence`    | `src/analysis/git-history.ts`                          | kind, cache key, HEAD, history window, payload version                                       | Git HEAD/history window or payload version change.                                                                                                           | `tests/storage/evidence-cache.test.ts`                                       | Not safe across branch/worktree/clone unless HEAD and history key match exactly.                                                                                              |
| `file:typescript-reference-fragments`    | Compiler-resolved TypeScript reference facts owned by the source file containing each reference and addressed to stable SCIP target symbols. Schema version 2 includes hierarchy and unindexed-interface attribution so assembled fragments preserve exact project-owned cross-file caller presence; full reference line/column parity remains a separate diagnostic contract.                                                                       | `file_evidence`    | `src/semantic/typescript/reference-fragment-shadow.ts` | kind, relative path, transitive semantic identity, payload version                           | Source bytes, any transitive compiler dependency, TypeScript configuration or ambient input, project membership, compiler engine, or payload version change. | `tests/semantic/typescript/typescript-reference-fragments.test.ts`           | Safe only when the full transitive semantic identity matches; a missing or uncertain identity disables reuse and exact caller consumers fall back to precise compiler lookup. |
| `file:typescript-import-usage`           | Compiler-resolved import binding usage for one TypeScript source file.                                                                                                                                                                                                                                                                                                                                                                               | `file_evidence`    | `src/semantic/shared-primitives.ts`                    | kind, relative path, transitive semantic identity, payload version                           | Source bytes, any transitive compiler dependency, TypeScript configuration or ambient input, project membership, compiler engine, or payload version change. | `tests/semantic/typescript/typescript-semantic-provider.test.ts`             | Safe only when the full transitive semantic identity matches; cross-workspace reuse also requires identical project membership and configuration.                             |
| `file:typescript-signatures`             | Compiler-normalized signatures for the indexed definitions owned by one TypeScript source file.                                                                                                                                                                                                                                                                                                                                                      | `file_evidence`    | `src/semantic/shared-primitives.ts`                    | kind, relative path, transitive semantic identity, payload version                           | Source bytes, any transitive compiler dependency, TypeScript configuration or ambient input, project membership, compiler engine, or payload version change. | `tests/semantic/typescript/typescript-semantic-provider.test.ts`             | Safe only when the full transitive semantic identity matches; symbol signatures share one file-owned payload.                                                                 |
| `project:file-dependency-graph`          | Whole-project file dependency graph combining a selected SCIP edge policy with source imports. The default preserves all reference edges; import-cycle analysis selects import-only SCIP edges so ambient or ordinary references cannot manufacture cycles.                                                                                                                                                                                          | `project_evidence` | `src/symbols/graph/file-dep-graph.ts`                  | kind, scope, SCIP edge mode, project fingerprint, payload version                            | Project fingerprint, selected SCIP edge mode, indexed language set, import-resolution identity, or payload version change.                                   | `tests/symbols/file-dep-graph.test.ts`, `tests/queries/graph/cycles.test.ts` | Safe across branch/worktree/clone when the project fingerprint and SCIP edge mode match; source-import metadata is retained in the payload for observability.                 |
| `project:semantic-import-usage`          | Rust compiler-backed import usage for one source file, including source-fallback facts plus `rust-analyzer`-resolved project-local definition files when available.                                                                                                                                                                                                                                                                                  | `project_evidence` | `src/semantic/shared-primitives.ts`                    | kind, relative path, project fingerprint, language, semantic engine, payload version         | Project fingerprint, indexed language set, Rust semantic engine identity, or payload version change.                                                         | `tests/semantic/rust/rust-semantic-cache-gate.test.ts`                       | Safe when project fingerprint and Rust semantic engine identity match; workspace and multi-language changes flow through the project fingerprint.                             |
| `project:semantic-signatures`            | Rust semantic signature text for one indexed definition.                                                                                                                                                                                                                                                                                                                                                                                             | `project_evidence` | `src/semantic/shared-primitives.ts`                    | kind, relative path, symbol, project fingerprint, language, semantic engine, payload version | Project fingerprint, indexed language set, Rust semantic engine identity, or payload version change.                                                         | `tests/semantic/rust/rust-semantic-cache-gate.test.ts`                       | Safe when project fingerprint, symbol, source path, and Rust semantic engine identity match.                                                                                  |
| `project:health-semantic-prewarm`        | Completion marker for one full-health semantic cache prewarm against an exact published project generation and CLI version.                                                                                                                                                                                                                                                                                                                          | `project_evidence` | `src/runtime/cli-support.ts`                           | kind, scope, CLI version, project fingerprint, payload version                               | Project fingerprint, indexed language set, CLI version, or payload version change.                                                                           | `tests/runtime/cli-support.test.ts`                                          | Safe only for the exact published generation and CLI version; it stores no semantic facts itself.                                                                             |

2026-07-23 verification: adding the zero-valued
`architectureViolations` field to deferred drift-phase output does not change
the health semantic-prewarm product, its cache key, or its invalidation
triggers.

## Finding-outcome observation ledger

The finding-outcome ledger is a worktree-local observational product: its rows
summarize how often one stable detector finding was shown and its latest
open, suppressed, or resolved state. Its companion observation table names
each completed logical run by a caller-owned ID and fingerprints that run's
normalized findings, checks, retained identities, and captured observation
time.

Both tables live in `evidence.db`. One `BEGIN IMMEDIATE` transaction claims the
observation ID, derives the transition from the latest committed ledger, and
applies count deltas with SQLite `UPSERT`. Distinct transactions therefore
have one database-defined commit order and cannot replace one another's
increments. An identical ID/fingerprint retry is a no-op; an ID with a
different fingerprint is a conflict. The observation ID omits attempt
identity: every retry of one logical run must reuse it, while a new detector
evaluation must use a new ID. Observation records are retained with the local
database because exact retry deduplication requires remembering every accepted
ID. Removing the rebuildable database resets both the metric and that memory.

Writer-lock timeout is an unavailable observation, not evidence that the
detector ran zero times. The gate result remains authoritative and the local
metric write is skipped with a warning. `tests/queries/health/finding-outcome-ledger.test.ts`
interleaves two independent connections at the old stale-read boundary and
tests exact retry, ID collision, distinct increments, and suppression.
`tests/storage/evidence-cache.test.ts` verifies the recency cap and lock-timeout
rollback.

## Sidecar Product Matrix

Sidecar products are stored cache files that do not live in an evidence table.
They still need an explicit identity key because they can affect command output.

| Product                          | Referent                                                                   | Storage                                      | Payload Owner                        | Key Parts                                                                                          | Invalidation Trigger                                                                                                                                                                                                             | Staleness Test                              | Branch / Worktree / Clone / Workspace / Multi-Language                                                                                                                                                                      |
| -------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index-side:health-report-cache` | Full rendered health report for one indexed project and health option set. | `health-report-cache.json` beside `index.db` | `src/runtime/health-report-cache.ts` | cache version, project evidence fingerprint, CLI version, `scope`, `full`, phase timeout, git HEAD | Project/index metadata, indexed language set, CLI version, health scope/full mode, phase timeout, git HEAD, or cache payload version change. Detector precision is refreshed from the live finding-outcome ledger on every read. | `tests/runtime/health-report-cache.test.ts` | Safe after clearing only `evidence.db`; not shared across branch/worktree/clone unless git HEAD and project fingerprint match exactly. Workspace and multi-language identity flow through the project evidence fingerprint. |

The cached health payload contains detector results. The command boundary adds
the live project capability matrix and experimental-score interpretation after
the cache read, so changes in installed semantic providers or checkers do not
require invalidating the detector-result cache and cannot be hidden by it.
Human rendering now uses investigation language for candidate LOC and does not
alter this cache ownership or invalidation contract.

## Benchmark Commands

- `node scripts/performance-architecture-contract.mjs --repo . --command "health --json" --warm-iterations 1 --no-clear`
- `node dist/cli.js work-audit <profile-jsonl> --top 10 --json`
- `node scripts/check-evidence-manifest-doc.mjs`

The consumer-evidence profile identity includes the exact definition set,
semantic/source-fallback options, and this matrix's project evidence
fingerprint. That makes equal identities evidence that the computation inputs
matched the same published project generation. When the project fingerprint is
unavailable, the span remains unclassified instead of being treated as safely
reusable.

## Cross-worktree sharing

Cross-worktree sharing has two deliberately different layers.

An index generation is a complete immutable artifact set for one repository,
Git tree, project-input fingerprint, indexed language set, artifact format, and
producer version. The producer version identifies the scip-query/index-format
implementation whose behavior created the files; including it makes an upgrade
miss safely instead of adopting artifacts with incompatible semantics.
Clean worktrees with that exact identity clone the generation into their own
writable cache before opening SQLite. The clone is rebound to the target SCIP
project root, then enters through the existing local complete-visibility
publication and generation-recovery boundary. The generation manifest,
worktree lease, local pointer, reindex metadata, and SQLite generation state
use crash-durable file replacement; the wider multi-file generation handoff
remains a distinct publication protocol. See `docs/DURABILITY.md` for that
classification. Dirty or partial indexes are never published.
Generation attachment, worktree-lease liveness updates, and repository cleanup
also share the repository-cache lock. A liveness update uses its first pointer
observation only to select that lock, then rereads and validates the current
pointer, lease ownership, Git tree, local fingerprint, generation, and
artifacts before changing only `lastSeenAt`. It therefore cannot replay an old
lease after a newer generation is attached or move liveness behind a touch
that completed first.
Peer bootstrap validates the stable cache artifacts, not the peer checkout's
current files: a dirty checkout may donate an older cache that still exactly
describes the target `HEAD`, while a cache containing the dirty changes cannot.
An idle-watcher generation proof is the matching 64-character digest written
into live watch state after the watcher verifies the current published
metadata. It lets a dirty checkout skip a second source scan for a local query
only while that watcher is idle, error-free, and naming the same database
generation; it never makes dirty files eligible for cross-worktree publication.
The implementation and its compiler-backed tests live in
`src/reindex/shared-generation-store.ts` and
`tests/reindex/shared-generation-store.test.ts`, with the cross-worktree path
covered by `tests/reindex/shared-worktree-cache.integration.test.ts`.

Shared-generation build ownership now uses the same crash-durable,
token-checked process-lock record as repository cleanup, reindex, watch, and
the Rust semantic server. This changes lock recovery—not generation identity,
manifest validation, lease ownership, or publication—and is specified in
`docs/LOCK_PROTOCOL.md`.
Waiting for that ownership is measured with a process-local monotonic clock, so
an operating-system civil-clock correction cannot lengthen the wait. Persisted
lease and lock timestamps remain civil-clock observations for diagnostics and
conservative cross-process expiry; they never, by themselves, prove that a
recorded process instance is dead or authorize replacement.

Shared evidence is a repository-level read-through database at
`~/.cache/scip-query/repositories/<repository-id>/evidence.db`. The
worktree-local `evidence.db` remains authoritative: reads try local first and
writes commit locally before a best-effort shared write. A shared SQLite open,
read, lock, corruption, or write failure becomes a miss or no-op and cannot
fail a query.

The shipped allowlist is intentionally limited to products whose manifest
dependencies are exactly content hash and tool version:

- `file:source-facts`
- `file:definition-exclusions`
- `file:doc-path-tokens` (the typed storage-contract test product)
- `file:react-component-behavior-profiles`

The shared table key contains kind, relative path, content hash, and payload
version, so two content versions of one path coexist. Project evidence,
semantic callees/references, legacy rows, Git-history-shaped products, and the
finding outcome ledger remain local. Products such as `file:file-definitions`
and `file:consumer-file-usage` also remain local because their meaning depends
on the project fingerprint, not source bytes alone.

`tests/storage/evidence-cache.test.ts` proves a safe product written from one
worktree is readable in another, two content hashes for one path coexist, and
a non-allowlisted product misses. Shared rows are oldest-first bounded during
repository cleanup. `SCIP_QUERY_SHARED_CACHE=0`, `SCIP_QUERY_CACHE_DIR`,
`SCIP_QUERY_INDEX_DB`, or configured `dbPath` bypasses this layer together with
shared index generations.
