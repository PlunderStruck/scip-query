# System Compression Refactors

This plan records the best refactors found by running the `scip-system-compression` workflow after the CLI descriptor conversion.

The purpose is not to make files shorter by slicing them into themed modules. The purpose is to remove repeated responsibilities by finding the smaller mechanisms that make the repeated behavior natural.

## Current Evidence

Commands run:

```bash
node dist/cli.js status
node dist/cli.js stats
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js similar --min-similarity 0.5 --limit 30
node dist/cli.js similar-files --min-similarity 0.65 --limit 20
node dist/cli.js stale-abstractions --min-loc 3 --limit 20
node dist/cli.js extract-candidates --min-loc 20 --min-callees 6 --limit 10
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js passthrough-candidates
node dist/cli.js system src/runtime
node dist/cli.js system src/language-parsers
node dist/cli.js system src/symbols
node dist/cli.js system src/queries
```

Current health snapshot:

```text
Score: 87
Dead symbols: 0
Isolated symbols: 0
Cycles: 0
Drift: 0
Similar pairs: 50
Extraction candidates: 1
Wrapper candidates: 12
Passthrough candidates: 2
Stale abstractions: 3
Complexity hotspots: 0
```

The score likely dropped from the earlier `95` because the CLI descriptor conversion removed the old registrar files but introduced a new large command-handler center and descriptor table. The health model now sees more similar handler lifecycles, one extraction candidate in `command-handlers.ts`, wrappers/passthroughs from the new adapter layer, and three single-consumer types. Verify this during implementation instead of assuming it.

## Refactor 1: CLI Execution Algebra

A CLI execution algebra is the runtime mechanism behind command handlers such as `handleRefs`, `handleSimilar`, and `handleWrapperCandidates`; it is a command-running structure whose essential job is to encode repeated lifecycles such as "decode options, open DB, choose semantic budget, run query, render result."

### Evidence

- `src/runtime/command-handlers.ts` is 1172 lines.
- `similar-signatures --min-loc 5` found 30 handlers with shape `(unknown) => void` and 19 handlers with shape `(unknown, unknown) => void`.
- `similar --min-similarity 0.5 --limit 30` found many 87-100% handler pairs sharing `options()`, `withDb()`, `commandAnalysisBudget()`, `booleanOption()`, `definedNumber()`, `stringOption()`, `renderHeuristicNotice()`, and render helpers.
- `extract-candidates` flags `handleDead()`, `handleSimilar()`, `handleTrace()`, `handleSimilarFiles()`, `handleExtractCandidates()`, and `handleStaleAbstractions()` primarily around the same option/budget/setup cluster.

### Proposed Shape

Extend descriptors from metadata into typed execution shapes:

- Pure DB query command: decode args/options, open DB, run query, render.
- Semantic DB query command: same, with `commandAnalysisBudget`.
- Heuristic candidate command: semantic DB query plus required heuristic notice and candidate-scan budget.
- Optional-target ranking command: one command supports either a specific target or a top-N listing.
- Project readiness command: inspect project config, index status, dependencies, and semantic provider readiness.
- Lifecycle side-effect command: reindex, watch, init, install, augment.
- Hidden worker command: internal command used for isolated health/diff-impact phases.

Descriptors should choose a shape whenever possible. Bespoke handlers should remain only for commands whose lifecycle order or output is materially different.

### What Should Disappear

- Most tiny handlers that only decode options, call one query, and render rows.
- Repeated ad hoc option extraction in handlers.
- Repeated heuristic notice and budget wiring.
- The current pressure for one thousand-line `command-handlers.ts`.

