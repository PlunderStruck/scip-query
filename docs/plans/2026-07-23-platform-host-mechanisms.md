# Platform Host-Mechanism Extraction

Date: 2026-07-23

## Goal

Move reusable operating-system and cache-layout mechanisms below `runtime`
without changing observable behavior, persistent cache identity, process-lock
semantics, binary resolution, Git worktree identity, or the amount of work
performed by indexing and query hot paths.

Done means reindex and semantic code no longer import runtime for Git,
process-liveness, cache-lock, CLI-version, SCIP-binary, or cache-layout
operations; the moved implementations retain their call shapes; focused and
full tests pass; and the architecture graph shows only the separately deferred
watch-service protocol edge in each reverse direction.

## Definitions and Invariants

A host mechanism is a reusable operation over the operating system, filesystem,
process table, Git executable, installed package, or binary environment. The
referents are `isProcessAlive`, Git worktree resolution, token-owned file
locks, installed CLI version, SCIP binary resolution, and cache-path
calculation. What distinguishes these operations from runtime delivery is that
they provide facts or atomic capabilities without choosing a user command or
workflow. Source: `node dist/cli.js plan-context
src/runtime/process-liveness.ts --json`; `node dist/cli.js plan-context
src/runtime/git-worktree.ts --json`; `node dist/cli.js code
resolveScipBinary --json`.

A cache identity is the deterministic filesystem location by which all
processes recognize the same project or repository artifacts. Its referents
are the project-root SHA-256 prefix and the 24-character repository worktree
identity. What makes it an identity rather than a convenience path is that a
change would make existing artifacts, leases, and locks invisible to another
process. Source: `node dist/cli.js code
'src/runtime/config.ts:600-690' --json`; `node dist/cli.js code
'src/runtime/git-worktree.ts:1-290' --json`.

A process lock is a filesystem synchronization mechanism whose token and PID
prove which process may release a lock. The referent is
`acquireProcessFileLock`; its essential characteristic is that stale-owner
reclamation and release both compare the observed owner record before
unlinking. Source: `node dist/cli.js code
'src/runtime/repository-cache-lock.ts:1-220' --json`.

The following invariants must always hold:

- I1. A project root maps to the same cache, database, index, and metadata paths
  before and after the move.
- I2. A repository and worktree map to the same stable identities before and
  after the move.
- I3. A lock is acquired, reclaimed, waited on, and released iff the existing
  token/PID rules permit it.
- I4. SCIP binary resolution, installation, and version checks perform the
  same I/O in the same order.
- I5. Package version discovery executes once per module load and returns the
  same version from source and bundled layouts.
- I6. No moved operation gains an additional call, polling loop, filesystem
  read, Git process, hash calculation, or serialization step.
- I7. Platform may depend only on the stable `domain` contract boundary after
  this slice; runtime delivery remains above platform.

## Premises

- P1. `process-liveness.ts`, `git-worktree.ts`, and `cli-version.ts` have no
  internal dependencies; `repository-cache-lock.ts` depends only on process
  liveness; and `scip-cli.ts` depends only on the existing platform binary
  module. Source: `node dist/cli.js deps <each-file> --json` for the five
  files.
- P2. Process liveness has ten production consumers across reindex, runtime,
  and semantic. Git worktree identity has consumers across the same
  boundaries. These are shared host capabilities, not runtime command policy.
  Source: `node dist/cli.js plan-context
src/runtime/process-liveness.ts --json`; `node dist/cli.js plan-context
src/runtime/git-worktree.ts --json`.
- P3. The current `reindex -> runtime` relationship contains twelve file
  edges from three reindex importers to seven runtime files. The current
  `semantic -> runtime` relationship contains six file edges from four
  semantic importers to three runtime files. Source: `node dist/cli.js
architecture --json`.
- P4. The cache-layout functions are one contiguous implementation in
  `runtime/config.ts`: environment override, project `dbPath`, XDG/home
  fallback, canonical-root hash, repository path, shared-cache eligibility,
  and the four returned index paths. Source: `node dist/cli.js code
'src/runtime/config.ts:600-690' --json`.
- P5. The complete production readers of cache-layout behavior are
  `shared-generation-store`, runtime CLI/watch/hook/cache-lifecycle code, and
  the runtime public barrel. Source: `node dist/cli.js refs
automaticSharedCacheEnabled --json`; `node dist/cli.js refs
resolveDefaultCacheDir --json`; `node dist/cli.js refs
resolveRepositoryCacheDir --json`; `node dist/cli.js refs
resolveIndexStoragePaths --json`.
- P6. The complete production callers of the process lock are reindex
  generation/index code and runtime repository-cache lifecycle code. Source:
  `node dist/cli.js refs acquireProcessFileLock --json`.
