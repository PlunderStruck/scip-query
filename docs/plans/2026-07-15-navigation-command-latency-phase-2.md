# Navigation Command Latency Phase 2 Plan — 2026-07-15

## Goal

Reduce warmed `code`, `outline`, and `refs` latency beyond the first verified
optimization pass while retaining the exact command output, index-freshness
guarantee, shared-generation side effects, and direct fallbacks used when the
watch service is absent or busy.

Done means three independently measurable changes are accepted or rejected:

1. one Git worktree context is reused within a CLI invocation;
2. an idle watcher may prove the current dirty-worktree database generation
   without a second project scan;
3. direct navigation invocations load only their command family instead of the
   full command catalog.

The Phase 2 baseline is the post-Phase-1 warmed scoreboard and startup sample in
[`docs/benchmarks/runs/2026-07-15-navigation-latency-after-warm-summary.json`](../benchmarks/runs/2026-07-15-navigation-latency-after-warm-summary.json).

## Current State

- `resolveCliProjectContext` already owns the project root, configuration,
  index paths, selected database, and fallback warning, but the CLI pre-action
  reconstructs part of that state and database opening resolves it again.
  Source: `scip-query code 'src/runtime/cli-context.ts:1-130'` and
  `scip-query plan-context src/runtime/cli.ts`.
- `prepareWorktreeIndex` calls `touchExistingWorktreeLease`, freshness, and one
  of the shared-generation preparation functions. Those shared functions each
  resolve Git context themselves. Source: `scip-query code
prepareWorktreeIndex`, `scip-query code touchExistingWorktreeLease`,
  `scip-query code prepareSharedGenerationForProject`, and `scip-query code
publishFreshLocalGenerationForProject`.
- Watch-service identity and the shared evidence path independently resolve Git
  identity after the pre-action. Source: `scip-query code
resolveWatchServiceIdentity`, `scip-query code resolveSharedEvidenceDbPath`,
  and `scip-query refs resolveGitWorktreeContext`.
- `getIndexFreshness` always builds the runtime project fingerprint when a
  database and metadata exist. That is still the dominant dirty-worktree cost.
  Source: `scip-query code getIndexFreshness`.
- The watch server persists source-watcher state after every transition and
  already knows when an atomic reindex completes, but it does not publish the
  resulting database-generation identity. Source: `scip-query code
'src/runtime/watch-server.ts:46-229'`, `scip-query code Watcher`, and
  `scip-query code publishedGenerationIdentity`.
- `cli.ts` statically imports the complete command descriptor catalog, and the
  query catalog statically imports every query-command family. Navigation then
  imports the public query barrel. Source: `scip-query plan-context
src/runtime/commands/command-descriptors.ts`, `scip-query code
'src/runtime/commands/query-command-specs.ts:1-180'`, and `scip-query code
'src/runtime/query-commands/navigation.ts:1-30'`.

## Reuse Audit

- Extend the existing `CliProjectContext`; do not add a parallel invocation
  context. Its real referents are the root, configuration, paths, selected
  database, and Git checkout used by one CLI command. It is a command-bound
  context whose essential property is that every downstream operation observes
  the same resolved checkout state.
- Extend the existing optional controller and shared-generation call shapes
  with a resolved `GitWorktreeContext`; do not cache Git state globally. Source:
  `scip-query refs WatchServiceControllerOptions`, `scip-query refs
prepareWorktreeIndex`, and `scip-query change-surface
src/runtime/git-worktree.ts --json --full`.
- Reuse `publishedGenerationIdentity` as the watcher freshness token. That
  token is a digest of the atomically published metadata generation; its
  defining function is to change whenever the database's indexed input
  generation changes. Source: `scip-query code publishedGenerationIdentity`.
- Extend `WatchServiceState` rather than creating a second service-state file.
  Source: `scip-query code WatchServiceState`, `scip-query code
writeWatchServiceState`, and `scip-query refs WatchServiceState`.
- Add one invocation descriptor loader and extract the three existing direct
  navigation descriptors because importing the existing complete
  descriptor module is itself the eager work being avoided. The loader selects
  either one independently backed navigation descriptor or the unchanged full
  catalog; it does not duplicate descriptor metadata. Source: `scip-query refs
navigationQueryCommandDescriptors` and `scip-query refs
queryCommandDescriptor`.
- Back the three extracted descriptors with direct imports from the existing
  navigation query modules; no query implementation is duplicated. Source:
  `scip-query plan-context src/queries/index.ts` and
  `scip-query plan-context src/runtime/query-commands/navigation.ts`.

## Testability Design

