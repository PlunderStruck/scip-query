# Complete Architecture Policy

Date: 2026-07-23

## Goal

Replace the mixed `resolution` directory with three responsibility-owned
modules, include re-export dependencies in architecture analysis, close every
architecture dependency row, and enable acyclicity enforcement. Completion
means every indexed file is mapped, every observed boundary relationship is
allowed, no reciprocal pair or boundary cycle remains, and future forbidden
edges, missing policy rows, or cycles fail `diff-gate`.

## Definitions & Invariants

An **import-resolution mechanism** is a source-fact operation that turns a
language import specifier into an indexed project path. Its referents are
`src/resolution/import-path-resolver.ts` and its language-parser consumers; what
distinguishes it from user-input lookup is that the importing source file and
language syntax determine the answer. Source: `scip-query refs
resolveImportPath`.

A **workspace-package discovery mechanism** is a platform operation that reads
workspace manifests and returns package names, directories, and export maps.
Its referent is `src/resolution/workspace-packages.ts`; what distinguishes it
from import interpretation is that it reports filesystem-backed project
structure without choosing how a language resolves a specifier. Source:
`scip-query refs discoverWorkspacePackages`.

A **file-pattern resolution operation** is a query-owned lookup that turns a
user-supplied file pattern into one or more indexed paths. Its referent is
`src/resolution/path-resolver.ts`; what distinguishes it from source import
resolution is that ranked path and symbol matches, rather than language import
syntax, determine the answer. Source: `scip-query refs resolveIndexedFile` and
`scip-query refs resolveIndexedPaths`.

A **re-export dependency** is a module dependency created by an
`export ... from` statement. Its concrete referents are the `sourcePath` values
returned by `getReExports`; what distinguishes it from an ordinary import is
that the source module republishes the target's public surface. Source:
`scip-query refs getReExports`.

A **closed dependency row** is an architecture rule that enumerates every
boundary one source boundary may depend on. Its essential effect is that every
unlisted cross-boundary edge becomes a forbidden finding instead of remaining
descriptive. Source: `src/domain/config-types.ts` and `scip-query architecture
--json`.

A **complete architecture policy** is a set of closed dependency rows with one
row for every configured boundary. Its essential effect is that removing or
forgetting an entire row is itself a violation instead of silently returning
that boundary to discovery mode. Source: `ArchitectureConfig.requireCompletePolicy`.

The change preserves these invariants:

1. Import, workspace, and file-pattern resolution results must always be
   identical before and after the file moves.
2. Default `buildFileDepGraph` callers must always retain import-only source
   edges and their present work profile.
3. Architecture analysis must always include resolved import and re-export
   edges.
4. Import-only and import-plus-re-export graph products must never share a
   durable or in-memory cache key.
5. `requireAcyclic` must be enabled iff the rebuilt boundary graph has no
   multi-boundary strongly connected component.
6. Every configured boundary must always have one closed dependency row after
   enforcement is enabled.
7. No new filesystem scan, source parser, hash, provider probe, watcher
   operation, or shared mutable registry may be introduced.

## Premises

- **P1.** The pre-edit graph maps 347/347 files, reports 56 boundary
  relationships, 50 undeclared relationships, zero reciprocal pairs, and one
  `resolution/source/symbols` boundary cycle. Source:
  `node dist/cli.js architecture --json`.
- **P2.** The file-level dependency graph reports zero cycles. The remaining
  cycle therefore comes from grouping unrelated dependency directions under
  one boundary, not from a runtime module-initialization cycle. Source:
  `node dist/cli.js cycles --json`.
- **P3.** `resolveImportPath` is consumed by language parsers, Vue source
  evidence, and TypeScript semantic evidence. `resolveIndexedFile` and
  `resolveIndexedPaths` are consumed only by query modules.
  `discoverWorkspacePackages` is consumed by import resolution, TypeScript
  semantics, and diff-gate. Source: `scip-query refs resolveImportPath`,
  `scip-query refs resolveIndexedFile`, `scip-query refs
  resolveIndexedPaths`, and `scip-query refs discoverWorkspacePackages`.
- **P4.** `buildFileDepGraph` has analysis, semantic, query, and reindex
  consumers. Only architecture needs re-export dependency evidence; changing
  the default would alter many performance-sensitive paths. Source:
  `scip-query refs buildFileDepGraph`.
- **P5.** `getReExports` already owns parsing, resolution, in-memory caching,
  and durable file-evidence caching for JavaScript/TypeScript re-exports.
  Reuse avoids a second parser or source scan implementation. Source:
  `scip-query refs getReExports` and `src/language-parsers/index.ts`.
