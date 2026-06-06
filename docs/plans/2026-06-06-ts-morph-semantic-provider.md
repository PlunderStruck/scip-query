# TS Morph Semantic Provider Plan

## Standards Loaded

No `agent-os/standards/index.yml` exists in this repository. This plan is grounded in `scip-query` discovery only.

## Gate A — Goal

The goal is to make TypeScript-specific command results more accurate without turning `scip-query` into a TypeScript-only tool. The user wants `dead`, `stale-abstractions`, `drift`, references, affected symbols, and related health signals to stop treating "the SCIP graph did not see it" as equivalent to "the code is unused."

Done means:

- TypeScript candidates are still produced by the existing language-agnostic SCIP graph where that graph is strong.
- Risky TypeScript claims are verified by TypeScript compiler semantics before being reported.
- Health score improves because false positives are suppressed, not because signals are hidden.
- Non-TypeScript languages keep their current behavior.
- `ts-morph` failure is recoverable: if the TypeScript project cannot be built, commands fall back to existing SCIP/tree-sitter/source behavior and surface optional diagnostics only when requested.

## Implementation Result

Implemented end to end on 2026-06-06 around shared primitives rather than command-local `ts-morph` calls.

- Added optional `ts-morph` support behind `src/semantic/`, with a fallback-safe provider interface and a cache keyed by resolved `tsconfig`.
- Added shared primitives for semantic import usage, references, caller maps, callee maps, and function signatures.
- Wired semantic import usage into `unused-imports` and `drift`.
- Wired semantic references/caller evidence through `identifier-attribution`, `reference-graph`, `change-surface`, and `diff-impact`, so `dead`, `stale-abstractions`, impact, refs, and health inherit the stronger evidence through shared infrastructure.
- Wired semantic callee evidence into the shared callee map, using per-file caching so health/dead do not walk a TypeScript source file once per definition.
- Wired semantic signatures into `similar-signatures`.
- Added `status` and `check-deps` visibility for TypeScript semantic-provider readiness.
- Added regression coverage for default imports, namespace imports, named imports, aliases, mixed `type` specifiers, full `import type`, semantic caller evidence, semantic signatures, dead-code suppression, and stale-abstraction suppression.

Verification on `scip-query`:

- `npm run typecheck`
- `npm test -- tests/typescript-semantic-provider.test.ts`
- `npm test`
- `npm run build`
- `node dist/cli.js reindex --force --language typescript --indexer-concurrency 1`
- `node dist/cli.js status`
- `node dist/cli.js check-deps`
- `node dist/cli.js unused-imports src/queries/imports.ts`
- `node dist/cli.js similar-signatures -n 5`
- `node dist/cli.js health` in 4.50s on the fresh index
- `node dist/cli.js dead --min-loc 5 --skip-barrels` in 2.21s on the fresh index, with 0 dead-code findings

## Gate B — Current Flow

### Command And Health Entry Points

- `src/queries/health.ts:51-86` builds the final health report by calling `runHealthAnalyses`, filtering signals, building actions, and computing the score.
  - Source: `node dist/cli.js code health -C 4`
- `src/queries/health.ts:89-102` runs the high-impact candidate queries: `dead`, `isolated`, `cycles`, `similarAll`, `extractCandidates`, `wrapperCandidates`, `passthroughCandidates`, `staleAbstractions`, `drift`, and `complexityHotspots`.
  - Source: `node dist/cli.js code runHealthAnalyses -C 4`
- `src/runtime/cli.ts:1-1338` contains the CLI command registration surface, while `src/queries/index.ts` exports query functions consumed by runtime and public API callers.
  - Source: `node dist/cli.js system src/runtime`
  - Source: `node dist/cli.js system src/queries`

### Current TypeScript Source Parsing

- `src/language-parsers/index.ts:39-51` exposes `getSourceImports`, normalizes the path, caches per DB/path, reads the source file, and delegates to the registered language parser.
  - Source: `node dist/cli.js code getSourceImports -C 4`
- `src/language-parsers/javascript.ts:22-42` parses JS/TS/Vue imports through tree-sitter when `getAst` succeeds and falls back to regex statement parsing when it does not.
  - Source: `node dist/cli.js code parseJavaScriptImports -C 4`
- `src/source/ast.ts:189-207` parses AST-supported files with tree-sitter and special-cases `.vue` by extracting the script block before parsing.
  - Source: `node dist/cli.js code getAst -C 4`

### Current Shared Graph Layer

- `src/core/project-index.ts:27-115` is the shared facade used by query modules. It exposes scoped definitions, callable definitions, callee maps, cross-file caller maps, source fallback caller files, file dependency graphs, source files, source-reference scanning, and callable signatures.
  - Source: `node dist/cli.js code ProjectIndex -C 4`
- `src/symbols/reference-graph.ts:64-125` builds the file dependency graph from SCIP mention-derived file edges plus source import edges from `getSourceImports`.
  - Source: `node dist/cli.js code buildFileDepGraph -C 4`
