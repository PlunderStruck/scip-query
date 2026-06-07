# Primogen Disgust Register

Date: 2026-06-07
Scope: whole repository after the command-spec compression pass.

This is the deliberately harsh architecture register: the things a very senior reviewer would notice first, not because the code is broken, but because the current shape makes future work require too much local folklore.

A code smell is an observable codebase fact that predicts avoidable future mistakes because the same knowledge must be rediscovered, synchronized, or defended in several places. The concrete units here are files, functions, tests, command specs, query modules, caches, and public exports; the distinguishing trait is that a maintainer must know more than the local interface admits.

An evidence policy is the rule for deciding what code-intelligence fact counts as truth when SCIP data, semantic-provider data, AST data, and source-text fallback data disagree or are missing. The concrete units are definitions, references, callers, callees, file dependencies, import uses, and source snippets; the distinguishing trait is that it chooses among imperfect sources and records why a result should be trusted.

An analysis pipeline is a repeatable path from candidate selection to evidence loading, scoring, filtering, and result projection. The concrete units are `dead`, `isolated`, `similar`, `stale-abstractions`, `wrapper-candidates`, `passthrough-candidates`, `complexity-hotspots`, and health phases; the distinguishing trait is that it turns a broad project index into a ranked judgment rather than a raw lookup.

A facade is a module whose interface hides several lower-level mechanisms behind one named operation. The concrete units are `ProjectIndex`, `ScipDatabase`, `referenceSitesForSymbol`, command execution helpers, and cache clearing helpers; the distinguishing trait is that callers depend on the named role instead of the implementation ingredients.

A public surface is the part of the package downstream users can import. The concrete units are `src/index.ts`, `package.json` exports, query exports, runtime exports, and exported domain types; the distinguishing trait is that changing it can break code outside this repository.

## Executive Read

The biggest remaining smell is not the long command file. The biggest smell is that query modules still know too much about how evidence is manufactured. `ProjectIndex` exists, but it is still mostly a convenience facade over symbol, source, storage, AST, and semantic modules. A new query author still has to know when to use SCIP rows, when to use source fallbacks, when to include semantic providers, how to clear caches, how to respect ignore policy, how to distinguish real consumers from re-export-only consumers, and how to avoid false positives from broad indexer ranges.

The next best architecture move is an evidence-model pass: make "definition/reference/caller/callee evidence with provenance" a deeper module, then make analysis pipelines consume that model instead of hand-assembling truth from lower layers.

## Disgust Ledger

