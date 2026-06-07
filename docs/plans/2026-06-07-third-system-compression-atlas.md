# Third System Compression Atlas

Date: 2026-06-07
Scope: whole repository, with emphasis on the post-command-refactor pressure points in storage, runtime readiness, query document iteration, and stale type surfaces.

## Scope Map

The repository is a TypeScript CLI and library over SCIP SQLite indexes. The main public surface is `src/index.ts`, which exports `ScipDatabase`, `ProjectIndex`, reindex/runtime helpers, query functions, and every type from `src/domain/types.ts`. The recurring internal surfaces are:

- CLI/runtime: `src/runtime/command-descriptors.ts`, `src/runtime/query-command-handlers.ts`, `src/runtime/command-execution.ts`, `src/runtime/command-handlers.ts`, `src/runtime/project-readiness.ts`.
- Query modules: `src/queries/*.ts`, especially the modules that enumerate indexed documents or classify reachability.
- Storage policy: `src/storage/db.ts`, `src/storage/scip-documents.ts`.
- Symbol evidence: `src/symbols/*.ts`, especially catalog, lookup, caller/reference graph helpers.
- Reindex and Vue augmentation: `src/reindex/*.ts`, especially the local Vue API type cluster in `src/reindex/augment-vue-types.ts`.
- Tests: `tests/cli-contract.test.ts`, `tests/command-accuracy-fixtures.ts`, query/reindex/source tests, and full `npm test`.

## Role Inventory

An indexed document path is the project-relative file path stored in the SCIP `documents` table; it is a storage record whose distinctive role is to name code files that SCIP indexed while still needing project ignore-policy filtering before most analyses use it.

A document-path policy is the shared rule for selecting indexed document paths; it is a storage policy whose distinctive role is to combine SQL path exclusions, `.gitignore` filtering, scope narrowing, and ordering so callers do not repeat subtly different file sets.

A readiness report is the runtime-facing status of project dependencies; it is a diagnostic result whose distinctive role is to translate language/indexer/semantic availability into CLI text for `status` and `check-deps`.

A public type surface is an exported TypeScript type reachable from the package entry point; it is an API contract whose distinctive role is to let downstream code name shapes without depending on source-module internals.

Execution shapes observed:

- Query/read/report commands have already been compressed into descriptor-driven execution shapes by prior plans.
- Many analysis modules still follow "select document paths -> apply DB path policy -> apply ignore policy -> per-file operation."
- Runtime readiness follows "detect languages -> check indexer dependency -> check TypeScript semantic provider -> render status/check-deps."
- Vue augmentation follows "resolve options -> create language context -> compute references -> write mentions/cache"; most helper types are local to this subsystem and not exported by `src/index.ts`.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| O1 | Centralize indexed-document path iteration in `src/storage/scip-documents.ts`. | `rg "pathExclusionsFor\\('documents'\\)|FROM documents|SELECT relative_path"` found repeated document-path SQL in catalog, path resolver, source fileset, tsconfig discovery, imports/refs/drift/isolated, and redundant reexports. `scip-query extract-candidates` also flagged several functions whose isolated callee cluster is `db.all` plus `pathExclusionsFor` plus `isIgnored`. | merge |
| O2 | Use the central document path policy in the first high-value callers: path resolver, definition catalog, source fileset, tsconfig discovery, direct import counting, reference callers, drift, isolated, and files where behavior is preserved. | `scip-query change-surface src/storage/scip-documents.ts` reports 4 current direct consumers, so the center already exists but is underused. | merge |
| O3 | Make runtime readiness stop being the source of semantic-layer drift. | `scip-query drift --min-deviation 3` reported `src/runtime/project-readiness.ts` importing `src/semantic/typescript/status.ts`; `scip-query affected src:runtime:project-readiness:getProjectReadiness --max-depth 2` reaches only `handleCheckDeps` and `handleStatus`. | enforce |
| O4 | Move single-consumer local types out of `src/reindex/augment-vue-types.ts` when they are not shared protocol types. | `scip-query stale-abstractions` flags `AugmentVueResolvedOptions`, `VueReferenceComputationOptions`, `VueLanguageDependencies`, `DefinitionRangeLookup`, and `AugmentVueCache` as one-consumer types; `rg` shows the first, computation options, and cache are owned by `augment-vue.ts`, while dependency/range lookup are owned by `augment-vue-runtime.ts`. | inline |
| O5 | Move `RegisteredCommandDescriptor` into `command-registry.ts`. | `scip-query stale-abstractions` flags a 4 LOC one-consumer type; `rg` shows it is only used by `registerCommandDescriptors()`. | inline |
| O6 | Move `HealthBudget` into `health.ts`. | `scip-query stale-abstractions` flags one consumer; `rg` shows `HealthBudget` is only used in `src/queries/health.ts`. | inline |
| O7 | Move `DocumentPathCandidate` into `path-resolver.ts`. | `rg` shows it is only imported by `path-resolver.ts`; it is not part of the documented public API except through `domain/types.ts` export. | skip |
| O8 | Move `ScipSymbol` and `ScipLocalSymbol` into `symbol-parser.ts`. | `rg` shows only `symbol-parser.ts` consumes them internally, but `src/index.ts` exports all domain types, so external callers may rely on them as public symbol grammar types. | skip |
| O9 | Compress language parser import functions. | `similar-files` and `similar-signatures` show parser families share signatures and dependencies, but AST grammar differences are material and prior parser utilities already encode the safe shared mechanics. | skip |

