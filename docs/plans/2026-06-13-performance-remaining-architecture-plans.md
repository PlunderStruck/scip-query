# Remaining Performance Architecture Plans

Date: 2026-06-13

This document closes out the performance feedback items that are not safe to land in the same patch train as the query-local optimizations. Each item below is deferred from the current implementation set because it changes indexing, cache persistence, or execution orchestration contracts rather than only replacing repeated work with equivalent local lookup.

## Implemented In This Patch Train

- Item 5: bulk SQL and path lookup improvements for `diff-impact`.
- Items 6 and 7: diff-plan reuse plus inverted candidate index for `incomplete-migration`.
- Item 8: cached source line arrays via `getSourceLines()`.
- Item 9: indexed-first/Git-first source filesets.
- Item 10: scoped `buildChunkCalleeMap()` evidence.
- Item 11: reusable definition line-owner index.
- Item 14: stale semantic callee deletes deduped per file/hash.
- Item 15: cached TypeScript semantic definition resolution.
- Item 19: exact bounded top-K retention for `similarAll()`.
- Item 20: source-shape token index for fallback similarity.

## Deferred Slice A: Git-Backed Freshness (Item 1)

### Current Anchors

- Source: `scip-query plan-context reindex`
  - `reindex()` computes one fingerprint before deciding whether to reuse an existing index.
  - `reuseExistingIndexIfPossible()` compares the current fingerprint with `meta.json`.
- Source: `rg "fingerprintProjectFiles|computeReindexFingerprint" -n src/reindex src/runtime/index-freshness.ts`
  - `src/reindex/project-files.ts` already uses Git to enumerate tracked/untracked files when possible.
  - `fingerprintProjectFiles()` still reads and SHA-256 hashes every listed file.
  - `src/runtime/index-freshness.ts` compares the same metadata fingerprint for status reporting.

### Plan

1. Extend `ProjectFileFingerprint` with `{ source: 'git-blob' | 'hash' | 'unreadable' }`.
2. Add a Git status reader:
   - `git ls-files -s -- <path>` or a bulk `git ls-files -s -z` map for tracked clean files.
   - `git status --porcelain=v1 -z` to identify dirty tracked and untracked files.
3. For clean tracked files, use Git blob ID plus size from the index instead of reading the file.
4. For dirty tracked files, untracked files, non-Git repos, and Git failures, keep the current content hash path.
5. Version the fingerprint metadata so old all-hash metadata does not compare equal accidentally.
6. Tests:
   - Clean tracked file avoids content hashing but detects committed blob changes.
   - Dirty tracked file hashes working-tree content.
   - Untracked file hashes working-tree content.
   - Non-Git fallback preserves current behavior.

### Deferral Rationale

This changes the persisted index metadata contract used by both reindex reuse and status reporting. It should land as its own slice with regression tests around Git clean/dirty/untracked states.

## Deferred Slice B: Per-Language Incremental Reindexing (Item 2)

### Current Anchors

- Source: `scip-query plan-context reindex`
  - `reindex()` computes one project-wide fingerprint and either reuses or rebuilds the full index.
- Source: `sed -n '260,430p' src/reindex/index.ts`
  - `runLanguageIndexersForFreshReindex()` prepares and runs every requested language.
  - `publishFreshReindexArtifacts()` materializes one merged SCIP file and one SQLite DB.

### Plan

1. Introduce a `languageFingerprints` object in `meta.json`, keyed by supported language.
2. Define each language's input set from existing language detection and source extension/config ownership.
3. Store per-language `.scip` artifacts under an internal cache directory next to `index.db`.
4. On reindex:
   - Recompute per-language fingerprints.
   - Reuse cached language `.scip` outputs whose fingerprints match.
   - Run indexers only for languages with changed fingerprints or missing artifacts.
5. Merge reused and fresh language outputs into the final SCIP file, then convert.
6. Tests:
   - Mixed TS/Python fixture where a TS-only change skips Python.
   - Missing cached artifact forces that language to rerun.
   - Changed shared config invalidates the correct language set.
   - Partial-index semantics remain unchanged.

### Deferral Rationale

