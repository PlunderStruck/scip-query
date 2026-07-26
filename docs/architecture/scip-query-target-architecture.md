# scip-query Target Architecture

Date: 2026-07-23

## Purpose

This document turns the repository's directory graph into an explicit target
architecture. It is not a claim that every dependency should form one global
layer stack. scip-query contains delivery code, use cases, evidence engines,
language adapters, persistence, and compiler integrations; those are different
kinds of responsibility and should be judged by the direction in which they
depend on one another.

An ownership boundary is a named group of files that has one stable reason to
change. The referents here are the configured `src/domain/**`,
`src/storage/**`, `src/queries/**`, and related directory groups. What
distinguishes a real boundary from a folder label is that its files own one
kind of decision and expose contracts that let other responsibilities use it
without importing its implementation policy.

A dependency direction is an architectural constraint on which responsibility
may know another. The referents are resolved ordinary imports and
`export ... from` dependencies summarized by `scip-query architecture`. What
makes the direction architectural is that it keeps mechanisms from deciding
higher-level policy: a persistence module may store an outcome record, but it
must not import the query workflow that decides what the outcome means.

A port is a consumer-owned capability contract through which a higher-level
decision uses a lower-level mechanism. The `isIgnored(relativePath)` behavior
needed by `ScipDatabase` is the immediate referent. Its essential trait is that
the consumer names only the operation it requires, so it does not depend on the
producer's larger concrete interface or directory.

## Current Evidence

The working-tree architecture command reports:

- 351 of 351 indexed files mapped, with no ambiguous files;
- 34 enforced boundaries;
- 205 observed cross-boundary dependency relationships;
- 34 of 34 closed dependency rows;
- 0 forbidden relationships;
- 0 reciprocal boundary pairs;
- 0 strongly connected multi-boundary groups;
- 0 unresolved coarse boundaries.

Source: `scip-query architecture --json` on 2026-07-24.

The mapping and policy are complete. `requireCompletePolicy` rejects a missing
outgoing dependency row, while `requireAcyclic` rejects a multi-boundary
strongly connected component. The analyzer includes resolved re-exports only
for architecture; the shared dependency graph retains its import-only default,
so navigation, incremental indexing, similarity, and semantic consumers keep
their established work profile.

## Enforced Boundary Responsibilities

| Boundary                 | Stable responsibility                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `analysis`               | Cross-cutting evidence interpretation, including history and file classification        |
| `domain`                 | Dependency-free values, configuration shapes, identities, and project-input transitions |
| `instrumentation`        | Dependency-free profiling primitives                                                    |
| `platform`               | Host, toolchain, process, cache, and verified-binary mechanisms                         |
| `public-api`             | Published library exports                                                               |
| `queries-cleanup`        | Cleanup detectors and candidate production                                              |
| `queries-facade`         | Public query aggregation and export registration                                        |
| `queries-frontend`       | Framework-specific analysis products                                                    |
| `queries-graph`          | Architecture and graph reports                                                          |
| `queries-health`         | Composite health collection and health-baseline orchestration                           |
| `queries-impact`         | Change-impact and diff-gate workflows                                                   |
| `queries-internal`       | Shared query evidence, policy, and baseline-file primitives                             |
| `queries-navigation`     | File and symbol navigation                                                              |
| `queries-quality`        | Complexity and self-audit queries                                                       |
| `queries-utils`          | Common query result normalization and formatting                                        |
| `reindex`                | Index construction and generation orchestration                                         |
| `reindex-augmentation`   | Post-index source augmentation                                                          |
| `reindex-vue`            | Vue-specific index augmentation                                                         |
| `runtime-command-kit`    | Reusable command definition and execution machinery                                     |
| `runtime-commands`       | Top-level command catalog, registry, and handlers                                       |
| `runtime-entry`          | CLI and package executable entry points                                                 |
| `runtime-query-commands` | Query command adapters and renderers                                                    |
| `runtime-services`       | Watch, setup, diagnostic, and delivery services                                         |
| `rust-kernels`           | Native package implementation                                                           |
| `semantic-contracts`     | Provider-neutral semantic contracts                                                     |
| `semantic-core`          | Provider selection, caching, and shared semantic orchestration                          |
| `semantic-rust`          | rust-analyzer-backed semantic evidence                                                  |
| `semantic-typescript`    | TypeScript-compiler-backed semantic evidence                                            |
| `source`                 | Source text, AST, import parsing, language adapters, and framework facts                |
| `storage`                | SQLite, cache, and repository-file persistence                                          |
| `symbols-core`           | Symbol catalog, identity, and attribution                                               |
| `symbols-graph`          | File and call dependency graph construction                                             |
| `symbols-references`     | Reference and caller discovery                                                          |
| `tla`                    | Formal-model use cases and tooling                                                      |

