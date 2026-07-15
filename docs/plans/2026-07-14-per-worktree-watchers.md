# Per-worktree watcher isolation plan

**Date:** 2026-07-14

**Status:** Implemented and verified on 2026-07-14

## Goal

Make the background watcher an explicit property of one Git worktree: every checkout that uses the default managed cache starts or reuses only a watcher bound to that checkout, observes only that checkout's files and Git state, and refreshes only that checkout's writable cache. A Git worktree is a filesystem checkout that shares a repository's object database with sibling checkouts while retaining its own `HEAD`, index, and working files. A watcher is a long-lived process whose defining responsibility is to translate changes in exactly one such checkout into refreshed index artifacts in exactly one writable cache.

Done means:

- The first watcher-eligible command in each worktree starts or reuses a daemon identified by that worktree's Git identity, not merely by an assumed primary checkout.
- Two linked worktrees at the same commit have different watcher lifecycle files, processes, project roots, and writable output paths.
- A source edit in one worktree is watched from that worktree root and its reindex child receives only that worktree's `index.scip` and `index.db` paths.
- A watcher state produced for another worktree is incompatible and replaced rather than reused, even if a cache directory is accidentally presented with the wrong project root.
- The behavior remains generic to Git worktrees. Conductor requires no special integration.
- Explicit `SCIP_QUERY_CACHE_DIR` and `dbPath` overrides retain their existing opt-out semantics; users who deliberately point multiple worktrees at one mutable cache remain responsible for that override.

## Current state

1. `resolveDefaultCacheDir()` canonicalizes and hashes the absolute project root into `~/.cache/scip-query/projects/<path-hash>`. Default-managed linked worktrees therefore already receive distinct cache directories. Source: `scip-query code resolveDefaultCacheDir` (`src/runtime/config.ts:514-523`).
2. `watchServicePaths()` puts `watch.lock`, `watch-state.json`, and `watch-activity.json` inside that cache. The lifecycle boundary is therefore path-local, but the persisted state identifies only `projectRoot` and CLI version, not the Git worktree identity. Sources: `scip-query code watchServicePaths`, `scip-query plan-context WatchServiceState` (`src/runtime/watch-service.ts`).
3. `ensureWatchServiceForCommand()` runs for watcher-eligible commands when `watch.enabled` is true and delegates to `ensureWatchService()` with the current command's project root and cache. Source: `scip-query code ensureWatchServiceForCommand` (`src/runtime/watch-service.ts`).
4. `runWatchServiceServer()` resolves the exact project root, derives index and mailbox paths from it, and constructs `Watcher` with that root. Source: `scip-query code runWatchServiceServer` (`src/runtime/watch-server.ts`).
5. `Watcher.start()` observes the exact project root, while `Watcher.runReindex()` reloads configuration for that root and passes its resolved SCIP and SQLite paths to the child process. This is the correct isolation mechanism, but its child-process output contract is embedded in a private method and has no linked-worktree regression test. Sources: `scip-query plan-context Watcher`, `scip-query code Watcher.runReindex` (`src/runtime/watch.ts`).
6. `resolveGitWorktreeContext()` already derives a stable `worktreeId` from the checkout root and Git directory and is used by shared-generation leases. Watcher identity should reuse that definition without paying for the context resolver's unrelated `HEAD`, tree, and dirty-status reads. Source: `scip-query code resolveGitWorktreeContext` (`src/runtime/git-worktree.ts`).

## Reuse audit