- `src/symbols/reference-graph.ts:340-379` builds callee maps by splitting definitions into AST-backed and chunk-only groups, then merges AST call detection with chunk fallback when requested.
  - Source: `node dist/cli.js code buildCalleeMap -C 4`
- `src/symbols/identifier-attribution.ts:49-95` resolves a textual identifier by leaf-name candidates, same-file preference, direct imports, then an indirect imported-file heuristic.
  - Source: `node dist/cli.js code attributeIdentifier -C 4`

### Current Candidate Queries That Most Need TypeScript Semantics

- `src/queries/drift.ts:25-162` builds drift from a file dependency graph and a symbol-reference graph. The unused-import branch reports an import dependency when no referenced symbols from that file are visible, then skips known false-positive classes like source-proven used imports, type-only imports, type-like filenames, side-effect imports, and Vue component imports.
  - Source: `node dist/cli.js code drift -C 4`
- `src/queries/dead.ts:15-151` builds reference counts from SCIP mentions, supplements them from AST/source/caller-map paths, filters definitions, then reports candidates with zero cross-file references as `dead-code` or `file-internal`.
  - Source: `node dist/cli.js code dead -C 4`
- `src/queries/stale-abstractions.ts:27-150` gathers type-like candidates, merges SCIP cross-file callers and source-fallback callers, accounts for transitive same-file container usage, and scores low-consumer abstractions.
  - Source: `node dist/cli.js code staleAbstractions -C 4`
- `src/queries/imports.ts:112-119` reports unused imports by filtering loaded import entries where `used` is false.
  - Source: `node dist/cli.js code unusedImports -C 4`
- `src/queries/refs.ts:9-35` resolves a symbol, tries source-reference sites first, falls back to mention-resolved sites, then adds Ruby semantic refs.
  - Source: `node dist/cli.js code refs -C 4`

## Gate C — Reuse Audit

The plan should not add `ts-morph` directly to every query. Existing reusable surfaces already exist:

- `ProjectIndex` is the correct query-facing facade because most high-impact queries already use it or nearby graph helpers.
  - Source: `node dist/cli.js code ProjectIndex -C 4`
- `getSourceImports` is the correct import parsing entry point because `buildFileDepGraph`, `drift`, `imports`, `redundant-reexports`, `stale-abstractions`, and `identifier-attribution` already depend on `src/language-parsers`.
  - Source: `node dist/cli.js system src/language-parsers`
- `attributeIdentifier`, `findReferences`, and source-reference scanning are the right reference-resolution integration points because `refs`, `trace`, `dataflow`, `slice`, `dead`, `drift`, and `stale-abstractions` already consume them directly or through `ProjectIndex`.
  - Source: `node dist/cli.js system src/symbols`
- `buildFileDepGraph`, `buildCalleeMap`, and `buildCrossFileCallerMap` are the right graph augmentation points because downstream commands consume graph products rather than raw parser facts.
  - Source: `node dist/cli.js code buildFileDepGraph -C 4`
  - Source: `node dist/cli.js code buildCalleeMap -C 4`

## Alternatives Considered

### Alternative 1 — Keep Patching Tree-Sitter And Source Heuristics

This is fastest and preserves the current optional-dependency shape. It is not sufficient for TypeScript accuracy because the current `attributeIdentifier` logic at `src/symbols/identifier-attribution.ts:49-95` resolves ambiguous names through leaf-name and import heuristics rather than TypeScript declaration resolution.

Decision: keep tree-sitter/source fallbacks, but do not make them the final authority for TypeScript semantic questions.

Source: `node dist/cli.js code attributeIdentifier -C 4`

### Alternative 2 — Replace SCIP With `ts-morph` For TypeScript

This would improve TypeScript semantics but breaks the product shape. `scip-query` is language-agnostic, and `health` currently combines many queries that operate on the same SCIP SQLite model.

Decision: reject. SCIP remains the persistent cross-language index; `ts-morph` verifies and supplements TypeScript evidence.

Source: `node dist/cli.js code runHealthAnalyses -C 4`

### Alternative 3 — Call TypeScript Compiler API Directly

This avoids a new wrapper dependency, but it would make project setup, source-file traversal, symbol lookup, and references harder to maintain. `ts-morph` exists specifically as a more usable wrapper around the TypeScript compiler API.

Decision: use `ts-morph`, but hide it behind an internal provider interface so the rest of the codebase does not depend on `ts-morph` shapes.

Source: `node dist/cli.js system src/language-parsers`

### Alternative 4 — Add One Semantic Provider Layer

Add a TypeScript-specific semantic provider that is optional, cached per DB/project root, and consumed through shared query infrastructure.

Decision: accept. This gives the highest accuracy gain with the fewest command-specific edits.

Source: `node dist/cli.js code ProjectIndex -C 4`