## Deferred Register

No opportunity is deferred because of size. O7 and O8 are skipped, not deferred: their blockers are public API stability facts. O9 is skipped because the shared role is already captured by parser utilities and the differences are language grammar, not accidental mechanism duplication.

## Compression Clusters

Cluster A: Indexed Document Policy

- Thesis: project-wide analyses should use one indexed-document path mechanism because the repeated SQL/ignore sequence is one storage policy.
- Evidence: O1/O2, `src/storage/scip-documents.ts`, repeated `SELECT relative_path FROM documents`, and extraction candidates tied to `db.pathExclusionsFor` plus `db.isIgnored`.
- Old mechanisms: local SQL in path resolver, catalog, source fileset, tsconfig discovery, redundant-reexport importer counting, and selected graph/query modules.
- New mechanism: `indexedDocumentPaths()` owns SQL exclusions, optional scope/LIKE filters, extension filtering, ordering, and ignore filtering.
- Validation: typecheck, targeted query tests, CLI checks for `files`, `system`, `refs`, `drift`, `redundant-reexports`, `dead`, and `reindex`.

Cluster B: Readiness Layer Boundary

- Thesis: runtime should render readiness, while semantic provider status should be supplied through a boundary that does not require runtime to import the semantic layer directly.
- Evidence: drift finding for `src/runtime/project-readiness.ts`; only `status` and `check-deps` depend on `getProjectReadiness()`.
- Old mechanism: runtime project-readiness imports `getTypeScriptSemanticStatus()` directly.
- New mechanism: place project readiness in the reindex/readiness layer or pass semantic status as a small callback from the command handler.
- Validation: drift, `node dist/cli.js status`, `node dist/cli.js check-deps`, typecheck.

Cluster C: Local Type Ownership

- Thesis: types used by only one implementation module should live with that module unless they are an intentional public API surface.
- Evidence: stale-abstractions output and `rg` consumer map.
- Old mechanisms: `augment-vue-types.ts`, `health-types.ts`, and `command-descriptor-types.ts` own several shapes they do not use.
- New mechanism: move only non-public local types into their consumers; keep exported symbol grammar/domain types stable.
- Validation: typecheck and stale-abstractions.

## Dependency Order

1. Cluster A first, because it establishes the storage policy used by several later analyses and is independent of runtime readiness.
2. Cluster B next, because it has tiny blast radius and gives a clean drift baseline after source changes.
3. Cluster C last, because it changes type ownership and should be done after behavior-preserving policy changes so typecheck failures are localized.

