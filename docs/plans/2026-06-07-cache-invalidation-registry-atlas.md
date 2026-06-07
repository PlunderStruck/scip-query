# Cache Invalidation Registry Compression Atlas

Date: 2026-06-07
Scope: cache invalidation calls in `src/queries/health.ts`, `src/queries/dead.ts`, source caches, parser caches, semantic caches, and symbol-evidence caches.

A cache invalidation registry is a table of cache owners and the scopes at which their stored facts can be discarded. Its real-world referents are source text, stripped source, AST trees, language-parser imports/exports, identifier indexes, semantic providers, definition catalogs, and symbol evidence; its defining characteristic is that callers ask to clear a kind of evidence at a scope instead of remembering every concrete cache object.

An invalidation scope is the boundary within which cached facts are no longer needed. Its real-world referents here are a whole SCIP database and one relative source file; its defining characteristic is that it tells a cache owner whether to drop all facts for a project index or only the facts attached to a file path.

## Scope Map

- Whole-project invalidation: `clearWholeProjectEvidenceCaches()` in `src/queries/internal/cache-invalidation.ts`.
- File-scoped invalidation: dead-code candidate iteration and source scanning in `src/queries/dead.ts`.
- Cache owners: `src/language-parsers/index.ts`, `src/semantic/provider-cache.ts`, `src/source/ast.ts`, `src/source/source-stripper.ts`, `src/source/source-text.ts`, `src/symbols/definition-catalog.ts`, `src/symbols/identifier-index.ts`, and `src/symbols/symbol-evidence-cache.ts`.

## Role Inventory

- Registry role: declare the cache kind and the scopes each cache supports.
- Whole-project policy: clear source, AST, parser, identifier, symbol-evidence, and optionally semantic-provider caches after health phases.
- File-source policy: clear file-scoped source, AST, parser, identifier, and stripped-source caches after source-backed scans.
- Definition policy: optionally clear file-scoped definition catalog facts when a scan just consumed definition rows for that file.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| C1 | Move whole-project health cache fan-out behind one evidence-cache policy. | `health-cache-control.ts` directly imported seven cache clear functions before the registry. | extract |
| C2 | Move dead-code file cache fan-out behind one file-scoped policy. | `dead.ts` imported five file cache hooks and also separately cleared definition cache in the same `finally` block. | extract |
| C3 | Keep concrete cache hooks in their owning modules. | `source-text`, `ast`, parser, identifier, semantic, and symbol modules still own their internal cache objects. | keep |
| C4 | Do not fold `clearStaleAbstractionsCaches()` into the evidence registry. | That cache stores one query's derived result shape, not reusable source/evidence facts. | skip |

## Dependency Order

1. Add `src/queries/internal/cache-invalidation.ts` with cache kinds and database/file scopes.
2. Move health cache cleanup to `clearWholeProjectEvidenceCaches()`.
3. Move dead-code source cleanup to `clearSourceFileEvidenceCaches()`.
4. Keep local cache owner APIs intact so existing modules retain ownership of their storage.

## Touch Map

- `src/queries/internal/cache-invalidation.ts`: new registry and policies.
- `src/queries/health.ts`: whole-project cache policy call.
- `src/queries/dead.ts`: file-scoped cache policy call.
- `docs/plans/2026-06-07-primogen-disgust-register.md`: completion note.
- `docs/plans/2026-06-07-cache-invalidation-registry-atlas.md`: this ledger.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/debloat-health.test.ts tests/stale-abstractions-accuracy.test.ts tests/command-accuracy.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120
node dist/cli.js wrapper-candidates --max-loc 40 --limit 80
```

Validation result:

- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm test -- tests/debloat-health.test.ts tests/stale-abstractions-accuracy.test.ts tests/command-accuracy.test.ts`: passed, 32 tests.
- `npm test`: passed, 36 files and 177 tests.
- `npm run build`: passed; no standalone public `queries/cache-invalidation` entry was emitted.
- `node dist/cli.js reindex --force --allow-partial`: passed.
- `node dist/cli.js health --json`: score 100, zero findings.
- `node dist/cli.js drift --min-deviation 3`: no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120`: no stale abstractions.
- `node dist/cli.js passthrough-candidates --max-loc 40 --limit 80`: no passthrough candidates.
- `node dist/cli.js wrapper-candidates --max-loc 40 --limit 80`: no cache-registry wrappers; 4 pre-existing evidence/AST boundary candidates remain.

## Compression Audit

The registry removes a maintenance rule from query modules: a detector no longer needs to remember the full source-backed cache stack. It also preserves local ownership: each cache still exposes its own clear hook, but composite invalidation now lives in one table keyed by evidence kind and invalidation scope. `health-cache-control.ts` now keeps only garbage-collection headroom behavior, not cache policy.
