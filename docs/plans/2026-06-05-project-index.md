# ProjectIndex Architecture Slice

## Standards Loaded

No `agent-os/standards/index.yml` exists in this repository. Discovery and implementation are based on `scip-query` evidence.

## Gate A: Goal

The user wants the flat query architecture to become easier to maintain without sacrificing indexing accuracy or speed. Done means the query layer stops recomposing the same low-level code-intelligence facts directly and instead uses one deeper module for definitions, callees, source-reference scanning, file classification, and suppression filtering.

## Gate B: Current Flow

- `src/queries/extract-candidates.ts:23-148` selects scoped definitions, filters ignored/test/suppressed/type files, builds a callee map, then looks for disconnected callee clusters. Source: `node dist/cli.js code extractCandidates -C 8`.
- `src/queries/similar.ts:217-249` independently selects scoped production function definitions, filters ignored/test/suppressed symbols, builds a callee map, then maps each definition into a callee fingerprint. Source: `node dist/cli.js code getAllCalleeFingerprints -C 8`.
- `src/symbols/definition-catalog.ts:123-139` owns the database-backed scoped-definition read. Source: `node dist/cli.js code getScopedDefinitions -C 5`.
- `src/symbols/reference-graph.ts:338-377` owns callee-map construction and chooses AST or chunk fallback per definition. Source: `node dist/cli.js code buildCalleeMap -C 5`.
- `src/symbols/source-reference-scan.ts:27-83` owns AST-backed source-reference scanning for `dead` and `drift`. Source: `node dist/cli.js code scanSourceReferences -C 5`.
- `src/queries/dead.ts:176-218` and `src/queries/drift.ts:162-219` already share `scanSourceReferences`, but each still owns the query-specific result shape. Source: `node dist/cli.js convergence supplementReferencesFromAst buildSymbolRefGraph`.

## Gate C: Reuse Audit

- Reuse `getScopedDefinitions`, not a new SQL query, for scoped definitions. Source: `node dist/cli.js code getScopedDefinitions -C 5`.
- Reuse `buildCalleeMap`, not a new call-graph implementation, for callee maps. Source: `node dist/cli.js code buildCalleeMap -C 5`.
- Reuse `scanSourceReferences`, not another identifier scan, for source-reference augmentation. Source: `node dist/cli.js code scanSourceReferences -C 5`.
- Reuse existing filtering helpers: `classifyFile`, `isInRustTestModule`, `hasSuppressionComment`. Source: `node dist/cli.js convergence extractCandidates getAllCalleeFingerprints`.

## Implementation Checklist

- [x] Add `src/core/project-index.ts`.
  - Current behavior: query files import `getScopedDefinitions`, `buildCalleeMap`, `classifyFile`, `isInRustTestModule`, and `hasSuppressionComment` directly. Source: `node dist/cli.js convergence extractCandidates getAllCalleeFingerprints`.
  - Target behavior: `ProjectIndex` exposes `productionCallableDefinitions`, `calleeMap`, `fileDependencyGraph`, `sourceFiles`, and `scanSourceReferences`, while delegating to the existing canonical implementations.
  - Reversibility: internal-only module; callers can be moved back to direct imports if needed.

- [x] Migrate `src/queries/extract-candidates.ts:23-148`.
  - Current behavior: `extractCandidates()` manually selects and filters production function definitions, then calls `buildCalleeMap`. Source: `node dist/cli.js code extractCandidates -C 8`.
  - Target behavior: construct `new ProjectIndex(db)`, call `productionCallableDefinitions({ scope, minLoc, excludeTypesFiles: true, requireFunctionLikeSymbol: true, sortByLocDesc: true })`, then call `index.calleeMap(symbols)`.
  - Verification: `node dist/cli.js extract-candidates --min-loc 15 --min-callees 5` still returns the same empty result on this repo.

- [x] Migrate `src/queries/similar.ts:217-249`.
  - Current behavior: `getAllCalleeFingerprints()` repeats most of `extractCandidates()`'s production callable filtering and callee-map construction. Source: `node dist/cli.js code getAllCalleeFingerprints -C 8`.
  - Target behavior: construct `new ProjectIndex(db)`, call `productionCallableDefinitions({ scope, minLoc: 5, excludeSymbol })`, then `index.calleeMap(candidates)`.
  - Verification: `node dist/cli.js similar --min-similarity 0.5 --min-callees 3` still reports actionable pairs and no new false-positive explosion.

- [x] Migrate `src/queries/dead.ts:176-218` and `src/queries/drift.ts:162-219` only far enough to use `ProjectIndex.scanSourceReferences`.
  - Current behavior: both call `scanSourceReferences` directly after query-specific setup. Source: `node dist/cli.js convergence supplementReferencesFromAst buildSymbolRefGraph`.
  - Target behavior: both call through `ProjectIndex`, keeping their result-shaping code local.
  - Verification: `node dist/cli.js dead --min-loc 5 --skip-barrels` and `node dist/cli.js drift` remain stable.

- [x] Export `ProjectIndex` from `src/index.ts`.
  - Current behavior: package root exports storage, source filtering, symbols, reindex, runtime config, watcher, setup, SCIP CLI helpers, queries, and domain types. Source: `node dist/cli.js code src/index.ts:1-12`.
  - Target behavior: root export includes `ProjectIndex` so API consumers can use the same code-intelligence facade as built-in queries.
  - Reversibility: additive public export.

