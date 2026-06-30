# Git Evidence Product — 2026-06-30

## Goal

The user wants the sixth structural optimization register item completed in order. Git history evidence refers to commit records, tracked paths, file-add records, churn counts, and co-change pairs observed from the repository's Git log; it is derived evidence because scip-query rebuilds it from Git instead of treating it as source code or SCIP graph data. A Git evidence product is the shared access boundary that makes those history facts available by repository HEAD, keeps Git-unavailable states explicit, and lets commands reuse the same cached history and co-change windows.

Done means file-add records, tracked files, file churn, change amplification, all-file co-change pairs, target-file co-change pairs, and changed-file directional co-change windows are exposed through one `gitEvidenceProduct(db)` API; existing public helpers remain source-compatible; and doc drift, recent duplicates, health, co-change, diff-gate, and plan-context consume the product rather than rebuilding their own Git access path.

## Current State

- `src/analysis/git-history.ts:1-14` describes Git history as the change-graph evidence source, imports `createPerDbValue()`, and already imports `createFileEvidenceProduct()` for persisted file-add records. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`.
- `src/analysis/git-history.ts:16-73` defines the core Git fact shapes: commit records, commit history, file churn, change amplification, and co-change pairs with subject context. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`.
- `src/analysis/git-history.ts:91-109` owns `headKeyedGitValue()` and `getCommitHistory()`, which cache one Git-derived value per DB and invalidate it when HEAD changes. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`, `node dist/cli.js trace getCommitHistory`.
- `src/analysis/git-history.ts:127-143` loads bounded non-merge commit history through `git log --name-only`; Git failures return `null`. Source: `node dist/cli.js code 'src/analysis/git-history.ts:120-240'`.
- `src/analysis/git-history.ts:151-205` derives file churn, change amplification, and tracked files from commit history or `git ls-files`, returning `null` when the backing Git data is unavailable. Source: `node dist/cli.js code 'src/analysis/git-history.ts:120-240'`, `node dist/cli.js trace getFileChurn`, `node dist/cli.js trace getTrackedFiles`.
- `src/analysis/git-history.ts:207-302` has the existing `git-file-adds` persistent evidence product keyed by the HEAD string and the synthetic `__git__/file-adds` path. Source: `node dist/cli.js code 'src/analysis/git-history.ts:120-240'`, `node dist/cli.js code 'src/analysis/git-history.ts:240-360'`.
- `src/analysis/git-history.ts:308-343` exposes three co-change accessors: all pairs, focused pairs for a file set, and directional pairs for changed files; the directional path loads focused commit windows with extra Git child processes. Source: `node dist/cli.js code 'src/analysis/git-history.ts:240-360'`, `node dist/cli.js trace getDirectionalCoChangePairsForFiles`.
- `src/analysis/git-history.ts:345-437` computes co-change counts, confidence, broad/focused split, recency, subject labels, and sorted output from a `CommitHistory`. Source: `node dist/cli.js code 'src/analysis/git-history.ts:360-500'`.
- `src/analysis/git-history.ts:439-566` loads focused commit windows and parses commit-history blocks; bulk commits are skipped by file cap. Source: `node dist/cli.js code 'src/analysis/git-history.ts:360-500'`, `node dist/cli.js code 'src/analysis/git-history.ts:500-633'`.
- `src/queries/cleanup/doc-drift.ts:283-323` reads commit history and tracked files to build a scan index containing change timestamps, doc/code co-change counts, tracked docs, and ever-seen history paths. Source: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:276-354'`.
- `src/queries/cleanup/recent-duplicates.ts:145-150` reads file-add records to decide which newly added files become duplicate-search focus files. Source: `node dist/cli.js code 'src/queries/cleanup/recent-duplicates.ts:136-152'`.
- `src/queries/impact/co-change.ts:90-150` reads commit history and co-change pairs separately, then filters actionability with path noise, existence, structural-link, and partner-class policy. Source: `node dist/cli.js code 'src/queries/impact/co-change.ts:90-150'`.
- `src/queries/impact/diff-gate.ts:567-654` reads directional co-change pairs for changed files and reports missing partners. Source: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:567-654'`.
- `src/queries/health/health.ts:526-545` summarizes Git evidence by reading churn, running `coChange()`, and reading change amplification. Source: `node dist/cli.js code 'src/queries/health/health.ts:520-545'`.
- `src/queries/impact/plan-context.ts:142-165` reads file churn and co-change partners for the plan-context history block. Source: `node dist/cli.js code 'src/queries/impact/plan-context.ts:140-165'`.
- `src/analysis/git-history.ts` is a medium-risk owner with 22 external consumers; it usually changes with `tests/analysis/git-history.test.ts`, `src/queries/impact/diff-gate.ts`, and co-change validation docs. Source: `node dist/cli.js change-surface src/analysis/git-history.ts`, `node dist/cli.js plan-context src/analysis/git-history.ts`.
- The SCIP index is fresh, the structural inventory doc has no drift findings, and recent-duplicates reports no current duplicate pressure. Source: `node dist/cli.js status --capabilities`, `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`, `node dist/cli.js recent-duplicates --json`.