## Architecture

A semantic provider is an analyzer that uses a language's real compiler or language-service model to resolve what source text means in that language. For TypeScript, the semantic provider will use `ts-morph` to answer questions about imports, declarations, aliases, references, and call targets that SCIP or tree-sitter may miss.

The implementation must be organized around deeply shared primitives, not command-local integrations. The shared primitives are:

1. `semanticImportUsage`: answers whether an import binding is type-used, value-used, unused, side-effect-only, or unresolved.
2. `semanticReferences`: maps indexed definitions to compiler-resolved reference sites.
3. `semanticCallerMap`: converts compiler-resolved references into the same symbol-id to caller-file shape already consumed by dead/stale/fan-in/impact queries.
4. `semanticCalleeMap`: converts compiler-resolved call expressions into the same callee rows already consumed by call graph, extraction, wrapper, passthrough, similarity, and complexity commands.
5. `semanticSignatures`: returns TypeScript compiler-normalized function/method signatures for same-shape detection.

Every command-specific change below must consume one of those primitives or a shared graph function that consumes one of those primitives. If an implementation step starts importing `ts-morph` from a query file, that step violates the plan.

Add a new internal layer:

```text
src/semantic/
  index.ts
  types.ts
  provider-cache.ts
  typescript/
    ts-morph-provider.ts
    tsconfig-discovery.ts
    import-usage.ts
    references.ts
    call-targets.ts
```

The provider should expose small scip-query-shaped facts, not `ts-morph` objects:

```ts
interface SemanticProvider {
  language: 'typescript';
  availability(): SemanticAvailability;
  importUsage(file: string): SemanticImportUsage[];
  referencesFor(definition: IndexedDefinition): SemanticReference[];
  referencedFiles(file: string): Set<string>;
  calleesFor(definition: IndexedDefinition): SemanticCallee[];
}
```

`ts-morph` is optional. If the dependency is missing, if no `tsconfig` can be found, or if project construction fails, `availability()` returns an unavailable result and every caller falls back to current behavior.

## Implementation Checklist

### Phase 1 — Add Optional TypeScript Semantic Infrastructure

- [ ] Add `ts-morph` to `optionalDependencies` in `package.json`, next to the existing optional TypeScript indexer and tree-sitter packages. Keep it optional so install failures degrade gracefully like the existing parser/indexer strategy.
  - Source: `node dist/cli.js system src/runtime`
- [ ] Add `SemanticAvailability`, `SemanticImportUsage`, `SemanticReference`, and `SemanticCallee` to `src/semantic/types.ts`. These types should use repo concepts: relative paths, 0-indexed lines, symbol IDs when known, and `IndexedDefinition` inputs.
  - Source: `node dist/cli.js code ProjectIndex -C 4`
- [ ] Add `src/semantic/provider-cache.ts` using the same per-DB caching style already used by `ProjectIndex`-adjacent helpers. The cache key must include `db.config.projectRoot` and the resolved TypeScript config path.
  - Source: `node dist/cli.js code getSourceImports -C 4`
- [ ] Add `src/semantic/typescript/tsconfig-discovery.ts` to find a usable TypeScript config for a file. Start with the nearest `tsconfig.json`; then support common workspace configs (`tsconfig.app.json`, `tsconfig.node.json`) only after tests prove nearest config is insufficient.
  - Source: `node dist/cli.js code getAst -C 4`
- [ ] Add `src/semantic/typescript/ts-morph-provider.ts` that lazy-loads `ts-morph` with dynamic import, creates a project from the selected tsconfig, and exposes only the internal semantic interface.
  - Source: `node dist/cli.js code ProjectIndex -C 4`
- [ ] Add `src/semantic/index.ts` with `getSemanticProvider(db, languageOrFile)` so query modules never import `ts-morph` directly.
  - Source: `node dist/cli.js system src/queries`
- [ ] Add `src/semantic/shared-primitives.ts` as the command-facing surface. It should export `semanticImportUsage`, `semanticReferences`, `semanticCallerMap`, `semanticCalleeMap`, and `semanticSignature` wrappers that return empty/fallback-safe results when no provider is available.
  - Source: `node dist/cli.js code ProjectIndex -C 4`

### Phase 2 — Use `ts-morph` For Import Truth First

- [ ] Extend `SemanticImportUsage` to include: importer file, resolved dependency file, imported name, local name, whether the binding is type-only, whether it is value-used, whether it is type-used, and reference locations.
  - Source: `node dist/cli.js code parseJavaScriptImports -C 4`
- [ ] In `src/language-parsers/index.ts:39-51`, keep `getSourceImports` as the fast parser path. Do not replace it. Add a separate semantic import API so current callers remain stable.
  - Source: `node dist/cli.js code getSourceImports -C 4`