## Touch Map

- Cluster A: `src/storage/scip-documents.ts`, `src/resolution/path-resolver.ts`, `src/symbols/definition-catalog.ts`, `src/source/source-fileset.ts`, `src/semantic/typescript/tsconfig-discovery.ts`, `src/queries/redundant-reexports.ts`, likely `src/symbols/reference-callers.ts`, `src/queries/drift.ts`, `src/queries/isolated.ts`, and `src/queries/files.ts` if behavior is preserved.
- Cluster B: `src/runtime/project-readiness.ts`, `src/runtime/command-handlers.ts`, possibly a new or moved readiness module under `src/reindex/`.
- Cluster C: `src/reindex/augment-vue-types.ts`, `src/reindex/augment-vue.ts`, `src/reindex/augment-vue-runtime.ts`, `src/queries/health-types.ts`, `src/queries/health.ts`, `src/runtime/command-descriptor-types.ts`, `src/runtime/command-registry.ts`.

## Validation Plan

Focused commands:

```bash
npm run typecheck
npm test -- tests/cli-contract.test.ts tests/command-accuracy-fixtures.ts tests/queries-advanced.test.ts tests/augment-sources.test.ts tests/typescript-semantic-provider.test.ts
npm run build
node dist/cli.js files src
node dist/cli.js system src/storage
node dist/cli.js refs ProjectIndex
node dist/cli.js drift --min-deviation 3
node dist/cli.js redundant-reexports
node dist/cli.js status
node dist/cli.js check-deps
node dist/cli.js stale-abstractions --min-loc 3 --limit 30
```

Final audit:

```bash
npm test
node dist/cli.js reindex --force --allow-partial
scip-query stats
scip-query health --json
scip-query drift --min-deviation 3
scip-query stale-abstractions --min-loc 3 --limit 30
scip-query similar --min-similarity 0.45 --limit 50
```

## Implementation Log

### Cluster A: Indexed Document Policy

Implemented in `src/storage/scip-documents.ts` and routed through:

- `src/resolution/path-resolver.ts`
- `src/symbols/definition-catalog.ts`
- `src/source/source-fileset.ts`
- `src/semantic/typescript/tsconfig-discovery.ts`
- `src/queries/files.ts`
- `src/queries/imports.ts`
- `src/queries/refs.ts`
- `src/queries/isolated.ts`
- `src/queries/drift.ts`
- `src/queries/redundant-reexports.ts`
- `src/symbols/reference-callers.ts`

The helper now owns optional scope, SQL `LIKE`, extension filtering, ordering, SQL path exclusions, and optional `.gitignore` filtering. Callers that only needed "allowed indexed document paths" no longer repeat local `SELECT relative_path FROM documents` loops.

### Cluster B: Readiness Layer Boundary

Moved project readiness from `src/runtime/project-readiness.ts` to `src/reindex/project-readiness.ts`. Runtime command handlers now render readiness while the reindex layer owns language detection, indexer dependency readiness, and TypeScript semantic readiness.

### Cluster C: Local Type Ownership

Moved these single-consumer implementation types into their owning modules:

- `RegisteredCommandDescriptor` into `src/runtime/command-registry.ts`.
- `HealthBudget` into `src/queries/health.ts`.
- Vue option/cache/computation/range/dependency implementation types into `src/reindex/augment-vue.ts` and `src/reindex/augment-vue-runtime.ts`.

Kept public SCIP/domain grammar types in `src/domain/symbol-types.ts` and added `ignore-stale` comments for the intentional public API surface.

## Verification Log

Source and build checks passed:

```bash
npm run typecheck
npm run lint
npm run build
npm test -- tests/cli-contract.test.ts tests/queries-advanced.test.ts tests/augment-sources.test.ts tests/typescript-semantic-provider.test.ts
npm test -- tests/cli-contract.test.ts tests/command-accuracy.test.ts
npm test
```

Full tests passed: 177 tests across 36 files.

