# Next System Compression Refactors

This plan starts from the fresh post-refactor evidence after the first system-compression pass.

Current health snapshot:

```text
Score: 90
Dead symbols: 0
Isolated symbols: 0
Cycles: 0
Stale types: 0
Drifted files: 0
Similar pairs: 28
Extraction candidates: 1
Wrapper candidates: 16
Passthrough candidates: 5
```

The next work is not more arbitrary splitting. The next work is to remove the remaining repeated report-command and subsystem lifecycles.

## Refactor 1: Report-Command Algebra

A report command is a DB-backed CLI command that assembles a user-facing analysis report from query facts. Unlike a list or table command, it has conditional sections, summaries, grouping, explanatory text, heuristic notices, or multi-part output.

### Evidence

- `similar --min-similarity 0.5 --limit 20` still clusters `handleCycles`, `handleDeepChains`, `handleSimilar`, `handleSimilarFiles`, `handleSimilarChains`, `handleDrift`, and `handleConvergence`.
- These handlers repeat the same lifecycle: decode options, open the DB, optionally compute a command budget, run one query, render a structured report, print a final count or summary.
- The earlier command-shape refactor moved simple list/table/grouped commands out of bespoke handlers, but left report-shaped commands behind.

### Proposed Shape

Add report-oriented execution helpers for:

- Optional target report: one command supports a target mode and an all/top mode.
- Budgeted heuristic report: compute `commandAnalysisBudget`, print a heuristic notice, render a candidate report.
- Sectioned iterative report: query returns ordered groups, each group renders with a heading and rows.
- Summary report: render rows and a final aggregate line.

Move command behavior only when the new shape explains the command. Keep bespoke handlers for side-effect lifecycles such as `reindex`, `watch`, augmentation, health workers, and other process-isolation paths.

### Candidate Commands

- `cycles`
- `deep-chains`
- `similar`
- `similar-files`
- `similar-chains`
- `drift`
- `convergence`

### Checks

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts tests/queries-advanced.test.ts tests/drift-accuracy.test.ts tests/similarity.test.ts
npm test
npm run build
node dist/cli.js cycles
node dist/cli.js deep-chains -n 3
node dist/cli.js similar --min-similarity 0.5 --limit 10
node dist/cli.js similar-files --min-similarity 0.65 --limit 5
node dist/cli.js similar-chains --limit 5
node dist/cli.js drift --min-deviation 3
node dist/cli.js convergence ProjectIndex ScipDatabase
```

## Refactor 2: Command Execution Renderer Unification

A command execution renderer is the shared runtime path that turns query rows into CLI output. Its wider class is a rendering helper; what makes it distinct is that it owns the repeated command mechanics around empty states, heuristic notices, row formatting, and post-render summaries.

### Evidence

- `similar` now reports overlap among `listCommand`, `tableCommand`, `groupedByFileCommand`, and `renderRows` in `src/runtime/command-execution.ts`.
- The first command algebra worked, but it left an internal duplication layer among the row renderers.

### Proposed Shape

Replace the separate list/table/grouped implementations with one internal row-rendering primitive and small public shape adapters.

Preserve public command behavior exactly. This should reduce implementation duplication without making command descriptor specs harder to read.

### Checks

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
npm run build
node dist/cli.js stats
node dist/cli.js by-kind class -n 3
node dist/cli.js kind-counts
node dist/cli.js wrapper-candidates --max-loc 20 -n 3
```

## Refactor 3: Intentional Facade Suppressions

An intentional facade is a small function that names and protects a module boundary. It may look like a wrapper or passthrough, but its essential role is to hide implementation details or preserve a stable public surface.

### Evidence

Fresh wrapper/passthrough output flags cache-clear helpers created by the reference-graph role split:

- `clearCallGraphEvidenceCaches()`
- `clearFileDepGraphCache()`
- `clearGlobalLeafIndexCache()`

These functions are deliberate module-local cache lifecycle hooks used by `reference-graph.ts`, not accidental indirection.

### Proposed Shape

Add `scip-query: ignore-passthrough` comments to intentional cache facade hooks with one-sentence explanations. Do not inline cache internals into the compatibility facade.

### Checks

```bash
npm run typecheck
node dist/cli.js passthrough-candidates -n 20
node dist/cli.js health --json
```

## Refactor 4: Vue Augmentation Pipeline Review

The Vue augmentation pipeline is the Volar-backed path that finds Vue SFC references and writes resolved SCIP mentions. It is a reindex augmentation subsystem whose essential job is to translate Vue language-service evidence into database facts.

### Evidence

`wrapper-candidates --max-loc 20 -n 30` now highlights a cluster in `src/reindex/augment-vue-runtime.ts`:

- `createSourceTextCache()`
- `offsetToLineChar()`
- `replaceVueDocumentChunks()`
- `firstSourceOffset()`
- `dedupeOccurrences()`
- `listVueDocumentFiles()`
- `firstGeneratedOffset()`
- `isExternalDefinition()`
- `toRelativePath()`

This may indicate a hidden Vue document/offset/occurrence pipeline.

### Proposed Shape

Investigate before editing:

- If these helpers are local mechanics of one cohesive augmentation transaction, document or suppress them as intentional.
- If they reveal repeated offset/source/occurrence responsibilities, introduce a smaller Vue augmentation pipeline abstraction.
- Do not split merely because helpers are single-consumer.

