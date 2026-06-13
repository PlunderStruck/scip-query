# GPT Performance Feedback

Date: 2026-06-13

This document records the performance feedback supplied after the GPT 5.5 Pro feedback pass. The goal is to improve latency and repeated-command cost without reducing output or accuracy. A performance optimization is acceptable only when it preserves the same evidence contract: the same source files, SCIP facts, semantic facts, Git facts, and candidate comparisons must still be considered whenever they can affect output.

## Accuracy Position

Most items below are accuracy-preserving because they replace repeated work with equivalent cached or bulk work. A cache is stored evidence reused when its exact inputs have not changed. A fingerprint is a compact identity for those inputs, such as file hashes or Git blob IDs. The risk in these changes is not the algorithmic idea itself; the risk is stale or incomplete invalidation. Every implementation slice must therefore include tests that compare old and new output shape, cache invalidation, and fallback behavior.

## Feedback Items

## Implementation Status

Implemented and verified in this patch train: items 5, 6, 7, 8, 9, 10, 11, 14, 15, 19, and 20.

Deferred with concrete architecture plans: items 1, 2, 3, 4, 12, 13, 16, 17, and 18. See `docs/plans/2026-06-13-performance-remaining-architecture-plans.md`.

### 1. Git-backed freshness instead of whole-project hashing

Current no-op reindex computes a project fingerprint by reading and SHA-256 hashing every non-artifact project file. That is exact, but it scales with total bytes in the repo. Use Git blob IDs for clean tracked files, hash only dirty or untracked files, and keep the current full-hash behavior for non-Git repos. This should preserve exactness while making no-op freshness checks much cheaper.

### 2. Per-language incremental reindexing

Fresh reindexing is currently all-or-nothing across requested languages. In a mixed-language repo, a Python-only change should not force TypeScript, Go, Rust, and Java indexers to rerun. Store per-language fingerprints and cached per-language `.scip` outputs, rerun only changed languages, then merge reused and fresh SCIP snapshots.

### 3. Merge and sanitize SCIP in one protobuf pass

Multi-language indexing currently merges SCIP output, writes it, rereads it, sanitizes it, and writes again. Merge and sanitize in memory, then serialize once. The final sanitized SCIP output should be identical, with less protobuf deserialize/serialize work.

### 4. Per-language SQLite databases or attached databases

This is a larger architecture change. Instead of converting a full merged `.scip` into one SQLite DB after any language changes, maintain per-language SQLite DBs and query them through SQLite `ATTACH`, or rebuild only affected rows in the merged DB. The safer first design is attached per-language DBs, but it requires a query-layer union strategy.

### 5. Bulk SQL for diff-impact

`diff-impact` currently performs per-symbol fan-in and consumer-file queries. Replace those with bulk `IN (...) GROUP BY ...` queries. Also replace per-file leading-wildcard path lookup with a document-path map and exact matching first. This should preserve the same evidence while reducing SQL round trips.

### 6. Reuse the diff plan in incomplete-migration

`diff-gate` computes diff impact, then `incomplete-migration` recomputes changed files through `diffImpactPlan()`. Allow `incompleteMigration()` to accept an existing diff plan or changed-file set so the same Git and DB resolution work is not repeated.

### 7. Inverted candidate index for incomplete-migration

The detector currently compares each new helper against many candidate fingerprints. Build an inverted map from callee symbol to candidate fingerprints, then only score candidates that share at least one helper callee. Any zero-overlap candidate cannot pass containment, so this should not change output.

### 8. Cached source line arrays

Several hot paths repeatedly split the same source text into lines. Add a cached `getSourceLines(db, relativePath)` primitive and use it in suppression checks, definition snippets, cleanup deletion helpers, re-export-only consumer checks, and other line-range logic.

### 9. Avoid full disk source walks when indexed documents already exist

`getSourceFiles()` uses indexed document paths and also walks the project directory. Prefer indexed documents, then use Git or filesystem listing only to find auxiliary unindexed source files. This preserves auxiliary-file behavior while avoiding a blind recursive walk when Git can enumerate files faster.