| Proposed unit               | Decision                                                                                                | Evidence and reason                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Worktree identity           | Extract `resolveGitWorktreeIdentity()` from `resolveGitWorktreeContext()` and reuse it in both callers  | The ID still has one definition based on the canonical checkout root and Git directory, while watcher inspection avoids the full snapshot resolver's unrelated status work.                          |
| Cache and service paths     | Reuse `resolveIndexStoragePaths()` and `watchServicePaths()` unchanged                                  | These existing functions already provide a distinct default cache and lifecycle namespace for each absolute worktree root.                                                                           |
| Watcher process controller  | Extend `ensureWatchService()` and `classifyWatchServiceState()`                                         | They already own reuse/replacement decisions. A parallel worktree watcher manager would duplicate process coordination.                                                                              |
| Reindex child configuration | Keep `Watcher.runReindex()` as the single existing builder and strengthen its direct child-process test | The private method already has a deterministic mocked-`fork` seam. Exporting a production helper solely for tests would enlarge the API without adding reuse.                                        |
| User diagnostics            | Extend the existing `watch status` report                                                               | It is already the aggregation boundary for watcher lifecycle state; a new command is unnecessary.                                                                                                    |
| Git index path resolution   | Export and reuse the existing `resolveGitPath()`                                                        | It already converts Git paths relative to the command's project directory while preserving absolute linked-worktree paths; duplicating that rule in the watcher would create a second path contract. |
| Missing-Git classification  | Extend `runGitCommand()` with its existing control-metadata proof                                       | The current filesystem walk is already the fail-closed distinction between a deliberate non-Git directory and a damaged checkout; no new identity mode is needed.                                    |

## Testability

| Boundary                 | Test seam                                                                                  | Contract                                                                                                                                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Daemon compatibility     | `classifyWatchServiceState()`                                                              | A live state with a different Git worktree ID is incompatible even when other strings match. Old protocol states are rejected through the protocol-upgrade path.                                       |
| Reindex target selection | Existing `Watcher.runReindex()` mocked-child seam                                          | The child project root and both output files derive from the same worktree root and configuration.                                                                                                     |
| Multi-worktree startup   | Real temporary Git repository plus linked worktree and injected watcher runtime            | Ensuring both roots starts two processes, writes two state files, and never signals or reuses the sibling process.                                                                                     |
| Default cache isolation  | `resolveIndexStoragePaths()` under a temporary `XDG_CACHE_HOME`                            | Primary and linked roots resolve different cache, SCIP, SQLite, state, and lock paths.                                                                                                                 |
| Git identity failure     | `resolveGitWorktreeIdentity()` and `resolveWatchServiceIdentity()`                         | A successful probe yields a required worktree ID, a confirmed non-Git directory yields an explicit non-Git identity, and any other Git failure aborts before daemon reuse.                             |
| File-event isolation     | Two real `Watcher.start()` instances rooted at temporary linked worktrees                  | Editing one checkout causes only that checkout's watcher to fork a reindex child, with that checkout's project, SCIP, and SQLite paths.                                                                |
| Protocol migration       | `ensureWatchService()` with an injected runtime and seeded protocol-3 files                | The old process is stopped, its state/activity/lock files are absent before spawn, and the replacement publishes protocol 4.                                                                           |
| Path-alias reuse         | Real Git worktree, symbolic-link alias, default cache resolver, and injected runtime       | Starting through the alias and ensuring through the canonical path shares one cache and reuses one daemon whose persisted and spawned project root is canonical.                                       |
| Git control evidence     | Real temporary directory with an empty `.git` control directory                            | A Git “not a repository” diagnostic is accepted as non-Git only when no `.git` entry exists in the directory or any ancestor; present or unreadable control metadata fails closed.                     |
| TypeScript alias clients | Existing semantic and incremental-index mailbox requesters with a symbolic-link root       | Both requesters normalize their caller root through the same canonical-path primitive as watcher identity and complete a real mailbox request against canonical daemon state.                          |
| Lock-only status         | `handleWatch({ status: true })` with a real Git checkout and live foreground lock          | JSON and human output include the canonical project root and checkout-specific worktree ID even before daemon state exists.                                                                            |
| Nested project identity  | Linked Git worktrees with the configured project rooted in a nested `src` directory        | Canonical alias reuse preserves the nested project root for cache, state, watcher, and reindex paths while deriving the checkout ID from the enclosing Git worktree.                                   |
| Portable source refresh  | Two public `Watcher.start()` instances with long Git polling and ordinary unstaged edits | Chokidar's real source subscriptions observe each checkout independently and launch children with only that checkout's project, SCIP, and SQLite paths.                                                 |
| Subscription isolation   | Two real source subscriptions followed by an edit to only the linked checkout            | Exactly one child is launched for the linked checkout, so the test fails if both watchers accidentally subscribe to the same root.                                                                    |
| Primary index resolution | Two nested watchers exercising only `startGitStatePolling()`                              | Staging in the nested primary project resolves Git's relative index path against that project and triggers only the primary child; staging in the linked project still triggers only the linked child. |
| Git executable absence   | Default `resolveGitWorktreeIdentity()` with a temporary non-Git directory and empty `PATH` | A missing `git` executable yields confirmed non-Git only when the existing filesystem proof finds no Git control metadata; present `.git` metadata remains an error.                                   |