- P7. `watchServicePaths`, `readWatchServiceState`, and the heartbeat constant
  are consumed directly by reindex and semantic requesters, but the parsed
  state also embeds runtime watcher state plus semantic and reindex service
  statuses. Moving that protocol safely is not a file move. Source:
  `node dist/cli.js refs watchServicePaths --json`; `node dist/cli.js refs
readWatchServiceState --json`; `node dist/cli.js code
parseWatchServiceState --json`.
- P8. Tests are not part of the current SCIP index, so test-path discovery
  uses the narrow filesystem fallback. It found focused coverage for process
  liveness, Git worktrees, SCIP CLI resolution, runtime config, repository
  cache lifecycle, shared generation/worktrees, TypeScript index mailboxes,
  watch service, and TypeScript semantic mailboxes. Source: `rg -l
"remote-provider|process-liveness|git-worktree|repository-cache-lock|scip-cli|resolveIndexStoragePaths|shared-generation-store|typescript-index-requester"
tests`.

### State-authority premises

- P9. Cache-directory creation and identity are authored only by the six
  contiguous cache-layout functions plus their private `ensureDir`; all
  readers are enumerated in P5. Source: P4; `node dist/cli.js refs ensureDir
--json`.
- P10. Process-lock records are written, reclaimed, and released only inside
  `repository-cache-lock.ts`; external files call its acquisition surface but
  do not write its token records. Source: `node dist/cli.js code
'src/runtime/repository-cache-lock.ts:1-220' --json`; P6.
- P11. Watch-service state is not an authority surface changed by this slice.
  Its writer, parser, and full validation remain in `runtime/watch-service.ts`.
  Source: `node dist/cli.js code parseWatchServiceState --json`; P7.

## Current State

Reindex and semantic import reusable host facts from the delivery-owned
`runtime` directory (P2, P3). Five of those files are already dependency-free
or depend only on platform peers (P1), so their directory ownership is the
only architectural defect. Cache layout is similarly mechanism code but is
embedded in the broader runtime configuration module (P4). The watch-state
edge is different: it crosses a persistent protocol with validators and
status types owned by three boundaries (P7), so combining it with mechanical
moves would enlarge the risk surface.

## Reuse Audit

- Reuse the five existing files and symbols unchanged; do not add wrappers,
  aliases, or replacement implementations (P1, P2).
- Extract the existing cache-layout block and its existing `ensureDir` helper
  into one named platform module; do not duplicate a second path algorithm
  (P4, P9).
- Reuse `ProjectConfig` as the cache-layout input contract. Platform will
  explicitly allow `domain` rather than inventing a structurally duplicate
  config type.
- Defer watch-state protocol extraction. A new partial parser would weaken the
  existing full-state validation, while moving the current parser would drag
  reindex and semantic protocol types into platform (P7, P11).

## Testability Design

| Behavior               | Test seam                             | Dependencies                    | Pure core                       | Side-effect shell               | Contract                    |
| ---------------------- | ------------------------------------- | ------------------------------- | ------------------------------- | ------------------------------- | --------------------------- |
| Process liveness       | `isProcessAlive`                      | `process.kill`                  | Existing result classification  | Existing signal probe           | Same boolean result         |
| Git/worktree identity  | Existing Git worktree unit tests      | Injected `GitReader`            | Existing parsers and stable IDs | Existing `spawnSync` reader     | Same context/identity       |
| Token-owned locks      | Repository-cache lifecycle tests      | Filesystem, PID liveness, clock | Existing record comparison      | Existing lock file I/O          | Same acquire/release result |
| SCIP binary resolution | `resolveScipBinaryPure` and CLI tests | PATH, env, filesystem, sidecar  | Existing resolution matrix      | Existing download/version shell | Same source/path            |
| Cache layout           | Runtime config and shared-cache tests | Environment, realpath, mkdir    | Existing path calculation       | Existing directory creation     | Same four paths             |
| Performance neutrality | Source diff plus lifecycle/full tests | None added                      | Same functions                  | Same call sites                 | No new operation or loop    |

