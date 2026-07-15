# Navigation Command Latency Phase 3 Plan — 2026-07-15

## Goal

Reduce the remaining warmed startup cost of direct `code`, `outline`, and
`refs` invocations without changing command registration, output bytes,
analysis-budget behavior, profiling behavior, freshness checks, or watcher
coordination.

The acceptance baseline is the eleven-run dirty-worktree sample in
`docs/benchmarks/runs/2026-07-15-navigation-latency-phase-3.jsonl`: 150 ms for
`code --help`, 265 ms for `code`, 244 ms for `outline`, and 317 ms for `refs`.
The built entry is 4,737 bytes but statically imports a 716,008-byte shared
runtime chunk.

## Current State

- `cli.ts` dynamically selects one direct-navigation descriptor, but its static
  dependencies still include `cli-support.ts`, `evidence-cache.ts`, CLI
  context, watch service, and repository-cache lifecycle. Source:
  `scip-query plan-context src/runtime/cli.ts`.
- `direct-navigation.ts` depends on the shared command-execution module, and
  `command-execution.ts` imports `commandAnalysisBudget` and
  `renderHeuristicNotice` from `cli-support.ts`. Source:
  `scip-query plan-context src/runtime/query-commands/direct-navigation.ts` and
  `scip-query code 'src/runtime/commands/command-execution.ts:1-120'`.
- `cli-support.ts` imports the complete query barrel plus semantic, health,
  evidence, and graph subsystems even though the direct path needs only one
  notice renderer and the small-index budget decision. Source:
  `scip-query code 'src/runtime/cli-support.ts:1-95'` and
  `scip-query code 'src/runtime/cli-support.ts:160-230'`.
- The budget decision calls `queries.stats`, whose actual referent is four
  SQLite count queries plus database-file stats in
  `src/queries/navigation/stats.ts`. Source: `scip-query code stats` and
  `scip-query plan-context src/queries/navigation/stats.ts`.
- Profile workload identity imports `projectEvidenceFingerprint` before the CLI
  knows whether profiling is enabled, although the fingerprint is used only
  after the profile-enabled guard. Source: `scip-query plan-context
src/runtime/cli.ts` and `scip-query code
'src/runtime/cli.ts:90-110'`.
- A tsup metafile for the current built graph attributes 715,966 bytes to the
  shared chunk; its largest inputs include diff-gate, similarity, TypeScript
  semantics, health, shared-generation, and CLI-support modules. This is build
  evidence, not a compiler graph fact.
- A direct `code` invocation launches six synchronous Git processes: five
  `rev-parse` lookups for the worktree root, Git directory, common directory,
  commit, and tree, followed by one dirty-worktree status. Twenty-one-run
  medians total 76.3 ms. A batched metadata lookup is one `git rev-parse`
  process returning those five facts; it is a process-consolidation change,
  distinguished by preserving the same repository facts while paying Git
  startup once. Source: `NODE_DEBUG=child_process node dist/cli.js code
findFirstSymbolMatch` and the per-command spawn benchmark recorded during
  this campaign.

## Reuse Audit

- Extend `command-execution.ts` with the existing analysis-budget and
  heuristic-notice definitions. It is the execution-policy module already used
  by every descriptor family, and it is the only direct-navigation consumer of
  these policies. Creating a parallel fast-path policy would duplicate behavior
  and risk output drift. Source: `scip-query plan-context
src/runtime/commands/command-execution.ts`, `scip-query refs
commandAnalysisBudget`, and `scip-query refs renderHeuristicNotice`.
- Import the existing `stats` query directly from
  `src/queries/navigation/stats.ts`; do not reproduce its SQLite queries.
  Source: `scip-query code stats` and `scip-query refs
isLargeCommandIndex`.
- Keep `cli-support.ts` as the owner of health and isolated-analysis behavior;
  remove only definitions whose consumers already belong to command execution.
  Source: `scip-query change-surface src/runtime/cli-support.ts --json --full`.
- Reuse dynamic ESM loading already established by
  `loadInvocationCommandDescriptors` for the profile-only evidence module; no
  new loader or configuration flag is justified. Source: `scip-query
plan-context src/runtime/cli.ts`.
- Reuse `GitReader.runResult`, the existing canonical-path and stable-ID
  behavior, and the current individual lookup sequence as a compatibility
  fallback. Do not add a Git cache: repository facts can change between CLI
  invocations, while one multi-argument `rev-parse` can obtain the immutable
  snapshot facts within a single process. Source: `scip-query plan-context
src/runtime/git-worktree.ts` and `scip-query change-surface
src/runtime/git-worktree.ts --json --full`.

## Testability Design

