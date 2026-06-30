# File Dependency Evidence — 2026-06-30

## Goal

The user wants the tenth structural optimization item completed in register order. File dependency evidence means the set of directed relationships where one indexed source file depends on another source file, classified as reusable evidence rather than as a command-local graph build. A directed relationship is a fact with a source file, a target file, and an orientation from consumer to dependency; an indexed source file is a file recorded in the SCIP database and not excluded by project filters.

Done means the file dependency graph has a registered project-level evidence product, cache keys include the project fingerprint and source-import fingerprint, all existing graph consumers keep the same output hashes, and benchmark/profile runs prove the new product can skip the expensive SCIP-edge scan after the graph is materialized.

## Current State

- `node dist/cli.js status --capabilities` reported a fresh TypeScript index before planning.
- `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json` returned no findings, so the register entry is still current.
- `node dist/cli.js recent-duplicates --json` returned no findings before this slice.
- `src/symbols/graph/file-dep-graph.ts:16-55` implements `buildFileDepGraph()`. It uses `FILE_DEP_GRAPH_CACHE`, collects indexed document paths, adds SCIP symbol-reference edges, then adds source-import fallback edges through the same normalization path. Source: `node dist/cli.js plan-context buildFileDepGraph`, `node dist/cli.js code buildFileDepGraph -C 8`.
- `src/symbols/graph/file-dep-graph.ts:57-80` reads cross-file SCIP edges from `mentions`, `chunks`, `documents`, and symbol-definition subqueries. Source: `node dist/cli.js code scipFileDepEdges -C 8`.
- `src/symbols/graph/file-dep-graph.ts:82-98` normalizes every edge by rejecting self edges, ignored paths, and targets that are not indexed files before adding to a `Map<string, Set<string>>`. Source: `node dist/cli.js code addFileDepEdge -C 8`.
- `src/language-parsers/index.ts:67-83` loads source imports through `SOURCE_IMPORT_CACHE` and `SOURCE_IMPORTS_PRODUCT`, keyed by file content hash and import-resolution fingerprint. Source: `node dist/cli.js code getSourceImports -C 8`.
- `src/storage/evidence-cache.ts:104-124` exposes `projectEvidenceFingerprint()`, which reads the reindex metadata fingerprint and indexed languages from `meta.json`. Source: `node dist/cli.js code projectEvidenceFingerprint -C 8`.
- Before this item, `src/storage/evidence-cache.ts:137-244` created the persistent `evidence.db` tables for file evidence, semantic callees, and semantic references, but there was no general project-evidence table. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:132-220'`, verified after implementation with `node dist/cli.js outline src/storage/evidence-cache.ts`.
- Before this item, `src/storage/evidence-products.ts:35-51` provided `createFileEvidenceProduct()`, a small product adapter over cache reads/writes, but it only supported file-keyed evidence. Source: `node dist/cli.js code createFileEvidenceProduct -C 8`, verified after implementation with `node dist/cli.js outline src/storage/evidence-products.ts`.
- `src/core/project-index.ts:109-111` exposes `ProjectIndex.fileDependencyGraph()` as a direct wrapper around `buildFileDepGraph()`. It is called by drift, locality candidates, and wrapper candidates. Source: `node dist/cli.js plan-context 'ProjectIndex:fileDependencyGraph'`.
- Direct `buildFileDepGraph()` callers include `getLiveBarrelPaths()`, `fanOut()`, `cycles()`, `deepChains()`, `similarChains()`, `similarFiles()`, `coChange()`, `coChangeStructuralLinkChecker()`, and `depsDigestFor()`. Source: `node dist/cli.js plan-context buildFileDepGraph`, `node dist/cli.js affected buildFileDepGraph`.

Non-obvious invariants to preserve:

- A graph miss must add SCIP edges before source-import fallback edges, because several graph commands iterate `Map` and `Set` insertion order while ranking chains and cycles. Source: `node dist/cli.js code buildFileDepGraph -C 8`, `node dist/cli.js code cycles -C 6`, `node dist/cli.js code deepChains -C 6`.
- Edge normalization must stay centralized in `addFileDepEdge()` so ignored files, self edges, and non-indexed source-import targets cannot leak into consumers. Source: `node dist/cli.js code addFileDepEdge -C 8`.
- Source-import fallback is part of the graph contract, not only a TypeScript convenience. `getSourceImports()` selects a language parser by path and returns `[]` when no parser or source is available. Source: `node dist/cli.js code getSourceImports -C 8`.
- The persistent evidence cache must degrade to misses/no-ops on SQLite errors; query commands must never fail because the rebuildable cache is unavailable. Source: `node dist/cli.js code readCachedFileEvidence -C 8`, `node dist/cli.js code writeCachedFileEvidence -C 8`.