## Implementation phases

### Phase 1 — Persist and enforce Git worktree identity

- [x] Extend `WatchServiceState` and `WatchServiceIdentity` with `worktreeId`, bump the watcher protocol, and classify an identity mismatch as incompatible.
- [x] Resolve the worktree context when the daemon starts and persist its `worktreeId` in every heartbeat state.
- [x] Resolve watcher identity through the lightweight shared Git identity primitive so automatic startup does not add a full dirty-status scan to every command.
- [x] Keep state parsing backward-readable so a daemon from the previous protocol is deliberately replaced rather than becoming an unclassified corrupt file.
- [x] Add unit tests for matching identity, mismatched identity, non-Git roots, and protocol replacement.

### Phase 2 — Prove watcher output isolation across linked worktrees

- [x] Keep the existing `Watcher.runReindex()` boundary and extend its mocked-child test to assert the exact project root alongside its local output paths.
- [x] Add a real Git linked-worktree integration test that creates two default caches and ensures two independent watcher processes through an injected runtime.
- [x] Assert each simulated daemon state carries the correct worktree ID and each reindex environment targets only that worktree's local SCIP and SQLite files.

### Phase 3 — Surface and document the contract

- [x] Include project-root and worktree identity in watcher status JSON and concise human output.
- [x] Document automatic per-worktree watcher startup, local dirty refreshes, idle shutdown, and override behavior in the README.
- [x] Record the change in `CHANGELOG.md`.

### Phase 4 — Close review-discovered correctness and lifecycle gaps

- [x] **Files**: `src/runtime/git-worktree.ts`, `src/runtime/watch-service.ts`, `tests/runtime/git-worktree.test.ts`, `tests/runtime/watch-service.test.ts`
  - **Source**: `scip-query plan-context resolveGitWorktreeIdentity`; `scip-query trace classifyWatchServiceState`; `scip-query plan-context ensureWatchService`
  - **What**: Git command failure and a confirmed non-Git directory currently both collapse to an absent ID, so a compatibility decision cannot prove why the ID is absent.
  - **Change**: Make the Git probe return worktree, confirmed-non-Git, or error; make watcher identity explicitly Git or non-Git; reject an error before lifecycle inspection can authorize reuse.
  - **Testability**: The Git reader remains the command side-effect boundary, the resolution result is the deterministic core, and unit tests cover all three outcomes plus watcher-level failure. Stopping remains cache-targeted because it authorizes no reuse and must still work after a checkout directory disappears.
  - **Validation**: Focused Git-worktree and watch-service tests must prove that only confirmed non-Git roots can form an identity without a worktree ID, while the repository-cache lifecycle test must still delete an unreferenced cache after its final live build exits.
  - **Why**: Compatibility must fail closed when its identity evidence is unavailable, without breaking intentional non-Git projects.

- [x] **File**: `tests/runtime/worktree-watch-service.integration.test.ts`
  - **Source**: `scip-query plan-context Watcher`; `scip-query trace runReindex`
  - **What**: Directly invoking the private reindex method proves output construction but bypasses the filesystem subscription that selects which watcher reacts.
  - **Change**: Start watchers for both real linked worktrees, edit only one checkout, and observe the reindex child calls produced by the public watcher lifecycle.
  - **Testability**: Real temporary Git worktrees and filesystem events exercise the subscription side effect; mocked child processes capture the output boundary without running indexers.
  - **Validation**: Exactly one child must be forked, and its project root, SCIP path, and SQLite path must all belong to the edited worktree.
  - **Why**: This test fails if either watcher is accidentally subscribed to the sibling checkout even when reindex path construction itself remains correct.