| Behavior                   | Test seam                                                | Dependencies to inject                      | Pure core                                     | Side-effect shell             | Contract                                                                                                                |
| -------------------------- | -------------------------------------------------------- | ------------------------------------------- | --------------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Invocation context reuse   | active-context setter plus `resolveCliProjectContext`    | resolved Git context                        | project-root match selects the active context | config and Git resolution     | one process command observes one immutable context; clearing restores normal resolution                                 |
| Shared and watch Git reuse | existing functions with optional resolved context        | Git context                                 | identity construction from matching context   | Git subprocess fallback       | supplied matching context is used; absent or mismatched context preserves current resolution                            |
| Watch freshness proof      | helper selecting a trusted generation from an inspection | watch state and current database generation | live + idle + matching generation decision    | state-file and metadata reads | any missing, busy, invalid, mismatched, or older state falls back to full fingerprinting                                |
| Generation publication     | `parseWatchServiceState` and watch integration state     | generation reader                           | optional token validation                     | watch state persistence       | token is present only for an idle successfully published generation                                                     |
| Lazy descriptor loading    | invocation descriptor loader                             | dynamic module imports                      | command-name scope selection                  | ESM dynamic import            | `code`, `outline`, and `refs` load exactly their existing descriptors; all other invocations load the unchanged catalog |

## Design Phases

### 2.1 — Reuse one project and Git context within the CLI invocation

- [x] **Files**: `src/runtime/cli-context.ts:20-114`,
      `src/runtime/cli.ts:21-60`, `src/reindex/shared-generation-store.ts:179-183,
364-488,606-671`, and `src/runtime/watch-service.ts:118-240`
- **Source**: `scip-query plan-context src/runtime/cli-context.ts`;
  `scip-query plan-context src/runtime/cli.ts`; `scip-query refs
resolveGitWorktreeContext`.
- **What**: Project config/path resolution and Git checkout resolution are
  repeated at the pre-action, shared-cache, watch-service, and database-open
  boundaries.
- **Change**: Add optional Git context to `CliProjectContext`; activate that
  context for the duration of a CLI action; pass it through shared-generation
  and watch controller calls; let database opening reuse it for the shared
  evidence path. All non-CLI and absent-context callers retain current fallback
  resolution.
- **Testability**:
  - Test seam: active-context lifecycle and context-accepting existing APIs.
  - Injected dependencies: pre-resolved `GitWorktreeContext`.
  - Pure core: project-root equality and watch identity projection.
  - Side-effect shell: Git/config/filesystem resolution.
  - Contract: no context survives a completed CLI action, and mismatched roots
    cannot reuse another checkout's identity.
- **Validation**: `tests/runtime/cli-context.test.ts`,
  `tests/runtime/watch-service.test.ts`, shared-generation tests, typecheck,
  and one warmed dirty before/after benchmark.
- **Why**: This removes accidental subprocess repetition before changing the
  freshness contract.

### 2.2 — Publish and consume an idle watcher generation proof

- [x] **Files**: `src/runtime/watch-service.ts:36-52,470-495`,
      `src/runtime/watch-server.ts:64-159`, `src/runtime/cli.ts:21-60`, and
      `src/runtime/cli-context.ts:51-62`
- **Source**: `scip-query code WatchServiceState`; `scip-query code
'src/runtime/watch-server.ts:46-229'`; `scip-query code
publishedGenerationIdentity`; `scip-query code getIndexFreshness`.
- **What**: A live watcher records idle/waiting/indexing transitions but the CLI
  cannot bind an idle state to the local database generation, so dirty commands
  still hash the full project.
- **Change**: Persist an optional database-generation identity only when the
  watcher is idle after a successful freshness check or reindex. Before shared
  preparation, inspect an already-live compatible watcher. When its token
  matches the local metadata generation and the resolved worktree is dirty,
  preserve the missed-lease side effect but skip `getIndexFreshness`. Every
  other state uses the existing path.
- **Testability**:
  - Test seam: trusted-generation selector and `prepareWorktreeIndex` hints.
  - Injected dependencies: parsed watch state and generation strings.
  - Pure core: compatibility, idle-state, and equality decision.
  - Side-effect shell: watch-state persistence and metadata reads.
  - Contract: a token is never trusted for clean publication, busy/error state,
    a dead watcher, a different worktree, or a different database generation.
- **Validation**: parser/state-machine tests, watch integration tests, a dirty
  fast-path test whose fingerprint inputs throw, and clean/dirty output hashes.
- **Why**: This targets the remaining 200-300 ms dirty-only scan without
  weakening cold start, clean sharing, or fallback behavior.