## Reuse Audit

- Reuse `projectEvidenceFingerprint()` for the project half of the graph cache key. It already ties cache validity to reindex metadata and indexed language set. Source: `node dist/cli.js code projectEvidenceFingerprint -C 8`.
- Reuse `createFileEvidenceProduct()`'s adapter pattern by extending `src/storage/evidence-products.ts` with a project-evidence sibling; do not let `file-dep-graph.ts` talk to SQLite statements directly. Source: `node dist/cli.js code createFileEvidenceProduct -C 8`, `node dist/cli.js surface src/storage/evidence-products.ts`.
- Reuse `sha256Hex()` for the source-import fingerprint. It is the canonical evidence hash helper. Source: `node dist/cli.js code fileContentHash -C 8`.
- Reuse `getSourceImports()` for import fallback and source-import fingerprint input. It already handles parser selection, file content hashes, import resolution fingerprints, and persistent per-file import rows. Source: `node dist/cli.js code getSourceImports -C 8`.
- Reuse `buildFileDepGraph()`'s public signature and `ProjectIndex.fileDependencyGraph()` wrapper. The direct and transitive blast radius is 60 affected symbols across 33 files, so changing call signatures would create unnecessary migration risk. Source: `node dist/cli.js affected buildFileDepGraph`, `node dist/cli.js plan-context 'ProjectIndex:fileDependencyGraph'`.
- `node dist/cli.js similar-files src/symbols/graph/file-dep-graph.ts --json` found no structurally similar module, and `node dist/cli.js similar buildFileDepGraph --json` only found low-similarity access/query scaffolding. A new file-dependency graph product is justified because no existing product serializes project-level file graph evidence.

## Baseline Hashes

These hashes were captured before item 10 edits and must match after migration:

- `cycles --json`: `fd5d5d9e282ae3e5ce7b10ca6ca1d6e9819506a1027b7fb24bcec8e5aacbb8bb`
- `deep-chains --json`: `9bca8cf576011bd5054ae533cac1ac1d042cbe1d51724967cc3d687cd963923d`
- `similar-files --json`: `cf0f6a9c88fe0f184eabcd92f8f7ceb808c32fe0d06fd984b8626636c4888c75`
- `similar-chains --json`: `72fd30a3fdf10d38b45faa8517ea166f7da305721134f49da77d73ac917d0831`
- `co-change --json`: `219c29d4a0e424769c102729d94fd9602029f5e85dc41aa74d6bf20abf7c191f`
- `drift --json`: `dde60e251c46c6b367ff88b81598674daa5332886aa63bee58f95db2e27fd900`
- `wrapper-candidates --json`: `111fbc2c4061ec68031525260f162c662cc6faa46d918c54e186d904c90f9240`
- `locality-candidates --json`: `c0e1fcdf7b05449142251ad8c378e1da0eebaa63d57599a71d3971159f80288c`
- `fan-out --json`: `6031420a5ca25ea4b695609751691975073965405a2206d4d6a6a999e4a820df`

Baseline profile sample:

- `similar-files --json`: `file-dep-graph.scip-edges` 35ms for 1447 edges, `file-dep-graph.source-imports` 13ms for 247 files and 1684 edges.
- `cycles --json`: `file-dep-graph.scip-edges` 35ms for 1447 edges, `file-dep-graph.source-imports` 24ms for 247 files and 1684 edges.

## Design Phases

### 1.1 — Add project-evidence storage primitives

- [x] **File**: `src/storage/evidence-cache.ts:27-58`
- **Source**: `node dist/cli.js code 'src/storage/evidence-cache.ts:1-90'`, `node dist/cli.js change-surface src/storage/evidence-cache.ts`
- **What**: `FileEvidenceKind` lists file-keyed product kinds, and `EvidenceConnection` has statements for file evidence, semantic callees, and semantic references only.
- **Change**: Add `ProjectEvidenceKind = 'file-dependency-graph'`; add `readProjectEvidence`, `readLegacyProjectEvidence`, and `writeProjectEvidence` statements to `EvidenceConnection`.
- **Why**: File dependency graph evidence is project-shaped: one payload represents the whole graph for a scope, keyed by project/source-import fingerprints rather than by one file's content hash.