## Target Responsibility Flow

Dependencies should normally move downward through these responsibility bands:

1. **Delivery** — `public-api` and the `runtime-*` boundaries.
2. **Use cases** — the `queries-*`, `reindex*`, and `tla` boundaries.
3. **Evidence engines** — `analysis`, `semantic-*`, and `symbols-*`.
4. **Adapters and persistence** — `source` and `storage`.
5. **Stable contracts and leaf mechanisms** — `domain`, `instrumentation`,
   `platform`, and native package boundaries.

This is a default direction, not a license to create forwarding wrappers. When
two evidence engines genuinely cooperate, they should share a narrowly named
domain contract or be treated as one subsystem. A reciprocal pair is resolved
by identifying ownership, not by inserting an interface whose only purpose is
to hide the import.

## First Cleanup Ledger

The initial review found three forbidden relationships leaving `storage`.
They were removed in the first refactor slice and their baseline identities
were deleted only after the rebuilt graph reported zero forbidden
relationships.

### `storage -> source`

`ScipDatabase` imports the concrete `PathFilter` type but calls only
`isIgnored(relativePath)`. The storage consumer should own that minimal
capability. The source-owned Gitignore implementation will satisfy it
structurally.

Disposition: resolved through the consumer-owned `PathExclusionPolicy` port.

### `storage -> queries`

`outcome-events.ts` imports finding-outcome records and `ledgerKey` from a
health query module. Those values describe detector-outcome identity and
transition state independently of either query orchestration or persistence.

Disposition: resolved. The pure model and event transition now live in
`domain`; the SQLite health ledger shell remains in `queries/health`, and JSON
persistence remains in `storage`.

### `storage -> analysis`

`outcome-events.ts` invokes `runGit` to resolve HEAD and worktree cleanliness.
The runtime already owns `resolveGitWorktreeContext()` and `gitOutput()`.

Disposition: resolved. Git inspection now reuses the existing runtime worktree
capability in the runtime outcome orchestrator.

## Second Cleanup Ledger

The next migration removed the accidental `core` package. Query evidence
orchestration moved to `queries/internal`, regex escaping moved to `source`,
and host binary mechanisms moved to the new closed `platform` boundary. That
removed nine boundary relationships and the `core/source` and `core/symbols`
reciprocal pairs.

The project-path contract then moved from `source` to `domain`. It defines
repository path identity for every subsystem rather than extracting source
facts. That removed the `resolution/source` reciprocal pair and made it safe
to close the `resolution` dependency row.

## Third Cleanup Ledger

Reusable host mechanisms now live in `platform`: process liveness, Git
worktree identity, token-owned cache locks, installed CLI identity, SCIP
binary resolution, deterministic cache layout, and the persisted watch-service
state contract. A host mechanism is an operation that reports or changes
operating-system state without choosing a user workflow; this is what
distinguishes these files from runtime delivery and command policy.

The moves preserve each implementation and reroute existing callers directly,
so they add no wrapper call, polling loop, filesystem operation, Git process,
hash calculation, or serialization step. `platform` depends only on stable
`domain` contracts used by cache layout and persisted watch-state validation.

