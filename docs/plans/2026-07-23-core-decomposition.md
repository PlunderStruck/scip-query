# Core Decomposition Plan

Date: 2026-07-23

## Goal

Delete the accidental `src/core` package by moving each unit to the boundary
that owns its reason to change. Completion means query evidence orchestration
lives under `queries/internal`, regular-expression escaping lives with
source-pattern mechanisms, host executable and download behavior lives under a
closed `platform` boundary, every consumer follows the new owners, and the
rebuilt architecture graph contains neither a `core` boundary nor a forbidden
edge.

## Definitions and Invariants

A query evidence facade is an application module whose referents are
`ProjectIndex`, callable candidate selection, and the cleanup/navigation
queries that consume them. It is distinguished from a general-purpose core by
coordinating lower-level compiler evidence specifically for query use cases.
Source: `scip-query plan-context src/core`, `scip-query surface src/core`.

A source-pattern primitive is a dependency-free operation used to construct
safe regular expressions over source text, symbols, generated language text,
and detector patterns. Its immediate referent is `escapeRegex()`. It belongs
with source-text mechanisms because every consuming boundary already uses the
source subsystem and the operation changes only when text-pattern semantics
change. Source: `scip-query refs escapeRegex`, `scip-query code escapeRegex`,
`scip-query architecture --json`.

A host platform mechanism is technical code whose referents are executable
discovery, portable process invocation, cache-path selection, verified network
downloads, and atomic binary installation. It is distinguished by translating
host operating-system, filesystem, process, and network behavior without
owning a query, reindex, runtime-delivery, or TLA policy. Source:
`scip-query outline src/runtime/binary.ts`, `scip-query code binaryAvailable`,
`scip-query code fetchVerifiedBinary`.

A closed dependency row is an architectural rule whose listed targets are the
only internal boundaries its source may import. The `platform: []` row is
therefore a testable claim that host mechanisms depend only on external
runtime APIs. Source: `scip-query architecture --json`,
`scip-query config-validate --json`.

Invariants:

- I1. A file is in `queries/internal` iff its main responsibility is
  coordinating indexed evidence for query implementations.
- I2. `escapeRegex(value)` must always return the same escaped string for every
  input before and after relocation.
- I3. Executable lookup, portable command resolution, binary health checks,
  cache-path resolution, hash verification, and atomic installation must always
  retain their current observable behavior and injection seams.
- I4. Every existing `ProjectIndex`, callable-policy, regex, binary, and
  verified-fetch consumer must always resolve exactly one implementation after
  the move.
- I5. The public `ProjectIndex` export must always remain source-compatible.
- I6. `platform -> X` is allowed iff `X` is not an internal project boundary.
- I7. The migration is complete iff `src/core` has no files, the architecture
  model has no `core` boundary, and no import specifier refers to the old
  locations.

## Premises

- P1. `src/core` contains five files with three unrelated responsibilities:
  query evidence (`project-index.ts`, `production-callables.ts`), pattern
  escaping (`regex-utils.ts`), and host tooling (`command-availability.ts`,
  `verified-binary-fetch.ts`). Source: `scip-query system src/core`.
- P2. `ProjectIndex` is consumed primarily by 28 query files, with additional
  delivery consumers in `src/index.ts` and `src/runtime/cli-support.ts`; it
  coordinates analysis, source, storage, and symbol evidence. Source:
  `scip-query refs ProjectIndex`, `scip-query code
'src/core/project-index.ts:1-151'`.
- P3. `productionCallableDefinitions()` is owned by the `ProjectIndex` facade
  and detector policy; its direct external test consumer is
  `tests/queries/cleanup/unused-params.test.ts`. Source: `scip-query code
'src/core/production-callables.ts:1-145'`, `scip-query rdeps
src/core/production-callables.ts`.
- P4. `escapeRegex()` is a pure twelve-line module consumed by source,
  language-parser, symbol, semantic, query, runtime, and TLA modules; every one
  of those boundaries already has an observed dependency on `source`. Source:
  `scip-query refs escapeRegex`, `scip-query architecture --json`.
