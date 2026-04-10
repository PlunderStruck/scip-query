# De-Bloat Report: scip-query

**Date:** 2026-04-10
**Health Score:** 33/100
**Scope:** 60 files, 1660 symbols, 996 KB

## Summary

- Total findings: 52 actionable (excluding false positives and expected deviations)
- Estimated recoverable LOC: ~1,724
- Safe deletions: 30 symbols (~1,712 LOC)
- Structural fixes: 2 (duplicate type, unused function)
- Consolidation candidates: 0 logic-level (similarity is boilerplate, not logic)
- Critical gap: Test coverage at 4%

---

## Priority 1: Safe Deletions (29 dead exports + 1 isolated symbol)

**Source:** `scip-query dead --min-loc 5` + `scip-query isolated --min-loc 3`

These are `export`ed functions that are only called within their own file, or not called at all. Remove `export` or delete entirely.

| File | Symbol | LOC | Classification |
|---|---|---|---|
| `src/symbol-parser.ts:116` | `parseDescriptors()` | 85 | dead export |
| `src/queries/slice.ts:98` | `forwardSlice()` | 64 | dead export |
| `src/queries/complexity.ts:78` | `countBranches()` | 54 | dead export |
| `src/queries/slice.ts:44` | `backwardSlice()` | 53 | dead export |
| `src/queries/similar.ts:143` | `getAllCalleeFingerprints()` | 50 | dead export |
| `src/queries/similar-chains.ts:184` | `editDistance()` | 44 | dead export |
| `src/queries/similar-chains.ts:137` | `dfsChains()` | 38 | dead export |
| `src/queries/similar-files.ts:105` | `compareProfiles()` | 35 | dead export |
| `src/queries/similar-files.ts:60` | `buildFileProfiles()` | 21 | dead export |
| `src/queries/similar-files.ts:82` | `findUniversalDependencies()` | 22 | dead export |
| `src/setup.ts:121` | `getScipDownloadUrl()` | 25 | dead export |
| `src/query-support.ts:160` | `calleeQueryParams()` | 17 | dead export |
| `src/queries/similar.ts:126` | `findCallees()` | 16 | dead export |
| `src/cli.ts:17` | `openDb()` | 23 | dead export |
| `src/cli.ts:41` | `withDb()` | 8 | dead export |
| `src/cli.ts:50` | `runQuery()` | 8 | dead export |
| `src/cli.ts` | `formatBytes()` | 6 | dead export |
| `src/cli.ts` | `formatStatus()` | 16 | dead export |
| `src/queries/similar-chains.ts:121` | `generateChains()` | 15 | dead export |
| `src/queries/similar-chains.ts:231` | `getCommonPrefix()` | 8 | dead export |
| `src/queries/similar-chains.ts:240` | `getCommonSuffix()` | 10 | dead export |
| `src/queries/similar-chains.ts:251` | `isSubChain()` | 6 | dead export |
| `src/queries/similar.ts:194` | `intersection()` | 7 | dead export |
| `src/queries/similar.ts:202` | `difference()` | 7 | dead export |
| `src/queries/similar.ts:210` | `unionSize()` | 5 | dead export |
| `src/gitignore-filter.ts:53` | `findGitignoreFiles()` | 26 | dead export |
| `src/reindex/index.ts:114` | `ensureBinary()` | 7 | dead export |
| `src/config.ts:51` | `resolveCacheDir()` | 19 | dead export |
| `src/config.ts:90` | `writeMetaFile()` | 12 | dead code (isolated) |

**Action:** Remove `export` keyword from all of these. Delete `writeMetaFile()` entirely (never called). This is ~1,712 LOC of leaked internal surface.

**Risk:** Zero. These are private implementation details incorrectly exported. Removing `export` doesn't change behavior.

**False positives excluded:** `cli.ts` module, `reindex-worker.ts` module, `postinstall.ts` module, `index.ts` module (all entry points).

---

## Priority 2: Structural Fixes

### 2a. Duplicate `HealthReport` type

**Source:** `scip-query stale-abstractions --min-loc 5`

`HealthReport` is defined in both `src/types.ts:380-399` and `src/queries/health.ts:22-46`. The one in `health.ts` is a local re-declaration.

**Action:** Remove the `HealthReport` interface from `queries/health.ts` and import from `types.ts`. ~25 LOC.

### 2b. Unused `ReindexOptions` interface