Non-obvious invariants to preserve:

- Git is optional: the module must return `null` or unavailable results when Git is missing, the project is not a repo, or Git commands fail. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`, `node dist/cli.js code 'src/analysis/git-history.ts:120-240'`.
- All Git-derived in-process caches are HEAD-sensitive so watch-mode queries do not reuse stale history after commits. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`.
- File-add records already have a validated persistent payload and fallback-to-recompute path; the product must reuse that rather than inventing a second file-add cache. Source: `node dist/cli.js code 'src/analysis/git-history.ts:207-302'`, `node dist/cli.js code 'src/storage/evidence-products.ts:1-37'`.
- Co-change policy belongs to `co-change.ts` and `diff-gate.ts`; the Git product should provide history facts, not decide whether a pair is actionable. Source: `node dist/cli.js code 'src/queries/impact/co-change.ts:90-150'`, `node dist/cli.js code 'src/queries/impact/diff-gate.ts:567-654'`.

## Reuse Audit

- New `GitEvidenceProduct` interface: reuse `CommitHistory`, `FileChurn`, `ChangeAmplification`, `CoChangePair`, and the existing file-add record shape from `src/analysis/git-history.ts:16-73` and `src/analysis/git-history.ts:207-211`. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`, `node dist/cli.js code 'src/analysis/git-history.ts:120-240'`.
- New `gitEvidenceProduct(db)` factory: extend `src/analysis/git-history.ts` because `plan-context`, `surface`, and `change-surface` show it is already the Git evidence owner and has all current Git history consumers. Source: `node dist/cli.js plan-context src/analysis/git-history.ts`, `node dist/cli.js surface src/analysis/git-history.ts`.
- Focused co-change cache: reuse `createPerDbValue()` and the existing HEAD invalidation pattern from `headKeyedGitValue()` instead of adding a separate global cache. Source: `node dist/cli.js code 'src/storage/per-db-cache.ts:86-110'`, `node dist/cli.js code 'src/analysis/git-history.ts:91-109'`.
- Persistent file-add product: reuse `createFileEvidenceProduct()` and `FILE_ADD_PRODUCT`; `similar getFileAddRecords` shows the nearest overlap is the existing `cachedFileAddRecords()` helper. Source: `node dist/cli.js similar getFileAddRecords`, `node dist/cli.js code 'src/storage/evidence-products.ts:1-37'`.
- Co-change accessors: `similar getDirectionalCoChangePairsForFiles` shows overlap with `getCoChangePairsForFiles()` and `getCoChangePairs()` inside the same file, so the product should centralize those existing paths rather than create a new co-change algorithm. Source: `node dist/cli.js similar getDirectionalCoChangePairsForFiles`.
- There is already a health output type named `GitEvidenceSummary`, but it is a user-facing summary in `src/queries/health/health-types.ts:67-72`, not an access product. The product should live in `src/analysis/git-history.ts` and avoid changing health output shapes. Source: `node dist/cli.js refs GitEvidence`, `node dist/cli.js code 'src/queries/health/health-types.ts:28-72'`.

## Design Phases

### 1.1 — Add Git evidence product contract

- [x] **File**: `src/analysis/git-history.ts:75-114`
- **Source**: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`
- **What**: Git fact types exist, but there is no product-level contract or first-class unavailable capability.
- **Change**: Export `FileAddRecord`; add `GitEvidenceSlot`, `GitEvidenceCapability`, `GitCoChangeOptions`, and `GitEvidenceProduct`. Slots are `commit-history`, `file-churn`, `change-amplification`, `tracked-files`, `file-add-records`, `co-change-pairs`, `focused-co-change-pairs`, and `directional-co-change-pairs`.
- **Why**: Git-unavailable should be a named product state, and consumers should ask one Git evidence object for facts.