This needs a persisted artifact cache and language ownership rules. Landing it alongside query-level changes would make failures hard to isolate.

## Deferred Slice C: Merge And Sanitize SCIP In One Pass (Item 3)

### Current Anchors

- Source: `sed -n '470,535p' src/reindex/index.ts`
  - `materializeScipOutput()` merges multiple language SCIP files into `tempOutputScip`.
  - `convertScipToSqlite()` then calls `sanitizeScipFile(tempOutputScip)`, which rereads and may rewrite the file.
- Source: `sed -n '1,220p' src/reindex/merge.ts` and `sed -n '1,160p' src/reindex/sanitize.ts`
  - `mergeScipIndexes()` and `sanitizeScipIndex()` already have in-memory APIs.

### Plan

1. Add `materializeMergedScipOutput()` that deserializes inputs, calls `mergeScipIndexes()`, calls `sanitizeScipIndex()` on the merged index, then serializes once.
2. Return the sanitize counts from materialization so `convertScipToSqlite()` does not run `sanitizeScipFile()` again when materialization already sanitized.
3. Keep single-language direct-output behavior unchanged unless the indexer wrote to a temporary language file, where the same sanitize-before-write path can be used.
4. Tests:
   - Multi-language merge writes exactly one sanitized output.
   - Invalid definition occurrences are removed before SQLite conversion.
   - Single-language path still sanitizes.

### Deferral Rationale

This is smaller than the other reindex architecture work, but it still changes the artifact handoff between merge, sanitize, and convert. It should be landed with reindex-focused tests.

## Deferred Slice D: Per-Language SQLite Or Attached Databases (Item 4)

### Current Anchors

- Source: `scip-query plan-context reindex`
  - Current publishing always converts one SCIP file to one SQLite DB.
- Source: `src/storage/db.ts` and query modules
  - Query code assumes one `ScipDatabase` connection and unqualified table names such as `documents`, `global_symbols`, `mentions`, and `chunks`.

### Plan

1. Prototype read-only attached DB support in `ScipDatabase`.
2. Define a compatibility view layer:
   - `documents`, `global_symbols`, `mentions`, `chunks`, and `defn_enclosing_ranges` must appear as unified tables.
   - IDs need language/db disambiguation, either by stable remapping during attach or by view-level composite IDs.
3. Start with query-only support for attached DBs; keep write/augment paths on the merged DB until views are proven.
4. Add a migration mode that can build both merged and per-language DBs and diff query outputs.
5. Tests:
   - Query parity for symbols, refs, call graph, diff-impact, health on merged vs attached DBs.
   - Cross-language references remain visible.
   - Auxiliary document augmentation has a defined owner.

### Deferral Rationale

This is a storage architecture change, not a performance refactor. It needs a design spike and parity harness before production use.

## Deferred Slice E: Lazy TypeScript Projects By Tsconfig (Item 12)

### Current Anchors

- Source: `scip-query plan-context createTsMorphProvider`
  - `createTsMorphProvider()` discovers all tsconfigs and immediately calls `createTsMorphProjectBundles()`.
- Source: `sed -n '1,120p' src/semantic/typescript/ts-morph-runtime.ts`
  - `createTsMorphProjectBundles()` constructs a `ts-morph` project for every tsconfig.
- Source: `sed -n '1,140p' src/semantic/typescript/source-file-resolver.ts`
  - Source-file resolution currently loops through all project bundles to find a file.

### Plan

1. Add a tsconfig ownership resolver:
   - Map indexed TypeScript-like files to the nearest/discovered tsconfig that includes them.
   - Fall back to current all-project search if ownership is ambiguous.
2. Replace eager `ProjectBundle[]` construction with a lazy bundle cache keyed by tsconfig path.
3. Change `createTypeScriptSourceFiles()` to request the bundle for the file's owning tsconfig first, then fallback to other bundles only when needed.
4. Keep `availability().tsconfigPaths` reporting all discovered configs.
5. Tests:
   - Multi-tsconfig fixture proves querying one package constructs only that package's project.
   - Cross-package imports still resolve when ts-morph needs dependency files.
   - Ambiguous file falls back to current behavior.