Representative CLI checks passed against the freshly built local CLI:

```bash
node dist/cli.js files src
node dist/cli.js system src/storage
node dist/cli.js status
node dist/cli.js check-deps
node dist/cli.js refs ProjectIndex
node dist/cli.js drift --min-deviation 3
node dist/cli.js redundant-reexports
node dist/cli.js stale-abstractions --min-loc 3 --limit 30
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js passthrough-candidates
```

Fresh local SCIP index:

```text
Documents:   145
Symbols:     6430
Definitions: 5749
References:  14127
Index size:  4.2 MB
Last built:  2026-06-07 17:43:36
```

Local post-compression health from `node dist/cli.js health --json`:

```json
{
  "score": 100,
  "findings": {
    "deadSymbols": 0,
    "isolatedSymbols": 0,
    "cycles": 0,
    "similarPairs": 0,
    "extractionCandidates": 0,
    "wrappers": 0,
    "passthroughs": 0,
    "staleTypes": 0,
    "driftedFiles": 0,
    "complexityHotspotCount": 0
  }
}
```

Note: the shell `scip-query` command resolves to `/opt/homebrew/bin/scip-query`, so final post-edit audit commands used `node dist/cli.js` to verify the freshly built local source.

## Follow-Up Atlas: Mention Evidence Compression

This follow-up handles the next pressure points found after the third compression pass.

### Role Inventory

A reference mention is a SCIP `mentions` row whose role is not definition; it is compiler/indexer evidence that a symbol appears in a code chunk as a use rather than as its defining site. Its essential role is to connect a symbol id to the file and line range where it is used.

A definition mention is a SCIP `mentions` row whose role is definition; it is compiler/indexer evidence that a symbol is introduced in a code chunk. Its essential role is to provide a fallback definition range when `defn_enclosing_ranges` does not contain a precise row.

A mention evidence policy is the shared storage rule for reading mention rows through `mentions -> chunks -> documents`; it is a database evidence mechanism whose essential role is to apply role predicates, symbol filtering, SQL path exclusions, batching, deterministic ordering, and ignored-path filtering consistently before query modules interpret the rows.

### Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| M1 | Centralize reference mention counts and referenced-symbol id loading. | `src/queries/dead.ts` owns `loadMentionReferenceCounts`, `loadMentionReferenceCountsForSymbols`, `loadMentionReferenceCountBatch`, `loadMentionReferencedSymbolIds`, and `loadMentionReferencedSymbolIdBatch`; all repeat role `!= 1`, `mentions -> chunks -> documents`, SQL path exclusions, batching, and ignored/inactive path filtering. | merge |
| M2 | Centralize reference chunks and caller rows. | `src/symbols/reference-sites.ts:referenceChunksByFile()` and `src/symbols/reference-callers.ts:loadChunkMentionCallerRowsBatch()` both read role `!= 1` mention chunks with document paths and post-query ignored filtering. | merge |
| M3 | Centralize symbol definition row fallback shapes used by symbol lookup. | `src/symbols/symbol-lookup.ts` repeats primary `defn_enclosing_ranges` reads plus fallback role `= 1` mention aggregation for path-qualified, file-line, exact-symbol, symbol-id, and token lookup. | extract |
| M4 | Parser-family similarity. | `similar` still reports `parseDotNetImports()` and `parsePhpImports()` sharing AST/regex/import-resolution callees; `similar-files` reports language parser files sharing parser utility dependencies. The different grammar rules are the essential distinction. | skip |
| M5 | Cohesive local algorithms flagged by strict extraction probes. | `findExactSymbolMatch`, `Watcher.handleFileChange`, `compareFilteredChains`, Vue symbol lookup, Rust export parsing, stale-candidate scoring, and reindex runner orchestration are visible to detectors but each preserves a local decision order. | skip unless M1-M3 make one naturally smaller |

### Compression Clusters

Cluster D: Reference Mention Evidence