The persisted watch-service state contract is the versioned JSON record that
lets runtime, reindex, and semantic processes agree on watcher identity,
liveness, index generation, and nested TypeScript service status. Its
essential characteristic is that it validates the complete stored record
without starting, stopping, or otherwise controlling the process. The schema,
paths, reader, parser, and all nested validators therefore moved together to
`platform/watch-service-state.ts`; runtime retains process lifecycle, activity
and lock mutation, and the existing atomic writer. The stored identity now
includes the operating-system process start token as well as the reusable PID;
runtime must verify both before a stop or replacement signal.

Protocol version 5 adds the validated refresh-request status snapshot and the
checkout-local `watch-refresh-requests/` path. The authoritative request,
claim, and completion records belong to `storage`; the runtime watch
coordinator couples those records to watcher transitions, while `platform`
continues to own only the process-neutral state schema and paths. Persisted
record decoders share dependency-free object, timestamp, scalar-number, and
string-or-null-record predicates in `domain/record-validation.ts` rather than
creating cross-dependencies between storage, reindex, platform, and semantic
protocols.

The nested TypeScript semantic and index snapshots now also expose the
bounded-mailbox state owned by `storage/bounded-mailbox.ts`: pending,
owner-specific inflight, retained response, and dead-letter counts plus the
retained byte total and oldest enqueue time. `platform/watch-service-state.ts`
validates that passive snapshot without owning admission, claim, expiry, or
cleanup policy. Runtime remains the service coordinator that asks each
mailbox host for its current snapshot when it durably publishes watch state.
This keeps cross-process lifecycle policy in storage/runtime while preserving
platform as a process-neutral decoder.

Admission also returns the deadline from the authoritative pending, inflight,
or completed operation, and completion records retain it. Domain protocols
such as durable Rust can therefore require an exact response deadline without
putting civil time into the content-derived logical-operation identity or
breaking first-completion retry convergence.

Each owner-specific inflight directory records a process instance: a PID plus
the operating-system start token that distinguishes successive processes
reusing that PID. Storage owns the pure record parser and equality rule;
service coordinators supply host liveness observations from `platform`.
Expired civil-clock lease age therefore permits reclamation only when the
recorded process is proven dead or now has a different start token. A live or
unverifiable owner fails closed. Admission and claim waits use monotonic time,
while persisted enqueue, expiry, retention, and diagnostic fields remain civil
timestamps.

The state union includes `draining`, the live interval in which the owner has
stopped accepting refreshes but has not yet closed every subscription and
reaped its active reindex child. Runtime persists the reason and continues to
reuse that live service rather than starting another owner. Only a successful
drain removes the service record and releases its process lock; an unproven
exit remains visible as degraded ownership.

The runtime module directly re-exports the former read-side names for source
compatibility, but internal consumers now import their owner directly. The
parser still accepts a numeric protocol version so runtime can classify an
otherwise valid older record as incompatible rather than erasing that
diagnostic distinction.

Measured after reindex, the final `reindex -> runtime` and
`semantic -> runtime` edges are gone. The boundary graph fell from 60 to 58
relationships and from four to two reciprocal pairs. It maps all 343 files,
reports zero forbidden relationships, and reduces the only strongly connected
group from nine boundaries to five.

## Fourth Cleanup Ledger

The project-input and toolchain extraction removed all nine
`semantic -> reindex` file edges. Stable snapshot records, input
classification, checked parsing, change manifests, and the file-dependency
graph type now live in `domain`. A project-input transition is the pure
comparison that reports changed repository facts and uncertainty; reindex
still owns the separate decision to widen those facts into a dependency
closure or full-project rebuild.

Git/filesystem enumeration and hashing now live in `platform/project-files.ts`.
Executable discovery, project-local and bundled indexer resolution,
dependency status, and .NET runtime probing now live in
`platform/indexer-toolchain.ts`. Reindex retains indexer invocation and
installation policy. Rust semantic readiness and Rust SCIP indexing reuse one
rust-analyzer descriptor and one resolver.

The published reindex entry directly re-exports its established names from the
new owners, while unused internal compatibility facades were removed. The move
adds no filesystem operation, Git process, hash, executable probe, availability
cache, or forwarding function.