## Implementation Checklist

### 1. Move dependency-free host modules to platform

- [x] **Files**: `src/runtime/process-liveness.ts`,
      `src/runtime/git-worktree.ts`, `src/runtime/repository-cache-lock.ts`,
      `src/runtime/scip-cli.ts`, `src/runtime/cli-version.ts`
- **Premises**: P1, P2, P3, P6, P10
- **Deployable**: no — part of the single-deploy import-migration group.
- **Change**: Git-move each file to `src/platform/`, preserve implementation,
  update its relative peer imports, and update every source/test importer and
  mock path. Move the three ownership-specific unit tests to
  `tests/platform/`.
- **Testability**: Existing exported functions and injected Git/binary seams
  remain unchanged; focused tests exercise the same symbols at their new
  paths.
- **Validation**: Typecheck; process-liveness, Git-worktree, SCIP-CLI,
  repository-cache, reindex-reliability, and shared-generation tests.

### 2. Extract the cache-layout block intact

- [x] **Files**: `src/runtime/config.ts`, new
      `src/platform/cache-layout.ts`, runtime/reindex importers, relevant tests,
      `src/runtime/index.ts`
- **Premises**: P4, P5, P9
- **Deployable**: no — part of the same import-migration group.
- **Change**: Move the six cache-layout functions and private `ensureDir`
  without altering branches, environment precedence, hash length, filenames,
  or directory creation. Internal consumers import the platform owner
  directly; the runtime public barrel re-exports the established public
  function.
- **Testability**: Existing config and shared-worktree tests remain the seam;
  no new dependency is injected and no extra wrapper call is introduced.
- **Validation**: Runtime-config, CLI-context, shared-generation,
  shared-worktree, watch-service, and repository-cache tests.

### 3. Update the declared platform dependency and architecture ledger

- [x] **Files**: `.scipquery.json`,
      `docs/architecture/scip-query-target-architecture.md`
- **Premises**: P3, P7
- **Deployable**: yes after steps 1-2.
- **Change**: Change the closed platform row from dependency-free to
  domain-only, record this slice as in progress, and explicitly leave the
  watch-state protocol edge for the next contract slice.
- **Validation**: Config validation, architecture graph, architecture drift,
  doc drift, and diff gate.

### 4. Verify behavior and efficiency preservation

- [x] **Files**: no production edit
- **Premises**: P1-P11
- **Deployable**: verification only.
- **Change**: Run focused tests, full suite, build, typecheck, lint, migration
  detectors, reindex, architecture report, and architecture-aware diff gate.
  Inspect the source diff to confirm moved implementations did not acquire new
  calls, loops, I/O, hashing, or serialization.
- **Validation**: Commands above; the full suite is the final behavioral
  oracle.

## Attack Record

### A1. I5 via bundled path resolution

- Attack: run source tests and then the bundled CLI after moving
  `cli-version.ts`; `createRequire(import.meta.url)` searches from a different
  directory and returns `0.0.0`.
- Outcome: HELD — runtime and platform are sibling directories at the same
  depth, and step 4 builds and invokes the bundle (P1).

### A2. I4 via stale mock paths

- Attack: reindex reliability mocks `src/runtime/scip-cli.ts`; reindex changes
  to the platform import, so the mock no longer intercepts installation and a
  test or production fallback runs real I/O.
- Outcome: HOLE — repaired by step 1, which updates all import and mock paths
  found by the migration search (P2, P8).

### A3. I1 via cache environment precedence

- Attack: a user sets `SCIP_QUERY_CACHE_DIR` while project config also has
  `dbPath`; extraction reorders the checks and changes which cache wins.
- Outcome: HELD — step 2 moves the contiguous implementation intact and the
  existing config tests exercise overrides (P4, P8, P9).

