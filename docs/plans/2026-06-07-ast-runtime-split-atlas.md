# AST Runtime Split Atlas

Date: 2026-06-07
Scope: `src/source/ast.ts` facade and internal AST runtime modules.

## Scope Map

- `src/source/ast.ts`
- `src/source/ast-language.ts`
- `src/source/ast-runtime.ts`
- `src/source/ast-types.ts`
- `docs/plans/2026-06-07-primogen-disgust-register.md`

## Role Inventory

An AST facade is the source module callers use to ask for parsed syntax facts. Its essential role is to preserve a stable public import path while hiding parser loading, language selection, source parsing, query compilation, and AST-derived facts.

A parser runtime is the tree-sitter loading mechanism: optional native binding resolution, grammar loading, parser pooling, and chunked parsing. Its essential role is to turn a language and source string into a tree while making missing native dependencies a fast, cacheable fallback condition.

A language catalog is the extension-to-AST-language map. Its essential role is to decide whether a file can use AST-backed source evidence without also knowing parser loading or query execution.

An AST structural type module is the shared type description for tree-sitter trees, syntax nodes, and compiled queries. Its essential role is to let runtime and facade modules share structural contracts without importing each other.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| A1 | Move tree-sitter optional binding and grammar loading out of `ast.ts`. | `ast.ts` owned `createRequire`, parser constructor caching, grammar cache, failed-language cache, and parser pool before any AST facts appeared. | extract |
| A2 | Move extension/language detection out of `ast.ts`. | `LANGUAGE_BY_EXT`, `detectAstLanguage`, and `isVueSfcPath` are parser catalog policy, not AST fact extraction. | extract |
| A3 | Move tree/query structural interfaces out of `ast.ts`. | Runtime code and facade code both need `Tree`, `SyntaxNode`, and `QueryInstance`; keeping them in the facade would create a cycle after extracting runtime. | extract |
| A4 | Keep the public `src/source/ast.ts` import surface stable. | More than twenty modules import AST helpers and types through `./ast.js`. | enforce |
| A5 | Defer Vue script extraction and AST fact extraction splits. | This first slice creates parser/language seams; moving Vue/fact logic next is safer after the runtime split has a clean verification pass. | defer |

## Compression Cluster

Cluster A: AST Runtime And Language Catalog

- Old mechanism: one 651-line `ast.ts` owned optional dependency loading, language detection, parser pooling, Vue script parsing, query compilation, cached AST walks, callable/callsite facts, type-container facts, and call leaf normalization.
- New mechanism: `ast.ts` remains the public AST facade, while `ast-runtime.ts` owns parser loading/pooling/parsing, `ast-language.ts` owns extension language detection, and `ast-types.ts` owns structural tree/query types.
- Behavior preserved: all current consumers still import from `src/source/ast.ts`; no query modules or language parsers changed their import paths.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/ast-parser-fallback.test.ts tests/source-backed-accuracy.test.ts tests/import-fallbacks.test.ts tests/command-accuracy.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80
node dist/cli.js symbols src/source/ast.ts
node dist/cli.js deps src/source/ast.ts
```

## Verification Log

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test -- tests/ast-parser-fallback.test.ts tests/source-backed-accuracy.test.ts tests/import-fallbacks.test.ts tests/command-accuracy.test.ts` passed: 4 files, 28 tests.
- `npm test` passed: 36 files, 177 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js health --json` reported score 100 and zero findings.
- `node dist/cli.js drift --min-deviation 3` reported no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` reported no stale abstractions.
- `node dist/cli.js wrapper-candidates --max-loc 40` returned the same pre-existing six candidates after suppressing the intentional `compileQuery` runtime facade.
- `node dist/cli.js symbols src/source/ast.ts` shows `ast.ts` at 456 indexed lines, down from 651 source lines before the split.
- `node dist/cli.js deps src/source/ast.ts` shows the facade now depends on `ast-language.ts`, `ast-runtime.ts`, and `ast-types.ts`.