- Thesis: reference-count, referenced-symbol, reference-site, and caller-map readers are one storage evidence policy with different projections.
- New mechanism: `src/storage/scip-mentions.ts` owns batching and role `!= 1` mention/document reads, returning small row shapes that callers interpret.
- Old mechanisms: dead-code mention count batching, dead-code referenced-id batching, reference-site chunk reads, and reference-caller chunk reads.
- Validation: `dead`, `refs`, `trace`, `isolated`, `stale-abstractions`, `health`, full tests.

Cluster E: Symbol Definition Row Reads

- Thesis: symbol lookup should own ranking and hydration, but storage should own the repeated primary/fallback definition-row SQL shapes.
- New mechanism: targeted helpers near `SymbolQueryRow` that read primary definition rows and fallback definition-mention rows.
- Old mechanisms: repeated `global_symbols -> defn_enclosing_ranges -> documents` and fallback `global_symbols -> mentions -> chunks -> documents` SQL in `symbol-lookup.ts`.
- Validation: symbol parser/lookup/path resolver/query tests, `refs`, `code`, `trace`, `system`.

### Dependency Order

1. Implement Cluster D first because it removes repeated storage policy without touching user-facing symbol ranking.
2. Implement Cluster E only after Cluster D is stable; symbol lookup behavior is public and needs smaller, targeted movement.
3. Re-run strict detector probes and keep M4/M5 as skipped unless new evidence shows a real repeated policy rather than cohesive local algorithms.

## Follow-Up Implementation Log

Cluster D landed in `src/storage/scip-mentions.ts`. The new storage helper centralizes the reference-mention evidence policy: role `m.role != 1`, `mentions -> chunks -> documents`, SQL path exclusions, ignored-path filtering, symbol-id batching, deterministic ordering, and projection-specific row shapes. `src/queries/dead.ts`, `src/symbols/reference-sites.ts`, and `src/symbols/reference-callers.ts` now consume that helper instead of owning local batching SQL.

Cluster E landed in `src/storage/scip-rows.ts`. `definitionRangeRows()` owns primary definition-range reads, and `definitionMentionRows()` owns fallback role `m.role = 1` mention aggregation. `src/symbols/symbol-lookup.ts` now keeps the public lookup ranking, scoring, and hydration behavior local while delegating repeated definition-row SQL to storage.

Parser-family similarity remains intentionally unmerged. `parseDotNetImports()` and `parsePhpImports()` share utility callees, but the referents are different language grammars; the grammar-specific parsing rules are the essential distinction, so a merged abstraction would package unlike concepts behind shared mechanics.

Strict extraction candidates remain intentionally local after this pass. The remaining probe hits are cohesive decision procedures: watcher event handling, filtered-chain comparison, stale-candidate scoring, Vue symbol lookup, singleton-backed-class discovery, Rust export parsing, TypeScript tsconfig discovery, fresh-reindex orchestration, and `pathQualifiedCandidates()` ranking. `pathQualifiedCandidates()` is now smaller because storage owns row reads, but it still properly owns path-qualified ranking and tie-breaking.

## Follow-Up Verification Log

Commands run after implementation:

```bash
npm run typecheck
npm run lint
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js passthrough-candidates
node dist/cli.js stale-abstractions --min-loc 3 --limit 30
node dist/cli.js drift --min-deviation 3
node dist/cli.js similar --min-similarity 0.45 --limit 20
node dist/cli.js extract-candidates --min-loc 20 --min-callees 4 --limit 30
node dist/cli.js stats
```

Final verification state:

```text
typecheck: passed
lint: passed
tests: 177 passed across 36 files
health score: 100
health findings: all zero
wrapper candidates: none
passthrough candidates: none
stale abstractions: none
drift: none
documents: 146
symbols: 6454
definitions: 5773
references: 14120
index size: 4.2 MB
last built: 2026-06-07 20:07:31
```

The shell `scip-query` command resolved to `/opt/homebrew/bin/scip-query`, so the final audits used `node dist/cli.js` to verify the freshly built local source.