### 10. Restrict `buildChunkCalleeMap()` to requested documents

For non-AST languages, chunk callee fallback currently queries all non-definition mentions and all global symbols even when only a small definition subset is requested. Limit the work to the target document IDs, collect mentioned symbol IDs, and resolve only those symbols.

### 11. Interval indexes for containing-definition lookup

AST and TypeScript semantic callee builders repeatedly answer which definition contains a call line. Replace linear per-callsite scans with per-file interval indexes or line-owner maps. This preserves ownership decisions while reducing per-callsite CPU.

### 12. Lazy TypeScript semantic projects by tsconfig

The TypeScript semantic provider currently tends to construct projects for all discovered tsconfigs. Instead, resolve the relevant tsconfig for a file, lazily construct only that project bundle, and cache by tsconfig path. This preserves accuracy because each file is still analyzed under its real tsconfig.

### 13. Persist semantic reference evidence

The evidence cache persists source facts and semantic callee evidence, but semantic references can still require ts-morph work on warm runs. Add a `semantic_references` cache keyed by CLI version, semantic project epoch, definition symbol, and definition file hash.

### 14. Delete stale semantic callee cache rows once per file/hash

`writeCachedSemanticCalleesBatch()` deletes stale rows inside a per-entry loop. If a file has many definitions, the same stale delete repeats many times. Delete once per `(relativePath, contentHash)` before writing rows.

### 15. Cache semantic definition resolution

TypeScript semantic definition resolution can issue repeated wildcard SQL and line-distance queries. Build a per-file definition index keyed by leaf name and sorted by start line, then resolve declarations through that cached index.

### 16. Persist Git-history derived facts

Git history is cached per process, but each CLI command starts fresh. Persist commit history, churn, add records, co-change pairs, and doc/code coupling summaries in `evidence.db`, keyed by HEAD and algorithm version. This should speed `co-change`, `recent-duplicates`, `doc-drift`, `health`, and `diff-gate`.

### 17. Health phases: smart in-process or parallel execution

`health` runs isolated phases sequentially. Add a smart default: in-process execution for small/medium repos to share caches, and bounded worker parallelism for large repos. Cache release between phases should be memory-sensitive rather than unconditional.

### 18. Share candidate corpora across health phases

Health phases rebuild candidate corpora because they run in separate processes and clear caches. A worker-pool design could keep warmed workers and share corpora where memory allows. Output should remain identical.

### 19. Exact top-K pruning for `similarAll`

`similarAll()` has an early break after collecting more than `limit * 5` results, which is fast but can miss better later pairs. Replace it with an exact bounded min-heap and cheap upper-bound pruning. This improves both speed and correctness.

### 20. Inverted token index for source-shape fallback

`similarBySourceShape()` compares a target source fingerprint against every source fingerprint. Build a token-to-candidate index and only compare candidates sharing meaningful tokens. Zero-token-overlap candidates cannot pass similarity, so output should be preserved.

## Suggested Implementation Order

1. Cached `getSourceLines()`.
2. Bulk SQL for `diff-impact`.
3. Stale-delete dedupe in semantic callee cache writes.
4. Restrict `buildChunkCalleeMap()` to requested docs and symbols.
5. Per-language reindex metadata and cached `.scip` outputs.
6. Git-backed exact freshness.
7. Lazy TypeScript semantic project loading by tsconfig.
8. Health in-process and worker-pool modes.
9. Persistent Git-history evidence cache.
10. Exact top-K heap for similarity.

## External Validation Plan Before Implementation

Before changing performance internals, validate the current post-feedback CLI behavior on a separate repository:

- Run the freshly built local CLI against `/Users/aydansalois/Documents/GitHub/Stable_Management`.
- Verify `config-validate --json`, `capabilities --json`, `status --json`, `setup-ci --dry-run`, `reindex`, and `diff-gate --json`.
- Exercise cleanup automation with `cleanup-plan --json` and, if the project has checkers and candidates, `cleanup-plan --verify`.
- If any command fails because of the previous implementation, fix that before starting performance changes.
