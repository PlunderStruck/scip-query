# Reference-Site Evidence Compression Atlas

## Scope Map

This pass starts from the committed system-compression work and focuses on symbol reference-site evidence.

Relevant files:

- `src/symbols/reference-sites.ts`
- `src/symbols/identifier-attribution.ts`
- `src/queries/refs.ts`
- `src/queries/trace.ts`
- `src/queries/dataflow.ts`
- `src/queries/slice.ts`
- `src/semantic/typescript/workspace-packages.ts`
- `src/semantic/typescript/ts-morph-provider.ts`

## Role Inventory

A reference site is an indexed or source-derived observation that a symbol is used at a particular file and line, optionally with the smallest enclosing definition at that line. Its essential role is to locate symbol usage in source code so query modules can project it as references, trace rows, dataflow usage sites, or forward-slice consumers.

A reference-site evidence policy is the ordered rule for deciding which reference-site evidence source to trust. In this codebase, it means using source-text identifier attribution when it yields concrete sites, otherwise falling back to SCIP mention chunks refined to source lines, then excluding ignored files. Its essential role is to give all reference-oriented queries the same definition of “where this symbol is used.”

A package export index is a TypeScript semantic-provider cache mapping a workspace package name and exported leaf name to the symbol ids that package exposes. Its essential role is to support ts-morph package-import reference attribution inside `TsMorphSemanticProvider`; it is not a workspace package discovery concept.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| R1 | Centralize source-primary, SCIP-fallback reference-site selection. | `refs`, `trace`, `dataflow`, and forward `slice` each call `getSourceReferenceSites()`, check length, fall back to `getResolvedReferenceSites()`, and filter ignored files. | extract |
| R2 | Move `PackageExportIndex` to its only consumer. | `stale-abstractions --include-low-confidence` reports `PackageExportIndex`; `refs` shows all uses in `ts-morph-provider.ts`. | inline |
| R3 | Keep wrapper candidates that preserve real ownership. | `hydrateSymbolMatch()` belongs with definition range correction, `definitionMentionRows()` pairs with `definitionRangeRows()`, `extractCallLeaf()` is AST target normalization, and `resolveVueDefinitionSymbolId()` is Vue definition resolution. | skip |
| R4 | Keep parser-family similarity skipped. | `parseDotNetImports()` and `parsePhpImports()` still share parser utilities but represent different language grammars. | skip |

## Compression Clusters

Cluster A: Reference-Site Evidence Policy

- New mechanism: a `referenceSitesForSymbol()` helper in `src/symbols/reference-sites.ts`.
- Old mechanisms: repeated source-primary/fallback/filter logic in `refs`, `trace`, `dataflow`, and `slice`.
- Validation: `queries-advanced`, `command-accuracy`, `source-backed-accuracy`, `definition-fallback`, `queries`, plus full tests.

Cluster B: Type Locality

- New mechanism: local `PackageExportIndex` type in `src/semantic/typescript/ts-morph-provider.ts`.
- Old mechanism: exported one-consumer type in `workspace-packages.ts`.
- Validation: `stale-abstractions --include-low-confidence`, `typescript-semantic-provider`, typecheck.

## Dependency Order

1. Extract Cluster A first; query modules should be smaller before the final stale/wrapper probes.
2. Inline Cluster B after Cluster A because it is independent and low risk.
3. Re-run detector probes and update this atlas with final dispositions.

## Implementation Log

Cluster A landed in `src/symbols/reference-sites.ts` as `referenceSitesForSymbol()`. The helper owns the source-primary, SCIP-fallback reference-site evidence policy and default ignored-file filtering. `refs`, `trace`, `dataflow`, and forward `slice` now project the returned sites into their own result shapes instead of repeating the evidence selection rule.

The old internal aliases `getSourceReferenceSites` and `buildSourceFallbackCallerFiles` were removed. Internal callers now import the real functions, `findReferences()` and `findCallerFiles()`, from `src/symbols/identifier-attribution.ts`.

Cluster B landed in `src/semantic/typescript/ts-morph-provider.ts`. `PackageExportIndex` is now local to its only consumer, and `src/semantic/typescript/workspace-packages.ts` keeps only workspace package discovery concepts.

`getResolvedReferenceSites()` remains intentionally named and marked as a wrapper exception. It is the SCIP-only fallback primitive used by both `referenceSitesForSymbol()` and targeted caller rows; inlining it would collapse distinct evidence modes.

## Verification Log

Commands run:

```bash
npm run typecheck
npm test -- tests/queries-advanced.test.ts tests/source-backed-accuracy.test.ts tests/definition-fallback.test.ts tests/typescript-semantic-provider.test.ts
npm run lint
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js wrapper-candidates --max-loc 30
node dist/cli.js passthrough-candidates --max-loc 30
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80
node dist/cli.js drift --min-deviation 3
node dist/cli.js extract-candidates --min-loc 8 --min-callees 3 --limit 100
node dist/cli.js similar-files --limit 40
node dist/cli.js stats
```

Final state:

```text
typecheck: passed
lint: passed
focused tests: 17 passed across 4 files
full tests: 177 passed across 36 files
build: passed
health score: 100
health findings: all zero
passthrough candidates: none
stale abstractions: none
drift: none
documents: 146
symbols: 6449
index size: 4.2 MB
```

Remaining low-threshold wrapper candidates are kept with existing dispositions: `hydrateSymbolMatch()` owns AST-corrected hydration in the definition catalog, `definitionMentionRows()` is paired with `definitionRangeRows()`, `extractCallLeaf()` is AST target normalization, and `resolveVueDefinitionSymbolId()` is Vue-specific definition resolution.
