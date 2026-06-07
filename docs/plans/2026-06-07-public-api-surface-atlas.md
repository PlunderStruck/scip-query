# Public API Surface Atlas

Date: 2026-06-07
Scope: package root exports and package subpath exports.

## Scope Map

- `src/index.ts`
- `src/queries/index.ts`
- `src/reindex/index.ts`
- `src/runtime/index.ts`
- `package.json`
- `tsup.config.ts`
- `docs/plans/2026-06-07-primogen-disgust-register.md`

## Role Inventory

A public API surface is the package code a downstream program can import without reaching into unexported files. Its essential role is to define which names must remain stable across releases because outside code can depend on them.

An API tier is a named group of public imports with the same stability expectation and purpose. Its essential role is to make package consumers choose the smallest surface they need instead of importing everything from the root.

A root export is the default package entry point `scip-query`. Its essential role is to preserve existing library imports while the package grows explicit subpaths.

A subpath export is a package export such as `scip-query/queries`, `scip-query/reindex`, or `scip-query/runtime`. Its essential role is to expose one coherent capability family without making the root package a permanent grab bag.

## Tier Inventory

| Tier | Import path | Status | Contents |
| --- | --- | --- | --- |
| Root library essentials | `scip-query` | stable compatibility surface | `ScipDatabase`, `ProjectIndex`, parser helpers, reindex/runtime utilities, all query functions, domain types |
| Query API | `scip-query/queries`, `scip-query/queries/*` | stable | query functions and query result types |
| Reindex API | `scip-query/reindex` | provisional explicit subpath | indexing, auxiliary-source augmentation, Vue augmentation, merge, indexer install/readiness helpers |
| Runtime API | `scip-query/runtime` | provisional explicit subpath | project config, watcher, skill installer, SCIP CLI availability helpers |
| Internal implementation | no package export | internal | source, symbols, storage, runtime command internals, language parsers, semantic providers, analysis helpers |

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| A1 | Add explicit reindex subpath export. | `src/index.ts` exports many reindex utilities from root, but `package.json` has no `./reindex` entry. | enforce |
| A2 | Add explicit runtime subpath export. | `src/index.ts` exports config, watcher, setup, and SCIP CLI helpers from root, but `package.json` has no runtime tier. | enforce |
| A3 | Keep the root export stable in this slice. | Removing root exports would be a breaking package change with no downstream usage inventory. | keep |
| A4 | Keep query subpaths unchanged. | `package.json` already exposes `./queries` and `./queries/*`; query exports are already a named tier. | keep |
| A5 | Defer root export removals until a semver-major API cleanup. | The current version exports all domain types and utilities from root. Removing them requires release planning. | defer |

## Compression Cluster

Cluster A: API Tiers

- Old mechanism: the root package export acted as the only non-query public surface.
- New mechanism: package exports now include `scip-query/reindex` and `scip-query/runtime`, with build entries that emit matching JS and type declarations.
- Behavior preserved: root imports still work; query subpaths still work.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/cli-contract.test.ts
npm test
npm run build
test -f dist/reindex.js
test -f dist/reindex.d.ts
test -f dist/runtime.js
test -f dist/runtime.d.ts
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
```

## Verification Log

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test -- tests/cli-contract.test.ts` passed: 1 file, 6 tests.
- `npm test` passed: 36 files, 177 tests.
- `npm run build` passed and emitted `dist/reindex.js`, `dist/reindex.d.ts`, `dist/runtime.js`, and `dist/runtime.d.ts`.
- `node --input-type=module -e "const r = await import('scip-query/reindex'); const t = await import('scip-query/runtime'); if (typeof r.reindex !== 'function') throw new Error('missing reindex'); if (typeof t.loadProjectConfig !== 'function') throw new Error('missing runtime config');"` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js health --json` reported score 100 and zero findings.
- `node dist/cli.js drift --min-deviation 3` reported no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` reported no stale abstractions.
