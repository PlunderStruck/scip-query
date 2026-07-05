# Per-Project TypeScript Shard Caching

Date: 2026-07-05

## Goal

In `typescriptProjectMode: "workspace"`, an edit inside one tsconfig project re-runs only that project's `scip-typescript` shard (plus any dependent projects) and the merge/convert step. Unchanged project shards come from a persisted cache. Done looks like: on a Vega_2.0-shaped monorepo, a one-file edit in `apps/web` re-runs 1–2 project shards instead of all 5, and `reindex --json` diagnostics show the reused project shards with `reused: true`.

Baseline measurements (Vega_2.0, 2026-07-05): single-mode full rebuild 57.4s; workspace-mode rebuild 34.1s; workspace-mode after one-file edit 35.4s (all 5 shards re-ran — caching is per-language only).

## Latency Budget and Non-Goals

The user's target is minimum-latency reindex: touch only the data that changed. Constraints that bound the floor:

1. **Smallest safe recompute unit for TypeScript is the tsconfig project.** An edit can change inferred types (and therefore emitted symbols/references) in any file of the same compilation, so per-file patching is unsound. This plan gets to the sound minimum: changed project + transitive dependents.
2. **Merge + SCIP→SQLite conversion stays whole-index.** Conversion is delegated to the external `scip expt-convert` binary (`src/reindex/index.ts:928`) — scip-query does not own the SQLite writing, so shard-scoped DB patching would require replacing that converter with an owned writer. Recorded as a follow-up, out of scope here. Empirically this tail is single-digit seconds on Vega.
3. **Latency hiding is a separate, complementary lever.** With `watch.enabled: true`, refresh happens in the background on file changes and an agent's `scip-query reindex` hits the reuse path (~1-3s observed). Recommend enabling watch on consumer repos alongside this feature; no code change in this plan.
4. Finer granularity than "tsconfig project" is a consumer-repo decision (more, smaller tsconfig projects), not a scip-query change.

## Current State

All claims verified against source on 2026-07-05 (`scip-query plan-context src/reindex/index.ts` + reads).

- `reindex()` (`src/reindex/index.ts:165-241`) computes a whole-project fingerprint, tries whole-index reuse (`reuseExistingIndexIfPossible`, `:270-312`), else runs `runFreshReindex` (`:350-387`).
- `classifyLanguageShardReuse` (`src/reindex/index.ts:453-521`) decides shard reuse **per language** by comparing `meta.languageFingerprints[language]` (meta v3) against `computeLanguageFingerprints` (`:1141-1175`), which fingerprints **every language-relevant file repo-wide** via `fingerprintProjectFiles` (`src/reindex/project-files.ts:31-55`). Miss reasons are recorded for `reindex --json` (plan6 6.5.2).
- `prepareIndexerRunsForLanguage` (`src/reindex/index.ts:693-741`): in workspace mode, `discoverTypeScriptProjectRoots` (`src/reindex/typescript-projects.ts:20-34`) yields relative project paths (e.g. `.`, `apps/web`); each becomes a `PreparedIndexerRun` with `id: typescript:<project>`, its own temp `scipPath` (`tempScipPath(..., 'typescript-project', index)`), and a shared `outputScipPath` (the language output).
- `runPreparedIndexers` (`src/reindex/indexer-runner.ts:104-137`) runs prepared runs with concurrency `min(8, cores)` by default; failed parallel runs retry serially.
- `collectIndexerOutputs` (`src/reindex/index.ts:807-841`) groups results by `(language, outputScipPath)`; multi-run groups go through `mergeScipFiles` (non-destructive read of inputs; `src/reindex/merge.ts:39-53`); **single-run groups are `renameSync`d** — destructive to the input path.
- `publishFreshReindexArtifacts` (`src/reindex/index.ts:570-618`) caches per-language shards to `language-indexes/<language>.scip` (`cacheLanguageShards`, `:620-628`; `languageShardPath`, `:1189-1191`), merges languages, converts to SQLite, writes meta v3 (`ReindexMetadata`, `:116-126`), promotes atomically.
- Root-alongside behavior: `shouldIndexRootAlongsideProjects` (`src/reindex/typescript-projects.ts:106-110`) re-adds the repo root as a project when the root tsconfig has subdirectory-covering `include` patterns (`tsconfigCoversSubdirectories`, `:112-123`). `dedupeNestedProjects` (`:97-104`) otherwise removes ancestor projects.
- **Explicit config is not authoritative today**: `discoverTypeScriptProjectRoots` merges `configuredProjects` with discovered dirs and still applies root-alongside; there is no way to exclude the root shard via config.
- Freshness checking (`src/runtime/index-freshness.ts:70,107`) compares only the whole-project `fingerprint` — untouched by this change.
- Failure semantics: any project-shard run failure marks the whole language skipped (`collectIndexerOutputs` → `appendSkippedLanguage`), and `validateIndexingOutcome` (`:858-887`) throws without `--allow-partial`, preserving the previous index.