## Fourth Pass: Facade and Option Policy Compression

After the follow-up verification, two additional real compression opportunities remained below the health-detector threshold.

A Commander option object is the runtime object produced by the CLI parser for a command invocation; in this codebase it is a command-input record whose essential role is to carry parsed user flags from Commander into command handlers. The custom command handlers and query command handlers both decoded that same record, but `src/runtime/command-handlers.ts` carried a local option-helper family while `src/runtime/command-execution.ts` carried the descriptor-backed query-command helper family.

A compatibility facade is a module kept to preserve an older import surface after its responsibilities have moved elsewhere; in this codebase `src/symbols/reference-graph.ts` was a module-level alias whose essential role was to re-export file dependency, caller/callee, leaf-index, and reference-site evidence from their new concrete modules.

### Fourth-Pass Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| F1 | Merge custom command option decoding into the shared command-execution option policy. | `command-handlers.ts` had local `options`, `stringOption`, `numberOption`, `booleanOption`, and `stringArrayOption`; `command-execution.ts` already owned `commandOptions`, `stringOptionValue`, `numberOptionValue`, and `booleanOptionValue` for descriptor-backed query commands. | merge |
| F2 | Delete the `reference-graph.ts` compatibility facade. | The package root did not export `reference-graph.ts`; internal imports mapped directly to `file-dep-graph`, `call-graph-evidence`, `reference-sites`, and `leaf-symbol-index`; the facade was only preserving an old name. | delete |
| F3 | Preserve cache reset as an explicit role instead of a broad graph barrel. | `health-cache-control.ts` needed one reset point for file-dep, caller/callee, and leaf-index caches after health phases. | extract |

### Fourth-Pass Implementation Log

`src/runtime/command-execution.ts` now exports `commandOptions()` and `stringArrayOptionValue()`. `src/runtime/command-handlers.ts` uses the same option policy as query command handlers and no longer defines a local helper family.

`src/symbols/reference-graph.ts` was deleted. Internal consumers now import concrete evidence roles directly:

- file dependencies from `src/symbols/file-dep-graph.ts`
- caller/callee evidence from `src/symbols/call-graph-evidence.ts`
- resolved reference sites from `src/symbols/reference-sites.ts`
- global leaf lookup and AST call candidate policy from `src/symbols/leaf-symbol-index.ts`

`src/symbols/symbol-evidence-cache.ts` now coordinates cache resets for the concrete symbol evidence modules. `src/queries/health-cache-control.ts` calls that explicit reset hook instead of depending on a broad compatibility facade.

### Fourth-Pass Verification Log

Commands run after the fourth pass:

```bash
npm run typecheck
npm run lint
npm test -- tests/queries-advanced.test.ts tests/command-accuracy.test.ts tests/cli-contract.test.ts tests/watch.test.ts tests/queries.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js wrapper-candidates --max-loc 20
node dist/cli.js passthrough-candidates
node dist/cli.js stale-abstractions --min-loc 3 --limit 30
node dist/cli.js drift --min-deviation 3
node dist/cli.js similar --min-similarity 0.45 --limit 20
node dist/cli.js extract-candidates --min-loc 12 --min-callees 3 --limit 40
node dist/cli.js files reference-graph
node dist/cli.js stats
```

Final fourth-pass state:

```text
typecheck: passed
lint: passed
focused tests: 55 passed across 5 files
full tests: 177 passed across 36 files
build: passed
health score: 100
health findings: all zero
wrapper candidates: none
passthrough candidates: none
stale abstractions: none
drift: none
reference-graph indexed files: none
documents: 146
symbols: 6442
definitions: 5761
references: 14072
index size: 4.2 MB
last built: 2026-06-07 20:16:14
```

The lower-threshold extraction probe still reports cohesive local algorithms, now 17 candidates instead of 19. The parser-family similarity probe still reports `parseDotNetImports()` and `parsePhpImports()` at 47%; this remains skipped because the concrete referents are different language grammars, and the shared utility calls do not justify merging the parsers.