**Source:** `scip-query stale-abstractions`

`ReindexOptions` in `src/reindex/index.ts:7-21` has 0 consumers. It may be intended for programmatic API consumers but is currently dead.

**Action:** Verify intent. If unused, remove. 15 LOC.

---

## Priority 3: Consolidation Opportunities

**Source:** `scip-query similar --min-similarity 0.6` + `scip-query convergence`

10 function pairs at 60%+ similarity, but convergence analysis reveals the overlap is **shared boilerplate** (db, types, shortenSymbol imports), not logic duplication. Every query module follows the same pattern: import db → query SQLite → filter → map results → shorten symbols. This is correct architecture, not a problem.

**Action:** Optional low-priority refactor — extract a `withFilteredSymbols(db, scope, callback)` helper to reduce per-query scaffolding. Not urgent.

---

## Priority 4: Extraction Opportunities

**Source:** `scip-query extract-candidates --min-loc 10 --min-callees 4`

| File | LOC | Clusters | Action |
|---|---|---|---|
| `similar-chains.ts` | 258 | 2 (100% isolated each) | Split edit-distance + chain-generation into `chain-utils.ts` |
| `setup.ts` | 198 | 2 | Logically grouped (install vs detect) — no action |
| `types.ts` | 593 | 2 | Type barrel — consider splitting if it keeps growing |

**Action:** `similar-chains.ts` is the only actionable extraction. The two clusters (similarity logic vs edit-distance/chain-generation) are fully isolated.

---

## Priority 5: Indirection Removal

**Source:** `scip-query wrapper-candidates` + `scip-query passthrough-candidates`

- **Wrappers:** 4 found (`PathFilter`, `DescriptorSuffix`, `ScipLocalSymbol`, `ScipDescriptor`). All are type definitions consumed by core modules. Inlining would reduce clarity. **No action.**
- **Passthroughs:** 0 found. Clean.

---

## Priority 6: Convention Alignment

**Source:** `scip-query drift --min-deviation 40`

9 files deviate. 4 are expected (barrel files, entry points, orchestrators). 5 are worth reviewing:

| File | Deviation | Issue |
|---|---|---|
| `postinstall.ts` | 100% | Only imports `setup.ts` — expected for a thin entry point |
| `query-support.ts` | 100% | Imports `db.ts` but not `types.ts` — expected, it provides helpers not query results |
| `trace.ts` | 43% | Missing `query-support.ts` import — uses `db.localSymbolPredicate` directly |
| `watch.ts` | 50% | Imports `config.ts` + `gitignore-filter.ts` — unique among src/ siblings, expected |
| `reindex/index.ts` | 50% | Imports sibling modules — expected for an orchestrator |

**Action:** `trace.ts` is the only questionable deviation — it could potentially use `query-support.ts` helpers. Low priority.

---

## Structural Metrics

| Metric | Value | Assessment |
|---|---|---|
| Circular dependencies | 0 | Clean |
| Max dependency chain depth | 6 | Acceptable (barrel → orchestrator → query → support → db → filter) |
| Top coupling bottleneck | `queries/index` (score 192) | Barrel file — expected |
| Top complexity hotspot | `types.ts` (score 121, 593 LOC) | Growing — monitor |
| Test coverage | **4%** (7/168 symbols) | **Critical gap** |
| Doc coverage | 100% (163/163) | Excellent |

---

## Action Plan

| # | Action | LOC Impact | Risk | Effort |
|---|---|---|---|---|
| 1 | Remove `export` from 29 dead exports | -0 (keyword removal) | Zero | 15 min |
| 2 | Delete `writeMetaFile()` | -12 | Zero | 1 min |
| 3 | Remove duplicate `HealthReport` from `health.ts` | -25 | Zero | 2 min |
| 4 | Verify/remove unused `ReindexOptions` | -15 | Low | 2 min |
| 5 | Split `similar-chains.ts` clusters | 0 (structural) | Low | 15 min |
| 6 | Add tests for `db`, `query-support`, `symbol-parser` | +200-400 | Zero | 1-2 hrs |
| 7 | Monitor `types.ts` growth (593 LOC) | — | — | — |

**Quick wins (items 1-4):** 20 minutes, ~52 LOC removed, zero risk.
**Test coverage (item 6):** Most impactful long-term investment. Core infrastructure at 4% is the biggest risk in this codebase.