### Non-obvious invariants

1. `index.db` is replaced wholesale on publish (readonly consumers; see memory + `promoteReindexArtifacts` `:1090-1101`). We are NOT patching the DB — merge+convert stays full.
2. Cached shard files must never be `renameSync`d into outputs (would destroy the cache) — `collectIndexerOutputs` renames single-input groups.
3. Cross-project coupling is real: in Vega, `apps/web` compiles `packages/shared` **source** via root-tsconfig `paths` aliases (`@vega/shared → packages/shared/src`), and workspace `package.json` deps link packages. An edit in a dependency can change a dependent's emitted SCIP. Invalidation must include dependents or the cache serves stale references.
4. Vega-shaped repos include a root `.` shard whose tsconfig covers the whole repo. Its honest fingerprint is "all TS files", so it never cache-hits. Without Phase 3 (explicit projects authoritative), the practical win on such repos is limited to dropping the 4 sub-project runs (~40% of shard work), not the root run.

## Reuse Audit

| Proposed unit | Decision | Evidence |
| --- | --- | --- |
| New module `src/reindex/project-shards.ts` (scoping + dep graph + per-project fingerprints, pure) | New file justified | `src/reindex/index.ts` is 1246 lines; `typescript-projects.ts` owns *discovery* only; `project-files.ts` owns repo-wide listing/hashing and is reused (its `fingerprintProjectFiles` output feeds the new scoping functions — no re-hashing). No existing module owns "which files feed which project shard". |
| Per-project fingerprint type | Reuse `ReindexFingerprint` (`src/reindex/index.ts:1109-1117`) shape's `files` array member; do NOT invent a parallel hash type. Store as `{ files: {path,size,hash}[] }` records. | `stableJson` comparison (`:509`) already works on these shapes. |
| Meta field | Extend `ReindexMetadata` with optional `typescriptProjectShards?: Record<string, { files: ... }>`; **keep version 3** (additive; old readers ignore it; new reader treats absence as all-miss → current behavior). | `classifyLanguageShardReuse` already degrades gracefully on missing fields (`:486-503`). |
| Project shard cache dir | Extend the existing `language-indexes/` layout: `language-indexes/typescript-projects/<slug>.scip`. Reuse `languageShardPath`'s dirname convention. | `cacheLanguageShards` (`:620-628`) already owns this directory. |
| Classification | New `classifyTypeScriptProjectShardReuse` alongside `classifyLanguageShardReuse` rather than generalizing it — the language map is `Map<SupportedLanguage, …>` keyed by language and consumed by diagnostics; forcing shard-id keys through it would ripple through `buildFreshReindexShardDiagnostics` and `buildFullyReusedShardDiagnostics` for no benefit. | `:523-553`, `:318-338`. |
| Config | No new config keys. Reuse `indexer.typescript.projects` (`INDEXER_OVERRIDE_CONFIG_KEYS`, `src/runtime/config.ts:65`) — Phase 3 makes it authoritative. | Existing validation at `config.ts:147-181`. |

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| File→project assignment | `assignFilesToProjects(files, projects)` unit call | none | yes (list → Map) | none | most-specific ancestor wins; unclaimed → root project if present, else shared-with-all |
| Dependency edges | `deriveProjectDependencies(projects, readings)` unit call | pre-read manifest/tsconfig contents passed as data | yes | caller reads files | parse failure or unresolvable alias → depend on ALL projects (fail toward re-run) |
| Per-project fingerprints | `computeProjectShardFingerprints(...)` unit call | file fingerprint list (already hashed) passed in | yes (dep-closure union) | none | fingerprint = own files ∪ transitive dep files, sorted, stable |
| Reuse classification | `classifyTypeScriptProjectShardReuse(meta, current, shardExists)` unit call | `shardExists: (slug) => boolean` | yes | `existsSync` injected | miss reasons: no metadata / no cached fingerprint / cache file missing / project inputs changed |
| End-to-end shard skip | `reindex()` with fake indexer binaries (existing pattern, `tests/reindex/reindex-reliability.test.ts:295`) | fake `scip-typescript` script fixture | — | temp dirs | second reindex after editing one project's file re-runs only that project (+dependents); merged output contains unchanged project's documents |
| Explicit projects authoritative | `discoverTypeScriptProjectRoots(root, configured)` unit call (existing tests `tests/reindex/typescript-projects.test.ts`) | none | yes | fs reads existing | non-empty configured list → exactly the configured set, no discovery, no root-alongside |