- [x] **File**: `tests/runtime/watch-service.test.ts`
  - **Source**: `scip-query plan-context ensureWatchService`; `scip-query trace classifyWatchServiceState`
  - **What**: Protocol mismatch is covered only as a pure classification, not as the stop-clean-start lifecycle promised for protocol 3.
  - **Change**: Seed a live protocol-3 state, lock, and activity file; ensure the service; observe the old PID and files immediately before replacement spawn.
  - **Testability**: The existing injected `WatchServiceRuntime` is the process boundary; its spawn observation records whether cleanup preceded replacement.
  - **Validation**: The old PID is signaled, all old observation files are absent before spawn, and the returned state uses protocol 4 with a new PID.
  - **Why**: The lifecycle test protects the one-time migration rather than assuming the classifier's action is wired correctly.

### Phase 5 — Canonicalize daemon identity across path aliases

- [x] **Files**: `src/runtime/watch-service.ts`, `src/runtime/watch-server.ts`, `tests/runtime/watch-service.test.ts`, `tests/runtime/worktree-watch-service.integration.test.ts`
  - **Source**: `scip-query plan-context resolveWatchServiceIdentity`; `scip-query code resolveDefaultCacheDir`; `scip-query code canonicalPath`; `scip-query trace resolveWatchServiceIdentity`
  - **What**: The default cache and Git worktree ID resolve filesystem redirects, but watcher identity and daemon spawn retain the unresolved input spelling, so one checkout accessed through a symbolic link and its real path shares a cache yet fails the project-root compatibility check.
  - **Change**: Reuse the canonical root already returned by `resolveGitWorktreeIdentity()` for Git identities, pass that same identity root to the daemon spawn boundary, and make the daemon independently adopt the canonical identity root before loading configuration or starting the watcher. Preserve the cache resolver's resolved-path fallback for confirmed non-Git roots without adding a second canonicalization helper.
  - **Testability**: The real Git worktree and symbolic link are the filesystem boundary; the existing injected watcher runtime captures daemon roots, PIDs, signals, state, and cache paths.
  - **Validation**: Start through a symbolic-link alias, ensure through the real path, and prove both inputs resolve one cache, one canonical state root, one spawn, no signal, and a reused PID.
  - **Why**: A worktree identity denotes the checkout itself, so alternate path spellings that reach the same checkout must not create alternate daemon identities.

### Phase 6 — Close final identity-boundary review findings

- [x] **Files**: `src/runtime/git-worktree.ts`, `tests/runtime/git-worktree.test.ts`, `tests/runtime/watch-service.test.ts`
  - **Source**: `scip-query plan-context runGitCommand`; `scip-query code resolveWatchServiceIdentity`
  - **What**: `runGitCommand()` currently interprets every Git diagnostic containing “not a git repository” as proof that the directory is non-Git, even when a present but damaged or unreadable `.git` control entry caused that diagnostic.
  - **Change**: Accept the diagnostic as confirmed non-Git only after checking that neither the project directory nor an ancestor contains a `.git` filesystem entry and no explicit Git control directory is configured. Treat present, unreadable, or explicitly configured control metadata as a Git error.
  - **Testability**: Real temporary directories exercise the Git process and filesystem boundary; an empty `.git` directory deterministically produces the ambiguous diagnostic; identity and watcher tests assert the error survives to the fail-closed lifecycle boundary.
  - **Validation**: A plain directory remains `non-git`, while an otherwise identical directory containing an empty `.git` directory returns `error` and `resolveWatchServiceIdentity()` throws.
  - **Why**: An ID-less watcher identity is safe only when the absence of Git control metadata is established, not merely inferred from an ambiguous diagnostic string.