- [x] **File**: `src/storage/evidence-cache.ts:137-244`
- **Source**: `node dist/cli.js code 'src/storage/evidence-cache.ts:132-220'`
- **What**: `connectionFor()` creates `file_evidence`, `semantic_callees`, and `semantic_references`.
- **Change**: Create a `project_evidence` table with `(kind, cache_key, project_fingerprint, version, payload)` and primary key `(kind, cache_key)`. Prepare read, legacy-read, and write statements. Keep the existing disable-on-error behavior.
- **Why**: Project evidence needs its own table so project-wide products do not pretend to be per-file rows.

- [x] **File**: `src/storage/evidence-cache.ts:253-325`
- **Source**: `node dist/cli.js code readCachedFileEvidence -C 8`, `node dist/cli.js code writeCachedFileEvidence -C 8`, `node dist/cli.js code readCachedSemanticCallees -C 8`
- **What**: Public cache functions expose safe file-evidence and semantic-evidence reads/writes, returning misses or no-ops when the evidence DB is disabled.
- **Change**: Add `readCachedProjectEvidence(db, kind, cacheKey, projectFingerprint)` and `writeCachedProjectEvidence(db, kind, cacheKey, projectFingerprint, payload)`, mirroring the file-evidence safety contract.
- **Why**: Product code should receive the same "never fail a query" guarantee for project evidence.

### 1.2 — Add a project evidence product adapter

- [x] **File**: `src/storage/evidence-products.ts:1-70`
- **Source**: `node dist/cli.js code createFileEvidenceProduct -C 8`, `node dist/cli.js surface src/storage/evidence-products.ts`
- **What**: The product adapter supports `read(db, relativePath, contentHash)` and `write(db, relativePath, contentHash, value)` only.
- **Change**: Add `ProjectEvidenceProduct<T>`, `ProjectEvidenceProductOptions<T>`, and `createProjectEvidenceProduct<T>()` with `read(db, cacheKey, projectFingerprint)` and `write(db, cacheKey, projectFingerprint, value)`.
- **Why**: File dependency evidence needs the same serialization/validation boundary as file evidence without duplicating storage calls in graph code.

### 1.3 — Register and use the file dependency graph product

- [x] **File**: `src/symbols/graph/file-dep-graph.ts:9-123`
- **Source**: `node dist/cli.js code buildFileDepGraph -C 8`, `node dist/cli.js code projectEvidenceFingerprint -C 8`, `node dist/cli.js code getSourceImports -C 8`
- **What**: `buildFileDepGraph()` builds the full graph on every fresh process miss, even when the same project fingerprint and import fallback facts were already materialized in `evidence.db`.
- **Change**: Add a `FILE_DEPENDENCY_GRAPH_PRODUCT` registered with `createProjectEvidenceProduct()`. Compute a scoped cache key from `scope ?? ''`. Compute a graph fingerprint from `projectEvidenceFingerprint(db)` plus a source-import fingerprint derived from the scoped indexed files and their `getSourceImports()` source-path edges. On a product hit, deserialize and return the graph. On a miss or unavailable fingerprint, run the existing SCIP-edge and source-import edge build, then write the graph payload.
- **Why**: The expensive graph build becomes a reusable evidence product while keeping the existing in-process per-DB cache as the first-level memoization.

- [x] **File**: `src/symbols/graph/file-dep-graph.ts:125-239`
- **Source**: `node dist/cli.js code scipFileDepEdges -C 8`, `node dist/cli.js code addFileDepEdge -C 8`
- **What**: The current graph stores `Map<string, Set<string>>` in insertion order produced by SCIP edges followed by source-import edges.
- **Change**: Add payload helpers that serialize graph entries and dependency arrays in current iteration order, validate payloads defensively, and rehydrate `Map<string, Set<string>>` without sorting. Add `collectSourceImportEdges()` so source-import fallback can feed both the source-import fingerprint and the miss-path graph build.
- **Why**: Output hashes for cycle and chain commands can depend on iteration order; the persistent payload must preserve the graph order, not normalize it into a new order.