### 2.3 — Load only the invoked navigation command family

- [x] **Files**: new
      `src/runtime/commands/invocation-command-descriptors.ts`,
      `src/runtime/query-commands/direct-navigation.ts`,
      `src/runtime/cli.ts:1-21`, and
      `src/runtime/query-commands/navigation.ts:1-30`
- **Source**: `scip-query plan-context
src/runtime/commands/query-command-specs.ts`; `scip-query refs
navigationQueryCommandDescriptors`; `scip-query plan-context
src/runtime/query-commands/navigation.ts`.
- **What**: Static CLI imports instantiate the complete command/query graph
  before Commander parses a direct navigation invocation. The measured median
  is 165 ms for the full CLI versus 53 ms for a bare Node process.
- **Change**: Dynamically load exactly one existing navigation descriptor for
  direct `code`, `outline`, or `refs` entrypoint invocations. Imports, tests,
  help without a direct command, and every other command load the unchanged full
  catalog. Back the three extracted descriptors with direct existing query
  imports so their lazy chunk cannot retain cleanup/health families.
- **Testability**:
  - Test seam: invocation-scope selector and loader result.
  - Injected dependencies: command name and module loaders.
  - Pure core: fast-family versus full-catalog selection.
  - Side-effect shell: ESM imports and Commander registration.
  - Contract: selected descriptors retain identical command text, arguments,
    options, evidence metadata, documentation, and handler.
- **Validation**: descriptor/CLI contract tests, `code --help`, `refs --json`,
  full help, build chunk inspection, ten-run startup sample, and warmed command
  benchmark.
- **Why**: This attacks the verified 112 ms eager-bundle ceiling only after the
  behavioral startup path is stable.

## Stress-Test Findings

- Purpose: Full fingerprinting exists to prevent stale evidence; the watcher
  token substitutes only when an already-live watcher has published the exact
  local generation and reports no pending source work.
- Blast radius: `cli.ts` and `watch-server.ts` have no external consumers;
  `watch-service.ts`, `cli-context.ts`, and shared-generation APIs are medium to
  high risk and retain optional fallbacks. Source: their `scip-query
change-surface <file> --json --full` reports.
- Valid intermediate states: Phase 2.1 is deployable alone. Phase 2.2 is
  backward-compatible because old watcher states omit the token and fall back.
  Phase 2.3 changes loading only, not descriptor contents.
- Reversibility: Each phase is a two-way door and has its own benchmark row.
- Failure: Missing files, malformed state, dead services, generation mismatch,
  dynamic import failure, and non-Git projects follow existing fallback/error
  paths.
- Concurrency: Watch state invalidates the token synchronously on observed
  waiting/indexing transitions and republishes it only after atomic reindex
  completion. The current fingerprint path remains the fallback.
- Data integrity: No schema, SQLite rows, shared-generation manifest, or command
  output format changes. Watch state gains one optional field.
- Observability: Existing watcher status and shared-cache debug output remain;
  benchmark history records accepted and rejected paths.
- Human experience: Fast navigation commands keep their complete help and
  errors; general help still loads the complete catalog.

## Execution and Ship Order

1. Ship Phase 2.1 only if its warmed benchmark improves or holds latency with
   identical output.
2. Ship Phase 2.2 only if mutation tests prove busy/mismatched watcher states
   fall back and a real edit invalidates the proof before reindex.
3. Ship Phase 2.3 only if full CLI contract tests and direct navigation help are
   identical and actual command startup improves.

There are no one-way doors. An older watcher state and an older CLI both ignore
the optional generation proof safely.

## Verification Summary

- Phase 2.1 focused tests and typecheck passed.
- Phase 2.2 unit and worktree-watch integration tests passed; dirty warmed
  medians reached 463/295/348 ms for `code`/`outline`/`refs`, with identical
  output hashes.
- Phase 2.3 split the built CLI entry from roughly 1.09 MB to 4.6 KB. In nine
  alternating same-build trials, the lazy path beat forced full-catalog loading
  by 11/11/9 ms for `code`/`outline`/`refs`.

- Files to create: one invocation descriptor loader, one independently backed
  direct-navigation descriptor module, and focused benchmark run records.
- Files to edit: CLI context/startup, shared-generation context consumers,
  watch state/server, navigation imports, focused tests, and the optimization
  ledger.
- Files to delete: none.
- Final checks: focused suites, full test/lint/typecheck/build, relevant
  `unused-params`, `recent-duplicates`, `wrapper-candidates`, `co-change`, and
  doc-drift postchecks, then `scip-query reindex && scip-query diff-gate`.