- [x] **Files**: `src/runtime/git-worktree.ts`, `src/semantic/typescript/remote-provider.ts`, `src/reindex/typescript-index-requester.ts`, `tests/semantic/typescript/typescript-session-mailbox.test.ts`, `tests/reindex/typescript-index-mailbox.test.ts`
  - **Source**: `scip-query refs canonicalPath`; `scip-query plan-context TypeScriptSemanticRequester`; `scip-query plan-context TypeScriptIndexRequester`; `scip-query trace usableServiceState --json --full`
  - **What**: Watcher state stores a canonical root, while both TypeScript clients compare it with an absolute but potentially symbolic-link-preserving caller path.
  - **Change**: Export and reuse the existing `canonicalPath()` primitive at requester construction so daemon state, semantic requests, and incremental-index requests compare the same filesystem identity without repeated Git probes.
  - **Testability**: The existing mailbox tests remain the process-free request seams; a real symbolic link supplies the alias input, canonical daemon state supplies the persisted side, and mocked polling drives one successful request through each protocol.
  - **Validation**: Both requesters complete through a symbolic-link project root; the semantic provider does not fall back locally and the incremental index requester does not reject the service.
  - **Why**: Daemon reuse is incomplete if its dependent clients reject the same process under another spelling of the same checkout.

- [x] **Files**: `src/runtime/watch-service.ts`, `src/runtime/commands/command-handlers.ts`, `tests/runtime/runtime-config.test.ts`, `README.md`
  - **Source**: `scip-query refs WatchServiceInspection`; `scip-query plan-context watchServiceReport`
  - **What**: A live foreground/startup lock has no daemon state, and the corresponding report drops the resolved project root and worktree ID already established during inspection. The README also uses “Git worktree ID” without defining its referents or distinguishing property.
  - **Change**: Include resolved watcher identity in `WatchServiceInspection`, carry its root and optional ID into lock-only JSON and human reports, and define the ID as the checkout identifier derived from its canonical path plus checkout-specific Git control directory.
  - **Testability**: A real temporary Git checkout supplies identity; an acquired process lock supplies the lock-only state; `handleWatch()` is the public formatting seam observed through JSON and console output.
  - **Validation**: Lock-only JSON includes `projectRoot` and `worktreeId`, human output prints the `Worktree:` line, and the README definition binds the term to concrete checkout and Git-directory referents.
  - **Why**: Status must identify the process scope while startup or foreground watching is active, not only after the daemon publishes its first heartbeat.

### Phase 7 — Preserve nested project roots and portable watcher coverage

- [x] **Files**: `src/runtime/watch-service.ts`, `tests/runtime/worktree-watch-service.integration.test.ts`
  - **Source**: `scip-query plan-context resolveWatchServiceIdentity`; `scip-query plan-context Watcher`; `scip-query code Watcher.start`; `scip-query code Watcher.startGitStatePolling`
  - **What**: The Git identity resolver returned the checkout top level, but watcher identity substituted that value for the configured project directory. The then-current isolation test also depended on recursive `fs.watch`, which Node 18 Linux does not provide.
  - **Change**: Canonicalize and retain the input project directory as `WatchServiceIdentity.projectRoot`; use `resolveGitWorktreeIdentity()` only for the checkout-specific `worktreeId`; and move the integration fixture into nested project directories. The initial staged-file polling fallback was later superseded by the complete source-subscription correction in Phase 9.
  - **Testability**: The existing injected service runtime captures cache/state/spawn roots; real nested linked worktrees and an alias exercise filesystem identity; mocked reindex children capture output paths. Phase 9 separately proves the portable source-event boundary.
  - **Validation**: Starting through a nested alias and reusing through the nested real path keeps one nested-project cache and daemon PID; state and spawn roots remain nested.
  - **Why**: A project root is the directory whose configuration, source scope, and cache belong together, while a Git worktree root is the wider checkout boundary. Conflating them breaks nested projects; depending on an optional filesystem feature breaks a declared supported runtime.