### Checks

```bash
npm run typecheck
npm test -- tests/augment-sources.test.ts tests/command-accuracy.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
```

## Completion Criteria

- Remaining runtime command-handler similarity is either reduced or documented as intentional report-specific behavior.
- `command-execution.ts` no longer has avoidable row-renderer duplication.
- Intentional facade wrappers/passthroughs have explicit suppression comments.
- Vue augmentation candidates are implemented or documented with concrete evidence.
- Fresh index and health are captured.
- `drift --min-deviation 3` still reports no drift.
- Full test and build pass.

## Implementation Log

### Refactor 1: Report-Command Algebra

Implemented in `src/runtime/command-execution.ts` and `src/runtime/query-command-handlers.ts`.

- Added `reportCommand()` and `budgetedReportCommand()` for DB-backed commands whose output is a structured report rather than plain rows.
- Moved `cycles`, `deep-chains`, `similar`, `similar-files`, `similar-chains`, `drift`, and `convergence` from bespoke process handlers into the query-handler layer.
- Updated `src/runtime/command-descriptors.ts` so these commands route through `queryHandlers`.
- Preserved side-effect and process lifecycles such as `reindex`, augmentation, diff-impact, health workers, setup, watch, and status in `command-handlers.ts`.

### Refactor 2: Command Execution Renderer Unification

Implemented in `src/runtime/command-execution.ts`.

- Replaced separate list/table/grouped lifecycle implementations with one internal `renderRows()` primitive.
- Added one deeper `runCommandOutput()` lifecycle primitive shared by row commands and report commands. This removed the new post-refactor overlap between `renderRows()` and report execution.
- Kept public adapters (`listCommand`, `tableCommand`, `groupedByFileCommand`, and budgeted variants) small and command-descriptor-friendly.
- Preserved empty-state handling, heuristic notices, row formatting, table headers, grouped keys, and post-render summaries.

### Refactor 3: Intentional Facade Suppressions

Implemented in:

- `src/symbols/call-graph-evidence.ts`
- `src/symbols/file-dep-graph.ts`
- `src/symbols/leaf-symbol-index.ts`

Added `scip-query: ignore-passthrough` comments for the cache lifecycle facades used by the reference-graph reset path. These functions preserve module boundaries: callers can clear reference-graph caches without knowing the concrete cache objects owned by each graph module.

### Refactor 4: Vue Augmentation Pipeline Review

Implemented a small pipeline simplification and documented remaining intentional adapters.

- Replaced the loose `createSourceTextCache()` function plus exported `offsetToLineChar()` helper with `createVueSourceReader()`, a source reader that owns both cached file text and source-offset translation.
- Updated direct and worker Vue augmentation paths to pass `sourceReader` through `VueReferenceComputationOptions`.
- Extracted the shared generated Vue default-export symbol lookup used by synthetic-symbol creation and worker-side symbol-ID lookup.
- Added explicit suppression comments for remaining intentional Vue helpers: document discovery, chunk replacement, occurrence dedupe, Volar generated/source offset adapters, external-definition policy, and canonical relative-path normalization.

The Vue augmentation helpers are not all accidental wrappers: they are boundary adapters around Volar generator APIs, SQLite replacement ordering, project-relative path policy, and direct/worker normalization. The only duplicated mini-domain found was source text plus offset conversion, now expressed as one reader.

## Verification Log

Final verification passed on the refactored source and a fresh index.

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts tests/queries-advanced.test.ts tests/drift-accuracy.test.ts tests/similarity.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
```

Targeted tests passed: 53 tests across 5 files. Full tests passed: 177 tests across 36 files. Build passed. Reindex passed for TypeScript in 1.7s.

Final health:

```json
{
  "score": 95,
  "findings": {
    "deadSymbols": 0,
    "isolatedSymbols": 0,
    "cycles": 0,
    "similarPairs": 0,
    "extractionCandidates": 1,
    "wrappers": 5,
    "passthroughs": 2,
    "staleTypes": 0,
    "driftedFiles": 0,
    "complexityHotspotCount": 0
  }
}
```

Representative command checks passed:

```bash
node dist/cli.js cycles
node dist/cli.js deep-chains -n 3
node dist/cli.js similar --min-similarity 0.5 --limit 10
node dist/cli.js similar-files --min-similarity 0.65 --limit 5
node dist/cli.js similar-chains --limit 5
node dist/cli.js convergence ProjectIndex ScipDatabase
node dist/cli.js stats
node dist/cli.js by-kind class -n 3
node dist/cli.js kind-counts
node dist/cli.js wrapper-candidates --max-loc 20 -n 3
node dist/cli.js drift --min-deviation 3
node dist/cli.js passthrough-candidates -n 20
```

Notable final outputs:

- `drift --min-deviation 3`: `No drift detected.`
- `similar --min-similarity 0.5 --limit 10`: `No similar symbol pairs found.`
- `passthrough-candidates -n 20`: 2 remaining older cache hooks outside this plan: `clearAstCacheForFile()` and `clearDefinitionCacheForFile()`.
- `wrapper-candidates --max-loc 20 -n 3`: the top remaining candidates are the `reference-sites.ts` helpers, which are now the next visible cleanup cluster.