Measured after reindex, all 345 files are mapped, cross-boundary relationships
fell from 58 to 57, reciprocal pairs fell from two to one, and the only
strongly connected group fell from five boundaries to four. `reindex` is no
longer in that group, and architecture drift reports zero findings.

## Fifth Cleanup Ledger

The semantic-evidence inversion removed all eight `symbols -> semantic` file
edges. `symbols/semantic-evidence-port.ts` now names only the compiler-resolved
reference, caller, and callee facts required by symbol attribution and graph
construction. A semantic-evidence port is the consumer-owned operation set
through which symbol logic can request those optional facts without knowing
which compiler provider, engine identity, or cache produces them.

`semantic/symbol-evidence.ts` implements that contract and now owns the complete
durable semantic-callee cache operation: in-memory prefetch consumption,
persistent cache reads, dependency and engine identities, miss computation,
provider-availability qualification, writes, and runtime prewarm. The move
preserves cache keys, payloads, profiling spans, and the early return that keeps
a full cache hit from constructing the provider.

Higher-level query orchestration passes one stateless adapter into symbol fact
operations. There is no service locator, global registration, new cache, new
filesystem operation, new dependency-graph pass, or new provider probe.
`semantic: false` decisions and the existing AST/semantic/SCIP precedence are
unchanged.

Measured after reindex, all 347 files are mapped, cross-boundary relationships
fell from 57 to 56, reciprocal pairs fell from one to zero, and the only
strongly connected group fell from four boundaries to three. The remaining
group is `resolution`, `source`, and `symbols`; `semantic` is no longer in a
cycle. `symbols -> semantic` is empty and the intended `semantic -> symbols`
direction remains.

## Sixth Cleanup Ledger

The final slice decomposed the misleading `resolution` boundary by moving each
implementation to the responsibility whose decisions it serves:

- language import-specifier resolution moved unchanged to
  `source/import-path-resolver.ts`;
- workspace-manifest discovery moved unchanged to
  `platform/workspace-packages.ts`;
- user file-pattern lookup moved unchanged to
  `queries/internal/file-resolution.ts`.

This was an ownership correction, not a new abstraction. Existing callers
import the implementations from their owners; there is no compatibility
wrapper, added filesystem pass, added cache, or changed resolution algorithm.
The file-level graph remained acyclic, and removing the mixed directory
eliminated the false `resolution/source/symbols` boundary component.

Architecture now opts into the existing resolved re-export evidence. That
exposes the five dependencies from `src/index.ts` that its public surface had
always carried but the import-only view could not observe. The opt-in mode has
separate memory and durable cache identities; every other
`buildFileDepGraph` caller keeps the import-only default.

The measured graph then supplied the exact outgoing targets for every
boundary. `.scipquery.json` closes every row, `requireCompletePolicy` prevents
a future omitted row from silently reopening one boundary, and `requireAcyclic`
prevents a future multi-boundary cycle.

**Superseded 2026-07-24.** The 14-boundary configuration described above
reported zero cycles, but that result was an artifact of granularity rather
than a property of the code: same-boundary dependencies are always allowed, so
every edge inside a boundary was discarded before the check ran. Six of the 14
boundaries — holding 295 of 348 files — each contained an internal cycle the
policy could not express. The configuration is now **34 boundaries over 351
files with 205 allowed relationships**, and `requireResolvedBoundaries` keeps
each boundary's own sub-directory quotient acyclic so the guarantee survives
future growth. Zero forbidden edges, undeclared edges, reciprocal pairs,
cycles, or coarse boundaries.

## Ownership Decisions for Evidence Direction

In the target direction `A -> B`, code in `A` may import code in `B`; the
reverse import must be removed before either row is closed. A merge means two
directories are one enforced subsystem because their files collaborate to
produce the same kind of result.