### 1.2 — Add product factory and HEAD-keyed map cache

- [x] **File**: `src/analysis/git-history.ts:132-165`
- **Source**: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`, `node dist/cli.js code 'src/storage/per-db-cache.ts:86-110'`
- **What**: `headKeyedGitValue()` supports one value per DB/HEAD, but changed-file co-change windows need multiple cached values per DB/HEAD keyed by file set and options.
- **Change**: Add `headKeyedGitMap()` beside `headKeyedGitValue()`. It stores `{ head, values: Map<string, T | null> }`, invalidates on HEAD change, returns `null` when HEAD cannot be resolved, and remains in the `whole-project` invalidation group.
- **Why**: Diff-gate can ask for changed-file co-change windows repeatedly without re-running the same focused Git child processes.

- [x] **File**: `src/analysis/git-history.ts:169-181`, `src/analysis/git-history.ts:184-485`
- **Source**: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`, `node dist/cli.js code 'src/analysis/git-history.ts:120-240'`, `node dist/cli.js code 'src/analysis/git-history.ts:240-360'`
- **What**: Public helper functions directly own Git evidence reads.
- **Change**: Add `gitEvidenceProduct(db)` with methods `capability`, `commitHistory`, `fileChurn`, `changeAmplification`, `trackedFiles`, `fileAddRecords`, `coChangePairs`, `coChangePairsForFiles`, and `directionalCoChangePairsForFiles`. Move current helper bodies into private `build*` functions, add compatibility wrappers with `scip-query: ignore-wrapper`, and route product co-change methods through HEAD-keyed map caches keyed by sorted files and normalized co-change options.
- **Why**: This creates the structural product boundary while keeping existing imports source-compatible.

### 1.3 — Migrate command consumers to the product

- [x] **File**: `src/queries/cleanup/doc-drift.ts:283-325`, `src/queries/cleanup/doc-drift.ts:334-414`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/doc-drift.ts:276-354'`
- **What**: Doc drift calls `getCommitHistory()` and `getTrackedFiles()` directly in two places.
- **Change**: Import `gitEvidenceProduct`, create one product instance per function, and call `git.commitHistory()` / `git.trackedFiles()`.
- **Why**: Doc drift should consume Git facts through the product instead of direct helper composition.

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:1-146`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/recent-duplicates.ts:1-90'`, `node dist/cli.js code 'src/queries/cleanup/recent-duplicates.ts:136-152'`
- **What**: Recent duplicates imports `getFileAddRecords()` and derives its `FileAddRecords` type from that helper.
- **Change**: Import `gitEvidenceProduct` and `FileAddRecord`; define `FileAddRecords` as `Map<string, FileAddRecord>` and read `gitEvidenceProduct(db).fileAddRecords()`.
- **Why**: The recent-file focus window should use the file-add evidence product through the Git product boundary.