| Behavior                    | Test seam                                                 | Dependencies to inject           | Pure core                           | Side-effect shell                       | Contract                                                                                   |
| --------------------------- | --------------------------------------------------------- | -------------------------------- | ----------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------ |
| Analysis-budget relocation  | existing `commandAnalysisBudget` tests and direct imports | `ScipDatabase` fixture           | threshold and disclosure selection  | SQLite counts and stderr notice         | identical budget object, threshold, and text                                               |
| Heuristic notice relocation | existing renderer tests                                   | console spy                      | exact notice formatting             | console output                          | byte-identical notice                                                                      |
| Profile-only loading        | CLI import and profile tests                              | profile environment and database | enabled/identity guard              | dynamic module import and database read | disabled profiling never loads evidence fingerprint; enabled profiling preserves identity  |
| Bundle acceptance           | tsup metafile and CLI smoke commands                      | built artifacts                  | output graph comparison             | build and process startup               | direct entry loads no full query/health catalog; general commands still do                 |
| Runtime acceptance          | eleven-run harness and output hashes                      | fixed arguments and idle watcher | median comparison and hash equality | process spawn, filesystem cache, SQLite | keep only measured wins with identical stdout                                              |
| Git lookup consolidation    | injected `GitReader` plus real linked-worktree tests      | Git command results              | five-line metadata parser           | two Git process launches                | normal paths use two Git processes; malformed or unsupported output preserves old behavior |

## Design Phases

### 3.1 — Move command policy out of the broad support catalog — rejected

- [x] **Files**: `src/runtime/commands/command-execution.ts:1-95,277-305`,
      `src/runtime/cli-support.ts:160-225`, `src/runtime/cli.ts:1-5,107-110`,
      `src/runtime/query-commands/impact.ts`, and
      `src/runtime/query-commands/cleanup/handlers.ts`
- **Source**: `scip-query code
'src/runtime/commands/command-execution.ts:1-120'`; `scip-query code
'src/runtime/cli-support.ts:160-230'`; `scip-query refs
renderHeuristicNotice`; `scip-query refs commandAnalysisBudget`.
- **What**: Two small execution policies force direct navigation through the
  complete CLI-support dependency graph.
- **Change**: Move the existing notice, budget types, threshold decision,
  budget selection, and disclosure formatter into `command-execution.ts`.
  Replace the query-barrel call with a direct import of the existing `stats`
  query. Update every consumer to the new owner and remove the old definitions.
- **Testability**:
  - Test seam: existing exported functions and CLI contract tests.
  - Injected dependencies: existing SQLite fixture and console spies.
  - Pure core: threshold/budget selection and formatting.
  - Side-effect shell: SQLite stats and console output.
  - Contract: return objects and rendered text remain identical.
- **Validation**: focused CLI-support, command-contract, query-output, and
  direct-command tests; typecheck; build metafile; output hashes; eleven-run
  benchmark.
- **Why**: This removes the verified dependency edge without inventing a
  fast-path implementation.

### 3.2 — Defer profile-only evidence initialization — rejected

- [x] **File**: `src/runtime/cli.ts:40-107`
- **Source**: `scip-query plan-context src/runtime/cli.ts` and `scip-query code
'src/runtime/cli.ts:90-110'`.
- **What**: The profile fingerprint implementation is statically loaded for
  ordinary commands but used only when profiling is enabled and lacks an
  initialized workload identity.
- **Change**: Make profile initialization asynchronous, preserve the existing
  early guard, and dynamically import `projectEvidenceFingerprint` only after
  that guard. Await initialization from both pre-action branches.
- **Testability**:
  - Test seam: existing profile context behavior and CLI subprocess smoke.
  - Injected dependencies: profile environment already controls the guard.
  - Pure core: enabled/already-initialized decision.
  - Side-effect shell: dynamic import, database open, fingerprint read.
  - Contract: profile identity and first-run tolerance remain unchanged.
- **Validation**: profile tests, direct and full CLI tests, build metafile, and
  separate before/after benchmark.
- **Why**: It removes cold initialization that ordinary navigation commands
  cannot use. Reject this phase if it does not improve the measured workload.

### 3.3 — Consolidate repository metadata lookups — accepted

- [x] **Files**: `src/runtime/git-worktree.ts` and
      `tests/runtime/git-worktree.test.ts`
- **Source**: `scip-query plan-context src/runtime/git-worktree.ts`,
  `scip-query change-surface src/runtime/git-worktree.ts --json --full`, and
  the six-process `NODE_DEBUG=child_process` trace.
- **What**: Five immutable repository facts are fetched by five sequential
  `git rev-parse` processes before every direct command.
- **Change**: Request the root, Git directory, common directory, `HEAD`, and
  `HEAD^{tree}` in one `rev-parse` call, validate the five-line result, and run
  the existing status command separately. Fall back to the current individual
  sequence when Git cannot provide an unambiguous five-field response, such as
  an unborn repository or a path containing a newline.