### Phase 8 — Resolve primary index paths and preserve optional Git

- [x] **Files**: `src/runtime/git-worktree.ts`, `src/runtime/watch.ts`, `tests/runtime/worktree-watch-service.integration.test.ts`
  - **Source**: `scip-query code readGitState`; `scip-query refs resolveGitPath`; `scip-query plan-context pollGitState`
  - **What**: `git rev-parse --git-path index` returns a path relative to the command directory for a nested primary checkout but an absolute path for a linked checkout. `readGitState()` currently passes either spelling directly to `statSync`, so the relative primary path is interpreted against the daemon process's inherited current directory.
  - **Change**: Export the existing `resolveGitPath()` primitive and apply it to the Git index output before storing or statting it. Exercise the Git polling boundary directly while staging and observing the nested primary project before separately staging and observing the linked project.
  - **Testability**: The existing `Watcher.start()` lifecycle is the test seam; real Git index files are the filesystem side-effect boundary; forced `fs.watch` failure removes platform event assistance; mocked reindex children expose which project and output paths reacted.
  - **Validation**: The first staged edit produces exactly one primary-project child and the second produces exactly one linked-project child, each with its own SCIP and SQLite paths.
  - **Why**: The Git index is the checkout-specific staging file whose metadata changes provide the portable polling signal, so its pathname must have the same resolution base as the Git command that produced it.

- [x] **Files**: `src/runtime/git-worktree.ts`, `tests/runtime/git-worktree.test.ts`, `tests/runtime/watch-service.test.ts`
  - **Source**: `scip-query code runGitCommand`; `scip-query code gitControlMetadataMayExist`; `scip-query refs resolveGitWorktreeIdentity`
  - **What**: `spawnSync` reports `ENOENT` when `git` is absent, and `runGitCommand()` currently promotes that process error to an identity failure even for a directory proven to contain no Git control metadata.
  - **Change**: Classify a missing Git executable as `not-repository` only when the existing control-metadata walk proves that neither the project nor an ancestor contains `.git` and no explicit Git directory is configured. Preserve errors for damaged or explicitly configured Git projects.
  - **Testability**: Default identity resolution with an empty executable search path exercises the real process boundary; real temporary directories supply absent versus present Git metadata; watcher identity remains the public lifecycle seam.
  - **Validation**: A plain directory resolves as non-Git without `git`; a directory with `.git` still fails closed; watcher identity can start from the confirmed non-Git result.
  - **Why**: Git is an optional repository capability for non-Git projects, while the absence of Git must never disguise a checkout whose control metadata says Git identity should exist.

### Phase 9 — Preserve ordinary unstaged refreshes on every supported runtime

- [x] **Files**: `package.json`, `package-lock.json`, `src/runtime/watch.ts`, `tests/runtime/worktree-watch-service.integration.test.ts`, `README.md`, `CHANGELOG.md`
  - **Source**: `scip-query plan-context Watcher.start`; `scip-query plan-context handleFileChange`; `scip-query refs createGitignoreFilter`
  - **What**: Node's recursive `fs.watch` is unavailable on supported Node 18 Linux. Git polling observes `HEAD` and the staging index, but an ordinary unstaged edit changes neither, so the staged integration fixture concealed a real automatic-refresh gap. The same fixture's forced watcher failure also could not prove that each source subscription was rooted in its own checkout, and its outer timeout was shorter than its sequential wait budgets.
  - **Change**: Replace the platform-limited recursive subscription with Chokidar 4, a cross-platform filesystem watcher whose defining behavior is maintaining the per-directory operating-system subscriptions needed to expose one recursive project event stream. Feed its absolute event paths through the existing project-relative ignore and debounce boundary, retain Git polling as the independent commit/staging signal, and close the subscription during watcher shutdown. Give Chokidar an explicit runtime dependency compatible with Node 18.
  - **Testability**: One real linked-worktree test starts both watchers with Git polling delayed for 60 seconds, makes ordinary unstaged edits, waits until both subscription maps are populated, and captures each reindex child. A separate test edits only the linked checkout and requires exactly one linked child. The Git-index test directly exercises only the polling boundary, preserving the relative-primary and absolute-linked path regression. Each integration case has an explicit outer timeout greater than all internal waits and repository setup.
  - **Validation**: Unstaged edits in the primary and linked worktrees launch only their respective children; a linked-only edit launches exactly one child; nested staged edits still exercise the correct primary and linked index paths; watcher errors remain empty; all child project, SCIP, and SQLite paths remain local.
  - **Why**: A source subscription is the operating-system event stream bound to one project directory. Its essential job is detecting working-file changes, including changes Git has not staged, so Git metadata cannot substitute for it.

