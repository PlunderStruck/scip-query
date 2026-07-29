# Worktree cache forks with private overlays

Date: 2026-07-29

## Goal

Make a newly created Git worktree reuse the immutable scip-query generation for
its committed `HEAD` even when the worktree has already acquired local edits
before its first reindex. The reused generation becomes the worktree's baseline;
the existing incremental indexers and per-language/per-project shard caches then
materialize a private overlay containing only that worktree's changes.

This plan does not add Redis and does not make query execution merge two live
databases. The shared generation is an immutable, content-addressed disk
snapshot. On filesystems that support clone-on-write, scip-query's existing
clone primitive gives the worktree private paths without duplicating unchanged
data blocks. The ordinary copy fallback preserves correctness on other
filesystems.

## Definitions and invariants

A **shared baseline generation** is a complete immutable set of scip-query
artifacts produced from one clean committed Git tree under one exact indexer
configuration. It is wider than a database snapshot because it includes the
SQLite database, SCIP files, reindex metadata, language shards, and compatible
incremental stores. Its defining characteristic is that its tree identity and
indexer configuration were fixed before publication and its artifacts cannot be
mutated by a worktree.

A **worktree overlay** is the private derived cache of one Git worktree whose
starting artifacts came from a shared baseline and whose later artifacts
describe that worktree's uncommitted state. It is a local index generation
differentiated by exclusive ownership: local reindex may replace it, while no
overlay write may alter the baseline or another worktree's cache.

A **cache fork** is the transition that materializes a shared baseline into a
worktree-owned cache before applying local changes. It is a cache reuse
operation differentiated by lineage: the resulting lease remembers the
baseline generation even after the local active generation diverges.

The following invariants are mandatory:

1. A baseline candidate must have the same repository identity, `HEAD` tree
   object, producer identity, requested language set, and normalized indexer
   configuration as the dirty worktree.
2. File-content fingerprints do not need to match the dirty worktree; they
   describe the clean committed baseline. Current local files are fingerprinted
   normally after attachment and decide which shards are rebuilt.
3. A complete usable local generation always wins over a shared baseline. A
   baseline must never replace more recent private worktree evidence merely
   because that evidence is stale relative to current files.
4. Shared artifacts are read-only inputs. Hydration uses the existing private
   clone/copy, root rebasing, integrity validation, rollback, and atomic
   promotion path.
5. A dirty result is never published as a shared generation.
6. A baseline lease protects the immutable generation from repository cache
   collection while the worktree remains live. Once local indexing diverges,
   `baseGenerationId` remains set and `activeGenerationId` is absent.
7. A missing, corrupt, incompatible, concurrently removed, or disabled shared
   baseline falls back to the existing isolated reindex. Cache reuse is an
   optimization, not a correctness dependency.
8. Explicit cache/database overrides and `SCIP_QUERY_SHARED_CACHE=0` retain
   their current behavior and perform no automatic baseline lookup.
9. Query preflight does not expose an unrefreshed baseline as current evidence.
   Dirty baseline attachment occurs inside reindex, where refresh completes
   before the caller can query it.

## Premises

1. `resolveGitWorktreeContext()` is the authority for repository ID, worktree
   ID, `HEAD` tree object, and cleanliness. Its Git subprocess is the sole
   writer of none of these facts; Git repository state is the external
   authority. Readers in this change are the baseline selector, reindex
   orchestrator, publisher, and lease writer.
2. `generations/<generation-id>/manifest.json` is the authority for a shared
   generation's repository, tree, producer, configuration fingerprint, source
   root, creation time, and artifact inventory. `publishSharedGeneration()` is
   the only writer. Readers are `readSharedGeneration()`, hydration, the new
   baseline selector, status/cleanup inventory, and tests.
3. `projects/<worktree-hash>/meta.json` plus the immutable SQLite generation
   pointer are the authority for whether a local generation is usable as an
   incremental base. Reindex publication writes them. Freshness, reindex reuse,
   incremental planning, and the new local-base guard read them.
4. `repositories/<repository-id>/worktrees/<worktree-id>.json` is the authority
   for shared-cache lineage and cleanup protection. Shared attach/publication
   and the new overlay transition write it under the repository lock. Cache
   inspection and garbage collection read it. The local `shared-cache.json`
   file remains only an ownership pointer to that lease; it is not a database
   indirection record.
5. Per-language fingerprints and files in `language-indexes/` are the authority
   for language-shard reuse. Reindex publication writes them.
   `classifyLanguageShardReuse()` reads them and reruns only mismatched or
   missing shards.