- [ ] In `src/queries/imports.ts:112-119`, update `unusedImports` so TypeScript files ask the semantic provider before reporting `!entry.used`. If the provider says the import is type-used or value-used, suppress the result.
  - Source: `node dist/cli.js code unusedImports -C 4`
- [ ] In `src/queries/drift.ts:52-71`, replace the growing TypeScript false-positive skip list with a single `isSemanticallyUnusedImport(db, file, dep)` helper. That helper should use `ts-morph` when available and fall back to the current source-import checks when unavailable.
  - Source: `node dist/cli.js code drift -C 4`
- [ ] Add tests covering default imports, named imports, aliased imports, namespace imports, mixed `import { type Foo, bar }`, full `import type`, re-exported aliases, and Vue script imports. Preserve the existing `tests/drift-accuracy.test.ts` cases.
  - Source: `node dist/cli.js files 'tests/drift-accuracy.test.ts'`

### Phase 3 — Add Semantic Reference Supplement

- [ ] Add `referencesFor(definition)` in the provider. It should map an `IndexedDefinition` from `src/symbols/definition-catalog.ts` to the closest `ts-morph` declaration node by relative path and line range, then ask TypeScript for references.
  - Source: `node dist/cli.js system src/symbols`
- [ ] In `src/symbols/identifier-attribution.ts:49-95`, ask the semantic provider first for TypeScript files when a textual identifier is ambiguous. If the provider resolves the identifier to SCIP symbol IDs, return those refs; otherwise use the current same-file/direct-import/indirect-import heuristic.
  - Source: `node dist/cli.js code attributeIdentifier -C 4`
- [ ] In `src/symbols/source-reference-scan.ts` through `ProjectIndex.scanSourceReferences`, add semantic reference hits for TypeScript files after the current identifier scan. Deduplicate by source file, line, target file, and target symbol.
  - Source: `node dist/cli.js code scanSourceReferences -C 4`
- [ ] In `src/queries/refs.ts:18-23`, preserve current source-first/fallback behavior, but let `getSourceReferenceSites` benefit from semantic provider data instead of modifying `refs` directly.
  - Source: `node dist/cli.js code refs -C 4`

### Phase 4 — Harden `dead`

- [ ] In `src/queries/dead.ts:55-90`, add `supplementReferencesFromSemanticProvider(db, definitions, referencesBySymbol, inactiveBarrelPaths)`. It should run after AST/source and caller-map supplements so TypeScript compiler references add evidence before candidates are classified.
  - Source: `node dist/cli.js code dead -C 4`
- [ ] The supplement must be conservative: only add references; never remove SCIP/source references. If TypeScript cannot resolve a definition, leave existing behavior unchanged.
  - Source: `node dist/cli.js code dead -C 4`
- [ ] Add tests where SCIP fixtures omit references but `ts-morph` can prove usage through type annotations, aliases, re-exports, default export aliases, namespace access, and class/interface member access.
  - Source: `node dist/cli.js code dead -C 4`

### Phase 5 — Harden `stale-abstractions`

- [ ] In `src/queries/stale-abstractions.ts:54-60`, add semantic TypeScript consumers into the existing merged consumer map rather than building a parallel stale algorithm.
  - Source: `node dist/cli.js code staleAbstractions -C 4`
- [ ] In `src/queries/stale-abstractions.ts:86-110`, keep the current transitive container-type rule, but let semantic references prove container reachability for TypeScript when SCIP/source fallback misses it.
  - Source: `node dist/cli.js code staleAbstractions -C 4`
- [ ] Add tests for shared contract types, nested helper types, generic constraints, type aliases, interface extension, and exported API-only types. Expected behavior: API-only types should be low-confidence or suppressed, not high-confidence stale candidates.
  - Source: `node dist/cli.js code staleAbstractions -C 4`

### Phase 6 — Add Semantic Call Edges Where Useful

- [ ] Add `calleesFor(definition)` in the TypeScript provider. It should resolve call expressions inside the definition range to declarations and map those declarations back to SCIP symbols when possible.
  - Source: `node dist/cli.js code buildCalleeMap -C 4`
- [ ] In `src/symbols/reference-graph.ts:340-379`, merge semantic callees for TypeScript definitions after AST callees and before chunk fallback. Keep additive behavior unchanged.
  - Source: `node dist/cli.js code buildCalleeMap -C 4`
- [ ] Let this improve downstream commands indirectly: `call-graph`, `similar`, `extract-candidates`, `wrapper-candidates`, `passthrough-candidates`, `complexity-hotspots`, and health should benefit through the shared callee map rather than individual command edits.
  - Source: `node dist/cli.js system src/queries`

### Phase 7 — Optional Diagnostics And Calibration

- [ ] Add a hidden or explicit diagnostic option to report semantic-provider availability: dependency loaded, config path selected, files loaded, project construction errors, and fallback reason.
  - Source: `node dist/cli.js system src/runtime`