### Deferral Rationale

This directly affects semantic accuracy. It needs instrumentation to prove fewer projects are constructed while preserving cross-package reference and import behavior.

## Deferred Slice F: Persist Semantic Reference Evidence (Item 13)

### Current Anchors

- Source: `src/storage/evidence-cache.ts`
  - `semantic_callees` is already persisted by relative path, symbol, content hash, dependency digest, and version.
- Source: `src/semantic/shared-primitives.ts`
  - `semanticReferences()` calls `provider.referencesFor(definition)` directly on each warm CLI run.
- Source: `src/semantic/typescript/semantic-locations.ts`
  - Reference evidence is reducible to `{ file, line, column }` records.

### Plan

1. Add a `semantic_references` table to `evidence.db`:
   - Primary key: `(relative_path, symbol)`.
   - Validity columns: definition file hash, dependency/project digest, CLI cache version.
   - Payload: JSON array of semantic reference locations.
2. Add read/write helpers parallel to semantic callees.
3. In the TypeScript provider or shared primitive, read before `referencesFor()` and write after successful computation.
4. Use the same stale-delete strategy as semantic callees, once per `(relativePath, contentHash)`.
5. Tests:
   - Warm run reads cached references without invoking provider work.
   - Source edit invalidates only affected definitions.
   - Corrupt payload falls back to recompute.

### Deferral Rationale

This adds an evidence schema and invalidation contract. It should land independently so cache correctness is easy to audit.

## Deferred Slice G: Persist Git-History Derived Facts (Item 16)

### Current Anchors

- Source: `rg "git history|co-change|commit|churn|recent" -n src`
  - `src/analysis/git-history.ts` computes commit history, churn, add records, and co-change pairs.
  - Commands using this include `co-change`, `recent-duplicates`, `doc-drift`, `health`, `plan-context`, and `diff-gate`.
- Source: `src/storage/evidence-cache.ts`
  - `evidence.db` already provides a rebuildable persistent cache mechanism.

### Plan

1. Add a `git_history_facts` table keyed by project HEAD, algorithm version, and history options.
2. Persist:
   - Commit records.
   - File churn.
   - file-add ages.
   - Pairwise co-change counts.
   - Doc/code coupling summaries if computed separately.
3. Keep process-level caches as a first layer; use evidence DB as the cross-process layer.
4. Invalidate on HEAD change, Git failure, or algorithm version bump.
5. Tests:
   - First run populates facts.
   - Second process reads persisted facts.
   - New commit invalidates facts.
   - No-Git repos keep current unavailable behavior.

### Deferral Rationale

This changes a shared analysis substrate for many commands. It needs end-to-end tests against a temporary Git repo.

## Deferred Slice H: Health Execution Strategy And Shared Corpora (Items 17 and 18)

### Current Anchors

- Source: `scip-query plan-context health`
  - `health()` delegates to `withHealthRun()` and `runHealthAnalyses()`.
- Source: `sed -n '149,260p' src/queries/health.ts`
  - `withHealthRun()` clears whole-project evidence caches after the run and requests GC.
  - `healthPhase()` and `healthReportFromPhases()` already define a phase boundary for orchestrated execution.
- Source: `src/queries/similar.ts`
  - Candidate corpora such as callee fingerprints are per-process/per-DB caches, so separate phase processes rebuild them.

### Plan

1. Add a health execution mode decision:
   - Small/medium repo: run phases in one process to share caches.
   - Large repo: run bounded worker phases to cap memory.
2. Define memory thresholds using stats output and V8 heap statistics.
3. For in-process mode, delay `clearWholeProjectEvidenceCaches()` until all phases complete.
4. For worker mode, group phases that share corpora into the same warmed worker where memory allows.
5. Add phase result parity tests:
   - `health()` equals `healthReportFromPhases()` for the same phase set.
   - In-process grouped phases produce identical report counts to isolated phases.
   - Large-repo heuristic selects worker mode without changing output.

### Deferral Rationale

Health execution strategy affects memory pressure and command latency across many detectors. It should be developed with benchmark fixtures and report parity tests, not merged into this query-local optimization batch.