### Migration Checks

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
npm test
node dist/cli.js --help
node dist/cli.js refs ProjectIndex
node dist/cli.js similar --min-similarity 0.5 --limit 3
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
```

### Progress

First slice completed after checkpoint commit `ee99e05`:

- Added `src/runtime/command-execution.ts`, a small executor for DB-backed command shapes.
- Converted these commands from bespoke handlers to descriptor-local execution specs: `stats`, `files`, `symbols`, `methods`, `deps`, `rdeps`, `system`, `surface`, `hotspots`, `imported-by`, `outline`, `members`, `by-kind`, `kind-counts`, and `hierarchy`.
- Removed the matching exported handlers from `src/runtime/command-handlers.ts`.
- `src/runtime/command-handlers.ts` dropped from 1172 lines to 1032 lines.
- Fresh `similar-signatures --min-loc 5` changed command handler groups from 30 `(unknown) => void` and 19 `(unknown, unknown) => void` handlers to 17 `(unknown) => void` and 18 `(unknown, unknown) => void` handlers.

Verified:

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js stats
node dist/cli.js files runtime/command
node dist/cli.js symbols src/runtime/command-descriptors.ts
node dist/cli.js methods ProjectIndex
node dist/cli.js deps src/runtime/command-descriptors.ts
node dist/cli.js rdeps src/runtime/command-execution.ts
node dist/cli.js system src/runtime
node dist/cli.js surface src/runtime
node dist/cli.js hotspots -n 3
node dist/cli.js by-kind class -n 3
node dist/cli.js kind-counts
node dist/cli.js imported-by ProjectIndex
node dist/cli.js outline src/core/project-index.ts
node dist/cli.js members ProjectIndex
node dist/cli.js hierarchy ProjectIndex
```

Second slice completed after checkpoint commit `4123540`:

- Extended `src/runtime/command-execution.ts` with budgeted DB/list/table/grouped-by-file command shapes.
- Converted these additional commands from bespoke handlers to descriptor-local execution specs: `imports`, `unused-imports`, `bottlenecks`, `isolated`, `call-graph`, `extract-candidates`, `change-surface`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions`, and `complexity-hotspots`.
- Removed the matching exported handlers from `src/runtime/command-handlers.ts`.
- `src/runtime/command-handlers.ts` dropped from 1032 lines to 828 lines.

Verified:

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
npm run build
node dist/cli.js imports src/runtime/cli.ts
node dist/cli.js unused-imports src/runtime/cli.ts
node dist/cli.js bottlenecks -n 3
node dist/cli.js isolated --min-loc 5
node dist/cli.js call-graph ProjectIndex
node dist/cli.js extract-candidates -n 2
node dist/cli.js change-surface src/runtime/command-descriptors.ts
node dist/cli.js wrapper-candidates --max-loc 20 -n 3
node dist/cli.js passthrough-candidates -n 3
node dist/cli.js stale-abstractions -n 3
node dist/cli.js complexity-hotspots -n 3
```

Third slice completed after checkpoint commit `02c0e8d`:

- Converted `refs`, `fan-in`, `fan-out`, `coupling`, `affected`, `code`, `complexity`, `dataflow`, `slice`, `redundant-reexports`, and `similar-signatures` to shared DB/budgeted/grouped/list execution shapes.
- Split query-shaped handlers out of `src/runtime/command-descriptors.ts` into `src/runtime/query-command-handlers.ts` so descriptors remain CLI metadata instead of becoming the new long command center.
- Current line counts: `command-descriptors.ts` 685 lines, `query-command-handlers.ts` 449 lines, `command-handlers.ts` 635 lines.
- Remaining handlers in `command-handlers.ts` are either side-effect lifecycles (`reindex`, `watch`, `status`, `check-deps`, augmentation), isolated worker lifecycles (`health`, `diff-impact`), or intentionally custom high-structure reports (`trace`, `dead`, `similar`, `similar-files`, `similar-chains`, `drift`, `convergence`, `cycles`, `deep-chains`).