- [x] **File**: `src/symbols/graph/file-dep-graph.ts:43-123`
- **Source**: `node dist/cli.js code buildFileDepGraph -C 8`
- **What**: Profile output currently reports only `file-dep-graph.scip-edges` and `file-dep-graph.source-imports`.
- **Change**: Add a `file-dep-graph.product` profile span with `scope`, `hit`, `available`, `sourceImportFingerprint`, `files`, `sourceEdges`, and `graphFiles` counters. On a product hit, the profile should show no `file-dep-graph.scip-edges` span for that process.
- **Why**: The benchmark proof for this register item needs direct observability of hit/miss behavior.

### 1.4 — Test storage and graph behavior

- [x] **File**: `tests/storage/evidence-cache.test.ts:45-53,152-174` (tests are not indexed by scip-query)
- **Source**: `node dist/cli.js change-surface src/storage/evidence-cache.ts`, `node dist/cli.js surface src/storage/evidence-cache.ts`
- **What**: Storage tests currently cover file and semantic evidence paths but not a project-evidence product.
- **Change**: Add tests that project evidence reads a matching `(kind, cacheKey, projectFingerprint)` payload, misses when the fingerprint changes, and tolerates corrupt payloads through the product adapter.
- **Why**: The new table is a storage boundary; it needs direct regression coverage.

- [x] **File**: `tests/symbols/file-dep-graph.test.ts:1-136` (new test file; tests are not indexed by scip-query)
- **Source**: `node dist/cli.js plan-context buildFileDepGraph`, `node dist/cli.js affected buildFileDepGraph`
- **What**: No test directly pins persistent graph hit behavior or output-preserving serialization.
- **Change**: Add a small integration test that runs a graph-backed command twice with profiling enabled against a fixture or the test DB: first run reports `file-dep-graph.product` miss plus SCIP/source spans; second run reports `file-dep-graph.product` hit and omits the SCIP-edge span. Add a helper-level test, if practical, that rehydrated graph iteration order matches the stored graph order.
- **Why**: The optimization is only accepted if it preserves output while proving the persistent hit path exists.

### 1.5 — Verify consumer outputs and benchmark hit path

- [x] **File**: command output fixtures in `/tmp` (verification artifact)
- **Source**: `node dist/cli.js affected buildFileDepGraph`, baseline hashes listed above
- **What**: Nine command outputs exercise the direct and ProjectIndex-mediated graph consumers.
- **Change**: After build, rerun `cycles`, `deep-chains`, `similar-files`, `similar-chains`, `co-change`, `drift`, `wrapper-candidates`, `locality-candidates`, and `fan-out` JSON commands and require exact hash matches.
- **Why**: Persistent graph reuse must not change any user-facing result contract.

- [x] **File**: profile fixtures in `/tmp` (verification artifact)
- **Source**: baseline profile commands listed above
- **What**: Baseline fresh-process graph builds spend about 35ms in SCIP-edge scanning and 13-24ms in source-import fallback on this repo.
- **Change**: Run the same profiled commands twice after implementation. Accept the item only if the second fresh process shows a `file-dep-graph.product` hit and skips the `file-dep-graph.scip-edges` span while command hashes still match.
- **Why**: This item is in "Promote after one more benchmark"; it needs measured proof that the product helps a repeated-process path.

## Stress-Test Findings

1. Understand before touch: the graph merges compiler-resolved symbol edges and source import fallback. Either source alone is incomplete. Source: `node dist/cli.js code buildFileDepGraph -C 8`.
2. Blast radius: `buildFileDepGraph()` affects 60 symbols across 33 files, including health, diff-gate, dead code, and graph commands. Source: `node dist/cli.js affected buildFileDepGraph`.
3. Valid intermediate states: adding project-evidence storage is backwards-compatible because no caller uses it until the graph product is wired.
4. Reversibility: this is a rebuildable cache table and internal product; rollback means returning `buildFileDepGraph()` to the in-process cache path and leaving unused evidence rows harmless.
5. Failure design: project-evidence reads/writes must mirror current evidence-cache behavior: first SQLite error disables the evidence connection and degrades to misses/no-ops. Source: `node dist/cli.js code readCachedFileEvidence -C 8`.
6. Concurrency: `evidence.db` already uses WAL and a 5000ms busy timeout. New writes use the same connection and `INSERT OR REPLACE` pattern. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:132-220'`.
7. Boundaries: no CLI API or output schema changes; all entry points continue calling existing query functions.
8. Data integrity: cache data is rebuildable and versioned; stale rows cannot be read unless project/source-import fingerprints and payload version match.
9. Observability: `file-dep-graph.product` counters make hit/miss behavior visible in profile JSONL.
10. Human impact: commands should become faster on repeated fresh-process runs, with byte-for-byte identical JSON output.
11. Reuse: the plan extends the evidence-product and evidence-cache patterns instead of creating graph-specific SQLite code.

