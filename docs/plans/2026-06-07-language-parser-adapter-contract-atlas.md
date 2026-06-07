# Language Parser Adapter Contract Atlas

Date: 2026-06-07
Scope: parser registry and per-language adapter contract.

## Scope Map

- `src/language-parsers/types.ts`
- `src/language-parsers/registry.ts`
- `src/language-parsers/index.ts`
- `src/language-parsers/javascript.ts`
- `docs/plans/2026-06-07-primogen-disgust-register.md`

## Role Inventory

A language parser adapter is the parser-registry entry for one source-language family. Its essential role is to translate a source file into import/export evidence while hiding AST availability, regex fallback, extension ownership, and language-specific syntax.

A parser capability is a declared source-fact operation an adapter can perform, such as imports, source exports, or JavaScript-style re-exports. Its essential role is to make the registry seam describe what callers can ask for without reaching into a language-specific module.

A fallback mode is the adapter's evidence strategy when AST parsing is unavailable. Its essential role is to tell maintainers whether the adapter is AST-primary, regex-only, or a multi-AST dispatcher.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| P1 | Add adapter capability/fallback metadata to `LanguageParser`. | The registry already exists, but the contract does not name AST-vs-regex strategy or optional surfaces. | enforce |
| P2 | Route JavaScript/TypeScript re-export parsing through the registry. | `getReExports()` imports `parseReExports` directly from `javascript.ts`, bypassing the adapter seam used by imports/exports. | merge |
| P3 | Add a re-export cache alongside import/export caches. | Re-export parsing reads source and AST like other parser operations, but currently has no barrel-level cache. | extract |

## Compression Cluster

Cluster A: Parser Adapter Contract

- Old mechanism: registry exposes only parse functions while comments describe fallback behavior.
- New mechanism: registry entries declare capabilities and fallback modes, and all parser surfaces dispatch through the registry.
- Behavior preserved: same parser implementations and extension ownership; only the dispatch seam changes.

## Implementation Log

- Added `ParserFallbackMode` and `LanguageParserCapabilities` to the adapter contract.
- Required every registry entry to declare supported source facts and fallback mode.
- Moved JavaScript/TypeScript re-export parsing behind `LanguageParser.parseReExports`.
- Added `SOURCE_REEXPORT_CACHE` to match import/export parsing cache ownership.
- Preserved JavaScript AST-first parsing and regex fallback behavior.

## Validation Plan

```bash
npm run typecheck
npm test -- tests/import-fallbacks.test.ts tests/redundant-reexports-fallback.test.ts tests/drift-accuracy.test.ts
npm test
npm run build
node dist/cli.js drift --min-deviation 3
node dist/cli.js redundant-reexports
node dist/cli.js health --json
```

## Verification Log

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test` passed: 36 files, 177 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js health --json` reported score 100 and zero findings.
- `node dist/cli.js drift --min-deviation 3` reported no drift.
- `node dist/cli.js redundant-reexports` reported no redundant re-exports.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` reported no stale abstractions.