## Stress findings

- A watcher cannot exist before any `scip-query` process runs in a newly created worktree. The first watcher-eligible command is the deterministic activation boundary; starting a daemon at `git worktree add` would require a Git/Conductor hook outside this repository's authority.
- Two concurrent starters for different worktrees do not contend because their default caches and locks differ. Two starters for the same worktree continue to coordinate through one cache-local lock.
- A linked worktree at the same commit may hydrate the same immutable shared generation, but each watcher writes to its own cloned writable cache. Shared generation identity does not imply shared watcher identity.
- Dirty files must never enter a sibling cache or immutable shared generation. The exact project root and output paths passed to the reindex child are the enforcement boundary.
- Bumping the watcher protocol intentionally replaces already-running version-3 daemons on the next command; this is a one-time safe migration.
- Removed worktrees remain covered by repository cache lifecycle cleanup. Live watcher/build protection remains cache-local and must not be weakened by this change.
- Git identity is required before starting, inspecting, or reusing a daemon, but not before stopping the PID recorded in an explicitly selected cache. This distinction lets cleanup remove caches for worktree directories that no longer exist without turning an uncertain identity into reuse authorization.
- Symbolic-link aliases do not create new worktrees. Canonical cache selection, worktree ID, persisted project root, watcher subscription root, and reindex output root must therefore converge on the same real checkout path before process reuse is decided.
- A “not a repository” Git message is not identity evidence by itself. Only the verified absence of a `.git` control entry permits non-Git classification; uncertainty remains an error.
- Every process-local client of watcher state must compare canonical filesystem identities. Canonicalizing only the daemon lifecycle leaves mailbox protocols observably split.
- One Git worktree can contain several independently configured scip-query projects. They share a checkout ID but must retain distinct canonical project roots and cache namespaces.
- Portable recursive source observation is the correctness boundary for ordinary working-file edits. Chokidar supplies that observation through per-directory subscriptions on Node 18 Linux, while Git polling remains a complementary signal for `HEAD` and staging-index changes.
- Relative paths printed by Git belong to the `-C` command directory, not the daemon's inherited current directory. Primary and linked checkout index paths must be normalized before comparison and filesystem access.
- An unavailable Git executable is equivalent to non-Git only after filesystem evidence rules out Git control metadata; otherwise identity resolution remains fail closed.

## Verification and ship order

1. Run focused watcher unit and linked-worktree integration tests.
2. Run type checking and the full test suite.
3. Run the routed postchecks required by repository policy, including `co-change` for the watcher state/public-contract files and `doc-drift` for this plan.
4. Run `scip-query reindex && scip-query diff-gate`; resolve or explicitly account for every finding.
5. Mark this plan implemented only after all verification passes.

## Verification record

