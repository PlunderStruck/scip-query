# Language Import Pipeline Compression Atlas

Date: 2026-06-07
Scope: `src/language-parsers/*` import parsing and fallback behavior.

This atlas covers the next parser-adapter compression pass. The target is the repeated path from source text or AST nodes to `ParsedSourceImport` rows, while preserving grammar-specific parsing where the syntax is genuinely different.

## Scope Map

- Parser contract and registry: `src/language-parsers/types.ts`, `src/language-parsers/registry.ts`.
- Shared parser helpers: `src/language-parsers/utils.ts`.
- Import-only adapters: `c-like.ts`, `ruby.ts`, `python.ts`, `jvm.ts`, `dotnet.ts`, `php.ts`.
- Mixed import/export adapters: `javascript.ts`, `rust.ts`, `dart.ts`.
- Consumers and tests: `src/language-parsers/index.ts`, import fallback tests, source-backed accuracy tests, Python accuracy tests, command accuracy tests.

## Role Inventory

- AST/fallback runner: tries grammar-backed parsing when a tree exists, then falls back to source-text parsing.
- AST dispatch runner: chooses a parser by detected AST language, then falls back to regex when no matching tree/parser is available.
- Used-name collector: computes identifiers outside import declarations to decide whether an import is used.
- Import emitter: converts imported name, local name, resolved source path, kind, and usage facts into `ParsedSourceImport`.
- Regex import line parser: masks import statements from source before checking local-name usage.
- Grammar-specific extractor: reads concrete syntax such as `#include`, `require_relative`, `use Ns\Foo`, `import foo.Bar`, `using Alias = Target`, or `from x import y`.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| IP-1 | Name the repeated import-emission shape. | C-like, Ruby, PHP, Rust, JVM, and .NET all manually assemble `ParsedSourceImport` rows from `importedName`, `localName`, `sourcePath`, `kind`, `used`, and `usedMembers`. | extract |
| IP-2 | Replace ad hoc AST dispatch in JVM/.NET with a shared dispatcher. | `jvm.ts` and `dotnet.ts` both call `getAst`, `detectAstLanguage`, branch by language, then run regex fallback. | extract |
| IP-3 | Extend `parseWithAstFallback` to PHP/Rust where equivalent. | PHP and Rust hand-roll `getAst` + fallback; `parseWithAstFallback` already exists and fits import parsing. | merge |
| IP-4 | Keep grammar-specific AST walkers separate. | Similarity output shows shared dependencies, but Java/Kotlin/Scala/C#/VB/PHP/Rust AST nodes and alias/wildcard semantics differ. | skip |
| IP-5 | Bring JavaScript onto the shared import emitters after its parser split. | The later JavaScript parser split moved imports to `javascript-imports.ts`, leaving the import-entry construction isolated enough to share helpers without touching re-export or Vue non-script facts. | merge - landed |
| IP-6 | Keep Dart regex-only parser separate. | Dart has regex-only imports/exports and no AST fallback, so forcing it into the AST pipeline would add concept count. | skip |

## Deferred Register

No remaining import-pipeline deferrals. JavaScript still owns its grammar-specific
AST and regex parsing, but `javascript-imports.ts` now uses the shared
`ParsedSourceImport` emitters for side-effect, default, named, and namespace
imports while preserving type-only and `usedMembers` facts.

## Compression Clusters

- Cluster A: import emission helpers. Root cause: parser files repeatedly build the same `ParsedSourceImport` object after grammar-specific extraction.
- Cluster B: AST dispatch fallback helper. Root cause: multi-grammar adapters repeat `getAst` + `detectAstLanguage` + branch + regex fallback.
- Cluster C: existing fallback helper adoption. Root cause: PHP and Rust have the same AST/fallback shape already represented by `parseWithAstFallback`.

## Dependency Order

1. Add import emission helpers in `utils.ts`, then migrate C-like/Ruby/PHP/Rust/JVM/.NET call sites.
2. Add AST dispatch fallback helper in `utils.ts`, then migrate JVM and .NET entrypoints.
3. Adopt `parseWithAstFallback` in PHP and Rust where the existing helper exactly preserves behavior.
4. Run parser-focused tests and inspect health/wrapper/stale fallout before broader verification.

## Touch Map

- `src/language-parsers/utils.ts`: new shared helpers.
- `src/language-parsers/c-like.ts`, `ruby.ts`, `php.ts`, `rust.ts`, `jvm.ts`, `dotnet.ts`: helper adoption.
- `docs/plans/2026-06-07-primogen-disgust-register.md`: record the parser pass.

## Implemented Shape

- `buildNamedImport()`, `buildUsedImport()`, `buildSideEffectImport()`, and `buildNamespaceImport()` now name the common import-entry construction.
- JavaScript import parsing now uses those same emitters after grammar-specific
  extraction, preserving its richer type-only and namespace-member facts.
- `parseWithAstLanguageDispatch()` now owns multi-grammar AST parser selection and fallback for JVM and .NET.
- PHP and Rust import entrypoints now reuse `parseWithAstFallback()` instead of locally repeating the AST-or-regex choice.
- Grammar-specific syntax extraction remains in each adapter; the shared helpers start only after the adapter has identified the import facts.
- JavaScript and Dart are explicit boundaries for this pass: JavaScript needs its own atlas, and Dart is too small and regex-only to benefit from this pipeline.

## Validation Plan

- Focused: `npm test -- tests/import-fallbacks.test.ts tests/source-backed-accuracy.test.ts tests/python-accuracy.test.ts tests/command-accuracy.test.ts tests/symbol-parser.test.ts`.
- Static: `npm run typecheck`, `npm run lint`.
- Full: `npm test`, `npm run build`, `node dist/cli.js reindex`.
- Structural: `node dist/cli.js health --json`, `node dist/cli.js drift --min-deviation 3`, `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120`, `node dist/cli.js wrapper-candidates --max-loc 15 --limit 40`, `node dist/cli.js passthrough-candidates --max-loc 15 --limit 40`, `node dist/cli.js similar-files --min-similarity 0.5 --limit 80 --scope src/language-parsers`.

## 2026-06-07 Deferred-Task Closure Verification

- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm test` passed: 38 files, 185 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120` reported no stale abstractions.
- `node dist/cli.js drift --min-deviation 3` reported no drift.
- JavaScript import parsing is now on the shared emitters while keeping grammar-specific parsing local to `javascript-imports.ts`.