- [x] **File**: `src/queries/impact/co-change.ts:90-151`
- **Source**: `node dist/cli.js code 'src/queries/impact/co-change.ts:90-150'`
- **What**: Co-change reads `getCommitHistory()` and `getCoChangePairs()` separately.
- **Change**: Import `gitEvidenceProduct`, read `const git = gitEvidenceProduct(db)`, and call `git.commitHistory()` plus `git.coChangePairs()`.
- **Why**: Co-change command policy stays local, but Git fact loading belongs to the product.

- [x] **File**: `src/queries/impact/diff-gate.ts:567-654`
- **Source**: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:567-654'`
- **What**: Diff-gate reads directional co-change windows through `getDirectionalCoChangePairsForFiles()`.
- **Change**: Import `gitEvidenceProduct` and call `gitEvidenceProduct(db).directionalCoChangePairsForFiles(changed, opts)`.
- **Why**: The changed-file commit-window optimization becomes structural.

- [x] **File**: `src/queries/health/health.ts:526-562`
- **Source**: `node dist/cli.js code 'src/queries/health/health.ts:520-545'`
- **What**: Health reads churn and amplification through direct helpers.
- **Change**: Import `gitEvidenceProduct`, read `const git = gitEvidenceProduct(db)`, and call `git.fileChurn()` / `git.changeAmplification()`.
- **Why**: The health summary remains unchanged but uses the same product as other Git consumers.

- [x] **File**: `src/queries/impact/plan-context.ts:142-167`
- **Source**: `node dist/cli.js code 'src/queries/impact/plan-context.ts:140-165'`
- **What**: Plan context reads file churn directly.
- **Change**: Import `gitEvidenceProduct` and call `gitEvidenceProduct(db).fileChurn()`.
- **Why**: Plans consume the shared Git evidence product like commands do.

### 1.4 — Extend tests and validation coverage

- [x] **File**: `tests/analysis/git-history.test.ts` (test file is not indexed by scip-query; production behavior sources are cited above)
- **Source**: `node dist/cli.js trace getFileAddRecords`, `node dist/cli.js trace getDirectionalCoChangePairsForFiles`
- **What**: Existing tests cover Git history behavior through direct helpers.
- **Change**: Add product assertions for `capability('file-add-records')`, `fileAddRecords()`, `trackedFiles()`, `fileChurn()`, `coChangePairs()`, and `directionalCoChangePairsForFiles()`. Keep legacy helper assertions where they already prove source compatibility.
- **Why**: The product contract should be covered without weakening existing Git history behavior tests.

## Stress-Test Findings

1. Understand before touch: Git history fills evidence gaps the SCIP graph cannot see, especially doc/code coupling and files with no symbol relationship. Source: `node dist/cli.js code 'src/analysis/git-history.ts:1-120'`.
2. Blast radius: `src/analysis/git-history.ts` has 22 external consumers across doc drift, recent duplicates, health, co-change, diff-gate, and plan-context, so all public helpers stay as wrappers. Source: `node dist/cli.js change-surface src/analysis/git-history.ts`, `node dist/cli.js surface src/analysis/git-history.ts`.
3. Valid intermediate states: product addition is additive; wrapper conversion preserves existing imports; consumer migrations can happen one file at a time after the product exists.
4. Reversibility: all changes are internal TypeScript refactors and process-local caches. No SQLite schema, persistent key, or payload shape changes are planned.
5. Failure design: Git command failures continue returning `null`, and the product capability reports unavailable when HEAD cannot be resolved. Source: `node dist/cli.js code 'src/analysis/git-history.ts:111-143'`.
6. Concurrency: Node query execution is synchronous here; the new cache is per DB and HEAD-keyed, so concurrent callers in one process share immutable results for the same HEAD.
7. Boundaries: no CLI input validation changes; command-level policy remains in command modules. The product only owns Git fact access.
8. Data integrity: persisted file-add rows keep the existing `git-file-adds` kind, `__git__/file-adds` key, HEAD content hash, serializer, and validator. Source: `node dist/cli.js code 'src/analysis/git-history.ts:213-267'`.
9. Observability: verification will use benchmark output plus command smokes; no new runtime log path is introduced because existing Git helpers are silent-on-unavailable by contract.
10. Human impact: command output should remain byte-identical for representative JSON smokes because output shaping stays in existing commands.
11. Reuse: no similar file product exists; the closest reusable primitives are the current Git owner, `createPerDbValue()`, and `createFileEvidenceProduct()`. Source: `node dist/cli.js similar-files src/analysis/git-history.ts`, `node dist/cli.js code 'src/storage/per-db-cache.ts:86-110'`, `node dist/cli.js code 'src/storage/evidence-products.ts:1-37'`.