6. TypeScript fragment/overlay stores and the previous project-input snapshot
   are the authority for affected-document incremental indexing.
   `tryMaterializeTypeScriptIncrementalIndex()` reads the attached baseline and
   `publishFreshReindexArtifacts()` publishes the private next generation.
7. Shared generation bytes are written only through staged durable publication.
   Worktree bytes are written only through hydration or local reindex
   publication. No path is permitted to hard-link mutable worktree files to
   immutable shared files.
8. Repository cleanup may delete only unprotected generations. Live or busy
   leases protect both `baseGenerationId` and `activeGenerationId`; therefore
   an overlay lease with only the base field protects its lineage without
   falsely claiming the private local generation equals the shared one.

## Current state

- Clean worktrees derive an exact generation ID from the Git tree, full project
  fingerprint, and producer identity. They attach an existing generation,
  import an exact peer cache, or coordinate one cold builder.
- `hydrateSharedGeneration()` already clones every allowlisted artifact to
  private staging paths, verifies hashes, rebases embedded SCIP roots, validates
  SQLite state, atomically promotes the result, and rolls back a failed handoff.
- `cloneFileDurable()` requests `COPYFILE_FICLONE`, so APFS and other supporting
  filesystems use clone-on-write; unsupported filesystems use a private copy.
- Reindex already reuses unchanged language and TypeScript project shards and
  can incrementally patch changed TypeScript documents.
- `prepareSharedGenerationForProject()` and `reindex()` currently construct
  shared snapshots only when `context.clean` is true. A dirty worktree with no
  local cache therefore starts cold even when its exact `HEAD` baseline exists.
- The current worktree pointer identifies the repository lease but does not
  redirect readers to a shared database. Treating it as such would mix cleanup
  ownership with query routing and would allow stale dirty queries.

## Reuse audit

| Need | Existing owner to reuse | Decision |
| --- | --- | --- |
| Repository/tree/worktree identity | `src/platform/git-worktree.ts` | Reuse unchanged. |
| Manifest validation and artifact integrity | `readSharedGeneration()` / `parseSharedGenerationManifest()` | Reuse after candidate discovery. |
| Configuration normalization | `buildProjectInputFingerprint()` policy in `src/platform/project-files.ts` | Extract a pure configuration projection so selection and fingerprinting cannot drift. |
| Private clone-on-write hydration | `hydrateSharedGeneration()` / `cloneArtifactFile()` | Reuse unchanged. |
| Local-generation validity | `inspectSqliteGeneration()` plus supported `meta.json` | Add one narrow reusable predicate; do not duplicate freshness policy. |
| Language/project shard reuse | `classifyLanguageShardReuse()` and TypeScript project shard planner | Reuse unchanged; integration tests prove the attached baseline reaches them. |
| Changed-document TypeScript overlay | `tryMaterializeTypeScriptIncrementalIndex()` | Reuse unchanged. |
| Lease durability and cleanup protection | `persistWorktreeLease()` / `protectedGenerationIds()` | Add an overlay-specific lease transition using the same lock and checksum. |
| Redis or merged base/delta query storage | No current owner | Defer. It is not required for worktree cache forking and would create a second consistency protocol. |

## Testability design

The selector is a pure compatibility core around a bounded manifest inventory:

- Inputs: resolved Git context, requested languages, normalized indexer
  configuration, repository generation entries.
- Pure decision: reject or rank candidates by exact identity/configuration and
  deterministic creation time/generation ID.
- Side-effect shell: bounded directory/manifest reads, existing artifact
  verification, existing hydration.

The reindex integration has explicit seams:

- local-base predicate;
- baseline selector;
- hydration call;
- status message;
- overlay lease transition after successful private publication.

Failure injection remains at the existing hydration and publication boundaries.
Integration tests use real Git worktrees and the existing deterministic fake
indexer harness where shard invocation counts are required.

## Preregistered evidence and performance checks

Before implementation, the acceptance probes are fixed as follows:

1. A clean primary reindex publishes one immutable shared generation.
2. A linked worktree is created at that commit, edited before its first
   reindex, and has no local `index.db`.
3. Its first dirty reindex reports one baseline fork, completes with fresh
   local evidence, and does not change the shared generation's SHA-256.
4. In a mixed TypeScript/Python fixture where only TypeScript changes, the
   Python shard is reused and its indexer invocation count does not increase.
5. A pre-existing usable local generation causes zero baseline hydration.
6. A generation with a different tree, language set, indexer mode, project
   list, workspace setting, or Clojure config path is rejected.
7. Corruption/removal during selection or hydration produces a correct cold
   local reindex rather than a partial cache.