### A4. I3 via concurrent lock reclamation

- Attack: process A observes a dead owner while process B replaces the lock;
  moved code unlinks B's record.
- Outcome: HELD — step 1 preserves raw-record comparison and token-owned
  release exactly; lifecycle tests and the full suite rerun (P6, P10).

### A5. I6 via compatibility wrappers

- Attack: old runtime wrappers call new platform functions, adding an extra
  call at every cache-path and process-liveness use.
- Outcome: HELD — steps 1-2 update internal importers directly and retain only
  the compile-time public barrel re-export (P2, P5).

### A6. I7 via an undeclared platform dependency

- Attack: cache layout imports `ProjectConfig`, but platform remains closed
  with `[]`; the extraction introduces a forbidden edge.
- Outcome: HOLE — repaired by step 3, which declares platform's sole allowed
  dependency on stable domain contracts.

### A7. Completion claim via the deferred watch protocol

- Attack: the moved host utilities pass, but architecture still reports
  `reindex -> runtime` and `semantic -> runtime` through watch-state readers.
- Outcome: HOLE — accepted: P7 proves this is a distinct persistent-contract
  migration. Step 3 records the remaining edge and does not claim either
  reciprocal pair is fully resolved.

### A8. I1-I6 via unnoticed performance work

- Attack: an import rewrite also changes a polling interval, hash operation,
  cache filename, Git invocation, or serialization path while tests happen not
  to assert cost.
- Outcome: HELD — step 4 combines source-diff inspection with focused
  lifecycle tests, build, and full suite; the implementation steps prohibit
  logic edits (P1, P4, P7).

## Coverage Matrix

| Surface or lens                    | Attacks        |
| ---------------------------------- | -------------- |
| Cache-layout writers/readers (P9)  | A3, A5, A8     |
| Process-lock writers/readers (P10) | A4, A8         |
| Watch-state authority (P11)        | A7             |
| Valid intermediate state           | A2, A6         |
| Reversibility                      | A1, A2         |
| Failure behavior                   | A1, A3, A4     |
| Concurrency                        | A4             |
| Boundaries                         | A5, A6, A7     |
| Data integrity                     | A3, A4         |
| Efficiency                         | A5, A8         |
| Reuse                              | A5             |
| Testability                        | A2, A3, A4, A8 |

## Execution and Ship Order

Steps 1-2 are one import-migration group and are not independently shippable.
Step 3 records only policy supported by the completed moves. Step 4 must pass
before handoff. All changes are reversible file moves or extraction; no data
migration, cache invalidation, or persistent-format version change is allowed.

## Verdict

A plan is `PLANNED-COMPLETE` iff the coverage matrix has no blank rows, every
attack ends in a cited held outcome or a written accepted hole, and no premise
fails reverification.

Result: **PLANNED-COMPLETE** — 8 attacks, 2 holes repaired, 1 hole accepted.
The accepted hole is the explicitly deferred watch-service protocol edge; it
does not weaken behavior or enforcement in this slice.

## Completion Evidence

- Git recognizes all five host-module moves as 100% renames; no moved
  implementation line changed.
- The focused suite passed 147 tests, and the full suite passed 1,408 tests
  across 200 files.
- Build, typecheck, lint, formatting, configuration validation, and
  `git diff --check` passed.
- Reindex reused the TypeScript and Rust index in 0.4 seconds; the extraction
  did not invalidate persistent cache identity.
- The graph maps 342 of 342 files, reports zero forbidden relationships, and
  reduces both `reindex -> runtime` and `semantic -> runtime` to their one
  deferred watch-state edge.
- Incomplete migration, recent duplicate, similar-file, scoped cleanup,
  architecture drift, and target-document drift checks found no slice defect.
- The final architecture-aware diff gate exited 0 with no advisory findings.

## File Summary

- Move five runtime host modules to `src/platform/`.
- Add `src/platform/cache-layout.ts` by extraction.
- Move three ownership-specific tests to `tests/platform/`.
- Update importers, mocks, `.scipquery.json`, and the target architecture
  ledger.
- Delete no behavior and add no runtime wrapper or hot-path operation.