- Original focused watcher and linked-worktree coverage: 59 tests passed. Review-remediation coverage: 5 focused files and 40 tests passed, including the removed-worktree cleanup interaction and symbolic-link-to-real-path reuse of the same daemon PID.
- Final identity-boundary remediation: 7 focused files and 71 tests passed, including damaged Git control metadata, both TypeScript alias-path mailbox clients, lock-only JSON and human status, linked-worktree isolation, and cache lifecycle cleanup.
- Final full suite with one worker: 196 test files and 1,379 tests passed. The first remediation run exposed that fail-closed identity lookup prevented cache cleanup after a worktree directory disappeared; stopping was narrowed to the explicitly selected cache, the focused lifecycle test passed, and the complete suite then passed. The final path-alias run exposed macOS's `/var` to `/private/var` redirect in the fixtures; expectations now deliberately assert the real path returned after filesystem redirects are resolved.
- Final suite after the identity-boundary remediation: 196 test files and 1,380 tests passed.
- Nested-project and initial Node 18 Linux remediation: 5 focused files and 40 tests passed, then the serialized full suite passed 196 test files and 1,380 tests. That staged-edit polling fixture was later superseded by Phase 9 because it did not cover ordinary unstaged edits.
- Primary-index and optional-Git remediation: 6 focused files and 76 tests passed, then the serialized full suite passed 196 test files and 1,381 tests. The current integration fixture proves Git returns a relative primary index path and an absolute linked index path, exercises only Git polling, and observes the correct child after staging each checkout independently. Default identity tests remove `git` from the executable search path and prove only an existing project with no Git control metadata becomes non-Git.
- Portable unstaged-source remediation: 2 focused watcher files and 17 tests passed. Real Chokidar subscriptions detect ordinary unstaged edits with Git polling delayed, a separate linked-only edit proves subscription-root isolation, and the direct polling regression still detects staged changes through relative primary and absolute linked index paths. The three integration cases use explicit 30-second or 20-second outer budgets rather than inheriting Vitest's five-second default.
- Final portable-source suite: the Node 18-targeted production build passed, followed by the serialized full suite with 196 test files and 1,383 tests passing.
- Final Phase 9 closeout: typecheck, lint, source-formatting, package dry-run, doctor, and capability checks passed; the index was fresh; live restart produced a protocol-4 daemon bound to this project root and worktree ID; and `diff-gate` reported zero blocking or advisory findings. The health baseline remains intentionally unratcheted at 103 repository-wide findings and now reports one baseline finding fixed.
- Direct portability evidence: in the official Node 18.20.8 Debian Linux ARM64 image, a clean container install ran all 17 focused watcher tests successfully, including real unstaged source events and linked-worktree isolation. A second install with native scripts enabled compiled the existing SQLite dependency and successfully opened, queried, and closed an in-memory database. Existing dependencies emit Node 18 engine warnings, but both the tested watcher behavior and the production SQLite load completed successfully.
- `npm run typecheck`, `npm run lint`, and `npm run build`: passed.
- Routed postchecks: `incomplete-migration`, `recent-duplicates`, `unused-params`, `wrapper-candidates`, changed-doc `doc-drift`, and final `diff-gate` produced no actionable findings attributable to this change.
- Contract postchecks: `co-change --full` ran for `watch-service.ts`, `git-worktree.ts`, and `watch.ts`; every relevant state, lifecycle, and test partner is present in this diff. `passthrough-candidates`, `stale-abstractions`, `similar resolveGitPath`, and `redundant-reexports` found no actionable item attributable to this change. A diff-gate advisory led to a verified correction from 10 to 12 state-writing `Watcher` actions in the TLA skill guide.
- Live smoke evidence: `status --capabilities` reported a protocol-4 daemon bound to this checkout's worktree ID and printed the exact worktree root.
- Repository-wide `health --baseline` remains behind current `HEAD` by 103 heuristic findings. Of those, 101 are outside this watcher slice and two are attributable review signals: `similar` pairs `resolveGitWorktreeContext()` with `resolveGitWorktreeIdentity()` because the former deliberately composes the latter, and `stale` flags the injected `GitReader` command boundary because it has one production implementation. Both are accepted intentionally: the shared identity primitive keeps one canonical worktree-ID algorithm, while `GitReader` is the test seam that proves Git success, confirmed non-Git, and command failure without replacing process-global Git behavior. The earlier `wrapper` signal disappeared because identity resolution now performs substantive failure classification. These exploratory signals are not suppressed; the diff-specific gate passed with zero blocking or advisory findings.