- **Testability**:
  - Test seam: existing injectable `GitReader`.
  - Injected dependencies: batched output, fallback output, and status.
  - Pure core: strict five-field parsing and context construction.
  - Side-effect shell: Git process execution.
  - Contract: worktree/repository identities, OIDs, clean state, non-Git
    behavior, and linked-worktree behavior remain exact.
- **Validation**: Git unit/integration tests, process-count trace, typecheck,
  output hashes, and an eleven-run benchmark.
- **Why**: Measured process startup is a dominant direct-command cost, and this
  removes four launches without caching mutable repository state.

### 3.4 — Stop at the next proven boundary

- [x] **Files**: benchmark history and this plan
- **Source**: post-change tsup metafile plus `scip-query plan-context` for the
  largest remaining direct-path module.
- **What**: Further splitting can increase module count and maintenance cost
  while saving only parser noise.
- **Change**: Record accepted and rejected phases, remaining chunk composition,
  and the next concrete bottleneck. Do not continue splitting without a new
  dominant source edge and a falsifiable benchmark threshold.
- **Testability**:
  - Test seam: machine-readable run history.
  - Injected dependencies: fixed workload and build graph.
  - Pure core: median and byte-delta comparison.
  - Side-effect shell: builds and spawned CLI processes.
  - Contract: output hashes and full CLI surface remain exact.
- **Validation**: full tests, lint, typecheck, build, routed postchecks,
  `scip-query reindex`, and `scip-query diff-gate`.
- **Why**: The optimization campaign remains evidence-bounded rather than
  turning into open-ended module churn.

## Stress-Test Findings

- Purpose: `cli-support.ts` groups health, diff-impact, semantics, and command
  presentation for historical convenience. Only the presentation/budget
  definitions move; health and isolated-process behavior stays intact.
- Blast radius: `command-execution.ts` is high risk with many descriptor
  consumers, so behavior is relocated verbatim and covered by full CLI contract
  tests. `cli.ts` has no external consumers. Source: their `scip-query
change-surface <file> --json --full` results.
- Valid intermediate state: Phase 3.1 and Phase 3.2 each build and run
  independently.
- Reversibility: both are two-way doors; a phase that misses its benchmark is
  reverted before proceeding.
- Failure: dynamic import failure occurs only after profiling is explicitly
  enabled and follows the existing first-index tolerance path.
- Concurrency: no persisted or shared mutable state changes.
- Data integrity: no SQLite schema, index metadata, watcher protocol, command
  descriptor, or shared-generation format changes.
- Observability: existing notices, profile records, and errors remain the
  contract; output hashes and focused snapshots detect drift.
- Human experience: direct help and command output remain identical; general
  help and every non-direct command still load the complete descriptor catalog.
- Phase 3.1 decision: rejected and unwound. Its direct support graph shrank from
  716,008 bytes to 355,822 bytes, but `code --help` improved only 3 ms and only
  one real command cleared 10 ms.
- Phase 3.2 decision: rejected and unwound. Disabled-profile startup gained no
  credible runtime improvement and its static support graph grew by 860 bytes.
- Phase 3.3 decision: accepted. The normal path fell from six Git processes to
  two; controlled same-build median savings were 38 ms for `code`, 127 ms for
  `outline`, and 60 ms for `refs`, with identical output hashes.

## Execution and Ship Order

1. Implement and measure Phase 3.1 alone. Keep it only if `code --help` improves
   by at least 15 ms and at least two real commands improve by at least 10 ms
   without output drift.
2. Implement and measure Phase 3.2 separately. Keep it only if it removes a
   visible build input or improves a real-command median by at least 5 ms.
3. Implement and measure Phase 3.3 after restoring rejected candidates. Keep it
   only if the direct path drops from six Git processes to two and at least two
   real-command medians improve by 25 ms without output drift.
4. Run full verification only after all decisions are recorded.

No phase is a one-way door.

## Verification Summary

- Files created: this plan and the Phase 3 machine-readable run history.
- Files edited for the accepted phase: Git worktree context, its tests,
  benchmark history, and the optimization ledger. Both rejected candidate code
  paths were unwound before final verification.
- Files to delete: none.
- Focused verification: 31 Git/worktree/cache/watcher tests passed before the
  final edge-case test; the final Git suite includes explicit batched,
  ambiguous-output fallback, unborn-repository, linked-worktree, and dirty-state
  coverage.
- Full verification: 197 test files and 1,394 tests passed; lint, typecheck, and
  build passed.
- Routed postchecks: `incomplete-migration`, `recent-duplicates`,
  `unused-params`, and `wrapper-candidates` returned no findings;
  `cleanup-plan --verify` returned no batches; Git-context co-change and ledger
  doc-drift returned no findings. CLI co-change results were historical
  broad-sweep associations and did not identify an omitted contract change.
- Final repository gate: `scip-query reindex` reused the unchanged index in 0.4
  seconds, and `scip-query diff-gate --json --full` passed with zero findings.