- P5. `src/runtime/binary.ts` already owns executable lookup and portable
  command resolution, and reindex imports it despite `runtime` being a delivery
  boundary. Source: `scip-query outline src/runtime/binary.ts`,
  `scip-query refs isBinaryAvailable`, `scip-query architecture --json`.
- P6. `binaryAvailable()` is not equivalent to `isBinaryAvailable()`:
  the former executes `<binary> --version` through an injectable spawn and
  checks its exit status, while the latter checks path discovery through
  `which` or `where`. Both are host executable capabilities and must remain
  separately named. Source: `scip-query code binaryAvailable`, `scip-query
code isBinaryAvailable`.
- P7. The complete readers of `binaryAvailable()` are
  `runtime/cleanup-verify.ts` and `tla/tool-runner.ts`; its only writer is its
  definition. Source: `scip-query refs binaryAvailable`.
- P8. The complete reader of `fetchVerifiedBinary()` and
  `resolveScipQueryCachePath()` is `tla/tool-runner.ts`; the fetch function is
  the sole writer of its configured cache path and preserves existing verified
  files or atomically renames a verified temporary file. Source: `scip-query
refs fetchVerifiedBinary`, `scip-query refs resolveScipQueryCachePath`,
  `scip-query code fetchVerifiedBinary`.
- P9. The existing focused tests are `tests/runtime/binary.test.ts`,
  `tests/core/verified-binary-fetch.test.ts`, and
  `tests/tla/tool-runner.test.ts`; query behavior is covered by the query test
  suite. Source: repository test paths plus `scip-query refs ProjectIndex` and
  `scip-query refs productionCallableDefinitions`.
- P10. `core` participates in reciprocal relationships with `source` and
  `symbols`; all eleven non-leaf boundaries currently occupy one strongly
  connected boundary group. Source: `scip-query architecture --json`.
- P11. The architecture configuration maps all 342 indexed files without
  ambiguity and currently closes `domain`, `instrumentation`, `rust-kernels`,
  and `storage`. Source: `scip-query architecture --json`.
- P12. `similar-files src/core/project-index.ts` produces no competing file
  with an overlapping dependency profile, while co-change evidence associates
  the facade with source/symbol evidence and query detector work rather than
  the other four `core` files. Source: `scip-query similar-files
src/core/project-index.ts --json --full`, `scip-query co-change src/core
--json --full`.

## Current State

The `core` name currently conceals three ownership decisions (P1). The query
facade's imports and consumers identify it as application-level query
infrastructure, not a dependency-free center (P2-P3). The regex primitive is
the reverse half of both `core/source` and `core/symbols` reciprocal traffic
(P4, P10). Host binary code is split between `core` and `runtime`, causing TLA
and reindex to depend on folders that own unrelated delivery policy (P5-P8).

No shared mutable application state changes in this migration. The only
side-effect state is the verified-binary cache, whose sole writer and complete
reader set remain behind the same functions (P8).

## Reuse Audit

- Extend and relocate `src/runtime/binary.ts`; do not create a second platform
  binary facade. It already owns executable and portable-command behavior
  (P5-P7).
- Relocate `verified-binary-fetch.ts` intact. No existing module provides its
  hash-verification and atomic-install contract (P8).
- Relocate `ProjectIndex` and `productionCallableDefinitions` together. Do not
  introduce compatibility forwarding files: all consumers are enumerable and
  can move atomically (P2-P3).
- Relocate the existing `escapeRegex()` implementation. Do not replace it with
  either same-named local implementation because those alternatives have
  narrower or locally specialized contracts (P4).

## Testability Design