| Original pair                 | Target decision                  | Reason                                                                                                                                                               | Migration status                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `language-parsers <-> source` | Merge into the `source` boundary | Both directories derive syntactic facts from source text. Fourteen parser files use source primitives, while the source evidence facade invokes the parser registry. | Complete, and the merge now holds without a reciprocal dependency. `source-evidence.ts` — the one file importing the parser registry from the source side — moved into `src/language-parsers/`, its true owner. `src/source` was then layered into `primitives/ -> ast/ -> facts/ -> vue/` with the products facade at the root, so the merged boundary is internally acyclic and the directory names still distinguish shared primitives from language-specific strategies. |
| `semantic <-> symbols`        | Keep `semantic -> symbols`       | Semantic providers translate compiler results into repository symbol identities and graphs; symbol facts need optional compiler evidence without provider knowledge. | Complete: the symbols-owned port is implemented in `semantic` and passed by query orchestration. `symbols -> semantic` is empty, and no reciprocal pair remains.                                                                                                                                                                                                                                                                                                             |

Evidence: `node dist/cli.js architecture --json`;
`node dist/cli.js imports src/language-parsers/source-evidence.ts --json`;
`node dist/cli.js imports src/reindex/index.ts --json`;
`node dist/cli.js imports src/reindex/shared-generation-store.ts --json`;
`node dist/cli.js imports src/storage/atomic-file.ts --json`;
`node dist/cli.js imports src/storage/atomic-json.ts --json`;
`node dist/cli.js system src/semantic --json`;
`node dist/cli.js imports src/semantic/typescript/remote-provider.ts --json`;
`node dist/cli.js imports src/symbols/identifier-attribution.ts --json`; and
`node dist/cli.js imports src/symbols/references/reference-callers.ts --json`.
The atomic-file and atomic-JSON boundary direction was reverified on
2026-07-25. The complete-descriptor write loop and Windows directory-handle
classification shared by atomic replacement and platform-owned lock/binary
publication live in the dependency-free `src/filesystem/file-descriptor.ts`
boundary; `platform` and `storage` may both depend on that primitive without
depending on one another. `src/storage/atomic-file.ts` now also owns exclusive
first publication through a flushed staging inode and hard link. The
revision-aware coordinator belongs to `runtime-services`, where it may combine
that storage primitive with the platform process-lock protocol without
introducing a forbidden `storage -> platform` dependency.

The shared-generation direction was reverified on 2026-07-25. Reindex owns
generation identity, lease validation, and the liveness-only merge; it depends
on the platform-owned repository-cache lock and storage-owned durable JSON
publication. Lease attachment, touch, and cleanup use that same lock, so no
reverse `platform -> reindex` or `storage -> reindex` dependency is needed to
prevent a stale touch from restoring an older generation.

The reindex-metadata direction was reverified on 2026-07-25.
`src/domain/reindex-metadata.ts` is the dependency-free version, validation,
and capability boundary. Reindex, runtime services, semantic sessions, and
storage identity/cache consumers depend inward on it; the domain decoder
depends only on domain language, record/timestamp, and project-file
validators. The generic object-record predicate now lives beside the timestamp
predicate in `src/domain/record-validation.ts` and is also reused by config and
JSON protocol decoders. This keeps future-version rejection identical without
introducing a reverse domain dependency.

The immutable SQLite generation handoff was reverified on 2026-07-25.
`src/reindex/index.ts` coordinates publication, but durable directory flushing
is owned by `src/storage/atomic-file.ts`; the reindex layer does not depend on
the low-level filesystem boundary. `src/storage/sqlite-generation.ts` resolves
the current pointer into one retained database, metadata, and SCIP artifact
set. `src/semantic/typescript/remote-provider.ts` carries that retained
generation identity into the semantic mailbox instead of rereading a mutable
compatibility path. The generation identity is part of the mailbox operation
key, so retries for one immutable generation join the same logical operation
while a later published generation is necessarily a distinct request.