- **P6.** `buildFileDepGraph` is the sole writer and reader of the durable
  `file-dependency-graph` project product. Its cache identity currently
  separates SCIP edge modes but not source re-export modes. Source:
  `scip-query refs buildFileDepGraph` and
  `src/symbols/graph/file-dep-graph.ts`.
- **P7.** `architecture()` selects `imports-only` SCIP edges and is used by
  drift, health baselines, the public query registry, and runtime rendering.
  Source: `scip-query refs architecture`.
- **P8.** `src/index.ts` publishes domain, query, source, storage, and symbol
  surfaces through re-export declarations, but the pre-edit architecture
  report shows no `public-api` outgoing relationship. Source:
  `node dist/cli.js architecture --json` and `src/index.ts`.
- **P9.** The committed health baseline exists and the source-built
  architecture check participates in default `diff-gate`. Source:
  `tests/queries/impact/architecture-ratchet.test.ts` and
  `node dist/cli.js diff-gate --json`.

## Current State

The `resolution` boundary combines source-import interpretation, filesystem
workspace discovery, and user query lookup (P3). Its outgoing symbol lookup
edge joins the source-to-import-resolution edges into the only remaining
boundary cycle even though the actual file graph is acyclic (P1-P2).

Architecture analysis consumes the shared import-only dependency graph (P4,
P7). That is correct for most graph consumers but omits the public entry
point's re-export-only dependencies (P8). The existing re-export evidence
already contains resolved project paths, so architecture can opt into those
edges without inventing new parsing (P5).

## Reuse Audit

| Proposed change | Decision | Evidence |
| --- | --- | --- |
| Import-resolution owner | Move the existing implementation unchanged to `source`; do not wrap it | P3 |
| Workspace discovery owner | Move the existing implementation unchanged to `platform`; do not wrap it | P3 |
| File-pattern owner | Move the existing implementation unchanged to `queries/internal`; do not wrap it | P3 |
| Re-export collection | Extend `buildFileDepGraph` with an opt-in source-edge mode and reuse `getReExports` | P4-P6 |
| Architecture enforcement | Extend the existing `.scipquery.json` rows, require complete policy and acyclicity, and add no second policy file | P1, P7, P9 |

## Testability Design

| Behavior | Test seam | Dependencies | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Moved resolution results | Existing resolution unit tests | Fixture filesystem and SQLite DB | Existing ranking/resolution decisions | Existing filesystem/DB readers | Existing exports |
| Re-export graph edge | `buildFileDepGraph` fixture test | Fixture DB and source files | Edge collection and dedupe | `getReExports` cache/parser | `sourceEdges` option |
| Boundary policy | `analyzeArchitectureGraph` tests and live architecture command | Config plus graph | Boundary classification/SCC analysis | Project graph load | `ArchitectureConfig` |
| Future regression gate | Architecture ratchet tests and live `diff-gate` | Baseline/config | Finding identities | Git/baseline reads | Existing diff-gate check |

## Implementation Checklist

### 1. Decompose the resolution boundary

- [x] **Files:** move `src/resolution/import-path-resolver.ts` to
  `src/source/import-path-resolver.ts`; move
  `src/resolution/workspace-packages.ts` to
  `src/platform/workspace-packages.ts`; move
  `src/resolution/path-resolver.ts` to
  `src/queries/internal/file-resolution.ts`; move their tests to matching
  ownership directories; update every import and live documentation reference.
- **Premises:** P1-P3
- **Deployable:** no — part of the `complete-architecture-policy` single-deploy
  group.
- **Validation:** moved focused tests, typecheck, import scan showing no
  `src/resolution` references.

### 2. Add opt-in re-export dependency evidence

- [x] **Files:** `src/symbols/graph/file-dep-graph.ts`,
  `src/queries/graph/architecture.ts`,
  `tests/symbols/file-dep-graph.test.ts`.
- **Premises:** P4-P8
- **Deployable:** yes before enforcement; it adds descriptive evidence.
- **Change:** add an `imports-and-reexports` source-edge mode, collect resolved
  `getReExports` paths only in that mode, and include the mode in both
  in-memory and durable cache identities. Keep the default import-only.
- **Validation:** fixture proves default exclusion, opt-in inclusion, and
  cache-mode isolation; live architecture reports `public-api` relationships.

### 3. Close the complete policy after the graph is clean

- [x] **Files:** `.scipquery.json`,
  `tests/queries/graph/architecture.test.ts`,
  `tests/queries/impact/architecture-ratchet.test.ts`.