## Execution Order

1. Add product/capability types and the HEAD-keyed map cache in `src/analysis/git-history.ts`.
2. Add `gitEvidenceProduct(db)` and convert existing exported helpers into compatibility wrappers.
3. Migrate doc drift, recent duplicates, co-change, diff-gate, health, and plan-context consumers.
4. Extend Git history tests with product assertions.
5. Run focused Git tests and command smokes: `co-change --json`, `diff-gate --json`, `doc-drift --json`, `recent-duplicates --json`, `health --json --full`, and `plan-context src/analysis/git-history.ts`.
6. Run `npm run typecheck`, `npm run build`, structural checks, full tests, benchmark, `scip-query reindex`, and `scip-query diff-gate --json`.

## Ship Order

Ship as one internal refactor. There are no one-way doors: no schema changes, no cache kind changes, no CLI output schema changes, and legacy helper exports remain.

## Verification

- Focused tests passed: `npm test -- tests/analysis/git-history.test.ts tests/queries/impact/co-change-partner-labels.test.ts tests/queries/impact/diff-impact-accuracy.test.ts tests/queries/health/health-full.test.ts tests/queries/cleanup/dead-output.test.ts`.
- The migrated mock test passed: `npm test -- tests/queries/cleanup/recent-duplicates-pruning.test.ts`.
- Full tests passed: `npm test` reported 83 files and 463 tests passing.
- TypeScript and build passed: `npm run typecheck`, `npm run build`.
- Git-facing CLI smokes passed after citation refresh: `co-change --json`, `doc-drift --json`, `recent-duplicates --json`, `health --json --full`, `health --full`, `plan-context src/analysis/git-history.ts`, and final `diff-gate --json`.
- Structural checks passed with no findings: `wrapper-candidates --json`, `incomplete-migration --json`, `recent-duplicates --json`, and `unused-params --json`.
- Evidence-product benchmark passed with zero failed commands: `npm run bench:evidence-products -- --warm-iterations 0 --no-clear --out /tmp/git-evidence-products.jsonl`.
- Final gate passed: `node dist/cli.js reindex && node dist/cli.js diff-gate --json`.

## Summary

Files to modify:

- `src/analysis/git-history.ts`
- `src/queries/cleanup/doc-drift.ts`
- `src/queries/cleanup/recent-duplicates.ts`
- `src/queries/impact/co-change.ts`
- `src/queries/impact/diff-gate.ts`
- `src/queries/health/health.ts`
- `src/queries/impact/plan-context.ts`
- `tests/analysis/git-history.test.ts`
- Citation refresh docs flagged by diff-gate doc-reference checks:
  `docs/analyzer-inventory.md`, `docs/analyzer-validation-ledger.md`,
  `docs/benchmarks/2026-06-28-health-ledger.md`,
  `docs/validation/2026-06-21-analyzer-validation-pilot.md`,
  `docs/validation/2026-06-22-co-change-partner-labels-result.md`, and
  `docs/validation/2026-06-22-second-corpus-score-weight-confirmation-result.md`

Expected net effect: one Git evidence product API, focused co-change window caching by HEAD/files/options, migrated command consumers, source-compatible legacy helpers, and focused product tests.