| Behavior                       | Test seam                                          | Dependencies to inject              | Pure core                    | Side-effect shell                 | Contract                      |
| ------------------------------ | -------------------------------------------------- | ----------------------------------- | ---------------------------- | --------------------------------- | ----------------------------- |
| Query evidence facade          | Existing query APIs and `ProjectIndex` constructor | Existing `ScipDatabase`             | Existing selection/map logic | Existing DB/source evidence calls | Public `ProjectIndex` methods |
| Regex escaping                 | `escapeRegex(value)`                               | None                                | Entire function              | None                              | String to escaped string      |
| Executable health              | `binaryAvailable(binary, spawn)`                   | Spawn implementation                | Exit-status decision         | Injected spawn                    | Boolean availability          |
| Portable executable resolution | Existing binary tests                              | Lookup function and platform        | Command selection            | Path/process lookup               | `PortableCommand`             |
| Verified download              | `fetchVerifiedBinary(options)`                     | Fetch implementation and cache path | SHA-256 comparison           | Filesystem/network shell          | Cached/downloaded result      |
| Architecture ownership         | `architecture --json`                              | Compiler index and config           | Boundary classification      | Index/config reads                | Zero forbidden edges          |

## Implementation Steps

### 1. Establish the host-platform boundary

- [x] **Files**: `src/runtime/binary.ts`,
      `src/core/command-availability.ts`,
      `src/core/verified-binary-fetch.ts`, all importers, and platform tests
- **Premises**: P5-P9
- **Deployable**: part of single-deploy group `core-decomposition`
- **Change**: Move `runtime/binary.ts` to `platform/binary.ts`, merge the
  separately named `binaryAvailable()` capability and injection type into that
  file, move verified fetching to `platform/verified-binary-fetch.ts`, and
  update every runtime/reindex/TLA/test importer. Move the verified-fetch test
  to `tests/platform`.
- **Testability**: retain every existing injection seam and run the three
  focused binary/TLA test files.
- **Validation**: typecheck plus focused tests.

### 2. Move the query facade to its consumers

- [x] **Files**: `src/core/project-index.ts`,
      `src/core/production-callables.ts`, their complete importer set, and
      related tests
- **Premises**: P1-P3, P12
- **Deployable**: part of single-deploy group `core-decomposition`
- **Change**: Move both modules to `src/queries/internal`, repair their deeper
  imports, update query consumers to local/internal paths, and preserve the
  public export from `src/index.ts` without a forwarding compatibility file.
- **Testability**: existing `ProjectIndex` constructor and query public APIs;
  no new seam.
- **Validation**: query tests, typecheck, `incomplete-migration`.

### 3. Move the source-pattern primitive

- [x] **Files**: `src/core/regex-utils.ts` and every importer
- **Premises**: P1, P4, P10
- **Deployable**: part of single-deploy group `core-decomposition`
- **Change**: Move the module to `src/source/regex-utils.ts` and update every
  source, parser, query, semantic, symbol, runtime, and TLA importer.
- **Testability**: unchanged pure function exercised transitively; add no
  wrapper.
- **Validation**: typecheck, query/source/TLA tests, `recent-duplicates`.

### 4. Replace the accidental boundary with an enforced leaf

- [x] **Files**: `.scipquery.json`, target architecture document
- **Premises**: P10-P11
- **Deployable**: yes after steps 1-3
- **Change**: Delete the empty `core` directory, replace its descriptive
  boundary with `platform`, close `platform` with an empty dependency row, and
  update the architecture record using the rebuilt graph.
- **Testability**: configuration validation and compiler-resolved architecture
  query.
- **Validation**: `config-validate`, reindex, `architecture --json`,
  `drift --architecture`, and default `diff-gate`.

## Counterexample Attacks

### A1. Duplicate executable abstraction

- Attack: a maintainer moves `command-availability.ts` to a new platform file
  while leaving `runtime/binary.ts`; reindex and runtime now choose different
  executable policies.
- Outcome: HOLE — repaired by step 1 merging both separately named behaviors
  into the relocated existing binary module (P5-P7).

### A2. Binary semantics collapsed

- Attack: the migration replaces `binaryAvailable()` with
  `isBinaryAvailable()`; a binary exists on `PATH` but exits nonzero for
  `--version`, and cleanup verification incorrectly treats it as runnable.
