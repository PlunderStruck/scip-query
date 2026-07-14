# Git-worktree-aware shared cache plan

**Date:** 2026-07-14

**Status:** Implemented end to end on 2026-07-14; the verification record and measured acceptance timings are in `docs/benchmarks/2026-07-14-git-worktree-shared-cache.md`.

## Goal

Make a newly created Git worktree start from a warm `scip-query` index for the exact repository snapshot it checked out, while allowing every worktree to evolve independently without corrupting another worktree's results. The behavior must be generic to Git worktrees; Conductor is one creator of those worktrees, not an integration boundary.

Done means:

- A clean linked worktree at the same commit and indexing configuration as an already indexed checkout attaches to a complete shared generation before its first index-reading command opens the database.
- Attaching does not run a language indexer. The worktree receives its own writable local artifact set, initially cloned from an immutable shared generation.
- Dirty edits and watcher refreshes update only that worktree's local cache. They never alter the shared generation or a sibling worktree's cache.
- Concurrent worktrees asking for the same absent generation coordinate one build and publication in the normal case; different snapshots are not serialized behind one repository-wide lock.
- Removing a Git worktree makes its managed local cache eligible for deletion on the next sweep. A shared generation stays while a live worktree references it, then expires after one hour without a reference; unreferenced generations are also bounded by a size budget.
- Explicit cache/database overrides remain private and are never automatically shared or deleted.
- A repository-level evidence cache may warm only evidence products whose complete invalidation keys are proven safe; the local evidence database remains authoritative for worktree-specific state.
- Status output explains whether a command attached, built, bypassed, or missed the shared cache and what cleanup did.

The essential runtime objects are these:

- A Git worktree is a filesystem checkout that shares one repository's Git object database with other checkouts but has its own `HEAD`, index, and working files. Those shared Git records identify the repository and committed snapshot; they do not identify a permanent “parent worktree.”
- A shared generation is an immutable, complete set of `scip-query` index artifacts selected by repository identity, project-input fingerprint, indexing configuration, and artifact-format compatibility. Immutability is what lets many worktrees trust the same generation without coordinating their later writes.
- A worktree cache is the existing path-scoped writable artifact directory for one checkout. Its separation from the shared generation is what lets a watcher publish dirty changes without affecting siblings.
- A lease is a small persisted record connecting a live worktree path to the shared generation it currently uses. Its reference is what prevents cleanup from deleting data that a live checkout can still use.
- Garbage collection is a cleanup pass that removes cache artifacts no live lease can reach after the retention rule permits deletion. Reachability, rather than Conductor session state, makes cleanup work for every Git worktree creator.
- A copy-on-write file clone is a filesystem copy whose initial disk blocks may be shared but whose later writes detach into private blocks. Unlike a hard link, it cannot let a worktree overwrite the shared inode.

Non-goals for the first release:

- Inferring which worktree “created” another worktree. Exact repository and snapshot identity is sufficient and remains valid when branches move.
- Publishing dirty or partial indexes as shared generations.
- Replacing existing TypeScript affected-document logic or making added, deleted, or compiler-configuration changes incrementally eligible.
- Adding a Conductor lifecycle API, a required daemon, or a new public configuration surface.
- Proving semantic equivalence from raw SQLite or SCIP file hashes. Existing benchmarks show that identical inputs can produce byte-different artifacts; normalized document facts are the correctness oracle.

## Current State

1. `resolveCacheDir()` hashes the absolute `projectRoot` and places the cache under `~/.cache/scip-query/projects/<path-hash>` unless `SCIP_QUERY_CACHE_DIR` or `config.dbPath` overrides it. `resolveIndexStoragePaths()` then assigns `index.db`, `index.scip`, and `meta.json` within that directory. This path identity makes linked worktrees cold by construction even when their committed files are identical. Sources: `scip-query plan-context resolveCacheDir`, `scip-query code resolveIndexStoragePaths` (`src/runtime/config.ts:497-537`).
2. `resolveCliProjectContext()` resolves the configured database and legacy root fallback, while `openProjectDb()` opens the selected SQLite database read-only for query commands. There is no shared-generation attach step before the open. Sources: `scip-query code resolveCliProjectContext`, `scip-query code openProjectDb` (`src/runtime/cli-context.ts:21-74`).
3. The CLI `preAction` resolves the project and starts or checks the watcher before dispatching the command, but it does not synchronously materialize a missing local index. Source: `scip-query code src/runtime/cli.ts:1-80` (`src/runtime/cli.ts:26-44`).
4. `ensureWatchServiceForCommand()` starts an eligible watcher, and `runWatchServiceServer()` keeps its lock, service record, and refresh mailboxes in the worktree's current cache directory. Those process-control files must remain worktree-local. Sources: `scip-query code ensureWatchServiceForCommand` (`src/runtime/watch-service.ts:159-183`), `scip-query code runWatchServiceServer` (`src/runtime/watch-server.ts:44-220`).
5. `Watcher.readGitState()` observes the worktree-specific Git index and `HEAD`; `Watcher.runReindex()` forks a worker with the same project root and local output paths. This is already the correct dirty-overlay boundary, but Git discovery is private and duplicated between watcher and agent-hook code. Sources: `scip-query plan-context Watcher`, `scip-query code Watcher.readGitState`, `scip-query code Watcher.runReindex` (`src/runtime/watch.ts:267-378`).
6. `refreshIndexForHookIfNeeded()` asks the watcher to refresh or launches a one-shot background refresh when a hook sees a stale index. It does not first try an exact shared generation, so hooks in newly created worktrees can all trigger cold work. Source: `scip-query code refreshIndexForHookIfNeeded` (`src/runtime/agent-hooks.ts:650-697`).
7. `reindex()` computes a whole-project fingerprint, takes an `index.lock` beside the output database, reuses only artifacts in that same local cache, and otherwise runs a fresh index. Since every worktree has a different local directory, the lock and reuse decision do not coordinate siblings. Source: `scip-query plan-context reindex` (`src/reindex/index.ts:247-354`).
8. `computeReindexFingerprint()` and `runtimeFingerprint()` independently construct the same project-input fingerprint from language and indexer settings plus `fingerprintProjectFiles()`. A shared cache key must extend one canonical calculation rather than add a third version. Sources: `scip-query code computeReindexFingerprint`, `scip-query code runtimeFingerprint`, `scip-query code fingerprintProjectFiles` (`src/reindex/index.ts:1996-2015`, `src/runtime/index-freshness.ts:100-115`, `src/reindex/project-files.ts:51-93`).
9. `runLanguageIndexersForFreshReindex()` already reuses language shards and attempts a TypeScript affected-document update from the previous local generation. `planTypeScriptIncrementalUpdate()` deliberately falls back for added, deleted, or configuration-changing inputs. A hydrated shared base can feed this path without changing its eligibility contract. Sources: `scip-query code runLanguageIndexersForFreshReindex`, `scip-query code planTypeScriptIncrementalUpdate` (`src/reindex/index.ts:600-744`, `src/reindex/typescript-incremental-index.ts:106-181`).
10. `patchIncrementalSqliteGeneration()` copies a previous database to a candidate, replaces affected rows in a transaction, validates integrity, and leaves the accepted previous database unchanged on failure. This is the existing safe mechanism for turning a shared clean base into a worktree-local dirty generation. Source: `scip-query code patchIncrementalSqliteGeneration` (`src/reindex/incremental-sqlite-publication.ts:100-171`).
11. `publishFreshReindexArtifacts()` assembles language shards, SCIP, SQLite, metadata, shadow state, and TypeScript fragment/overlay state before calling `promoteReindexArtifacts()`. The promotion code uses replacement and recovery semantics for a local stable handoff. Shared publication must wrap, not bypass, these completeness guarantees. Sources: `scip-query code publishFreshReindexArtifacts`, `scip-query plan-context promoteReindexArtifacts` (`src/reindex/index.ts:1044-1207`, `src/reindex/sqlite-generation-store.ts:88-110`).
12. `mergeMetadata()` rejects SCIP inputs with different `metadata.projectRoot` values. Current SCIP artifacts contain an absolute checkout URI, so a cross-worktree clone must rebind the root in the local SCIP artifact and cached language shards before a later merge. Source: `scip-query code mergeMetadata` (`src/reindex/merge.ts:79-96`).
13. TypeScript fragments and overlays and SQLite recovery generations already have independent stores and pruning rules under the local cache. Their path constants are private and spread across modules, so a shared-generation publisher currently has no canonical artifact catalog. Sources: `scip-query code typeScriptFragmentStorePaths`, `scip-query code pruneTypeScriptFragmentGenerations`, `scip-query code pruneTypeScriptOverlays`, `scip-query plan-context promoteReindexArtifacts` (`src/reindex/typescript-fragment-store.ts:112-119`, `src/reindex/typescript-fragment-store.ts:344-364`, `src/reindex/typescript-overlay-store.ts:99-119`).
14. `connectionFor()` creates one writable `evidence.db` beside each worktree's `index.db`, uses WAL, and disables the cache for the process after its first SQLite failure. This failure-open-for-queries behavior must survive a shared read-through layer. Sources: `scip-query plan-context connectionFor`, `scip-query code projectEvidenceFingerprint` (`src/storage/evidence-cache.ts:152-326`).
15. The evidence product manifest records dependency contracts. Only `source-facts`, `definition-exclusions`, `doc-path-tokens`, and `react-component-behavior-profiles` currently depend solely on content hash and tool version; other products also depend on a project fingerprint, Git history, import resolution, configuration, or dependency digests. Source: `scip-query code EVIDENCE_PRODUCT_MANIFEST` (`src/storage/evidence-products.ts:68-188`).
16. `handleStatus()` and `renderStatusReport()` already combine freshness, watcher, shadow, generation, and database diagnostics. Shared-cache state belongs in this existing report rather than a separate diagnostic command. Sources: `scip-query code handleStatus`, `scip-query code renderStatusReport` (`src/runtime/commands/command-handlers.ts:1582-1679`).
17. The 2026-07-02 benchmark measured five temporary Vega worktrees at a median 44.880 seconds per commit; indexing was 52.8% of the total and about 1,835 evidence rows were recomputed because each path received a new cache. That is the observed workload this plan targets. Source: `docs/benchmarks/2026-07-02-performance-architecture-ledger.md:114-205`.