- [ ] Extend the existing calibration habit by running health and key commands on `scip-query`, `Stable_Management`, and `vega_2.0` before and after semantic verification. Record deltas in a follow-up markdown note.
  - Source: `node dist/cli.js code health -C 4`
- [ ] Do not let the health score improve by suppressing entire categories. The expected improvement is fewer false positives in `dead`, `stale-abstractions`, and `drift` while true findings remain visible.
  - Source: `node dist/cli.js code runHealthAnalyses -C 4`

## Complete CLI Command Evaluation

This section evaluates every non-help command registered in `src/runtime/cli.ts`. The guiding rule is completeness without scattering `ts-morph` calls everywhere: commands should use TypeScript semantics directly only when they need TypeScript-specific truth; otherwise they should benefit through shared file-dependency, reference, import, or callee-map layers.

| Command | `ts-morph` role | Implementation action | Source |
|---|---|---|---|
| `reindex` | Operational integration. Do not replace `scip-typescript`, but optionally record TypeScript semantic availability metadata after indexing. | Keep SCIP indexing as the source of SQLite truth. Add no semantic analysis during Phase 1; later add optional metadata only if diagnostics need it. | `src/runtime/cli.ts:50-79`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'` |
| `augment-sources` | No direct semantic role. | Keep as document augmentation for source files missed by indexers. `ts-morph` should consume the augmented file set indirectly, not modify this command. | `src/runtime/cli.ts:81-98`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'` |
| `augment-vue` | Adjacent semantic role through Volar, not `ts-morph` alone. | Keep Volar augmentation as the Vue-template semantic path. Later share tsconfig discovery/caches with the TypeScript semantic provider if duplication appears. | `src/runtime/cli.ts:100-121`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'`; `src/reindex/augment-vue.ts:179-257`; Source: `node dist/cli.js system src/reindex` |
| `stats` | No direct semantic role. | Leave as SQLite index statistics. It should not load a TypeScript project. | `src/runtime/cli.ts:123-137`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'` |
| `files` | No direct semantic role. | Leave as document/path query. | `src/runtime/cli.ts:139-145`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'` |
| `symbols` | Later optional enrichment. | Keep SCIP definition rows as primary. In a later phase, use `ts-morph` only to improve missing TypeScript signatures or declaration kind labels when SCIP metadata is weak. | `src/runtime/cli.ts:147-156`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'`; `src:queries:symbols:symbols()` lines 6-9; Source: `node dist/cli.js system src/queries` |
| `methods` | Later optional enrichment. | Keep current symbol-child lookup. Use `ts-morph` only if TypeScript class/interface members are missing or misclassified in SCIP. | `src/runtime/cli.ts:158-167`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'`; `src:queries:methods:methods()` lines 8-37; Source: `node dist/cli.js system src/queries` |
| `refs` | Direct semantic reference value. | Route TypeScript reference lookup through semantic provider inside `getSourceReferenceSites`/identifier attribution, not by rewriting the command. | `src/runtime/cli.ts:169-175`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'`; `src/queries/refs.ts:9-35`; Source: `node dist/cli.js code refs -C 4` |
| `trace` | Indirect semantic reference value. | Let `trace` inherit improved definitions/references from the same semantic reference layer used by `refs`. | `src/runtime/cli.ts:177-213`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'`; `src:queries:trace:trace()` lines 9-45; Source: `node dist/cli.js system src/queries` |
| `deps` | Indirect semantic file-dependency value. | Let it benefit when `buildFileDepGraph` gains semantic TypeScript dependency edges. Do not add command-local logic. | `src/runtime/cli.ts:215-221`; Source: `node dist/cli.js code 'src/runtime/cli.ts:50-220'`; `src/symbols/reference-graph.ts:64-125`; Source: `node dist/cli.js code buildFileDepGraph -C 4` |
| `rdeps` | Indirect semantic file-dependency value. | Same as `deps`: improve reverse dependencies by improving `buildFileDepGraph`. | `src/runtime/cli.ts:223-229`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src/symbols/reference-graph.ts:64-125`; Source: `node dist/cli.js code buildFileDepGraph -C 4` |
| `system` | Indirect semantic value. | Let file deps and references improve through shared graph layers; no command-local provider use. | `src/runtime/cli.ts:231-246`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:system:system()` lines 11-82; Source: `node dist/cli.js system src/queries` |
| `surface` | Direct semantic reference value. | Use semantic references to avoid undercounting TypeScript symbols consumed from a module, especially exported types and aliased imports. Implement through shared reference/caller maps. | `src/runtime/cli.ts:248-254`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:surface:surface()` lines 8-76; Source: `node dist/cli.js system src/queries` |
| `dead` | Direct semantic verification. | Add semantic reference supplementation before classification so TypeScript declarations with real compiler references are not reported as dead or file-internal. | `src/runtime/cli.ts:256-358`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src/queries/dead.ts:15-151`; Source: `node dist/cli.js code dead -C 4` |
| `hotspots` | Indirect semantic reference value. | Improve reference counts through shared semantic references/caller maps; no command-local provider use. | `src/runtime/cli.ts:360-374`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:hotspots:hotspots()` lines 14-70; Source: `node dist/cli.js system src/queries` |
| `imports` | Direct semantic import value. | Optionally enrich import output with TypeScript-resolved source and type/value role. Keep normal output stable unless a verbose/json mode exists later. | `src/runtime/cli.ts:376-387`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:imports:imports()` lines 12-18; Source: `node dist/cli.js system src/queries` |
| `imported-by` | Direct semantic import value. | Use semantic import data to find importers when SCIP role=2 import mentions are missing or aliases obscure the source. | `src/runtime/cli.ts:389-395`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:imports:importedBy()` lines 23-106; Source: `node dist/cli.js system src/queries` |
| `unused-imports` | Direct semantic verification. | First TypeScript rollout target with `drift`: ask semantic import usage whether the binding is type-used or value-used before reporting. | `src/runtime/cli.ts:397-406`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src/queries/imports.ts:112-119`; Source: `node dist/cli.js code unusedImports -C 4` |
| `outline` | Later optional enrichment. | Keep SCIP hierarchy. Use `ts-morph` only if TypeScript declaration nesting/ranges are missing from SCIP. | `src/runtime/cli.ts:408-422`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:outline:outline()` lines 14-70; Source: `node dist/cli.js system src/queries` |
| `members` | Later optional enrichment. | Keep SCIP child-symbol query. Use semantic members only to fill gaps for TypeScript interfaces/classes if observed. | `src/runtime/cli.ts:424-433`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:members:members()` lines 14-30; Source: `node dist/cli.js system src/queries` |
| `fan-in` | Indirect semantic reference value. | Improve through semantic reference/caller map supplementation. | `src/runtime/cli.ts:435-454`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:fan:fanIn()` lines 12-34; Source: `node dist/cli.js system src/queries` |
| `fan-out` | Indirect semantic dependency/callee value. | Improve through semantic file dependency and callee maps. | `src/runtime/cli.ts:456-475`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:fan:fanOut()` lines 40-95; Source: `node dist/cli.js system src/queries` |
| `coupling` | Indirect semantic reference value. | Improve when shared symbol/reference edges improve. Do not call provider directly. | `src/runtime/cli.ts:477-496`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:coupling:coupling()` lines 9-60; Source: `node dist/cli.js system src/queries` |
| `cycles` | Indirect semantic dependency value, with caution. | Use semantic file deps only when they represent actual import/module dependencies. Do not add type-only edges to cycle detection unless they are real module imports already present in source. | `src/runtime/cli.ts:498-521`; Source: `node dist/cli.js code 'src/runtime/cli.ts:220-520'`; `src:queries:cycles:cycles()` lines 13-82; Source: `node dist/cli.js system src/queries` |
| `bottlenecks` | Indirect semantic graph value. | Improve through shared fan-in/fan-out/reference maps. | `src/runtime/cli.ts:523-545`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:bottlenecks:bottlenecks()` lines 18-35; Source: `node dist/cli.js system src/queries` |
| `isolated` | Direct semantic verification. | Similar to `dead`: use semantic references to suppress TypeScript symbols that are compiler-reachable but SCIP/source-fallback missed. | `src/runtime/cli.ts:547-561`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:isolated:isolated()` lines 15-95; Source: `node dist/cli.js system src/queries` |
| `by-kind` | Later optional enrichment. | Keep SCIP kinds. Add semantic fallback only if TypeScript kind metadata is missing or misleading. | `src/runtime/cli.ts:563-579`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:by-kind:byKind()` lines 124-153; Source: `node dist/cli.js system src/queries` |
| `kind-counts` | Later optional enrichment. | Keep SCIP histogram. Semantic fallback would only matter if kind classification is proven inaccurate. | `src/runtime/cli.ts:581-592`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:by-kind:kindCounts()` lines 156-175; Source: `node dist/cli.js system src/queries` |
| `deep-chains` | Indirect semantic dependency value. | Improve through semantic file-dependency graph if SCIP/source imports miss TS dependencies. | `src/runtime/cli.ts:594-614`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:deep-chains:deepChains()` lines 19-155; Source: `node dist/cli.js system src/queries` |
| `hierarchy` | Later optional enrichment. | Keep SCIP symbol ancestry. Add semantic fallback only if TypeScript declaration ancestry is missing in SCIP rows. | `src/runtime/cli.ts:616-624`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:hierarchy:hierarchy()` lines 13-78; Source: `node dist/cli.js system src/queries` |
| `call-graph` | Direct semantic callee/caller value through shared map. | Add TypeScript semantic callees/callers into `buildCalleeMap` and caller-map inversion; command inherits better caller/callee truth. | `src/runtime/cli.ts:626-644`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src/symbols/reference-graph.ts:340-379`; Source: `node dist/cli.js code buildCalleeMap -C 4` |
| `similar` | Indirect semantic callee value. | Callee fingerprints become better after semantic call edges; no command-local provider use. | `src/runtime/cli.ts:646-695`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:similar:similar()` lines 25-39 and `similarAll()` lines 109-180; Source: `node dist/cli.js system src/queries` |
| `similar-files` | Indirect semantic dependency value. | File profiles improve if `buildFileDepGraph` gains semantically resolved TS import/dependency edges. | `src/runtime/cli.ts:697-727`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:similar-files:similarFiles()` lines 13-54; Source: `node dist/cli.js system src/queries` |
| `similar-chains` | Indirect semantic dependency value. | Dependency-flow similarity improves through the shared dependency graph. | `src/runtime/cli.ts:729-761`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:similar-chains:similarChains()` lines 22-177; Source: `node dist/cli.js system src/queries` |
| `extract-candidates` | Indirect semantic callee value. | Extraction candidates depend on callee clusters; improve via semantic `buildCalleeMap` edges. | `src/runtime/cli.ts:763-791`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:extract-candidates:extractCandidates()` lines 20-141; Source: `node dist/cli.js system src/queries` |
| `affected` | Direct semantic reference/caller value. | Use semantic references/callers through the affected graph so TypeScript downstream impact is not undercounted. | `src/runtime/cli.ts:793-814`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:affected:affected()` lines 15-65; Source: `node dist/cli.js system src/queries` |
| `change-surface` | Direct semantic consumer value. | Improve exported-symbol consumer counts by supplementing reference maps with semantic TypeScript references. | `src/runtime/cli.ts:816-829`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:change-surface:changeSurface()` lines 14-78; Source: `node dist/cli.js system src/queries` |
| `diff-impact` | Direct semantic consumer value. | Use semantic references/caller maps when computing downstream affected consumers for changed TypeScript symbols. | `src/runtime/cli.ts:831-853`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:diff-impact:diffImpact()` lines 12-152; Source: `node dist/cli.js system src/queries` |
| `drift` | Direct semantic import/dependency value. | Replace TypeScript false-positive skips with semantic import/dependency truth when provider is available. | `src/runtime/cli.ts:855-877`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src/queries/drift.ts:25-162`; Source: `node dist/cli.js code drift -C 4` |
| `wrapper-candidates` | Indirect semantic caller/callee value. | Candidate quality improves through semantic caller maps and callee maps; no command-local provider use. | `src/runtime/cli.ts:879-897`; Source: `node dist/cli.js code 'src/runtime/cli.ts:520-900'`; `src:queries:wrapper-candidates:wrapperCandidates()` lines 17-119; Source: `node dist/cli.js system src/queries` |
| `passthrough-candidates` | Indirect semantic callee value. | Candidate quality improves through semantic call edges. | `src/runtime/cli.ts:899-917`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:passthrough-candidates:passthroughCandidates()` lines 15-61; Source: `node dist/cli.js system src/queries` |
| `stale-abstractions` | Direct semantic consumer verification. | Add semantic TypeScript consumers into the existing consumer map before 0-1 consumer classification. | `src/runtime/cli.ts:919-945`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src/queries/stale-abstractions.ts:27-150`; Source: `node dist/cli.js code staleAbstractions -C 4` |
| `complexity-hotspots` | Indirect semantic fan-in/fan-out/callee value. | Keep LOC/branch scoring local. Improve fan-in/fan-out/callee metrics through shared semantic graph layers. | `src/runtime/cli.ts:947-967`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:complexity-hotspots:complexityHotspots()` lines 17-49; Source: `node dist/cli.js system src/queries` |
| `health` | Indirect only. | Do not call semantic provider directly. Health should improve only because underlying commands become more accurate. | `src/runtime/cli.ts:969-1017`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src/queries/health.ts:89-102`; Source: `node dist/cli.js code runHealthAnalyses -C 4` |
| `convergence` | Indirect semantic callee value. | Similar-function consolidation advice improves through semantic callee overlap; no command-local provider use. | `src/runtime/cli.ts:1019-1041`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:convergence:convergence()` lines 12-87; Source: `node dist/cli.js system src/queries` |
| `code` | Later optional enrichment. | Keep source-range reader. Use `ts-morph` only if definition ranges or signatures need correction for TypeScript. | `src/runtime/cli.ts:1043-1056`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:code:code()` lines 18-66; Source: `node dist/cli.js system src/queries` |
| `complexity` | Indirect semantic graph value. | Branch/cyclomatic stays source-based; fan-in/fan-out/callee metrics improve through semantic graph layers. | `src/runtime/cli.ts:1058-1072`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:complexity:complexity()` lines 16-79; Source: `node dist/cli.js system src/queries` |
| `dataflow` | Direct semantic reference/call value. | Improve producers, consumers, and usage sites through semantic references and semantic call edges. | `src/runtime/cli.ts:1074-1112`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:dataflow:dataflow()` lines 25-72; Source: `node dist/cli.js system src/queries` |
| `slice` | Direct semantic reference/call value. | Improve backward/forward slices by using semantic references and call edges in shared graph traversal. | `src/runtime/cli.ts:1114-1134`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:slice:slice()` lines 24-39; Source: `node dist/cli.js system src/queries` |
| `install-skills` | No semantic role. | Leave unchanged. It installs agent skills, not code intelligence data. | `src/runtime/cli.ts:1136-1147`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'` |
| `check-deps` | Operational semantic dependency role. | Extend to report whether optional `ts-morph` is loadable when TypeScript is detected. This is diagnostic only and should not block existing readiness checks. | `src/runtime/cli.ts:1149-1193`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'` |
| `redundant-reexports` | Direct semantic import/re-export value. | Use semantic import/re-export usage to avoid false positives around TypeScript aliases, `export type`, and barrels consumed through type-only paths. | `src/runtime/cli.ts:1195-1212`; Source: `node dist/cli.js code 'src/runtime/cli.ts:900-1210'`; `src:queries:redundant-reexports:redundantReexports()` lines 21-191; Source: `node dist/cli.js system src/queries` |
| `similar-signatures` | Direct semantic signature value. | Use `ts-morph` to normalize TypeScript signatures from compiler declarations where SCIP docs/source declaration extraction are incomplete. | `src/runtime/cli.ts:1214-1232`; Source: `node dist/cli.js code 'src/runtime/cli.ts:1210-1338'`; `src:queries:similar-signatures:similarSignatures()` lines 21-83; Source: `node dist/cli.js system src/queries` |
| `init` | Operational integration. | If TypeScript is detected, optionally include future semantic-provider config defaults only after provider behavior is stable. No Phase 1 direct use. | `src/runtime/cli.ts:1234-1244`; Source: `node dist/cli.js code 'src/runtime/cli.ts:1210-1338'` |
| `watch` | Operational integration. | Keep reindex watch behavior. Later invalidate semantic provider caches after reindex completes; do not run `ts-morph` on every file-change event. | `src/runtime/cli.ts:1246-1285`; Source: `node dist/cli.js code 'src/runtime/cli.ts:1210-1338'` |
| `status` | Operational diagnostics. | Add optional semantic-provider status once implemented: available/unavailable, selected tsconfig count, and last fallback reason. | `src/runtime/cli.ts:1287-1316`; Source: `node dist/cli.js code 'src/runtime/cli.ts:1210-1338'` |