- [x] Continue the migration through the shared health/debloat query path.
  - Current behavior: `complexity-hotspots`, `passthrough-candidates`, `wrapper-candidates`, `isolated`, `stale-abstractions`, `affected`, `complexity`, `surface`, `members`, `methods`, `change-surface`, `slice`, and `redundant-reexports` still composed scoped definitions, definitions-for-file reads, caller maps, callee maps, fallback caller attribution, suppression checks, and file classification directly. Source: `node dist/cli.js refs getScopedDefinitions`, `node dist/cli.js refs getDefinitionsForFile`, `node dist/cli.js refs buildCrossFileCallerMap`, `node dist/cli.js refs buildCalleeMap`.
  - Target behavior: those queries construct `ProjectIndex` and ask it for the shared code-intelligence facts, while query-specific ranking and result shaping stays local.
  - Verification: health now reports no stale abstractions, no wrapper candidates, and no passthrough candidates on the freshly rebuilt self-index.

## Stress Test

- Understand before touch: this slice keeps existing implementations as adapters behind the new module rather than replacing them.
- Blast radius: `getScopedDefinitions` has 39 affected symbols across 21 files; `buildCalleeMap` has 126 affected symbols across 54 files; the plan changes only selected query callers, not those canonical functions. Source: `node dist/cli.js affected getScopedDefinitions && node dist/cli.js affected buildCalleeMap`.
- Valid intermediate state: each migration is call-site local and can build after each file.
- Failure and concurrency: no new async path, no new writes, no shared mutable process state.
- Boundaries and data integrity: no CLI argument, DB schema, or index artifact behavior changes.
- Observability: no new error path; existing query errors still surface through the CLI.
- Reuse: every new `ProjectIndex` method delegates to an existing canonical implementation.

## Verification Commands

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed: 29 files, 145 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --indexer-concurrency 1` passed in 1.7s.
- `node dist/cli.js health` passed with score 95/100; findings are now limited to pattern drift and complexity hotspots.
- `node dist/cli.js similar --min-similarity 0.5 --min-callees 3` still reports facade-shaped similarities, but health no longer counts similarity as a prioritized action.
- `node dist/cli.js extract-candidates --min-loc 15 --min-callees 5` reports no extraction candidates.

## Layer Drift Follow-up

- [x] Make `drift` layer-policy aware instead of purely statistical.
  - Current behavior: rare but intentional layer edges, including `core -> storage` and parser `language-parsers -> resolution` imports, were reported beside actual cross-layer mistakes. Source: `node dist/cli.js drift`.
  - Target behavior: known `src/*` layers and common application layers use explicit edge policy first, with the old frequency fallback preserved for unknown project shapes.
  - Verification: self-scan now reports `0 unused import(s), 0 layer violation(s), 10 pattern deviation(s)`.

- [x] Keep informational unique-dep findings out of health actions.
  - Current behavior: `health` could show `100/100` and still list unique deps as a prioritized action.
  - Target behavior: `health` only creates a Structural drift action for unused imports or layer violations; `drift` remains the detailed command for unique dependency inspection.
  - Verification: `node dist/cli.js health` now reports `100/100` with no prioritized actions.

## Follow-up Cleanup Increment

- [x] Reduce the largest complexity hotspots without changing query semantics.
  - Current behavior: `reindex()`, `health()`, `findFirstSymbolMatch()`, and `shortenSymbol()` were among the highest complexity hotspots.
  - Target behavior: `reindex()` delegates indexer preparation, outcome validation, SCIP materialization, and conversion to private helpers; `health()` delegates analysis execution, signal filtering, action creation, and scoring; symbol lookup/parsing helpers own their narrower substeps.
  - Verification: the old top four hotspots dropped out of the top of `node dist/cli.js complexity-hotspots --limit 10`.

- [x] Resolve informational unique-dep drift for known project layers.
  - Current behavior: `drift` still reported unique dependency deviations for allowed `src/*` layer edges.
  - Target behavior: `src/queries/drift-policy.ts` owns explicit layer policy; `drift` does not report unique deps when the project layer policy already says the dependency is normal.
  - Verification: `node dist/cli.js drift` reports `No drift detected.`

- [x] Wire and document `drift --min-deviation`.
  - Current behavior: `drift()` accepted `minDeviation`, but the option did not affect behavior and the CLI did not expose it.
  - Target behavior: `minDeviation` controls the sibling threshold for unique dependency deviations; CLI exposes `--min-deviation <n>`.
  - Verification: `tests/queries-advanced.test.ts` covers the threshold.

- [x] Deepen reindex reliability tests.
  - Current behavior: tests covered fail-closed partial indexing and conversion failure preservation.
  - Target behavior: tests also cover explicit `allowPartial` metadata and serial retry after parallel indexer failure.
  - Verification: `tests/reindex-reliability.test.ts` now has four reliability cases.

- [x] Refresh public README examples after the folder restructure.
  - Current behavior: README examples still referenced flat paths like `src/cli.ts`, `src/db.ts`, and `src/symbol-parser.ts`.
  - Target behavior: public examples reference layered paths like `src/runtime/cli.ts`, `src/storage/db.ts`, and `src/symbols/symbol-parser.ts`, and document `drift --min-deviation`.
  - Verification: README scan found no stale flat-path examples.