The untrusted-artifact read direction was reverified on 2026-07-26.
`src/filesystem/bounded-file.ts` is the dependency-free owner of
descriptor-bound regular-file reads, byte budgets, changed-during-read checks,
and streaming hashes. Platform and storage expose boundary-specific facades
over that primitive; they do not duplicate its safety policy. Repository
regular-expression budgets are a dependency-free domain rule, so analysis can
compile configured test patterns without importing host-platform mechanisms.
Post-index augmentation is the one augmentation layer that owns a file-backed
fingerprint cache, so its closed dependency row deliberately includes the
filesystem primitive alongside source facts. This is narrower than allowing
augmentation to depend on the full platform or storage layers.

The `semantic -> symbols` row is now closed together with the rest of
semantic's classified outgoing relationships. The intended direction is
observed without a reverse import.

## No-Move Decisions

- Do not move the entire `outcome-events.ts` file under `queries`. That would
  make filesystem persistence look like query policy rather than separating
  the mixed responsibilities.
- Do not allow `storage -> source`, `storage -> analysis`, or
  `storage -> queries` merely to produce a clean report. The existing closed
  storage row expresses the correct mechanism boundary.
- Do not disable `requireCompletePolicy` or `requireAcyclic` to accommodate a
  regression. Repair the ownership direction, or deliberately revise the
  complete contract with evidence.
- Do not re-split `source` and `language-parsers` merely to force a layer
  direction. They form one source-fact subsystem; their directory names still
  usefully distinguish shared primitives from language-specific strategies.
  This rule was tested on 2026-07-24: the subsystem did contain a real cycle,
  and the repair was an ownership correction inside the merged boundary
  (relocating `source-evidence.ts`, then layering `src/source`), not a split.
  `requireResolvedBoundaries` now enforces the internal structure directly, so
  a future cycle here surfaces without needing separate boundaries.
- Do not bulk-move files based only on locality candidates. The current
  locality report mostly withholds exact destinations because consumers are
  repository-wide.

## Migration Order

1. **Complete:** remove all three `storage` leaks while preserving behavior,
   then remove their stable baseline identities.
2. **Complete:** decompose `core` into `platform`, `queries/internal`, and
   source-pattern owners.
3. **Complete:** move the project-path contract into `domain`, remove the
   `resolution <-> source` reciprocal pair, and close `resolution`.
4. **Complete:** govern `source` and `language-parsers` as one source-fact
   boundary, removing a false reciprocal relationship from the policy graph.
5. **Complete:** move reusable host mechanisms from `runtime` to `platform`.
   Worktree identity, process liveness, cache locking and layout, CLI identity,
   SCIP binary resolution, and the complete persisted watch-state contract now
   live below runtime. Runtime retains delivery and process-lifecycle policy.
6. **Complete:** extract project-input and toolchain contracts so semantic no
   longer imports reindex implementation files. Pure transitions live in
   `domain`; host fingerprinting and executable discovery live in `platform`;
   reindex retains affected-set, invocation, and installation policy.
7. **Complete:** introduce the symbols-owned semantic-evidence port, move
   semantic cache/provider mechanics behind its semantic adapter, wire
   higher-level orchestration, and remove `symbols -> semantic`.
8. **Complete:** decompose the mixed `resolution` directory into `source`,
   `platform`, and `queries/internal`, preserving each implementation.
9. **Complete:** include resolved re-export edges in architecture's opt-in
   graph view, derive and close all 14 dependency rows from the rebuilt graph,
   and enable complete-policy and acyclicity enforcement.

## Completion Criteria

The architecture is now clean enough to govern changes because:

- every mapped boundary has one documented responsibility;
- every boundary has a closed outgoing row with no forbidden edge;
- no relationship remains undeclared;
- stable contracts live below the mechanisms that implement them;
- delivery code does not supply reusable lower-level infrastructure;
- the architecture baseline contains accepted debt, not false boundary
  definitions;
- `scip-query architecture`, `drift --architecture`, and the default
  `diff-gate` agree on the same project-owned policy.

Future work may still improve internal cohesion within a boundary, especially
the broad delivery and query boundaries. That is a refinement of an enforced,
acyclic dependency contract rather than unresolved cross-boundary debt.