## Stress Test Against The 11 Principles

1. Understand before touching: the plan keeps SCIP as the source of persistent graph truth and adds TypeScript semantics only where current flows are heuristic.
2. Blast radius: new code is centralized in `src/semantic` plus shared integration points: `language-parsers`, `identifier-attribution`, `reference-graph`, `dead`, `drift`, and `stale-abstractions`.
3. Valid intermediate states: each phase is independently shippable. Phase 1 adds optional infrastructure only; Phase 2 improves imports only; later phases expand coverage.
4. Reversibility: all phases are two-way internal refactors. Removing the provider should leave current SCIP/tree-sitter behavior intact.
5. Failure design: provider unavailable means fallback to existing behavior. No command should fail just because `ts-morph` cannot load.
6. Concurrency: provider cache must be per DB/project root and read-only after construction. No source files are mutated.
7. Boundaries: CLI users trigger analysis only through existing command entry points. No new external service or network path is introduced.
8. Data integrity: no database writes are added. The provider supplements in-memory query evidence only.
9. Observability: diagnostics should expose provider availability and fallback reasons without cluttering normal command output.
10. Human impact: users should see fewer false positives and clearer confidence, not fewer categories or hidden heuristics.
11. Reuse: the plan reuses `ProjectIndex`, `getSourceImports`, `attributeIdentifier`, `buildFileDepGraph`, and `buildCalleeMap` instead of adding command-local TypeScript analyzers.

## Verification Checklist

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `node dist/cli.js reindex --force --language typescript --indexer-concurrency 1`
- [ ] On `scip-query`: `health`, `dead --min-loc 5 --skip-barrels`, `drift`, `stale-abstractions`, `refs <known TS symbol>`, `call-graph <known TS function>`
- [ ] On `Stable_Management`: reindex with TypeScript, then compare `health`, `drift`, `dead`, `stale-abstractions`
- [ ] On `vega_2.0`: reindex with TypeScript, then compare the same commands

## Open Questions

- Should `ts-morph` support multiple tsconfigs in the first implementation, or should Phase 1 use nearest `tsconfig.json` only and document misses?
- Should `.vue` template semantic support wait for the existing Volar augmentation path, or should the provider only handle Vue script blocks at first?
- Should semantic-provider diagnostics be a global CLI option, a hidden command, or a field in `health --json` if JSON output exists later?