| Priority | Smell | Main files | Why it earns the side-eye | Better shape |
| --- | --- | --- | --- | --- |
| P0 | Evidence policy is distributed across query, symbol, source, semantic, and storage modules. | `src/core/project-index.ts`, `src/symbols/*.ts`, `src/source/*.ts`, `src/queries/dead.ts`, `src/queries/stale-abstractions.ts`, `src/queries/similar.ts`, `src/queries/isolated.ts` | Adding a query requires knowing too many fallback rules and too many cache/ignore details. | A deeper `ProjectEvidence`/`EvidenceIndex` module that returns definitions, references, callers, callees, and file deps with provenance. |
| P0 | Analysis commands are hand-built pipelines, not instances of a shared analysis model. | `src/queries/dead.ts`, `src/queries/stale-abstractions.ts`, `src/queries/health.ts`, `src/queries/similar.ts`, `src/queries/wrapper-candidates.ts`, `src/queries/passthrough-candidates.ts` | Many files repeat candidate selection, scan limiting, fallback merging, confidence scoring, sorting, and suppression in concept if not text. | A candidate-analysis kernel: candidate source -> evidence sources -> filters -> scorer -> ranked report. |
| P1 | `query-command-specs.ts` declares once but still mixes two axes in one 1,317-line file. | `src/runtime/query-command-specs.ts`, `src/runtime/command-execution.ts` | The last refactor removed descriptor/handler duplication, but command manifest, option decoding, query invocation, rendering, and bespoke report text still live in one giant module. | A `queryCommand()` spec object per command, grouped by command family, with handler/render behavior derived from the spec where possible. |
| P1 | `src/source/ast.ts` is an AST runtime, grammar loader, Vue script extractor, query compiler, callsite finder, callable finder, type-container mapper, and target normalizer. | `src/source/ast.ts`, language parser modules, framework pattern analysis | One file owns several different reasons to change: optional dependency loading, parser pooling, language catalogs, source extraction, and semantic AST queries. | A deep AST facade with internal submodules for parser runtime, language query catalog, Vue extraction, and AST-derived facts. |
| P1 | Tests are an incident archive more than a contract system. | `tests/command-accuracy.test.ts`, `tests/command-accuracy-fixtures.ts`, `tests/*fallback*.test.ts`, `tests/typescript-semantic-provider.test.ts` | Coverage is valuable but hard to navigate: many tests construct SQLite rows directly and assert historical bug fixes at query level. | A fixture DSL plus evidence-contract tests for each source mode: SCIP-only, semantic, AST fallback, source fallback, mixed fallback. |
| P1 | The public package surface looks accidental. | `src/index.ts`, `src/domain/types.ts`, `package.json` | The root export mixes database, project index, runtime config, watcher, setup, reindex, CLI install helpers, all query functions, and every domain type. | Explicit public API tiers: core library, queries, reindex/runtime utilities, and internal-only domain shapes. |
| P2 | Language parser adapters repeat a real shape without a named adapter contract. | `src/language-parsers/python.ts`, `src/language-parsers/ruby.ts`, `src/language-parsers/c-like.ts`, `src/language-parsers/javascript.ts`, `src/language-parsers/utils.ts` | Fresh `similar-files` output shows Python/Ruby/C-like at 100% dependency-profile similarity; the repeated shape is "AST if available, regex/source fallback otherwise." | A parser adapter contract that names import/export/re-export/source-usage capabilities and fallback mode explicitly. |
| P2 | Vue augmentation is a dense subsystem hidden as helper soup. | `src/reindex/augment-vue.ts`, `src/reindex/augment-vue-runtime.ts` | It has a real lifecycle, but the lifecycle is implicit: Volar context, generated/source offsets, occurrence mapping, SCIP writes, and cache replacement. | Name the lifecycle as a Vue augmentation transaction with small owned phases and a single result model. |
| P2 | Cache invalidation is coordinated by convention. | `src/queries/health-cache-control.ts`, `src/source/source-text.ts`, `src/source/ast.ts`, `src/source/source-stripper.ts`, `src/symbols/*cache*`, `src/queries/dead.ts`, `src/queries/stale-abstractions.ts` | Many caches are correct locally, but callers have to remember which composite invalidation path applies after source-backed scans or health phases. | A cache registry keyed by evidence kind and invalidation scope: whole DB, file, source text, semantic provider. |
| P2 | Suppression comments are carrying architecture decisions that should be named mechanisms. | many `scip-query: ignore-*` comments in `src/queries`, `src/symbols`, `src/source`, `src/core` | The comments are good local guardrails, but many say "this is one policy/pipeline" repeatedly, which means the policy lacks a first-class home. | Turn repeated suppressions into named analysis/evidence mechanisms, then keep suppressions only for true intentional facades. |

## Evidence

Commands run for this register:

```bash
node dist/cli.js stats
node dist/cli.js health --json
find src tests -type f | xargs wc -l | sort -nr | head -40
node dist/cli.js system runtime
node dist/cli.js system queries
node dist/cli.js system symbols
node dist/cli.js system source
node dist/cli.js wrapper-candidates --max-loc 40
node dist/cli.js passthrough-candidates --max-loc 40
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120
node dist/cli.js drift --min-deviation 3
node dist/cli.js rdeps src/core/project-index.ts
node dist/cli.js rdeps src/symbols/symbol-lookup.ts
node dist/cli.js rdeps src/source/ast.ts
node dist/cli.js similar-files --min-similarity 0.35 --limit 80
node dist/cli.js extract-candidates --min-loc 5 --min-callees 2 --limit 80
rg -n "\\.prepare\\(|getSourceText\\(|getAst\\(|getCallableSites\\(|getCallSites\\(|findFirstSymbolMatch\\(|getFullSymbolMatch\\(|getDefinitionsForFile\\(|getAllDefinitions\\(|definitionMentionRows\\(|clear.*Cache|withDb\\(" src/queries src/runtime src/symbols src/source src/reindex tests
```

Current health is 100, with no drift, no stale abstractions, no passthrough candidates, and no health-reported wrappers. That matters: these are architecture smells in a healthy codebase, not cleanup of broken behavior.

Largest files by line count:

- `src/runtime/query-command-specs.ts` - 1,317 lines.
- `src/queries/stale-abstractions.ts` - 674 lines.
- `tests/command-accuracy.test.ts` - 672 lines.
- `src/source/ast.ts` - 651 lines.
- `src/language-parsers/javascript.ts` - 651 lines.
- `src/semantic/typescript/ts-morph-provider.ts` - 650 lines.
- `src/analysis/framework-patterns.ts` - 634 lines.
- `src/reindex/augment-vue-runtime.ts` - 630 lines.
- `src/reindex/index.ts` - 625 lines.
- `src/symbols/definition-catalog.ts` - 609 lines.
- `src/queries/dead.ts` - 580 lines.
- `src/queries/health.ts` - 536 lines.

Wrapper probes still identify low-threshold candidates:

- `src/symbols/identifier-attribution.ts:213-246` `findCallerFiles()`
- `src/symbols/definition-catalog.ts:233-259` `hydrateSymbolMatch()`
- `src/storage/scip-rows.ts:55-78` `definitionMentionRows()`
- `src/reindex/augment-vue-runtime.ts:280-313` `createVueComponentSymbolLookup()`
- `src/source/ast.ts:626-651` `extractCallLeaf()`
- `src/reindex/augment-vue-runtime.ts:381-405` `resolveVueDefinitionSymbolId()`

Some of these were already intentionally kept, but together they point at the same pressure: evidence construction, source/AST interpretation, and augmentation writes are still hard to name at the right level.

## P0: Evidence Policy Is Distributed

What the reviewer sees:

- `src/queries/dead.ts` imports storage rows, file classification, symbol parsing, call-graph evidence, `ProjectIndex`, language parsers, source caches, AST caches, source text caches, identifier indexes, path normalization, import indexes, document paths, and mention rows.
- `src/queries/stale-abstractions.ts` imports `ProjectIndex`, source text, AST, re-export parsing, symbol parsing, per-DB cache, query utilities, and local scoring policy.
- `src/core/project-index.ts` wraps useful operations, but most methods are thin pass-throughs to `definition-catalog`, `call-graph-evidence`, `file-dep-graph`, `reference-callers`, `identifier-attribution`, `source-text`, and `source-reference-scan`.
- `src/symbols/call-graph-evidence.ts` owns a separate SCIP/AST/semantic/chunk merge policy.
- `src/symbols/reference-sites.ts` owns source-primary reference selection after the previous compression pass.
- `src/symbols/identifier-attribution.ts` owns strict/permissive ambiguity policy for source hits.

Why this is disgusting:

The user-facing concept is simple: "show me what references this symbol," "tell me if this definition is dead," "tell me what calls this." The implementation concept is not simple because truth can come from several evidence sources. That complexity is real. The smell is that each analysis still decides too much of that truth locally.

The proper deeper module:

Create a `ProjectEvidence` or `EvidenceIndex` module that owns these facts as first-class results:

- `definitions(scope | file)` returns source-corrected definitions.
- `references(symbol, mode)` returns reference sites with provenance.
- `callers(definitions, mode)` returns caller files with provenance.
- `callees(definitions, mode)` returns callees with provenance.
- `fileDependencies(scope, mode)` returns file edges with provenance.
- `sourceFacts(file)` returns AST/source/import facts through one cache-aware path.

The important addition is provenance. A reference discovered by SCIP, TypeScript semantic analysis, AST callsite matching, source-token fallback, or re-export parsing should carry that source. Then query modules can filter and score by provenance instead of re-running the source selection story.

What this would delete or simplify:

- Local fallback merging in `dead`, `stale-abstractions`, `isolated`, `wrapper-candidates`, `call-graph`, `slice`, and `similar`.
- Many direct imports from `src/source/*`, `src/symbols/*`, and `src/storage/*` inside `src/queries/*`.
- Some cache invalidation calls in query modules, because the evidence module can own source-sensitive invalidation.

Suggested first slice:

Move `ProjectIndex` from a thin facade to a deeper `ProjectEvidence` by first making callers/callees/references return provenance-bearing records. Port `dead`, `isolated`, and `stale-abstractions` first because they currently pay the most evidence tax.

## P0: Analysis Pipelines Are Implicit

What the reviewer sees:

- `dead()` is a full candidate pipeline: document iteration, candidate gates, mention counts, source fallback, caller-map supplement, row projection, summary.
- `staleAbstractions()` is a full candidate pipeline: type candidates, consumer map, singleton correction, transitive reachability, real/barrel consumer partitioning, confidence scoring.
- `similar()`, `similarAll()`, `extractCandidates()`, `wrapperCandidates()`, `passthroughCandidates()`, and `complexityHotspots()` are all variations on candidate loading, evidence gathering, scoring, sorting, limiting, and report projection.
- `health()` repeats the same analyses as phases and then summarizes them.

Why this is disgusting:

Each detector is individually understandable, but the family has no common shape. The codebase has "detectors," but no detector abstraction. That makes each new analysis a bespoke invention and makes health orchestration depend on each detector's private result shape.

The proper deeper module:

Introduce an analysis pipeline kernel:

```text
candidateSource -> evidenceLoaders -> filters -> scorer -> ranker -> resultProjection
```

This should not be an over-general framework. It should encode only the repeated facts this repository already has:

- scan limits and candidate budgets
- include/exclude tests and entry surfaces
- suppression comments
- evidence provenance
- confidence labels
- result sorting
- health summaries

What this would delete or simplify:

- Repeated scan-limit, candidate-sort, and confidence-ranking code.
- Detector-specific health summarizers that mostly count results.
- Some `scip-query: ignore-extract` comments that exist only because the pipeline has no name.

Suggested first slice:

Model `candidate-scan` as a small internal API and migrate `wrapper-candidates`, `passthrough-candidates`, and `complexity-hotspots` first. Then tackle `dead` and `stale-abstractions` after `ProjectEvidence` exists.

## P1: Query Command Specs Are Better, But Not Done

What the reviewer sees:

- `src/runtime/query-command-specs.ts` is 1,317 lines.
- The file contains handler functions, option decoding, query invocation, output formatting, explanatory text, and the `queryCommandDescriptors` manifest.
- The last pass made each query command declared in one module, but many commands are still two nearby things: an exported `handleX` and a descriptor entry that points to it.

Why this is disgusting:

The refactor removed the worst duplication, but the module still has "command declaration" and "command rendering implementation" braided together without a smaller unit of composition. A reviewer would probably say: good first move, now finish the algebra.

The proper deeper module:

Define a `queryCommand()` builder whose return value is the descriptor and the handler together. For example:

```text
queryCommand({
  id,
  command,
  docs,
  options,
  budget,
  output: list/table/grouped/report/custom,
  run,
  render
})
```

Then split commands by family only after the unit is right: navigation, graph, cleanup, impact, health. Splitting before that would only create several smaller files with the same mixed concept.

What this would delete or simplify:

- Standalone exported `handleX` names for commands that no one else calls.
- Descriptor arrays that separately point at handlers.
- Some duplicated option decoding in report commands.

Suggested first slice:

Convert only simple row commands first: `files`, `symbols`, `methods`, `deps`, `rdeps`, `surface`, `imported-by`, `members`, `by-kind`. Leave bespoke report commands until the builder proves itself.

## P1: AST Runtime Is Too Many Concepts In One File

What the reviewer sees:

- `src/source/ast.ts` is 651 lines.
- It loads optional native parser bindings.
- It maps file extensions to AST languages.
- It caches grammars, parsers, trees, queries, callable sites, call sites, and type-container maps.
- It special-cases Vue SFC script extraction.
- It compiles Tree-sitter queries.
- It exposes AST walks and AST query helpers.
- It normalizes call leaves for framework-pattern code.

Why this is disgusting:

The module's public role is "AST facts from source files." Internally it has at least four different reasons to change: parser availability, language support, Vue extraction, and specific code-intelligence queries. That means adding a grammar, fixing Vue, changing callsite extraction, and changing cache strategy all land in the same file.

The proper deeper module:

Keep one public AST facade, but split the implementation by role:

- parser runtime: optional dependency loading, grammar cache, parser pool
- language catalog: extensions and Tree-sitter query strings
- Vue script extraction: SFC-to-script source mapping
- AST facts: callable sites, call sites, type containers, generic query/walk helpers

What this would delete or simplify:

- Broad imports from a module that contains unrelated AST mechanics.
- The need to understand parser loading before changing callsite logic.
- The low-threshold `extractCallLeaf()` wrapper signal, because call target normalization would live in the AST facts layer.

Suggested first slice:

Extract parser runtime and language catalog without changing exported functions. This is mostly file movement with typecheck/test coverage, but it creates room for AST fact APIs to deepen later.

## P1: Tests Are An Incident Archive

What the reviewer sees:

- `tests/command-accuracy.test.ts` is 672 lines.
- `tests/command-accuracy-fixtures.ts` is 452 lines.
- Several tests directly prepare SQLite statements and manually insert SCIP-like rows.
- Test names encode historical fixes: source fallbacks, role-one fallback definitions, parser fallback, file-wide caller fallback, redundant re-export fallbacks, TypeScript semantic provider behavior.

Why this is disgusting:

The tests are doing an important job, but they make the next engineer learn the system by reading a chronology of bugs. That protects behavior, but it does not clearly expose the contracts: which evidence modes exist, what each mode guarantees, and how they combine.

The proper deeper module:

Create an evidence fixture DSL:

```text
fixture()
  .file(path, source)
  .definition(symbol, range, kind)
  .reference(symbol, file, line, sourceKind)
  .import(from, to, importedName)
  .semanticReference(...)
  .buildDb()
```

Then create evidence-contract test groups:

- symbol lookup contracts
- definition range correction contracts
- reference-site provenance contracts
- caller/callee evidence contracts
- detector confidence contracts
- CLI rendering contracts

What this would delete or simplify:

- Repeated manual SQLite setup.
- Test fixtures that know raw table details when the test only cares about symbols and references.
- Some giant accuracy tests that could become smaller contract suites.

Suggested first slice:

Build the fixture DSL around the existing `command-accuracy-fixtures.ts` helpers, then migrate one fallback test file and one command-accuracy section. Do not rewrite the whole suite at once.

## P1: Public Surface Looks Accidental

What the reviewer sees:

- `src/index.ts` exports `ScipDatabase`, `ProjectIndex`, gitignore filter creation, symbol parsing helpers, reindex functions, runtime config, `Watcher`, skill installer, SCIP install helpers, all queries, and every type from `src/domain/types.ts`.
- `package.json` already supports `./queries/*`, so direct query imports exist.
- Previous compression passes kept some stale-looking domain types solely because they may be part of this public surface.