## Reuse Audit

| Proposed unit                                          | Decision                                                                                           | Evidence and reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GitWorktreeContext` and `src/runtime/git-worktree.ts` | New shared runtime unit; replace private Git discovery in watcher and hooks                        | `findGitRoot()` in `src/runtime/agent-hooks.ts:882-891` and `gitOutput()` in `src/runtime/watch.ts:388-397` are private, narrower, and duplicated. Neither exposes the common Git directory, tree object, cleanliness, or live worktree list required for repository-scoped identity. Sources: `scip-query code resolveHookWorkspace`, `scip-query code Watcher.readGitState`.                                                                                                                  |
| Canonical project-input fingerprint builder            | Extend `src/reindex/project-files.ts`; do not create another fingerprint module                    | `computeReindexFingerprint()` and `runtimeFingerprint()` already duplicate the calculation around `fingerprintProjectFiles()`. Moving the shared calculation next to the file fingerprint removes duplication and gives shared selection the exact existing freshness contract. Sources: `scip-query code computeReindexFingerprint`, `scip-query code runtimeFingerprint`, `scip-query code fingerprintProjectFiles`.                                                                          |
| `src/reindex/index-artifacts.ts`                       | New artifact-catalog unit                                                                          | `resolveIndexStoragePaths()` covers the three stable files, while fragment, overlay, language-shard, and recovery paths remain private in separate modules. A versioned allowlist is required so publication never copies arbitrary cache files such as locks, watcher records, or local evidence. Sources: `scip-query code resolveIndexStoragePaths`, `scip-query code typeScriptFragmentStorePaths`, `scip-query code languageShardPath`, `scip-query plan-context promoteReindexArtifacts`. |
| SCIP root rebinding                                    | Extend `src/reindex/merge.ts`; do not add a forwarding wrapper                                     | `mergeMetadata()` owns the absolute-root compatibility rule and no existing symbol rewrites one index's root. A sibling exported transformation keeps validation and transformation together. Source: `scip-query code mergeMetadata`.                                                                                                                                                                                                                                                          |
| `src/reindex/shared-generation-store.ts`               | New store with a pure action planner and thin filesystem shell                                     | Local promotion, TypeScript fragments, and overlays each manage one artifact family, but none owns repository identity, immutable generation manifests, cross-worktree selection, or per-generation build locks. Extending `sqlite-generation-store.ts` would mix local reader recovery with repository-wide publication and cleanup lifetimes. Sources: `scip-query plan-context promoteReindexArtifacts`, `scip-query code persistManifest`, `scip-query code acquireReindexLock`.            |
| Worktree preparation orchestrator                      | Extend `src/runtime/cli-context.ts` and call it from CLI/hooks                                     | `resolveCliProjectContext()` already selects paths and `openProjectDb()` is the last boundary before queries read them. The new orchestrator belongs between those operations; a parallel command framework is unnecessary. Sources: `scip-query code resolveCliProjectContext`, `scip-query code openProjectDb`, `scip-query code refreshIndexForHookIfNeeded`.                                                                                                                                |
| Local artifact promotion after hydration               | Reuse `promoteReindexArtifacts()` and `inspectSqliteGeneration()`                                  | These functions already provide local atomic replacement, recovery, and structural inspection. Hydration should stage compatible local files and enter through the same promotion boundary. Sources: `scip-query plan-context promoteReindexArtifacts`, `scip-query code inspectSqliteGeneration`.                                                                                                                                                                                              |
| Dirty overlay refresh                                  | Reuse watcher, TypeScript affected-set planning, and incremental SQLite publication unchanged      | They already confine refreshes to local paths and preserve the previous accepted generation on failure. The shared feature supplies a better previous local generation; it does not need a second overlay engine. Sources: `scip-query code Watcher.runReindex`, `scip-query code planTypeScriptIncrementalUpdate`, `scip-query code patchIncrementalSqliteGeneration`.                                                                                                                         |
| `src/runtime/repository-cache-lifecycle.ts`            | New lifecycle policy with injected clock/filesystem/process checks                                 | `stopWatchService()` and `cleanupWatchServiceFiles()` clean one known service, while fragment/overlay pruning operates inside one live cache. No existing unit discovers removed Git worktrees or computes repository-generation reachability. Sources: `scip-query code stopWatchService`, `scip-query code cleanupWatchServiceFiles`, `scip-query code pruneTypeScriptFragmentGenerations`.                                                                                                   |
| Shared evidence read-through                           | Extend `src/storage/evidence-cache.ts` and `ScipQueryConfig`; do not replace evidence product APIs | All evidence callers already pass through `connectionFor()` and public read/write functions. A second connection inside that boundary can preserve every caller and local-authoritative behavior. Sources: `scip-query plan-context connectionFor`, `scip-query refs connectionFor`, `scip-query code createFileEvidenceProduct`.                                                                                                                                                               |
| Shared diagnostics                                     | Extend status report and existing JSON shape                                                       | `handleStatus()` is already the user-facing aggregation point. A new command would duplicate project, watcher, and generation discovery. Sources: `scip-query code handleStatus`, `scip-query code renderStatusReport`.                                                                                                                                                                                                                                                                         |
| Conductor cleanup hook                                 | Reject                                                                                             | Git worktree records provide the generic lifecycle referent, and CLI/watcher sweeps can observe them regardless of whether Conductor, an agent, or a person created the checkout. No Conductor dependency is needed.                                                                                                                                                                                                                                                                            |

The test tree is intentionally excluded from the SCIP index; `scip-query outline tests/runtime/watch.test.ts` and equivalent test targets return no indexed symbols. Test-file locations below therefore come from the repository filesystem, while every production behavior claim remains anchored to a SCIP command.

## Testability Design

| Behavior                                        | Test seam                                                                             | Dependencies to inject                                     | Pure core                                                                                                                 | Side-effect shell                                                         | Contract                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identify repository, worktree, and snapshot     | `resolveGitWorktreeContext(root, git)`                                                | Git command runner, path canonicalizer                     | Parse porcelain/NUL output; derive IDs from canonical paths and tree/config identity                                      | Execute read-only Git commands and resolve symlinks                       | Return a discriminated `git` or `not-git` result; malformed Git output is a typed diagnostic, not a guessed identity                                                                          |
| Select a reusable generation                    | `planSharedGenerationAction(input)`                                                   | None                                                       | Choose `attach`, `import-peer`, `build-owner`, `wait`, or `bypass` from snapshot, manifests, leases, locks, and overrides | Read manifests, locks, local metadata, and current snapshot               | Never select a generation whose repository, fingerprint, settings, format, or completeness differs                                                                                            |
| Publish a clean generation                      | `publishSharedGeneration(candidate, io)`                                              | Filesystem, clock, PID/liveness, hash function             | Validate manifest and artifact allowlist; decide stale-lock ownership                                                     | Stage COW/full copies, hash, fsync/close, and atomically rename           | Only a complete, still-clean, unchanged snapshot becomes visible; existing immutable generation is never overwritten                                                                          |
| Bootstrap from a peer's legacy cache            | `validatePeerGenerationCandidate(candidate)`                                          | Filesystem inspector, Git context resolver                 | Compare source metadata, generation identity, target fingerprint, and compatibility                                       | Snapshot peer artifacts and compare source identity before/after staging  | A partial, changing, custom-path, or fingerprint-mismatched cache is rejected; the peer's current files may be dirty when its stable cached generation still exactly matches the clean target |
| Hydrate a worktree                              | `hydrateSharedGeneration(input, io)`                                                  | Clone/copy implementation, SCIP serializer, local promoter | Produce the staged-file/rebase plan                                                                                       | Clone/copy allowlisted artifacts, rebind SCIP roots, call local promotion | Shared files are never hard-linked; local stable paths change atomically or remain on the previous generation                                                                                 |
| Coordinate simultaneous cold builds             | `decideGenerationLock(state, now)`                                                    | Clock, PID liveness, atomic file creation, bounded waiter  | Decide acquire/wait/reclaim/fallback                                                                                      | Create/remove lock and poll for atomic publication                        | One live owner per generation; stale owners are reclaimable; timeout falls back to correct local indexing                                                                                     |
| Preserve dirty isolation                        | Existing `planTypeScriptIncrementalUpdate()` and `patchIncrementalSqliteGeneration()` | Existing indexer and SQLite dependencies                   | Existing affected-set calculation                                                                                         | Existing local watcher/reindex publication                                | Dirty outputs remain under the worktree cache and never publish to the repository store                                                                                                       |
| Sweep removed worktrees and expired generations | `planRepositoryCacheSweep(state, policy, now)`                                        | Clock, filesystem, Git worktree listing, PID liveness      | Mark live leases; rank unreferenced generations by expiry/age/size                                                        | Stop stale services and remove only verified managed paths                | Removed worktree caches are immediately eligible; live references and live locks are protected; unreferenced generation TTL defaults to one hour                                              |
| Read safe evidence across worktrees             | Existing `readCachedFileEvidence()` with injected connection paths                    | Local/shared SQLite openers                                | Select the safe product allowlist and read order                                                                          | Read local, then shared; write local, then best-effort shared             | Shared failure is a miss/no-op; outcome ledger and products with unproven keys stay local                                                                                                     |
| Explain cache behavior                          | `buildProjectDiagnosticReport()` plus a shared-cache report builder                   | Filesystem manifest/lease readers                          | Normalize attach/build/bypass/cleanup state                                                                               | Read state files                                                          | Human and JSON status agree and never require opening mutable shared artifacts for diagnosis                                                                                                  |

## Design Phases

### Phase 1 — Establish repository and snapshot identity without changing cache behavior

This phase is deployable on its own: all new identity data is internal and existing path selection remains unchanged.

#### 1.1 — Centralize Git-worktree discovery

- [ ] **File**: `src/runtime/git-worktree.ts` (new), `src/runtime/agent-hooks.ts:862-891`, `src/runtime/watch.ts:359-397`
- **Source**: `scip-query code resolveHookWorkspace`; `scip-query code Watcher.readGitState`
- **What**: Hooks privately run `git rev-parse --show-toplevel`, while the watcher privately resolves the Git index and `HEAD`. Neither describes the shared repository or enumerates live linked worktrees.
- **Change**: Add `GitWorktreeContext` and a small injected `GitReader` contract. Resolve canonical project root, `--absolute-git-dir`, `--git-common-dir`, `rev-parse HEAD`, `rev-parse HEAD^{tree}`, and `status --porcelain=v1 -z --untracked-files=all`; derive stable repository and worktree IDs from canonical paths. Parse `git worktree list --porcelain -z` into live worktree records. Replace the duplicated hook/watcher Git helpers with this unit while preserving their current errors and polling fields.
- **Testability**:
  - Test seam: `resolveGitWorktreeContext()` and exported porcelain parsers.
  - Injected dependencies: Git runner and path canonicalizer.
  - Pure core: NUL-safe parsing and deterministic ID derivation.
  - Side-effect shell: read-only Git subprocess calls and realpath resolution.
  - Contract: return exact Git facts or a typed unavailable/malformed result; never infer a parent worktree.
- **Validation**: Add `tests/runtime/git-worktree.test.ts` covering a primary checkout, two linked worktrees, detached `HEAD`, branch movement, spaces/newlines in paths where Git supports them, untracked/modified cleanliness, and malformed injected output; run `npm test -- tests/runtime/git-worktree.test.ts tests/runtime/watch.test.ts tests/runtime/agent-hooks.test.ts`.
- **Why**: Repository identity and liveness must have one generic source before shared paths or deletion can be safe.

#### 1.2 — Unify the project-input fingerprint

- [ ] **File**: `src/reindex/project-files.ts:51-93`, `src/reindex/index.ts:1996-2015`, `src/runtime/index-freshness.ts:100-115`
- **Source**: `scip-query code fingerprintProjectFiles`; `scip-query code computeReindexFingerprint`; `scip-query code runtimeFingerprint`
- **What**: Reindex and freshness independently wrap the same project-file hash with language and indexer settings.
- **Change**: Export one `buildProjectInputFingerprint()` beside `fingerprintProjectFiles()`. Make reindex and runtime freshness call it. Define a `SharedSnapshotIdentity` from repository ID, Git tree object, this full fingerprint, indexed languages/settings, CLI/artifact schema version, and companion mode. Do not use raw artifact hashes as the semantic key.
- **Testability**:
  - Test seam: `buildProjectInputFingerprint()` and `sharedSnapshotIdentity()`.
  - Injected dependencies: file lister/reader only through the existing project-file layer.
  - Pure core: stable serialization and identity hashing.
  - Side-effect shell: existing Git file listing and byte reads.
  - Contract: existing freshness fingerprints remain byte-for-byte identical for the same inputs; two roots with the same tracked snapshot/config receive the same snapshot identity within one repository.
- **Validation**: Extend `tests/reindex/project-files.test.ts` and `tests/runtime/index-freshness.test.ts`; assert old and refactored fixture fingerprints match and changes to content, language set, settings, format version, or companion mode miss. Run `npm test -- tests/reindex/project-files.test.ts tests/runtime/index-freshness.test.ts`.
- **Why**: Shared reuse is only correct if it uses the exact input contract that already decides local freshness.

#### 1.3 — Define the shareable artifact catalog and SCIP root transformation

- [ ] **File**: `src/reindex/index-artifacts.ts` (new), `src/reindex/merge.ts:79-96`, `src/reindex/index.ts:1044-1267`, `src/reindex/typescript-fragment-store.ts:112-119`, `src/reindex/typescript-overlay-store.ts:99-119`
- **Source**: `scip-query code mergeMetadata`; `scip-query code publishFreshReindexArtifacts`; `scip-query code typeScriptFragmentStorePaths`; `scip-query code pruneTypeScriptOverlays`
- **What**: A complete local index spans stable files and optional shard/fragment/overlay files, while process locks, watcher records, and `evidence.db` must not enter an immutable generation. SCIP metadata embeds an absolute project root that sibling merges reject.
- **Change**: Add a versioned artifact catalog that enumerates allowed relative files/directories and required/optional completeness rules by `ReindexMetadata` state. Export existing private path builders/constants through that catalog. Add `rebaseScipProjectRoot(index, fromRoot, toRoot)` in `merge.ts`; apply it only to staged local SCIP and language-shard copies during hydration. Reject unexpected paths and root metadata that does not match the manifest source root.
- **Testability**:
  - Test seam: `describeIndexArtifactSet()` and `rebaseScipProjectRoot()`.
  - Injected dependencies: directory lister and SCIP codec.
  - Pure core: allowlist/completeness classification and metadata transformation.
  - Side-effect shell: directory traversal and protobuf read/write.
  - Contract: complete accepted artifacts are enumerated; locks, service files, local evidence, temp files, and unknown paths are excluded; all hydrated SCIP roots equal the target root.
- **Validation**: Add `tests/reindex/index-artifacts.test.ts` and extend `tests/reindex/reindex-merge.test.ts`; cover full, reused, deferred-companion, missing, unexpected, and root-mismatch cases. Run `npm test -- tests/reindex/index-artifacts.test.ts tests/reindex/reindex-merge.test.ts tests/reindex/reindex-reliability.test.ts`.
- **Why**: An explicit catalog prevents accidental sharing of mutable state and makes cross-root reuse compatible with existing merge invariants.

### Phase 2 — Add an opt-out immutable generation store

This phase is deployable with no automatic consumers. `SCIP_QUERY_SHARED_CACHE=0` disables every shared-store read, write, lock, lease, and sweep. Explicit `SCIP_QUERY_CACHE_DIR`, `SCIP_QUERY_INDEX_DB`, or `config.dbPath` also bypasses the store and marks the reason in diagnostics.

#### 2.1 — Implement repository paths, manifests, selection, and safe cloning

- [ ] **File**: `src/reindex/shared-generation-store.ts` (new), `src/runtime/config.ts:497-537`
- **Source**: `scip-query plan-context resolveCacheDir`; `scip-query code resolveIndexStoragePaths`; `scip-query plan-context promoteReindexArtifacts`
- **What**: Default cache paths are worktree-scoped and there is no repository-level artifact namespace or immutable manifest.
- **Change**: Add the repository layout below the existing global cache root:

  ```text
  repositories/<repository-id>/
    generations/<generation-id>/manifest.json
    generations/<generation-id>/<allowlisted artifacts>
    locks/<generation-id>.lock
    worktrees/<worktree-id>.json
    evidence.db
    gc-state.json
  ```

  Define a versioned manifest containing repository/snapshot identity, source root, completeness and compatibility fields, creation/access timestamps, and per-file relative path/size/SHA-256 records used only for corruption detection. Implement a pure action planner returning `attach`, `import-peer`, `build-owner`, `wait`, or `bypass`. Implement COW cloning with `COPYFILE_FICLONE` where supported and ordinary copy fallback; explicitly reject hard-link semantics.

- **Testability**:
  - Test seam: `planSharedGenerationAction()`, manifest parser/validator, and `cloneArtifactFile()`.
  - Injected dependencies: filesystem, clock, hash function, environment, and copy primitive.
  - Pure core: path derivation, compatibility checks, action selection, and manifest validation.
  - Side-effect shell: manifest reads and COW/full file copies.
  - Contract: repository paths cannot escape the managed root; invalid/unknown manifests are misses; overrides and opt-out cause no shared I/O.
- **Validation**: Add `tests/reindex/shared-generation-store.test.ts` for path containment, version mismatch, corrupt file, symlink escape, unsupported COW fallback, local-write isolation, opt-out, and all override bypasses. Run `npm test -- tests/reindex/shared-generation-store.test.ts tests/runtime/runtime-config.test.ts`.
- **Why**: The store can be reviewed and fuzzed before it is allowed to affect query startup.

#### 2.2 — Publish complete clean generations atomically

- [ ] **File**: `src/reindex/shared-generation-store.ts` (new), `src/reindex/index.ts:1044-1207`, `src/reindex/sqlite-generation-store.ts:88-110`
- **Source**: `scip-query code publishFreshReindexArtifacts`; `scip-query plan-context promoteReindexArtifacts`; `scip-query code sqliteGenerationIdentity`
- **What**: Local publication has atomic replacement/recovery, but successful clean indexes are not exported for siblings.
- **Change**: After local publication succeeds, permit shared publication only when metadata is complete and the worktree was clean at both the pre-build and post-build checks with the same tree object and project fingerprint. Stage allowlisted artifacts into a sibling temporary generation directory, validate hashes and completeness, close all handles, and atomically rename it to the immutable generation ID. If that ID already exists and validates, keep it. If a worktree changes during indexing, retain the correct local result and skip shared publication.
- **Testability**:
  - Test seam: `validatePublishCandidate()` and `publishSharedGeneration()`.
  - Injected dependencies: filesystem, Git-context reader, clock, artifact inspector, and atomic renamer.
  - Pure core: pre/post snapshot comparison and manifest construction.
  - Side-effect shell: staging, hashing, directory sync/rename, and cleanup.
  - Contract: incomplete, partial, dirty, changing, or incompatible caches never become visible; a crash leaves either no generation or one complete immutable generation.
- **Validation**: Extend `tests/reindex/shared-generation-store.test.ts` with failure injection at every staged file and before/after rename; extend `tests/reindex/reindex-reliability.test.ts` to assert a successful clean reindex publishes and a dirty/partial one does not. Run `npm test -- tests/reindex/shared-generation-store.test.ts tests/reindex/reindex-reliability.test.ts tests/reindex/sqlite-generation-store.test.ts`.
- **Why**: Publish-after-local-success preserves the existing correctness path and makes shared caching a reversible optimization.

#### 2.3 — Bootstrap a generation from a matching live worktree cache

- [ ] **File**: `src/reindex/shared-generation-store.ts` (new), `src/runtime/config.ts:497-537`, `src/runtime/index-freshness.ts:38-98`
- **Source**: `scip-query plan-context resolveCacheDir`; `scip-query code getIndexFreshness`; `scip-query code inspectSqliteGeneration`
- **What**: Existing users may have a fresh path-scoped index in the primary checkout but no shared generation yet. A first linked worktree would otherwise pay one migration-era cold build.
- **Change**: On an exact shared miss, inspect only default-managed caches for live worktrees in the same repository. Accept a peer candidate only when its metadata, indexed languages, generation state, and full project-input fingerprint exactly match the clean target snapshot. Do not require the peer's current working files to remain clean: if its stable cache still describes the target's committed baseline, later dirty peer edits must not invalidate that reusable generation. Stage through the same publisher, compare the peer generation identity before and after staging to detect concurrent replacement, and reject rather than retrying from mixed files. Never inspect or adopt a custom override path.
- **Testability**:
  - Test seam: `findPeerGenerationCandidate()` and `validatePeerGenerationCandidate()`.
  - Injected dependencies: live-worktree provider, cache-path resolver, artifact inspector, and generation-state reader.
  - Pure core: candidate ordering and compatibility decision.
  - Side-effect shell: peer metadata/artifact reads and shared publication.
  - Contract: a stable complete legacy generation can seed once when its artifact fingerprint matches the clean target; stale, partial, changing, mismatched, or overridden caches are ignored without writes to their directories.
- **Validation**: Add primary-plus-linked-worktree fixtures where the primary cache matches and its files stay clean, the primary files become dirty after that matching cache was published, the cache itself represents dirty content, the cache is replaced during staging, or the primary uses a custom path. Assert both stable exact-cache cases import and every other case misses. Run `npm test -- tests/reindex/shared-generation-store.test.ts tests/runtime/index-freshness.test.ts`.
- **Why**: This provides the desired warm first worktree after upgrade without treating the mutable primary checkout as the cache's permanent parent.

### Phase 3 — Hydrate before reads and coordinate cold reindexes

After this phase the core feature is useful. It remains deployable because every shared failure falls back to the current local behavior and the environment opt-out restores the old path immediately.

#### 3.1 — Hydrate an exact generation into local stable paths

- [ ] **File**: `src/reindex/shared-generation-store.ts` (new), `src/reindex/sqlite-generation-store.ts:88-110`, `src/reindex/merge.ts:79-96`
- **Source**: `scip-query plan-context promoteReindexArtifacts`; `scip-query code inspectSqliteGeneration`; `scip-query code mergeMetadata`
- **What**: Query readers require local stable paths, and later local reindex merges require SCIP metadata rooted at the current checkout.
- **Change**: Clone allowlisted generation artifacts into local temporary paths, rebind staged SCIP roots, validate the manifest hashes for corruption, and use `promoteReindexArtifacts()` for the final local handoff. Then run `inspectSqliteGeneration()` and existing freshness checks. Write or refresh the worktree lease only after local validation succeeds. On any error, delete staging and keep the prior local generation untouched.
- **Testability**:
  - Test seam: `hydrateSharedGeneration()`.
  - Injected dependencies: artifact cloner, SCIP codec, local promoter, generation inspector, and lease writer.
  - Pure core: staging map and root-rebase plan.
  - Side-effect shell: copies, protobuf rewrite, promotion, inspection, and lease write.
  - Contract: success yields a private, fresh local cache for the target root; failure cannot mutate shared files or replace a valid local cache.
- **Validation**: Add crash/mismatch/root-rebase tests and an inode/content test proving a later local write leaves shared bytes unchanged. Run `npm test -- tests/reindex/shared-generation-store.test.ts tests/reindex/sqlite-generation-store.test.ts tests/reindex/reindex-merge.test.ts`.
- **Why**: Keeping readers on local paths avoids invasive database changes and preserves existing watcher and recovery behavior.

#### 3.2 — Prepare the cache before query opens and hook refreshes

- [ ] **File**: `src/runtime/cli-context.ts:21-93`, `src/runtime/cli.ts:26-44`, `src/runtime/agent-hooks.ts:650-739`
- **Source**: `scip-query code resolveCliProjectContext`; `scip-query code openProjectDb`; `scip-query code refreshIndexForHookIfNeeded`; `scip-query code src/runtime/cli.ts:1-80`
- **What**: CLI and hook paths can open or refresh a worktree before checking for a reusable repository generation.
- **Change**: Add `prepareWorktreeIndex()` between path resolution and watcher/database use. For index-reading commands and session hooks, return immediately for a fresh local index; otherwise resolve the exact snapshot, attach/import an exact shared generation synchronously, or record a miss and preserve the existing missing/stale behavior. Exclude commands that intentionally manage setup, reindex, watch, or explicit paths where preparation would recurse. Start the watcher only after preparation so it observes the hydrated local generation.
- **Testability**:
  - Test seam: `prepareWorktreeIndex()` with a fake generation store and command classifier.
  - Injected dependencies: context resolver, freshness reader, Git-context reader, shared store, logger.
  - Pure core: command eligibility and local-fresh/attach/miss decision.
  - Side-effect shell: hydration and diagnostic recording.
  - Contract: an exact hit exists locally before `openProjectDb()`; a miss retains current command semantics; opt-out/override never touches the shared store.
- **Validation**: Extend `tests/runtime/cli-context.test.ts`, `tests/runtime/cli-contract.test.ts`, and `tests/runtime/agent-hooks.test.ts`; prove ordering (`hydrate` before `ensureWatchServiceForCommand` and DB open), recursion exclusions, hit, miss, stale local replacement, and failure fallback. Run `npm test -- tests/runtime/cli-context.test.ts tests/runtime/cli-contract.test.ts tests/runtime/agent-hooks.test.ts tests/runtime/watch-service.test.ts`.
- **Why**: One preparation boundary makes the feature apply to humans, agents, and Conductor without client-specific hooks.

#### 3.3 — Coordinate reindex ownership per generation

- [ ] **File**: `src/reindex/shared-generation-store.ts` (new), `src/reindex/index.ts:247-354`, `src/reindex/index.ts:1850-1917`
- **Source**: `scip-query plan-context reindex`; `scip-query code acquireReindexLock`; `scip-query code tryAcquireReindexLock`
- **What**: Reindex locks are local to each worktree, so simultaneous cold worktrees can run the same language indexer independently.
- **Change**: Before a clean reindex with no exact generation, atomically acquire `locks/<generation-id>.lock`. The owner continues through the existing local reindex and shared publication. Followers wait with bounded backoff for the atomic generation, hydrate when it appears, reclaim a stale lock only when its process is dead, and fall back to the current local reindex after a bounded timeout or unrecoverable store failure. Keep the existing local lock for same-worktree safety. Do not serialize different generation IDs.
- **Testability**:
  - Test seam: `decideGenerationLock()` and a reindex orchestrator using a fake builder.
  - Injected dependencies: clock, process liveness, atomic lock I/O, waiter, and local reindex callback.
  - Pure core: ownership/reclaim/timeout state transitions.
  - Side-effect shell: lock creation/removal, wait polling, build, publish, and hydrate.
  - Contract: one live owner per exact generation in normal operation; dead owners are reclaimable; all fallbacks produce correct local results even if duplicate work occurs.
- **Validation**: Add deterministic lock-state tests and an integration test launching four reindexes at one clean `HEAD`; assert one indexer invocation, three attaches, no leaked lock, and equal normalized facts. Cover owner crash, publish failure, timeout, and two different snapshots building concurrently. Run `npm test -- tests/reindex/shared-generation-store.test.ts tests/reindex/reindex-reliability.test.ts` plus the new worktree integration test.
- **Why**: Per-generation coordination removes the observed contention without turning the repository cache into a global bottleneck.

#### 3.4 — Preserve local dirty overlay behavior explicitly

- [ ] **File**: `src/reindex/index.ts:600-744`, `src/reindex/typescript-incremental-index.ts:106-343`, `src/reindex/incremental-sqlite-publication.ts:100-171`, `src/runtime/watch.ts:267-307`
- **Source**: `scip-query code runLanguageIndexersForFreshReindex`; `scip-query code planTypeScriptIncrementalUpdate`; `scip-query code tryMaterializeTypeScriptIncrementalIndex`; `scip-query code patchIncrementalSqliteGeneration`; `scip-query code Watcher.runReindex`
- **What**: Existing watcher and reindex code can incrementally replace affected TypeScript documents in a local database, with full fallback for ineligible change classes.
- **Change**: Thread the lease's base-generation identity into reindex diagnostics only; continue to pass hydrated local artifacts through the existing incremental planner and publisher. Add a hard publication guard that any dirty pre/post Git state cannot call the shared publisher. When the worktree returns clean at an existing exact generation, attach that generation instead of publishing the former dirty overlay.
- **Testability**:
  - Test seam: existing incremental planner plus `validatePublishCandidate()`.
  - Injected dependencies: Git state reader and fake shared publisher.
  - Pure core: existing affected-set calculation and clean/publication gate.
  - Side-effect shell: watcher worker and local SQLite publication.
  - Contract: modified existing sources may update locally; added/deleted/config changes retain full local fallback; no dirty result enters the shared store.
- **Validation**: Extend `tests/reindex/typescript-incremental-index.test.ts`, `tests/reindex/incremental-sqlite-publication.test.ts`, and `tests/runtime/watch.test.ts` with two sibling worktrees making disjoint edits. Assert each local query sees only its edit, shared manifest/files remain unchanged, and cleaning/resetting one checkout reattaches the committed generation. Run the focused tests.
- **Why**: This proves that “forking” the cache means a shared immutable base plus private evolution, not a mutable cache tree shared by processes.

### Phase 4 — Make cleanup follow Git worktree liveness

This phase is deployable independently of evidence sharing. Cleanup only handles paths carrying a valid scip-query ownership record under the default managed cache root.

#### 4.1 — Add leases and a pure cleanup policy

- [ ] **File**: `src/runtime/repository-cache-lifecycle.ts` (new), `src/runtime/watch-service.ts:261-280`, `src/runtime/watch-service.ts:553-560`
- **Source**: `scip-query code stopWatchService`; `scip-query code cleanupWatchServiceFiles`; `scip-query code classifyWatchServiceState`
- **What**: Existing cleanup can stop one known watcher and remove its control files, but it does not connect cache directories to live Git worktrees or shared generations.
- **Change**: Store one versioned lease per worktree with canonical worktree path, default-managed local cache path, repository ID, base/active generation IDs, last-seen time, and ownership checksum. Implement `planRepositoryCacheSweep()` as a pure mark-and-sweep policy. A lease absent from `git worktree list` and whose canonical path no longer exists makes its local cache immediately eligible; a live path, live watcher/build PID, or live lock protects it. Only paths that resolve under the managed cache root and match their recorded worktree/path hash may be deleted.
- **Testability**:
  - Test seam: lease parser/validator and `planRepositoryCacheSweep()`.
  - Injected dependencies: clock, live-worktree list, path existence/canonicalization, process liveness.
  - Pure core: reachability marking and ordered cleanup actions.
  - Side-effect shell: lease reads/writes, watcher stop, and recursive deletion.
  - Contract: malformed/symlinked/unowned/custom paths are never deleted; disappeared managed worktrees are eligible on the next sweep.
- **Validation**: Add `tests/runtime/repository-cache-lifecycle.test.ts` covering removed, pruned, renamed, recreated, malformed, symlink-escape, live-PID, custom-cache, and partial-deletion cases. Run `npm test -- tests/runtime/repository-cache-lifecycle.test.ts tests/runtime/watch-service.test.ts`.
- **Why**: Ownership proof and a pure deletion plan make aggressive hour-scale cleanup safe.

#### 4.2 — Apply one-hour generation retention and a size budget

- [ ] **File**: `src/runtime/repository-cache-lifecycle.ts` (new), `src/reindex/shared-generation-store.ts` (new)
- **Source**: `scip-query code pruneTypeScriptFragmentGenerations`; `scip-query code pruneTypeScriptOverlays`; `scip-query plan-context promoteReindexArtifacts`
- **What**: Existing pruning is local to fragment/overlay stores and does not bound repository generations.
- **Change**: Protect every generation referenced by a live lease or build lock. For unreferenced generations, default to a one-hour TTL, then delete oldest unreferenced generations until a default 2 GiB repository budget is met. Protected generations may temporarily exceed the budget. Keep TTL, sweep cadence, and budget as injectable policy constants rather than public config in the first release. Remove temp generations and stale locks only after their owner is dead.
- **Testability**:
  - Test seam: `planRepositoryCacheSweep()` with a complete synthetic inventory.
  - Injected dependencies: clock and process-liveness predicate.
  - Pure core: protection, expiry, size accounting, and oldest-first ranking.
  - Side-effect shell: measured directory inventory and deletion.
  - Contract: one-hour-unreferenced and over-budget artifacts are collectible; live leases/locks are never selected; deletion is idempotent.
- **Validation**: Use a fake clock to test 59 minutes/60 minutes, budget pressure, protected over-budget state, stale temp/lock, concurrent new lease, and repeated sweep. Run `npm test -- tests/runtime/repository-cache-lifecycle.test.ts`.
- **Why**: Hours match short-lived agent worktree churn while live-reference protection prevents premature eviction.

#### 4.3 — Trigger bounded cleanup from normal CLI and watcher activity

- [ ] **File**: `src/runtime/cli.ts:26-44`, `src/runtime/watch-server.ts:44-220`, `src/runtime/repository-cache-lifecycle.ts` (new)
- **Source**: `scip-query code src/runtime/cli.ts:1-80`; `scip-query code runWatchServiceServer`; `scip-query code ensureWatchServiceForCommand`
- **What**: Git worktrees can disappear without a scip-query process receiving a teardown event.
- **Change**: Run a cheap, lock-protected, at-most-once-per-five-minutes sweep attempt from CLI `preAction`; let the long-running watcher request the same throttled sweep from its existing loop. The caller that acquires the sweep lease performs cleanup; other callers return immediately. Cleanup failures are recorded and never block a query or reindex.
- **Testability**:
  - Test seam: `maybeSweepRepositoryCache(now, state, io)`.
  - Injected dependencies: clock, sweep-lock I/O, lifecycle planner, logger.
  - Pure core: throttle/ownership decision.
  - Side-effect shell: CLI/watcher invocation and cleanup executor.
  - Contract: no more than one active sweep per repository/cadence; failures degrade to retained cache, not command failure.
- **Validation**: Extend CLI, watch-server, and lifecycle tests for throttle, simultaneous callers, crashed sweeper, failed deletion, and successful retry. Add a disposable-repository smoke test that removes linked worktrees without Conductor and observes their caches disappear on the next forced sweep. Run the focused tests.
- **Why**: Opportunistic generic triggers provide cleanup even when the worktree creator has no teardown integration.

### Phase 5 — Add conservative repository-level evidence read-through

This phase is optional for shipping the index-generation feature and must land after core isolation/cleanup is proven. It is a separate rollback unit because SQLite contention and invalidation have different risks from immutable index reuse.

#### 5.1 — Add a shared evidence connection with a strict product allowlist

- [ ] **File**: `src/storage/evidence-cache.ts:182-369`, `src/storage/evidence-products.ts:68-188`, `src/domain/config-types.ts:77-100`, `src/runtime/cli-context.ts:52-74`
- **Source**: `scip-query plan-context connectionFor`; `scip-query code EVIDENCE_PRODUCT_MANIFEST`; `scip-query code createFileEvidenceProduct`; `scip-query code openProjectDb`
- **What**: Every worktree creates a local `evidence.db`. The existing local table primary keys keep only one content version per relative path, and the same database also holds worktree-specific finding outcomes.
- **Change**: Add an optional internal `sharedEvidenceDbPath` to `ScipQueryConfig` only for default-managed Git worktrees. Inside `connectionFor()`, retain the current local connection as authoritative and open a best-effort repository connection with tables whose primary keys include every lookup field, content/project identity, and payload version. Initially allow only `source-facts`, `definition-exclusions`, `doc-path-tokens`, and `react-component-behavior-profiles`, derived and asserted from `EVIDENCE_PRODUCT_MANIFEST`. Reads check local then shared; writes commit local then best-effort shared. Do not share project evidence, semantic callees/references, legacy rows, or `finding_outcome_ledger` in this phase.
- **Testability**:
  - Test seam: existing public evidence read/write functions plus `sharedEvidenceEligibleKinds()`.
  - Injected dependencies: local/shared SQLite openers and debug logger.
  - Pure core: allowlist derivation and local/shared read order.
  - Side-effect shell: two SQLite connections and best-effort writes.
  - Contract: local hits win; safe shared hits fill work; either shared open/read/write failure becomes a miss/no-op; all non-allowlisted and outcome data remains local.
- **Validation**: Extend `tests/storage/evidence-cache.test.ts` and `tests/storage/evidence-products.test.ts` for cross-worktree hit, same relative path with two content hashes, local precedence, schema/version mismatch, locked/corrupt shared DB, allowlist drift, and outcome isolation. Run `npm test -- tests/storage/evidence-cache.test.ts tests/storage/evidence-products.test.ts`.
- **Why**: The measured workload recomputed thousands of evidence rows, but immutable index reuse should not be coupled to a broad unproven evidence-sharing migration.

#### 5.2 — Bound and observe the shared evidence database

- [ ] **File**: `src/storage/evidence-cache.ts:182-326`, `src/runtime/repository-cache-lifecycle.ts` (new)
- **Source**: `scip-query plan-context connectionFor`; `scip-query code projectEvidenceFingerprint`
- **What**: A repository-level SQLite cache survives individual worktrees and can grow or contend independently of generation cleanup.
- **Change**: Record shared hit/miss/write-disable counters in existing profiling/diagnostic channels. Add a sweep action that checkpoints WAL when safe and deletes least-recently-used safe-product rows above an injectable byte/row budget; never delete or migrate the local database. If SQLite cannot be maintained, close/disable the shared connection for that process and continue locally.
- **Testability**:
  - Test seam: evidence maintenance planner and existing profiled read paths.
  - Injected dependencies: SQLite stats/checkpoint executor, clock, and logger.
  - Pure core: budget/eviction selection.
  - Side-effect shell: checkpoint, row deletion, and connection disable.
  - Contract: maintenance is bounded and best-effort; query correctness never depends on shared evidence availability.
- **Validation**: Add budget, locked-WAL, corrupt-db, concurrent-reader/writer, and repeated-maintenance tests; compare query results with `SCIP_QUERY_SHARED_CACHE=0` and enabled. Run the storage tests and the disposable multi-worktree smoke suite.
- **Why**: Repository lifetime is longer than worktree lifetime, so shared evidence needs its own bounded lifecycle.

### Phase 6 — Expose diagnostics, document the contract, and prove the workload

#### 6.1 — Extend status with shared-cache and cleanup state

- [ ] **File**: `src/runtime/commands/command-handlers.ts:1098-1148`, `src/runtime/commands/command-handlers.ts:1582-1679`
- **Source**: `scip-query code buildProjectDiagnosticReport`; `scip-query code handleStatus`; `scip-query code renderStatusReport`
- **What**: Status already reports local project/database freshness, watcher, shadow, and SQLite generation but cannot explain shared reuse or cleanup.
- **Change**: Add an additive JSON object and concise human section containing repository/worktree IDs, managed/override/opt-out state, local/base/active generation, last action (`local-fresh`, `attached`, `peer-imported`, `built`, `waited`, `missed`, `bypassed`, `failed`), reason, shared evidence state, last sweep, protected/unreferenced generation counts, and bytes. Redact cache roots consistently with current path output conventions; never list sibling worktree file contents.
- **Testability**:
  - Test seam: diagnostic report builder and renderer.
  - Injected dependencies: shared manifest/lease/GC-state readers.
  - Pure core: report normalization and human formatting.
  - Side-effect shell: state-file reads.
  - Contract: JSON fields are additive/stable and human/JSON values agree; missing/corrupt diagnostics do not fail status.
- **Validation**: Extend the status assertions in `tests/runtime/runtime-config.test.ts` for every action/reason and malformed state. Run `npm test -- tests/runtime/runtime-config.test.ts`.
- **Why**: Maintainers need to distinguish a correct miss, opt-out, corruption fallback, lock wait, and cleanup lag without reading source.

#### 6.2 — Document user-visible behavior and rollback

- [ ] **File**: `README.md:435-448`, `README.md:563-590`, `docs/architecture/evidence-cache-invalidation.md:63-120`, `docs/benchmarks/2026-07-14-git-worktree-shared-cache.md` (new)
- **Source**: `scip-query plan-context resolveCacheDir`; `scip-query plan-context connectionFor`; `scip-query code handleStatus`
- **What**: Documentation describes path-scoped caches and treats cross-checkout evidence sharing as design-only; it does not define generic worktree reuse, override behavior, retention, or rollback.
- **Change**: Document immutable shared generations versus writable worktree caches, automatic Git detection, one-hour unreferenced retention, managed-path deletion limits, override bypasses, and `SCIP_QUERY_SHARED_CACHE=0`. Update the evidence design only to the actually shipped allowlist. Record benchmark hardware/repository, cold control, warm attach, concurrency, dirty isolation, and cleanup results in a dated benchmark ledger.
- **Testability**:
  - Test seam: documentation examples executed by the disposable smoke script.
  - Injected dependencies: temporary repository/cache root and environment.
  - Pure core: none; this is contract documentation.
  - Side-effect shell: smoke commands and benchmark capture.
  - Contract: every documented default, bypass, retention rule, and status field has an automated or recorded validation.
- **Validation**: Run `scip-query co-change README.md --json --full`, `scip-query doc-drift README.md --json --full`, the documentation examples, and `git diff --check`.
- **Why**: This feature changes disk lifetime and startup behavior; users need an exact mental model and an immediate rollback.

#### 6.3 — Run end-to-end worktree and performance acceptance

- [ ] **File**: `tests/reindex/shared-worktree-cache.integration.test.ts` (new), `docs/benchmarks/2026-07-14-git-worktree-shared-cache.md` (new)
- **Source**: `scip-query plan-context reindex`; `scip-query code openProjectDb`; `scip-query code Watcher.runReindex`; `scip-query code connectionFor`
- **What**: Unit seams prove decisions, but the user-visible contract spans Git, filesystem cloning, reindex subprocesses, SQLite, watchers, and cleanup.
- **Change**: Build a disposable Git repository fixture and isolated cache root. Exercise primary-cache bootstrap, four concurrent same-`HEAD` linked worktrees, two different snapshots, disjoint dirty edits, watcher refresh, worktree removal, forced sweep, opt-out, and custom cache overrides. Instrument language-indexer invocations and evidence rows. Compare normalized per-document SCIP/SQLite facts and query output, never raw file hashes, for semantic parity.
- **Testability**:
  - Test seam: one integration harness with injectable executable/cache root and forced clock/sweep controls.
  - Injected dependencies: temporary Git repository, cache root, fixture indexer counter, and clock controls.
  - Pure core: normalized fact comparison.
  - Side-effect shell: real CLI processes, linked worktrees, watchers, and SQLite files.
  - Contract: exact-snapshot worktrees attach without an indexer; dirty siblings remain isolated; cleanup removes only disappeared managed caches; every fallback matches cold local query results.
- **Validation**: Require: (1) one build/publish for four simultaneous exact snapshots; (2) zero language-indexer calls on subsequent worktree attach; (3) warm attach materially faster than the cold control and near the existing no-edit reuse baseline; (4) normalized facts/query output equal; (5) dirty edits visible only in their worktree; (6) removed local caches gone after a forced sweep, live generation retained, then unreferenced generation removed after the fake one-hour boundary; (7) opt-out and overrides untouched. Record actual timings rather than imposing an unmeasured fixed latency threshold.
- **Why**: The feature is successful only if it removes real parallel-worktree duplication without changing answers or deleting user-owned data.

## Stress-Test Findings

| Lens                     | Finding and resolution                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Purpose                  | The path hash currently guarantees isolation. Preserve that invariant by keeping local stable paths and using the shared store only as an immutable source.                                                                                                                                                                                       |
| Blast radius             | `resolveIndexStoragePaths()` feeds CLI, hooks, watcher, worker, and setup paths. Avoid changing its default local result; add preparation/publication around it. `connectionFor()` has many consumers, so evidence sharing stays inside its existing boundary.                                                                                    |
| Valid intermediate state | Phase 1 is a no-op refactor. Phase 2 creates an unused/opt-out store. Phase 3 ships core reuse with local fallback. Phase 4 adds independently safe cleanup. Phase 5 is optional and separately reversible. Phase 6 exposes and proves behavior.                                                                                                  |
| Reversibility            | Shared generations and evidence are rebuildable. `SCIP_QUERY_SHARED_CACHE=0` is the immediate rollback; bypassing shared reads/writes leaves existing local caches usable. Manifest/schema version changes create new identities rather than migrating in place.                                                                                  |
| Failure                  | Missing/corrupt/incompatible shared data is a cache miss. Failed staging cannot replace a valid local cache. Failed cleanup retains data. Failed evidence sharing degrades to local behavior.                                                                                                                                                     |
| Concurrency              | Locks are per exact generation, publication is atomic, and shared artifacts are immutable. Different snapshots build concurrently. A bounded wait avoids permanent stalls; stale locks require dead-owner proof before reclamation.                                                                                                               |
| Boundaries               | Git/environment/manifest input is parsed at runtime boundaries. Paths are canonicalized and containment-checked before any deletion or shared read. Explicit user overrides opt out of automatic sharing and ownership.                                                                                                                           |
| Data integrity           | Publish builds only from complete clean snapshots; import peers only when their stable complete artifact fingerprint equals the clean target even if their current files later became dirty. Compare pre/post identities, validate artifact catalogs and corruption hashes, rebind SCIP roots locally, and use existing local promotion/recovery. |
| Observability            | Status records action/reason, identities, locks, lease, cleanup counts/bytes, and evidence state. Failures remain visible even though they do not fail queries.                                                                                                                                                                                   |
| Human experience         | A worktree created by any tool becomes warm automatically when an exact generation exists. A correct miss behaves as today and explains why. Cleanup happens within hours without requiring users to know Conductor internals.                                                                                                                    |
| Reuse                    | Existing local paths, freshness, incremental TypeScript planner, SQLite patcher, promotion/recovery, watcher, evidence APIs, and status are extended. New units exist only for Git identity, cross-worktree artifact lifecycle, and cleanup policy not represented today.                                                                         |
| Testability              | Selection, locking, path safety, reachability, and eviction are pure decisions. Git, filesystem, process, clock, SQLite, and protobuf operations sit behind injected contracts and are exercised again in a disposable real-process suite.                                                                                                        |

Accepted tradeoffs:

- The first exact snapshot with neither a shared generation nor a stable matching peer still performs one cold local build. Correctness and current CLI behavior take priority over silently turning every query into an implicit reindex.
- A bounded lock timeout may allow duplicate local builds after store or owner failure. It must never produce an incorrect attachment or block indefinitely.
- Hydrating/rebasing SCIP artifacts performs some filesystem/protobuf work. It is expected to be far cheaper than compiler indexing and avoids making mutable local consumers read directly from a shared directory.
- The first evidence-sharing allowlist is intentionally narrow. Products whose invalidation includes project, Git, import-resolution, config, or dependency state remain local until their complete storage keys and stale-read tests prove safe.

## Execution Order and deployable phase notes

1. Land Phase 1 and run the full suite. It changes shared utilities but not cache placement or lifetime.
2. Land Phase 2 behind `SCIP_QUERY_SHARED_CACHE=0` and with no startup consumer until atomicity/failure-injection tests pass. Inspect created manifests manually in a disposable cache.
3. Land Phase 3 with the opt-out documented in the same change. This is the first user-visible warm-cache release; run concurrency and dirty-isolation acceptance before enabling it by default.
4. Land Phase 4 after path-ownership and symlink-escape tests pass. Start with the one-hour TTL and five-minute sweep cadence already encoded in tests; cleanup failure must remain retain-only.
5. Land Phase 5 separately. Do not block core worktree reuse on evidence sharing; measure SQLite contention before expanding the allowlist.
6. Land Phase 6 diagnostics/docs alongside their corresponding visible behavior, then record final benchmark numbers.

At the end of every code phase, run the focused tests named in the checklist, then:

```bash
npm run typecheck
npm run lint
npm test
npm run build
scip-query reindex
scip-query diff-gate
```

Run the repository-prescribed targeted checks whenever the implementation shape triggers them: `scip-query recent-duplicates` for new helpers, `scip-query unused-params` for injected contracts, `scip-query incomplete-migration` after extracting Git/fingerprint logic, `scip-query wrapper-candidates` for new boundaries, and `scip-query co-change <file>` for manifest/config/schema changes. Commit generated `.scipquery/suppressions/*.json` and `.scipquery/events/*.json` with the change that produced them; never commit `.codex/hooks.json` or `.claude/settings.local.json`.

## Ship Order and one-way doors

1. **Two-way door:** Git identity/fingerprint refactor. Roll back to private helpers without touching persisted data.
2. **Two-way door:** Versioned shared generation store with opt-out. Generations are disposable and old local caches remain valid.
3. **Two-way door:** CLI/hook hydration and build coordination. Disable with `SCIP_QUERY_SHARED_CACHE=0`; no local database schema changes are required.
4. **One-way operational door:** Automatic deletion. Although caches are rebuildable, a deletion cannot be undone. Ship only after managed-path ownership, symlink containment, live-lock protection, dry inventory diagnostics, and disposable cleanup acceptance pass. Keep failures retain-only.
5. **One-way compatibility door:** Any promise that external tools may consume the repository cache layout. Do not make that promise in this release; manifests and directories remain internal and versioned.
6. **Two-way door with schema data:** Shared evidence read-through. The database is disposable and optional, but expand its allowlist only through explicit invalidation-key tests and a manifest review.

## File summary

### Create

- `src/runtime/git-worktree.ts`
- `src/reindex/index-artifacts.ts`
- `src/reindex/shared-generation-store.ts`
- `src/runtime/repository-cache-lifecycle.ts`
- `tests/runtime/git-worktree.test.ts`
- `tests/reindex/index-artifacts.test.ts`
- `tests/reindex/shared-generation-store.test.ts`
- `tests/runtime/repository-cache-lifecycle.test.ts`
- `tests/reindex/shared-worktree-cache.integration.test.ts`
- `docs/benchmarks/2026-07-14-git-worktree-shared-cache.md`

### Edit

- `src/runtime/config.ts`
- `src/runtime/cli-context.ts`
- `src/runtime/cli.ts`
- `src/runtime/agent-hooks.ts`
- `src/runtime/watch.ts`
- `src/runtime/watch-server.ts`
- `src/runtime/watch-service.ts`
- `src/runtime/commands/command-handlers.ts`
- `src/runtime/index-freshness.ts`
- `src/reindex/project-files.ts`
- `src/reindex/index.ts`
- `src/reindex/merge.ts`
- `src/reindex/sqlite-generation-store.ts` only if a narrow export is required for the existing promoter/inspector; do not move repository lifecycle into it
- `src/reindex/typescript-fragment-store.ts` and `src/reindex/typescript-overlay-store.ts` only to expose canonical artifact paths
- `src/storage/evidence-cache.ts`
- `src/storage/evidence-products.ts`
- `src/domain/config-types.ts`
- relevant existing runtime/reindex/storage tests named in the phases
- `README.md`
- `docs/architecture/evidence-cache-invalidation.md`

### Delete

- No production or persisted user files during implementation. Remove duplicated private Git/fingerprint helpers only after their consumers migrate and `scip-query incomplete-migration` passes.

### Verify

- Every exact snapshot/compatibility mismatch is a miss, never a stale hit.
- Shared generation directories remain byte-stable after dirty sibling reindexes.
- Local hydrated artifacts have the target SCIP root and remain independently writable.
- Same-generation concurrency normally invokes one compiler/indexer; different generations proceed independently.
- Removed managed worktree caches are collectible immediately; live and locked generations are protected; unreferenced generations expire at one hour and obey the size budget.
- Custom overrides and opt-out paths receive no shared reads, writes, leases, locks, or deletion.
- Shared evidence failures and non-allowlisted products retain local behavior.
- Normalized query facts match the cold control across clean attach, dirty divergence, refresh, and reattach.
- Full typecheck, lint, test, build, `scip-query reindex`, and `scip-query diff-gate` pass, with all repository records retained.