- Outcome: HELD — step 1 preserves both contracts and the injected spawn
  (P6-P7).

### A3. Cache corruption during relocation

- Attack: a download returns bytes with the wrong checksum, then a second run
  observes the cache path.
- Outcome: HELD — step 1 relocates the existing checksum-before-write and
  atomic-rename implementation intact (P8).

### A4. Public API break

- Attack: an external library consumer imports `ProjectIndex` from the package
  root after the internal file move.
- Outcome: HOLE — repaired by step 2 updating the root export directly instead
  of deleting or forwarding it (P2, I5).

### A5. Partial import migration

- Attack: one of the 29 query importers or the test-only callable importer
  retains `core/...`; compilation or test discovery follows a deleted path.
- Outcome: HELD — steps 2-3 update the complete reference sets and validate
  with typecheck, `incomplete-migration`, and an old-path search (P2-P4).

### A6. Cosmetic architecture replacement

- Attack: `core` is renamed `platform` while query and source code remain
  inside it, reproducing the same package deal under a cleaner word.
- Outcome: HELD — steps 1-3 classify by responsibility before step 4 adds the
  platform boundary (P1, P10).

### A7. Unenforced new leaf

- Attack: platform is added descriptively but no dependency row is closed; a
  later platform module imports runtime policy without a gate failure.
- Outcome: HOLE — repaired by step 4 adding `platform: []` in the same change
  that introduces the boundary (P11, I6).

### A8. Regex move creates a new boundary pair

- Attack: after moving `escapeRegex()` to `source`, a consumer creates a
  previously absent dependency on source and expands the cycle.
- Outcome: HELD — P4 establishes that every consuming boundary already depends
  on source; the rebuilt graph in step 4 verifies this premise.

### A9. Tests preserve obsolete ownership

- Attack: production files move but `tests/core/verified-binary-fetch.test.ts`
  remains, teaching future maintainers that core is still an owner.
- Outcome: HOLE — repaired by step 1 moving that test to `tests/platform`
  (P9, I7).

| Surface or lens                                | Attacks    |
| ---------------------------------------------- | ---------- |
| `ProjectIndex` definition and consumers        | A4, A5, A6 |
| Callable-policy definition and consumers       | A5, A6     |
| `escapeRegex` definition and consumers         | A5, A8     |
| `binaryAvailable` definition and readers       | A1, A2, A5 |
| Existing runtime binary definition and readers | A1, A2     |
| Verified cache writer and TLA reader           | A3, A5, A9 |
| Public API                                     | A4         |
| Valid intermediate state                       | A5, A7     |
| Boundary ownership                             | A6, A8     |
| Reversibility and failure                      | A2, A3, A5 |
| Reuse                                          | A1, A6     |
| Testability                                    | A2-A5, A9  |

## Execution and Ship Order

Steps 1-3 form one deployable file-move group because no compatibility wrappers
will preserve the accidental paths. Step 4 follows only after typecheck proves
all imports moved. The changes are reversible by moving the same implementations
and import specifiers back; there is no data migration or public API removal.

## Verdict

A plan is `PLANNED-COMPLETE` iff every state writer and reader appears in the
coverage matrix, every attack has a cited outcome, the new platform row has no
enforcement window, and the source-producing premises still reproduce.

Result: **PLANNED-COMPLETE** — 9 attacks, 4 holes repaired, 0 holes accepted;
no blank coverage rows or unresolved premises.

## Change Summary

- Move and merge: `src/runtime/binary.ts` and
  `src/core/command-availability.ts` -> `src/platform/binary.ts`.
- Move: `src/core/verified-binary-fetch.ts` ->
  `src/platform/verified-binary-fetch.ts`.
- Move: query facade files -> `src/queries/internal`.
- Move: `src/core/regex-utils.ts` -> `src/source/regex-utils.ts`.
- Move: verified-fetch test -> `tests/platform`.
- Edit: every enumerated importer, `.scipquery.json`, and architecture docs.
- Delete: the empty `src/core` and `tests/core` directories.