Verified:

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
npm run build
node dist/cli.js --help
node dist/cli.js stats
node dist/cli.js refs ProjectIndex
node dist/cli.js fan-in -n 3
node dist/cli.js wrapper-candidates --max-loc 20 -n 2
node dist/cli.js similar-signatures --min-loc 5 -n 2
```

## Refactor 2: Source Reference Evidence Pipeline

A source-reference evidence pipeline is the reference-detection path made from source scanning, identifier attribution, import resolution, framework dispatch names, Rust attribute references, and occurrence counting. Its essential job is to decide which source-level mentions count as real symbol references.

### Evidence

- `src/symbols/source-reference-scan.ts` already exposes `scanSourceReferences()`.
- `src/queries/dead.ts` still has a custom `supplementDeadCodeOnlySourceReferences()` loop that repeats source-file scanning, AST-language checks, ignored-file checks, identifier-line scans, cross-language dispatch handling, Rust attribute handling, and occurrence counting.
- `similar src:queries:dead:supplementDeadCodeOnlySourceReferences --min-similarity 0.3` found overlap with `scanSourceReferences()` through `detectAstLanguage()`, `isVueSfcPath()`, `getIdentifierLineMap()`, `getCrossLanguageDispatchNames()`, and `getRustAttrReferencedNames()`.
- `dead.ts` has only 3 direct external consumers of `dead()`, and most reference-supplement helpers are private, so the blast radius is controlled if output stays identical.

### Proposed Shape

Deepen `scanSourceReferences()` so callers can plug in target-resolution and occurrence policy:

- Source traversal remains in `source-reference-scan`.
- Dead-code-specific target choice remains dead-code policy, but is supplied as a resolver hook.
- Occurrence policy, unused-import-only filtering, inactive barrel skipping, and cache cleanup become explicit hooks/options.
- `dead.ts` stops owning a second source traversal lifecycle.

### What Should Disappear

- The hand-rolled source scan loop in `supplementDeadCodeOnlySourceReferences()`.
- Repeated AST/Vue/ignored-file/source-file traversal logic.
- Duplicated framework dispatch and Rust attribute scanning branches.

### Migration Checks

```bash
npm run typecheck
npm test -- tests/command-accuracy.test.ts tests/debloat-health.test.ts tests/source-backed-accuracy.test.ts tests/stale-abstractions-accuracy.test.ts
npm test
node dist/cli.js dead --min-loc 10
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
```

### Progress

Completed after checkpoint commit `532e678`:

- Deepened `src/symbols/source-reference-scan.ts` with a target-resolution hook and per-path cleanup hook.
- Replaced `src/queries/dead.ts`'s dead-code-only hand-rolled source traversal with `ProjectIndex.scanSourceReferences()`.
- Kept dead-code-specific target policy in `dead.ts`: same-file preference, import-path disambiguation, permissive fallback for identifier/Rust attribute references, and strict handling for cross-language dispatch names.
- Removed direct dead-query ownership of framework dispatch scanning, Rust attribute scanning, AST language gating, Vue SFC gating, identifier-line map traversal, and per-file traversal cleanup.
- Health score improved from the plan baseline `87` to `92` after this plus the CLI execution split.

Verified:

```bash
npm run typecheck
npm test -- tests/command-accuracy.test.ts tests/debloat-health.test.ts tests/source-backed-accuracy.test.ts tests/stale-abstractions-accuracy.test.ts
npm run build
node dist/cli.js dead --min-loc 10
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
```

## Refactor 3: Reference Graph Role Split

The reference graph module is the compiler/source evidence module whose essential job is to provide graph-shaped facts about files, callers, callees, and reference sites. It currently contains several roles in one high-fan-in file.

### Evidence

- `src/symbols/reference-graph.ts` is 695 lines.
- `change-surface src/symbols/reference-graph.ts` reports 21 consumers of the module and 47 external consumer references.
- It owns file dependency graph construction, callee maps, caller rows, reference-site fallback, AST/chunk merging, global leaf indexing, and compatibility re-exports.
- `affected buildFileDepGraph --max-depth 2` reaches file classifier, cycles, deep chains, fan-out, similar chains, similar files, drift, health, and wrapper candidates.

### Proposed Shape

Split by stable role, not by arbitrary helper clusters:

- `file-dep-graph`: file-to-file dependency graph from SCIP edges plus source-import fallback.
- `call-graph-evidence`: callee and caller row maps.
- `reference-evidence`: resolved reference sites and source fallback policy.
- `leaf-symbol-index`: global leaf lookup for AST/chunk candidate resolution.
- Keep `reference-graph.ts` as a compatibility facade only if needed, and make it thin.

### What Should Disappear

- One module owning unrelated graph responsibilities.
- The need for callers to import a broad reference graph module when they need only file deps or call evidence.

### Migration Checks

```bash
npm run typecheck
npm test -- tests/queries.test.ts tests/queries-advanced.test.ts tests/command-accuracy.test.ts tests/diff-impact-accuracy.test.ts tests/file-wide-caller-fallback.test.ts
npm test
node dist/cli.js affected buildFileDepGraph --max-depth 2
node dist/cli.js call-graph ProjectIndex
node dist/cli.js refs ProjectIndex
node dist/cli.js drift --min-deviation 3
```

### Progress

Completed after checkpoint commit `835a52d`:

- Split `src/symbols/reference-graph.ts` into role-focused modules:
  - `src/symbols/file-dep-graph.ts`: SCIP/file-import dependency edges and file-dependency cache.
  - `src/symbols/call-graph-evidence.ts`: caller/callee rows, caller maps, AST/chunk/semantic callee merge policy.
  - `src/symbols/leaf-symbol-index.ts`: global leaf-name index and AST call candidate selection.
  - `src/symbols/reference-graph.ts`: 43-line compatibility facade and cache-clear orchestration.
- Kept root exports stable for existing callers and tests.
- Current line counts: `reference-graph.ts` 43, `file-dep-graph.ts` 100, `call-graph-evidence.ts` 470, `leaf-symbol-index.ts` 104.

Verified:

```bash
npm run typecheck
npm test -- tests/queries.test.ts tests/queries-advanced.test.ts tests/command-accuracy.test.ts tests/diff-impact-accuracy.test.ts tests/file-wide-caller-fallback.test.ts
npm run build
node dist/cli.js affected buildFileDepGraph --max-depth 2
node dist/cli.js call-graph ProjectIndex
node dist/cli.js refs ProjectIndex
node dist/cli.js drift --min-deviation 3
```

## Refactor 4: Language Parser Lifecycle Helper

The language parser subsystem already has a registry. The remaining opportunity is to standardize the per-language lifecycle for "load source, parse AST when available, fall back to source patterns, resolve import paths, return normalized imports."

### Evidence

- `similar-files --min-similarity 0.65 --limit 20` found 100% dependency-profile similarity among `python.ts`, `ruby.ts`, and `c-like.ts`, and 67% similarity with `javascript.ts`.
- The parser registry already centralizes extension dispatch in `src/language-parsers/registry.ts`.
- `src/language-parsers/index.ts` is the public cache/dispatch entry point with 6 consumers of `getSourceImports()`.

### Proposed Shape

Add a parser lifecycle helper only where it removes repeated mechanics:

- Common AST parse wrapper.
- Common regex fallback runner.
- Common import-path resolver adapter.
- Common source-stripper use.

Do not abstract language syntax. Each language parser should still own its grammar-specific extraction.

### What Should Disappear

- Repeated source/AST/fallback scaffolding across simple parsers.
- Any duplicate path-resolution glue that can be expressed as a common helper.

### Migration Checks

```bash
npm run typecheck
npm test -- tests/import-fallbacks.test.ts tests/redundant-reexports-fallback.test.ts tests/python-accuracy.test.ts tests/command-accuracy.test.ts
npm test
node dist/cli.js imports src/runtime/cli.ts
node dist/cli.js unused-imports src/runtime/cli.ts
node dist/cli.js redundant-reexports
node dist/cli.js drift --min-deviation 3
```

### Progress

Completed after checkpoint commit `c09c4dd`:

- Added `parseWithAstFallback()` to `src/language-parsers/utils.ts` as the common lifecycle for "try tree-sitter AST, otherwise use source fallback."
- Applied it to the parser families that shared the exact repeated mechanics: JavaScript imports, Python, Ruby, and C/C++.
- Kept language grammar local to each parser: AST node walkers, regex statement parsing, alias rules, namespace/member tracking, and import-path resolution still live in the language-specific files.
- Left JVM, .NET, Rust, and PHP on local dispatch because each parser has multi-language or export-specific branching where forcing the helper would hide the grammar boundary more than it would simplify the lifecycle.

Verified:

```bash
npm run typecheck
npm test -- tests/import-fallbacks.test.ts tests/redundant-reexports-fallback.test.ts tests/python-accuracy.test.ts tests/command-accuracy.test.ts
npm run build
node dist/cli.js imports src/runtime/cli.ts
node dist/cli.js unused-imports src/runtime/cli.ts
node dist/cli.js redundant-reexports
node dist/cli.js drift --min-deviation 3
```

## Refactor 5: Low-Risk Cleanup

These are smaller cleanup items surfaced by health signals. Do them after the structural refactors unless they block type cleanup.

### Stale Single-Consumer Types

- `src/reindex/indexer-runner.ts: PreparedIndexerRun`
- `src/reindex/indexer-runner.ts: IndexerRunResult`
- `src/semantic/typescript/workspace-packages.ts: WorkspacePackage`

Inline them or keep them only if their names carry durable domain meaning.

### Passthroughs

- `src/source/ast.ts: clearAstCacheForFile()`
- `src/symbols/definition-catalog.ts: clearDefinitionCacheForFile()`

Inline only if doing so does not leak cache implementation details across module boundaries.

### Wrappers

Review wrapper candidates, but do not blindly inline wrappers that intentionally preserve a facade boundary. Existing `scip-query: ignore-wrapper` comments should be treated as evidence, not noise.

### Progress

Completed after checkpoint commit `625589d`:

- Preserved `PreparedIndexerRun` and `IndexerRunResult` because they name the handoff record between reindex planning and indexer execution. Added `scip-query: ignore-stale` comments to make that boundary explicit.
- Preserved `WorkspacePackage` because it names a TypeScript semantic-provider concept: a package root plus source root inside a workspace. Added `scip-query: ignore-stale`.
- Preserved `clearAstCacheForFile()` and `clearDefinitionCacheForFile()` because they are cache lifecycle facades; inlining would expose cache storage details to query code.
- Reviewed wrapper candidates. The remaining candidates are facade/public primitive boundaries or internal helpers with existing `ignore-wrapper`/`ignore-extract` evidence; no safe deletion was identified without weakening module boundaries.

Verified:

```bash
npm run typecheck
npm test -- tests/command-accuracy.test.ts tests/debloat-health.test.ts
```

## Completion Evidence

Before declaring this plan complete:

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stats
node dist/cli.js refs ProjectIndex
node dist/cli.js trace ProjectIndex
node dist/cli.js call-graph ProjectIndex
node dist/cli.js system src/runtime
node dist/cli.js system src/symbols
node dist/cli.js dead --min-loc 10
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js similar --min-similarity 0.5 --limit 10
```

Expected final state:

- Runtime command behavior is preserved.
- The CLI command surface no longer depends primarily on one bespoke handler per command.
- Dead-code source reference supplementation uses the shared source-reference scan lifecycle.
- Reference graph responsibilities are separated by role or intentionally documented if kept together.
- Parser lifecycle repetition is reduced without hiding language-specific grammar.
- Health score drop from 95 to 87 is explained by current findings, improved where behavior-preserving, or documented if the score is lower because the health model now sees legitimate intentional boundaries.
- `drift` reports no layer violations.