- **Premises:** P1, P7-P9
- **Deployable:** yes, only after steps 1-2.
- **Change:** remove `resolution`, add one exact row per remaining boundary,
  enable `requireCompletePolicy` and `requireAcyclic`, and add regression
  assertions for full policy coverage plus re-export and cycle failures.
- **Validation:** `config-validate`, architecture reports zero forbidden,
  undeclared, reciprocal, and cyclic relationships; default diff-gate passes.

### 4. Reconcile the architecture record and verify

- [x] **Files:** `docs/architecture/scip-query-target-architecture.md`, this
  plan, and any directly cited living documentation found by the doc gate.
- **Premises:** P1-P9
- **Deployable:** yes.
- **Validation:** focused and full tests, lint, typecheck, build, matching
  postchecks, reindex, doc-drift, architecture, health baseline, and diff-gate.

## Attack Record

### A1. Enforcement is enabled against the pre-move graph

- **Attack:** a contributor adds complete closed rows and `requireAcyclic`
  before moving the resolution files; the known SCC immediately blocks every
  diff.
- **Outcome:** **HOLE — repaired by step 3.** Enforcement is ordered after the
  rebuilt graph proves step 1 removed the SCC (P1-P3).

### A2. Re-export work slows every dependency-graph consumer

- **Attack:** architecture needs re-exports, so an implementation adds
  `getReExports` to the default collection loop; semantic identities,
  incremental indexing, cycles, and similarity now pay extra parser/cache work.
- **Outcome:** **HOLE — repaired by step 2.** The new mode is opt-in and
  architecture is its only caller (P4-P7).

### A3. Warm cache returns an import-only graph to architecture

- **Attack:** a normal graph command populates the durable product; architecture
  then requests re-exports under the same key and silently receives the
  narrower graph.
- **Outcome:** **HOLE — repaired by step 2.** Both memory and durable identities
  include source-edge mode, and the fixture calls both modes on fresh
  connections (P6).

### A4. A moved consumer retains an old path

- **Attack:** one language parser or semantic consumer still imports
  `src/resolution`; local focused tests miss that language.
- **Outcome:** **HELD by step 1.** Typecheck plus an exact old-path scan covers
  every TypeScript consumer enumerated by P3.

### A5. Public API remains invisible

- **Attack:** the new collector reads only ordinary imports or unresolved
  re-exports, so `src/index.ts` still shows no dependency relationships.
- **Outcome:** **HELD by step 2.** The fixture exercises a resolved
  `export ... from`, and the live report must show the five public API
  relationships in P8.

### A6. The allow-list merely copies a stale estimate

- **Attack:** configuration is written from the pre-move table; relocation and
  re-export evidence change the actual rows, leaving forbidden or undeclared
  relationships.
- **Outcome:** **HELD by step 3.** The exact rows are derived from the rebuilt
  live graph, then `config-validate`, architecture, and diff-gate must all pass.

## Coverage Matrix

| Surface or lens | Attacks |
| --- | --- |
| Resolution consumers | A1, A4 |
| File-dependency product writer/reader | A2, A3 |
| Architecture callers | A2, A5 |
| Public API re-exports | A5 |
| Configuration enforcement window | A1, A6 |

## Validation Result

- `config-validate` reports no diagnostics.
- The rebuilt architecture graph maps 347/347 files across 14 boundaries,
  with 14/14 dependency rows, 56 allowed relationships, and zero forbidden,
  undeclared, reciprocal, or cyclic relationships.
- Focused resolution, dependency-graph, configuration, and architecture
  ratchet tests pass; the full suite passes 1,415/1,415 tests.
- Typecheck, lint, generated command documentation, build, cleanup verification,
  incomplete-migration, recent-duplicates, unused-params, architecture drift,
  and default diff-gate pass.
- The final reindex reused both unchanged TypeScript and Rust shards in 390 ms.
  The re-export-aware architecture product uses a separate durable identity;
  its verified warm graph read was a 2 ms cache hit. Default graph callers
  remain import-only.
- The background watcher is running against the canonical repository root with
  its Git worktree identity, and all linked-worktree watcher integration tests
  pass.
| Performance | A2, A3 |
| Data integrity/cache identity | A3 |
| Observability and future regression | A5, A6 |

## Execution and Ship Order

Steps 1-3 form one source/config change. Step 2 is independently safe but ships
with the ownership moves so the final allow-list is derived from the same
graph users will enforce. Step 3 is the only enforcement step and must remain
last. No database schema or public runtime API migration is involved.

## Verdict

A plan is `PLANNED-COMPLETE` iff every coverage row names an attack, every
attack has a cited defense or accepted reason, and no premise failed
reverification.

Result: **PLANNED-COMPLETE — 6 attacks, 3 holes repaired, 0 holes accepted.**