## Verification

- Focused tests: `npx vitest run tests/storage/evidence-cache.test.ts tests/symbols/file-dep-graph.test.ts` passed, 2 files and 14 tests.
- Typecheck: `npm run typecheck` passed.
- Build: `npm run build` passed after implementation and after the item-specific formatting pass.
- Item-specific format check: `npx prettier --check src/storage/evidence-cache.ts src/storage/evidence-products.ts src/symbols/graph/file-dep-graph.ts tests/storage/evidence-cache.test.ts tests/symbols/file-dep-graph.test.ts` passed after formatting `src/symbols/graph/file-dep-graph.ts`.
- Repo-wide format check remains blocked by 29 broader working-tree files that predate this item, so this item used the narrower file set above.
- Output preservation before reindex: the nine baseline hashes listed above matched exactly for `cycles`, `deep-chains`, `similar-files`, `similar-chains`, `co-change`, `drift`, `wrapper-candidates`, `locality-candidates`, and `fan-out`.
- Persistent hit proof: after clearing only `project_evidence` rows with kind `file-dependency-graph`, the first fresh-process `similar-files --json` run reported `file-dep-graph.product` with `available: true`, `hit: false`, `graphFiles: 213`, and also reported `file-dep-graph.scip-edges` at 35ms for 1447 edges. The second fresh process reported `file-dep-graph.product` with `available: true`, `hit: true`, `graphFiles: 213`, and no `file-dep-graph.scip-edges` span.
- Structural checks after reindex: `wrapper-candidates --json`, `incomplete-migration --json`, `recent-duplicates --json`, and `unused-params --json` returned no findings. `stale-abstractions --json` stayed at the known five accepted stale entries: `FileEvidenceKind`, `ReactComponentProfileOptions`, `VueComponentProfileOptions`, `SemanticReferenceCacheEntry`, and `FileAddRecord`.
- Full tests: `npm test` passed, 86 files and 474 tests. Vitest printed an existing git-diff usage warning from a test path, but the suite exited 0.
- Benchmark: `npm run bench:evidence-products -- --warm-iterations 0 --no-clear --out /tmp/file-dependency-evidence.jsonl` completed with `failed: 0`.
- Diff impact: `node dist/cli.js diff-impact --json` completed; the broad impact reflects the accumulated structural-optimization campaign, and item 10 specifically added `ProjectEvidenceProduct`, `createProjectEvidenceProduct()`, `FILE_DEPENDENCY_GRAPH_PRODUCT`, and `buildFileDepGraph()` evidence-product wiring.
- Health: `node dist/cli.js health --full --json` reported `score: 99`, `riskScore: 100`, and `hygieneScore: 99`. The remaining point is the existing similar-function axis at 8 pairs, not a file-dependency evidence regression.

## Execution Order

1. Extend project-evidence storage primitives.
2. Add the project evidence product adapter.
3. Register and use the file dependency graph product.
4. Add storage and graph tests.
5. Run focused tests, typecheck, build, command hash checks, profile before/after comparison, structural checks, full tests, benchmark, health, reindex, and diff-gate.

## Ship Order

Ship as one internal optimization. The storage addition is a two-way door because `evidence.db` is a rebuildable cache and old installations create missing tables lazily. Public query APIs and JSON outputs must not change.

## Summary

Files to modify/create:

- `src/storage/evidence-cache.ts`
- `src/storage/evidence-products.ts`
- `src/symbols/graph/file-dep-graph.ts`
- `tests/storage/evidence-cache.test.ts`
- `tests/symbols/file-dep-graph.test.ts`

Expected net effect: file dependency graph construction becomes a registered project evidence product with persistent hit/miss observability; repeated fresh-process graph commands can skip the SCIP-edge graph scan while preserving current outputs.