8. Status shows `baseGenerationId`, no `activeGenerationId`, and an overlay
   action after dirty publication.
9. The shared-cache opt-out and explicit-path overrides cause no selector I/O.

Timing and physical-allocation measurements are observational rather than CI
thresholds because filesystem clone support and runner load vary. The benchmark
ledger will record wall time, logical cloned bytes, allocated blocks where the
host exposes them, shard invocations, and shared-generation hashes. A regression
is blocking if the forked path reruns an unchanged shard or mutates shared
bytes; timing is blocking only if repeated local measurements show it slower
than the existing cold path.

## Slices

### Slice 1 — Normalize and select an exact committed baseline

- **Files**:
  - `src/platform/project-files.ts`
  - `src/reindex/shared-generation-store.ts`
  - `tests/reindex/shared-generation-store.test.ts`
- **Current behavior**: a generation can be addressed only by a full current
  source fingerprint, which a dirty worktree intentionally does not share with
  its committed `HEAD`.
- **Change**:
  - extract the normalized non-file configuration projection used by project
    fingerprints;
  - add a bounded selector that scans only the resolved repository's generation
    directory;
  - accept only manifests with the exact repository, `HEAD` tree, producer,
    languages, and configuration projection;
  - call `readSharedGeneration()` before returning the candidate;
  - rank multiple valid candidates deterministically.
- **Test seam**: pure compatibility predicate plus a temporary repository cache.
- **Validation**:
  - candidate matrix for every identity/configuration field;
  - corrupt and missing artifacts;
  - deterministic selection;
  - `npm test -- tests/reindex/shared-generation-store.test.ts`;
  - `npm run typecheck`, `npm run lint`, and `scip-query diff-gate`.
- **Commit**: `feat: select worktree cache baselines`

### Slice 2 — Fork the baseline before a dirty cold reindex

- **Files**:
  - `src/reindex/index.ts`
  - `src/reindex/shared-generation-store.ts`
  - `tests/reindex/shared-worktree-cache.integration.test.ts`
  - `tests/reindex/reindex-reliability.test.ts`
- **Current behavior**: dirty worktrees skip all shared generation logic; a
  newborn worktree therefore cold-builds every language.
- **Change**:
  - when shared caching is eligible, the worktree is dirty, and no usable local
    generation exists, select and hydrate its exact `HEAD` baseline;
  - preserve any usable local generation;
  - continue through existing fingerprint, shard classification, incremental
    indexing, and atomic publication;
  - emit a concise status identifying the baseline fork;
  - treat selector/hydration failure as a logged local fallback.
- **Test seam**: real worktree fixture and fake mixed-language indexer counts.
- **Validation**:
  - dirty-before-first-run integration;
  - shared hash isolation;
  - unchanged-language reuse;
  - local-cache precedence;
  - `npm test -- tests/reindex/shared-worktree-cache.integration.test.ts tests/reindex/reindex-reliability.test.ts`;
  - `npm run typecheck`, `npm run lint`, and `scip-query diff-gate`.
- **Commit**: `feat: fork shared cache for dirty worktrees`

### Slice 3 — Persist honest baseline/overlay lineage

- **Files**:
  - `src/reindex/shared-generation-store.ts`
  - `src/reindex/index.ts`
  - `src/runtime/repository-cache-lifecycle.ts`
  - `tests/reindex/shared-generation-store.test.ts`
  - `tests/runtime/repository-cache-lifecycle.test.ts`
- **Current behavior**: an attached generation lease says the shared generation
  is both base and active; no transition expresses a private divergent overlay.
- **Change**:
  - add explicit `baseline-attached` and `overlay` lifecycle actions;
  - after successful dirty publication, atomically persist a lease retaining
    `baseGenerationId` and removing `activeGenerationId`;
  - keep cleanup protection and status reporting based on that lease;
  - never write the overlay transition on failed reindex.
- **Test seam**: lease writer with temporary repository cache and sweep planner.
- **Validation**:
  - checksum and parser compatibility;
  - base protection without false active identity;
  - failed-run lease state;
  - `npm test -- tests/reindex/shared-generation-store.test.ts tests/runtime/repository-cache-lifecycle.test.ts tests/reindex/shared-worktree-cache.integration.test.ts`;
  - `npm run typecheck`, `npm run lint`, and `scip-query diff-gate`.
- **Commit**: `feat: record worktree cache overlay lineage`

### Slice 4 — Document and benchmark the cache-fork contract

- **Files**:
  - `README.md`
  - `docs/architecture/evidence-cache-invalidation.md`
  - `docs/benchmarks/2026-07-29-worktree-cache-fork-overlays.md`
  - setup/agent documentation only if generated references describe the cache
    lifecycle