## Design Phases

### Phase 1 — Pure core: `src/reindex/project-shards.ts` (deployable: unused module + tests)

#### 1.1 - Create project shard scoping and fingerprint module

- [ ] **File**: `src/reindex/project-shards.ts` (new)
- **Source**: `scip-query outline src/reindex/project-files.ts`; read of `src/reindex/typescript-projects.ts:20-142`
- **What**: No module today maps repo-wide fingerprint entries (`{path,size,hash}[]` from `fingerprintProjectFiles`) onto tsconfig project dirs.
- **Change**: Export three pure functions:
  - `assignFilesToProjects(files: {path,...}[], projects: string[])` — most-specific project dir (relative-path prefix match on `/` boundaries) claims each file; `.` (root project) claims unclaimed files when present; when root is absent, unclaimed files go into a `shared` bucket included in every project's fingerprint.
  - `deriveProjectDependencies(projects: string[], inputs: ProjectManifestInputs)` — `ProjectManifestInputs` carries pre-parsed `package.json` (name + dep names) and tsconfig data (`paths` targets, `references` paths, resolved through a caller-supplied `extends` chain, max depth 5) per project. Edge when a dep name matches another project's package name, or a `paths`/`references` target resolves under another project dir. Any parse/read failure for a project → that project depends on all others. Returns transitive closure.
  - `computeProjectShardFingerprints(projects, assignment, dependencies)` — per project: own files ∪ all transitive deps' files (and the shared bucket), sorted by path; returns `Record<string, { files: ProjectFileFingerprint[] }>`.
  - `projectShardSlug(project: string)` — `.` → `root`; otherwise path with `/` → `__` plus an 8-hex sha256 suffix of the raw path (collision-proof, filesystem-safe).
  - Type note: `ProjectFileFingerprint` (`src/reindex/project-files.ts:7-11`) is module-private today — export it from `project-files.ts` (add that file to the edit list) rather than duplicating the shape.
  - Scope note: `tempScipPath`, `stableJson`, `hashFingerprint` are module-private to `index.ts`; all Phase 2 glue that needs them (`classifyTypeScriptProjectShardReuse`, cached-shard copy, diagnostics) lives in `index.ts` where they are already in scope — no exports needed.
- **Testability**: seams as in the table above; all pure.
- **Validation**: new `tests/reindex/project-shards.test.ts` covering: nested project specificity; root-claims-rest; shared-bucket-without-root; package-name dep edge; tsconfig `paths` dep edge (including alias defined in an extended base config); parse-failure → depend-on-all; transitive closure; slug stability/uniqueness.
- **Why**: Isolates every invalidation decision in pure code before any I/O wiring; wrong-direction failures here are the only way the cache can serve stale data, so this gets the densest tests.

#### 1.2 - Add a manifest/tsconfig reader shell

- [ ] **File**: `src/reindex/project-shards.ts` (same module, separate exported function)
- **Source**: read of `src/reindex/typescript-projects.ts:125-132` (`readJsonObject` pattern)
- **What**: `deriveProjectDependencies` needs parsed manifests; reading belongs in a thin shell.
- **Change**: Export `readProjectManifestInputs(projectRoot, projects)` — reads each project's `package.json` and `tsconfig*.json` (following `extends` up to depth 5, resolving relative to each config), returns `ProjectManifestInputs` with per-project `parseFailed: boolean`. Strip `//` and `/* */` comments before `JSON.parse` (tsconfigs commonly contain them). Note: this is a deliberate improvement over `readJsonObject` (`typescript-projects.ts:125-132`), which is plain `JSON.parse` — today a comment-containing tsconfig silently fails discovery (`isIndexableTsconfig` returns false on null parse, `:87-88`). The two readers intentionally differ; a parse failure here sets `parseFailed` → depend-on-all (safe), never a silent skip.
- **Testability**: integration-tested via temp fixture dirs in `project-shards.test.ts`; pure consumers already covered.
- **Validation**: fixture test: project with `extends: "../../tsconfig.base.json"` whose base declares `paths` into a sibling → dep edge detected.
- **Why**: Keeps `deriveProjectDependencies` pure while giving `index.ts` a single call to gather inputs.