Why this is disgusting:

The root package surface reads like "whatever people might need" rather than a designed API. That makes internal refactors more expensive because it is unclear which shapes are intentionally public and which are just exported because they were nearby.

The proper deeper module:

Define public API tiers:

- `scip-query` root: stable library essentials only.
- `scip-query/queries` and `scip-query/queries/*`: query functions and result types.
- `scip-query/reindex`: indexing and augmentation utilities.
- `scip-query/runtime`: watcher/config/setup only if intentionally supported.
- internal domain/source/symbol types stay unexported unless deliberately promoted.

What this would delete or simplify:

- Defensive skips around one-consumer types that are only "public" accidentally.
- Root-level import churn.
- Fear around moving domain types into owning modules.

Suggested first slice:

Write an API inventory first. Mark each root export as stable, provisional, or internal-leaked. Then add subpath exports before removing anything from the root.

## P2: Vue Augmentation Is A Hidden Transaction

What the reviewer sees:

- `src/reindex/augment-vue-runtime.ts` is 630 lines.
- The file owns Volar dependency loading, tsconfig parsing, language context creation, project host creation, definition range lookup, source/generated offset mapping, document chunk replacement, definition mention insertion, occurrence insertion, symbol id lookup, and source reading.
- `src/reindex/augment-vue.ts` drives the command-facing orchestration and imports many local helpers from runtime.

Why this is disgusting:

The domain concept is not "a lot of helpers"; it is "translate Vue language-service evidence into SCIP database facts." That is a transaction. The transaction phases are real, but they are implicit.

The proper deeper module:

Name the phases:

- load Vue language context
- select Vue documents
- compute resolved references
- map generated offsets to source offsets
- resolve symbol ids
- replace affected chunks and mentions
- report augmentation result

What this would delete or simplify:

- Helper soup in `augment-vue-runtime.ts`.
- Low-threshold wrapper warnings for Vue helper functions.
- The need to understand database writes and language-service offsets in the same pass.

Suggested first slice:

Create a `VueAugmentationTransaction` or equivalent internal object that owns the DB write phase and result. Keep Volar context creation separate.

Completed slice:

`docs/plans/2026-06-07-vue-augmentation-transaction-atlas.md` records the transaction boundary. `augmentVueResolvedReferences()` now owns setup/cache concerns, while `runVueAugmentationTransaction()` owns component-symbol creation, Volar computation, occurrence dedupe, chunk replacement, status reporting, and the single `AugmentVueResolvedResult` summary. The previous one-use write/result helpers were inlined into that named transaction.

## P2: Cache Invalidation Is Convention-Driven

What the reviewer sees:

- `health-cache-control.ts` clears language parser caches, semantic provider cache, AST cache, source stripper cache, source text cache, identifier index cache, and symbol evidence caches.
- `dead.ts` clears file-local definition/source/parser/AST/identifier caches after source-backed candidate passes.
- `stale-abstractions.ts` has its own stale abstraction cache clearing.
- `source-text`, `source-stripper`, `ast`, `identifier-index`, `file-dep-graph`, `call-graph-evidence`, and `leaf-symbol-index` each expose cache lifecycle hooks.

Why this is disgusting:

The caches are individually reasonable. The problem is that composite invalidation is something callers must remember. That is how a future subtle stale-read bug happens.

The proper deeper module:

Create a cache registry with evidence kinds and invalidation scopes:

- whole DB
- file
- source text changed
- semantic provider changed
- analysis phase completed

The registry should know which caches subscribe to which scope.

What this would delete or simplify:

- Manually coordinated cache clears.
- Cache clearing imports in query modules.
- Some intentional passthrough suppressions for cache lifecycle hooks.

Suggested first slice:

Do not overbuild. Start with file-scoped source evidence invalidation because `dead.ts` already coordinates several file-local clears manually.

Completed slice:

`docs/plans/2026-06-07-cache-invalidation-registry-atlas.md` records the registry. `src/queries/internal/cache-invalidation.ts` now owns evidence cache kinds and database/file scopes, `health.ts` delegates whole-project cleanup to that registry, and `dead.ts` delegates source-backed file cleanup to the same file-scoped policy. `health-cache-control.ts` now keeps only garbage-collection headroom behavior. Concrete cache modules still own their local cache objects.

## Attack Order

1. Evidence model: promote `ProjectIndex` into a deeper `ProjectEvidence` interface with provenance-bearing definitions, references, callers, callees, and source facts.
2. Analysis pipeline kernel: migrate the small detectors first, then the heavyweight detectors.
3. Query command spec algebra: finish the command declaration unit and then split by family.
4. AST runtime split: keep public AST facade stable while separating parser runtime, language catalog, Vue extraction, and AST facts.
5. Test fixture DSL: turn the incident archive into evidence contracts gradually.
6. Public API inventory: classify and tier exports before removing anything.
7. Vue augmentation transaction: name the lifecycle and phase boundaries.
8. Cache registry: centralize invalidation once the evidence model clarifies cache ownership.

## What Not To Do

- Do not split files just because they are long. Some long files are long because the concept is real.
- Do not make `ProjectIndex` a larger bag of pass-through methods. It has to own evidence policy, not merely forward to helpers.
- Do not introduce a generic framework for all analyses before the evidence model is stable.
- Do not remove public exports until an API inventory says they are accidental.
- Do not turn suppression comments into a blanket ignore policy. Each repeated suppression should either become a named mechanism or stay a narrow exception.

## Best Next Refactor

The most professionally embarrassing smell is the distributed evidence policy. The next refactor should be a `ProjectEvidence` compression pass.

Success would look like this:

- Query modules import fewer low-level source/symbol/storage modules.
- Evidence records carry provenance.
- `dead`, `isolated`, and `stale-abstractions` stop manually deciding how to combine SCIP, semantic, AST, and source fallback facts.
- Cache invalidation starts moving behind the evidence layer.
- Health remains 100, drift remains clean, and command accuracy tests still pass.

First slice started in `docs/plans/2026-06-07-project-evidence-isolated-compression-atlas.md`: `isolated` no longer imports framework-pattern AST helpers, AST language detection, or indexed-document iteration directly for framework reference evidence, and no longer hand-projects non-self callees from raw callee maps. `stale-abstractions` and `wrapper-candidates` also no longer hand-merge indexed caller evidence with source-fallback caller evidence.

Language parser adapter slice landed in `docs/plans/2026-06-07-language-parser-adapter-contract-atlas.md`: parser adapters now declare their source-fact capabilities and fallback modes, JavaScript-style re-export parsing dispatches through the registry instead of importing the JavaScript implementation directly, and re-export parsing now shares the same per-database cache ownership as import/export parsing.

Query command algebra slice continued in `docs/plans/2026-06-07-query-command-spec-compression-atlas.md`: simple list/table/grouped commands now use `listQueryCommand`, `tableQueryCommand`, and `groupedQueryCommand`, so metadata, query invocation, render shape, empty state, and post-render behavior live in one command-spec unit instead of split `handleX` symbols plus descriptor entries.

AST runtime split started in `docs/plans/2026-06-07-ast-runtime-split-atlas.md`: the public `src/source/ast.ts` facade stays stable, while parser runtime, language detection, and structural tree/query types move into owned internal modules.

Test fixture DSL slice started in `docs/plans/2026-06-07-test-fixture-dsl-atlas.md`: `tests/evidence-fixture.ts` now owns the minimal SCIP-like SQLite schema, source-file writing, and document/symbol/definition/chunk/mention insertion contract for fallback tests.

Public API surface slice started in `docs/plans/2026-06-07-public-api-surface-atlas.md`: the root export remains stable, while explicit `scip-query/reindex` and `scip-query/runtime` subpath tiers now have source barrels, build entries, and package exports.