- **Current behavior**: documentation describes clean exact-generation sharing
  and private dirty updates but not dirty-before-first-run baseline forking.
- **Change**:
  - document shared baseline versus private overlay, clone-on-write fallback,
    opt-out, status fields, and cleanup;
  - record the preregistered live benchmark and filesystem allocation facts;
  - avoid instructing agents to reindex more often—watcher freshness rules
    remain authoritative.
- **Validation**:
  - command/reference generation checks if affected;
  - `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`,
    `scip-query reindex` only if freshness is stale after edits, and
    `scip-query diff-gate`;
  - inspect the final public API report.
- **Commit**: `docs: explain worktree cache forks`

## Attack record and coverage matrix

| Attack | Failure if unhandled | Countermeasure | Probe |
| --- | --- | --- | --- |
| Dirty source fingerprint differs from `HEAD` | Exact generation ID cannot be reconstructed | Select by trusted manifest tree/config identity, then let current fingerprint drive rebuilds | dirty-before-first-run integration |
| Wrong branch or moved `HEAD` | Stale facts enter a new worktree | Exact tree-object equality | different-tree rejection |
| Dirty config changes indexer behavior | Baseline artifacts interpreted under incompatible settings | Exact normalized language/indexer configuration | config matrix |
| Dirty peer cache is mistaken for baseline | Uncommitted facts leak across worktrees | Select immutable published generations only; no dirty peer import | shared hash/content assertions |
| Existing local overlay is overwritten | More recent evidence is lost | Usable local generation has precedence | local-cache precedence test |
| Generation disappears during attach | Partial local cache or crash | Existing staged hydration/rollback; cold fallback | concurrent removal/failure injection |
| Shared file is hard-linked and later mutated | Cross-worktree corruption | Existing reflink/private-copy primitive; immutable source modes | shared hash isolation |
| Lease still says shared generation is active | Diagnostics lie and cleanup reasoning drifts | Overlay transition clears active ID, retains base ID | lease/status test |
| Cleanup deletes a live overlay's baseline | Later lineage/reset loses source and concurrent hydration can fail | Base ID remains protected for live/busy lease | sweep-plan test |
| Query opens baseline before dirty refresh | User sees stale committed facts | Restrict baseline attach to reindex, not graph-command preflight | CLI-context contract remains unchanged |
| Shared cache disabled or custom path configured | Unexpected global I/O | Existing bypass gate precedes selector | opt-out/override tests |
| Full clone is physically expensive | Disk wear remains high | Existing `COPYFILE_FICLONE`; record allocated blocks and retain safe copy fallback | benchmark ledger |
| Redis becomes another source of truth | Split-brain and eviction correctness bugs | Defer Redis until lineage protocol is proven; disk manifest remains durable authority | architectural verdict |

## Execution and ship order

Slices 1 through 3 are ordered: selection must exist before reindex can attach,
and the actual attachment path must exist before overlay lineage can be tested.
Slice 4 follows implementation so the benchmark records shipped behavior.
Each slice is committed independently after its focused tests and full
repository gates pass. If an unrelated flaky test fails, the exact command,
failure, isolated rerun, and rationale are recorded before proceeding.

## Verdict

Proceed with the four slices. The existing generation store, durable hydration,
incremental SQLite publication, and shard caches already contain the hard
mechanisms. The missing abstraction is a safe way to identify the committed
baseline without pretending the dirty worktree's current source fingerprint is
the baseline fingerprint. Adding that selector and an honest lease transition
delivers cache forking without introducing a second database authority or a
Redis consistency protocol.

## Execution record

All four slices were completed on 2026-07-29.

- Slice 1 added deterministic exact-tree/configuration baseline selection.
- Slice 2 attached that baseline only for a dirty worktree with no usable local
  cache and proved unchanged Python shard reuse in the mixed-language fixture.
- Slice 3 added a base-only overlay lease and exposed base/active lineage in
  status. Its live cleanup test also surfaced and fixed a macOS path-identity
  defect: managed paths can be spelled through `/var` while `realpath` returns
  `/private/var`. Cleanup now performs the containment decision on physical
  paths after retaining the existing symlink and directory checks.
- Slice 4 records the user contract and the measured validation in
  `docs/benchmarks/2026-07-29-worktree-cache-fork-overlays.md`.

The implementation did not add Redis, a merged base/delta query path, a new
watcher, or any instruction that asks an agent to reindex more often. The
existing watcher/freshness rules remain the sole refresh policy.