### Phase 2 — Wire classification, cache, and publish (deployable: feature active)

#### 2.1 - Extend metadata contract

- [ ] **File**: `src/reindex/index.ts:116-126`
- **Source**: read of `ReindexMetadata`
- **What**: Meta v3 has `languageFingerprints` only.
- **Change**: Add optional `typescriptProjectShards?: Record<string, { files: { path: string; size: number; hash: string }[] }>` keyed by relative project path. Version stays 3.
- **Validation**: `tests/runtime/reindex-json.test.ts` still passes; new assertions in 2.4's integration test check the field round-trips.
- **Why**: Additive: old binaries ignore it; new binary treats absence as all-miss (exactly today's behavior).

#### 2.2 - Classify per-project reuse when the TS language shard misses

- [ ] **File**: `src/reindex/index.ts:389-437` (`runLanguageIndexersForFreshReindex`) plus new `classifyTypeScriptProjectShardReuse` helper near `:453`
- **Source**: reads of `:389-521`
- **What**: Today, a TS language-fingerprint miss re-runs every project shard produced by `prepareIndexerRunsForLanguage`.
- **Change**: When `language === 'typescript'`, `typescriptProjectMode === 'workspace'`, and the language shard missed:
  1. Discover projects once (`discoverTypeScriptProjectRoots`) — pass the list into `prepareIndexerRunsForLanguage` instead of letting it re-discover (keeps one project list per run; today it discovers internally at `:717`).
  2. Compute current per-project fingerprints (Phase 1 functions) from the SAME `fingerprintProjectFiles(projectRoot, { language: 'typescript', … })` output already computed for the language fingerprint — do not hash files twice.
  3. Compare against `meta.typescriptProjectShards` + check `language-indexes/typescript-projects/<slug>.scip` exists (injected `existsSync` for unit tests). Record per-project miss reasons mirroring `classifyLanguageShardReuse`'s (`no reindex metadata found` / `no cached fingerprint for this project` / `cached shard file missing on disk` / `project inputs changed since last index`).
  4. **Copy** (never rename) each reused project's cached `.scip` into the temp run dir (`tempScipPath(tempOutputScip, 'typescript-project-cached', i)`) and synthesize successful `IndexerRunResult`-shaped entries (`id: typescript:<project>`, `durationMs: 0`) so `collectIndexerOutputs` merges them with fresh runs unchanged.
  5. Filter `preparedRuns` to missed projects only.
  If the project set changed (any project in meta absent from current list or vice versa is fine per-project; but a changed *discovery input* like a deleted tsconfig simply changes the project list — removed projects' cache entries are pruned in 2.3).
- **Testability**: classification decision is a pure function over `(meta, currentFingerprints, shardExists)`; the copy/synthesize step is the shell.
- **Validation**: unit tests for the classifier; integration test in 2.4.
- **Why**: This is the core behavior change. Copy-not-rename protects invariant 2; reusing the already-hashed file list keeps reindex overhead flat.

#### 2.3 - Cache fresh project shards and prune stale entries at publish

- [ ] **File**: `src/reindex/index.ts:570-628` (`publishFreshReindexArtifacts`, `cacheLanguageShards`)
- **Source**: reads of `:570-628`
- **What**: Publish caches one `.scip` per language and writes `languageFingerprints`; nothing project-scoped.
- **Change**:
  - After successful runs, copy each fresh typescript-project run's `scipPath` to `language-indexes/typescript-projects/<slug>.scip` (before `collectIndexerOutputs` renames/merges — thread the per-run results through, or copy inside `runLanguageIndexersForFreshReindex` right after `runPreparedIndexers` returns; prefer the latter so publish stays language-scoped).
  - In publish: when mode is workspace and ALL typescript project shards succeeded, write `typescriptProjectShards` (current fingerprints from 2.2 — reuse, don't recompute). When mode is `single` or the language was skipped, omit the field and delete `language-indexes/typescript-projects/` (stale-mode pruning). Always prune slugs not in the current project set.
- **Testability**: pruning decision (`slugsToDelete(currentProjects, existingFiles)`) pure; fs operations shell.
- **Validation**: integration test: switch workspace→single → project cache dir removed; remove a tsconfig → its slug pruned.
- **Why**: An unpruned stale shard for a renamed project could otherwise be revived by a slug collision (slug hash suffix also guards this); meta written only on full success matches the existing fail-closed contract (`validateIndexingOutcome` throws before publish on any shard failure without `--allow-partial`).

#### 2.4 - Diagnostics + integration tests

- [ ] **File**: `src/reindex/index.ts:523-553` (`buildFreshReindexShardDiagnostics`); `tests/reindex/reindex-reliability.test.ts`
- **Source**: reads of `:523-553`; existing workspace test at `tests/reindex/reindex-reliability.test.ts:295`
- **What**: Diagnostics emit one reused entry per reused *language* and one entry per executed run; reused project shards would silently vanish from `--json`.
- **Change**: Pass the project classification into the diagnostics builder; emit `{ id: 'typescript:<project>', language: 'typescript', reused: true, fingerprint: hashFingerprint(projectFp), … }` for reused project shards and attach project-level `missReason` to executed project runs.
- **Validation**: New integration tests (fake-indexer pattern from `:295`):
  1. Workspace fixture, two projects A/B + edit in B → second reindex executes only B's run; diagnostics show A reused with project id; merged SCIP contains A's documents (assert via `deserializeSCIP` on output or via the SQLite documents table).
  2. B depends on A (package name dep) + edit in A → both re-run.
  3. Cached shard file deleted → that project re-runs with `cached shard file missing on disk`.
  4. Meta from an older run (no `typescriptProjectShards`) → all projects re-run, no crash.
- **Why**: plan6 6.5.2 established that every reuse decision must be explainable from `reindex --json`; project shards must keep that property.

### Phase 3 — Explicit `typescript.projects` config becomes authoritative (deployable; behavior change, flagged)

#### 3.1 - Configured projects replace discovery

- [ ] **File**: `src/reindex/typescript-projects.ts:20-34`
- **Source**: read of `:20-34`
- **What**: `discoverTypeScriptProjectRoots` merges configured projects with discovered dirs and re-adds the root via `shouldIndexRootAlongsideProjects`; explicit config cannot exclude the root shard.
- **Change**: When `configuredProjects` normalizes to a non-empty list, return exactly that list (deduped/sorted, root-alongside skipped). Discovery remains the no-config path.
- **Testability**: pure-ish unit seam already exists (`tests/reindex/typescript-projects.test.ts`).
- **Validation**: unit tests: configured `['apps/web','apps/api']` on a fixture with a subdir-covering root tsconfig → exactly those two, no `.`; existing no-config tests unchanged. Also update the reindex-reliability test at `:335` if its expectation encodes merge semantics.
- **Why**: On Vega-shaped repos the root shard covers the whole repo (root tsconfig `include: apps/*/src/**...`) and can never cache-hit (invariant 4). Explicit config is the escape hatch, and its existing config-warning copy already promises "explicit TypeScript projects are indexed directly" (`src/runtime/config.ts:181`). One-way-door note: users who relied on configured-projects-as-additive get fewer shards; mitigated by documenting in the config reference and the release note. Files covered only by the root tsconfig (e.g. Vega's `types/**/*.d.ts`) drop out of the index when root is excluded — the config owner opts into that.

#### 3.2 - Document the workspace caching + authoritative projects contract

- [ ] **File**: `docs/` config/command reference for reindex + `.scipquery.json` docs (locate via `scip-query files "docs.*config"` at execution time; likely `docs/commands` or README section)
- **Change**: Document: per-project caching applies only in workspace mode; invalidation includes workspace/package-alias dependents; explicit `projects` list is authoritative; cache lives in `language-indexes/typescript-projects/`.
- **Validation**: `scip-query doc-drift` clean for touched docs.
- **Why**: The reuse rules are invisible runtime behavior; without docs the next calibration session re-derives them.

### Phase 4 — Verify end-to-end

- [ ] `npm test -- tests/reindex` green; full `npm test` green.
- [ ] `scip-query reindex && scip-query diff-gate` in this repo — fix or justify findings.
- [ ] Fixture benchmark: two-project workspace fixture, assert second reindex executes 1 indexer process (observable via the fake indexer's invocation log).
- [ ] Optional real-repo calibration on Vega_2.0 (requires setting `indexer.typescript.projectMode: workspace` + explicit `projects: ["apps/api","apps/web","packages/shared","packages/companion"]` in its `.scipquery.json` — coordinate with the repo owner; expected: one-file `apps/web` edit → only `apps/web` shard + merge/convert).

## Stress-Test Findings

| Lens | Answer |
| --- | --- |
| Purpose | Language-shard reuse invariant survives untouched (single mode and non-TS languages unchanged). The new invariant: a cached project shard is served only when its own files AND all transitive dependency files are byte-identical. |
| Blast radius | `runLanguageIndexersForFreshReindex`, `prepareIndexerRunsForLanguage` (project list threading), publish, diagnostics, meta type, `discoverTypeScriptProjectRoots` (Phase 3). External consumers of `reindex()` (`worker.ts`, `command-handlers.ts`, `project-setup.ts`) see unchanged signatures. |
| Valid intermediate state | Phase 1 ships dead code + tests. Phase 2 activates caching with meta additive. Phase 3 independent. Each phase leaves `reindex` fully functional. |
| Reversibility | Two-way door: deleting `typescriptProjectShards` from meta (or the cache dir) reverts to per-language behavior. Phase 3 is the only behavior change for existing configs and only when `projects` is set. |
| Failure | Any project run failure → language skipped → `validateIndexingOutcome` throws (no `--allow-partial`) → previous artifacts preserved, `typescriptProjectShards` not written. Unreadable cache file at merge time → `mergeScipFiles` throws → same fail-closed path. Corrupt meta JSON → classifier's `no reindex metadata found` miss. |
| Concurrency | Reindex lock (`acquireReindexLock`) already serializes writers per cache dir; cached shard reads happen under the lock. |
| Boundaries | No new CLI/config surface (Phase 3 changes semantics of an existing validated key). |
| Data integrity | Meta stays version 3 additive. Old binary + new meta: ignores field, still correct. New binary + old meta: all-miss. Fingerprint hashes reuse the exact `{path,size,hash}` records already computed — no second hashing pass, no drift between language and project fingerprints. |
| Observability | Every project shard decision appears in `reindex --json` shards with id + missReason (2.4); status line already prints reused shard counts. |
| Human experience | Surprise risk: dependency closure re-runs more than "the file I touched" (e.g. `packages/shared` edit re-runs 3 shards). Diagnostics miss reasons make that legible. Phase 3 flagged as a behavior change in docs. |
| Reuse | Verified: `fingerprintProjectFiles`, `stableJson`, `hashFingerprint`, `tempScipPath`, `mergeScipFiles`, existing test fixture pattern all reused; no new config keys; no CLI registration ripple (no new command). |
| Testability | Invalidation logic 100% pure and unit-tested; I/O confined to manifest reading, shard copy, prune. |

### Phase 4 additional check

- `measureColdIndex` (`src/runtime/commands/command-handlers.ts:349-386`) moves the whole cache dir aside and back for bench `--cold-index`; the new `language-indexes/typescript-projects/` subdir travels with the directory rename automatically — verify the bench path still passes, no code change expected.
- `src/storage/evidence-cache.ts:133-153` reads `meta.json` but only `version`/`status`/`fingerprint`/`indexedLanguages` — additive-safe, no change.

## Execution Order

1. Phase 1 (pure core + tests) — deployable, inert.
2. Phase 2 (wiring + integration tests) — deployable, feature live in workspace mode.
3. Phase 3 (authoritative projects + docs) — deployable, flagged behavior change.
4. Phase 4 verification gates each of the above; run `scip-query reindex && scip-query diff-gate` before declaring done.

## Ship Order / One-Way Doors

- Phases 1→2→3 in order; 3 could ship independently but pairs naturally with 2 for the Vega payoff.
- One-way doors: none hard. Phase 3 changes semantics of `indexer.typescript.projects` (documented); meta field is additive.

## Files

- Create: `src/reindex/project-shards.ts`, `tests/reindex/project-shards.test.ts`, this plan.
- Edit: `src/reindex/index.ts` (meta type, classification wiring, publish, diagnostics), `src/reindex/project-files.ts` (export `ProjectFileFingerprint`), `src/reindex/typescript-projects.ts` (Phase 3), `tests/reindex/reindex-reliability.test.ts`, `tests/reindex/typescript-projects.test.ts`, docs config reference.
- Delete: none.
- Verify: `tests/runtime/reindex-json.test.ts`, `tests/runtime/index-freshness.test.ts` (should be untouched behaviorally).
