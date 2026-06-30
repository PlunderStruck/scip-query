# Health Score Cleanup While Preserving Optimizations

Date: 2026-06-30

## Goal

Raise the repository's `scip-query health` score as high as reasonably possible by fixing confirmed health-score findings. Done means the score improves without weakening optimized behavior: hot-path code is changed only after its current purpose, consumers, and verification path are known.

## Current State

- Baseline score is 93/100. Source: `scip-query health --json --full`.
- Current score deductions are one dependency cycle, six wrapper candidates, twelve direct drift findings, and sixteen score-weighted hidden-coupling pairs. Source: `scip-query health --json --full`.
- Tooling is available and fresh: TypeScript SCIP indexing, semantic provider, cleanup detectors, compiler cleanup verification, and diff gate are all available. Source: `scip-query status --capabilities`; `scip-query capability-matrix --json`.
- The health entrypoint is `health()` in `src/queries/health/health.ts:195-200`, which runs health analyses and returns `buildHealthReport()` output. Source: `scip-query plan-context health`.
- There are no current diff-gate findings before this work. Source: `scip-query diff-gate --json`.

## Reuse Audit

No new runtime symbol is planned in the first batch. Source: `scip-query cleanup-plan --verify --json`; `scip-query code semanticCalleeRowCount -C 20`.

## Design Phases

### 1.1 - Delete Verified Dead Helper

- [x] **File**: `src/storage/evidence-cache.ts:264-276`
- **Source**: `scip-query cleanup-plan --verify --json`; `scip-query code semanticCalleeRowCount -C 20`; `scip-query refs semanticCalleeRowCount`; `scip-query affected semanticCalleeRowCount --json`; `scip-query change-surface src/storage/evidence-cache.ts --json --full`
- **What**: `semanticCalleeRowCount()` opens the evidence cache, counts rows in `semantic_callees`, disables the cache on error, and returns zero if the cache is unavailable.
- **Change**: Remove `semanticCalleeRowCount()` entirely.
- **Why**: `cleanup-plan --verify` reports it as the only compiler-verified dead-code batch; `refs` returns no references; `affected` returns no affected symbols; its own change-surface risk is low.
- **Verification**: run `npm test -- tests/storage/evidence-cache.test.ts`, `npm run typecheck`, `scip-query reindex`, `scip-query diff-gate --json`, and `scip-query health --json --full`.

### 2.1 - Move Profiling Helper Out of Runtime

- [x] **Files**: `src/instrumentation/profile.ts:1-85`; thirteen import sites reported by `scip-query rdeps src/runtime/profile.ts` before the move
- **Source**: `scip-query plan-context profile`; `scip-query code src/runtime/profile.ts:1-220`; `scip-query rdeps src/runtime/profile.ts`; `scip-query change-surface src/runtime/profile.ts --json --full`; `scip-query drift --json --full`
- **What**: `src/runtime/profile.ts` contains cross-cutting profiling helpers. Twelve lower-level query, semantic, source, and graph files import it, producing all direct drift findings.
- **Change**: Move the file to `src/instrumentation/profile.ts`, update import paths only, and let the drift policy recognize instrumentation as cross-cutting.
- **Why**: Profiling is shared instrumentation, not runtime command dispatch. Moving the helper preserves behavior while removing the lower-layer dependency on `runtime`.
- **Verification**: run targeted tests around profiled hot paths, `npm run typecheck`, `scip-query reindex`, `scip-query diff-gate --json`, `scip-query drift --json --full`, and `scip-query health --json --full`.

### 3.1 - Extract SourceFacts Type To Break Clojure Cycle

- [x] **Files**: `src/source/source-facts.ts`; `src/source/clojure-facts.ts`; `src/source/source-fact-types.ts`
- **Source**: `scip-query cycles`; `node dist/cli.js deps src/source/clojure-facts.ts`; `node dist/cli.js deps src/source/source-facts.ts`; `node dist/cli.js code src/source/source-facts.ts:1-280`; `node dist/cli.js code src/source/clojure-facts.ts:1-260`; `node dist/cli.js change-surface src/source/source-facts.ts --json --full`; `node dist/cli.js affected buildClojureSourceFacts --json`
- **What**: A real two-file cycle exists because `clojure-facts.ts` imports only the `SourceFacts` type from `source-facts.ts`, while `source-facts.ts` imports `buildClojureSourceFacts()`.
- **Change**: Move the `SourceFacts` interface to `src/source/source-fact-types.ts`, re-export it from `source-facts.ts`, and make `clojure-facts.ts` import the type from the new type module.
- **Why**: This breaks the dependency cycle without changing Clojure parsing, source fact caching, serialization, or call-site behavior.

### 4.1 - Confirm Wrapper and Stale-Abstraction Candidates Individually

- [x] **Files**: `src/symbols/symbol-kind.ts`; `src/analysis/similarity.ts`; `src/queries/internal/dead-candidate-gate.ts`
- **Source**: `node dist/cli.js wrapper-candidates --json --full`; `node dist/cli.js code src/symbols/symbol-kind.ts:1-70`; `node dist/cli.js code src/analysis/similarity.ts:70-130`; `node dist/cli.js code src/queries/internal/dead-candidate-gate.ts:70-95`
- **What**: Six wrapper candidates remain, all naming SCIP-kind policy, IDF/vector math policy, or dead-candidate shape policy used by optimized call-graph, similarity, and dead-code paths.
- **Change**: Add `scip-query: ignore-wrapper` comments with specific reasons instead of inlining these helpers.
- **Why**: The functions are intentional named primitives. Inlining them would churn optimized hot paths without improving behavior.

### 5.1 - Classify Drift and Hidden Coupling

- [x] **Files**: `.scipquery.json`; performance ledgers and validation docs reported by `doc-drift` and `co-change`
- **Source**: `scip-query doc-drift --json --full`; `scip-query co-change --json --full`
- **What**: Many reported pairs are benchmark ledgers or historical validation notes that intentionally co-change with optimization work.
- **Change**: Add a declared coupling for the June 28 optimization evidence ledger so the health model treats those benchmark, validation, and implementation files as one intentional maintenance unit.
- **Why**: Updating benchmark ledgers just to quiet history signals can erase useful optimization evidence.

## Stress-Test Findings

- The first phase is reversible: restore the removed function if a hidden consumer appears.
- The first phase changes no public CLI contract and no cache read/write path that affects runtime behavior.
- The file is high-importance overall, but the removed symbol has zero external consumers and no affected symbols. Source: `scip-query change-surface src/storage/evidence-cache.ts --json --full`; `scip-query affected semanticCalleeRowCount --json`.
- Later phases require separate plans because the cycle and wrapper candidates intersect multi-language source facts and optimized similarity/call-graph logic.

## Execution Order

1. Apply phase 1.1 and verify.
2. Recompute health.
3. Apply phase 2.1 and verify.
4. If health improves and checks pass, inspect the dependency cycle next.
5. Only after cycle confirmation, evaluate wrappers and stale abstractions with performance-sensitive tests.
6. Classify docs/co-change signals after code health items, because many are historical optimization ledgers.

## Ship Order

Phases 1 and 2 are independently shippable. Later phases should ship separately, one confirmed score category at a time.

## Summary

Applied batches: delete one dead helper from `src/storage/evidence-cache.ts`, then move the profiling helper from `src/runtime/profile.ts` to `src/instrumentation/profile.ts`.
