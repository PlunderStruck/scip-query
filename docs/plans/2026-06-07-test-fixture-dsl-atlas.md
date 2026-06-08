# Test Fixture DSL Atlas

Date: 2026-06-07
Scope: evidence fixture setup in fallback tests.

## Scope Map

- `tests/evidence-fixture.ts`
- `tests/import-fallbacks.test.ts`
- `tests/redundant-reexports-fallback.test.ts`
- `docs/plans/2026-06-07-primogen-disgust-register.md`

## Role Inventory

An evidence fixture DSL is a test helper that creates SCIP-like project evidence using domain operations such as documents, symbols, definition ranges, chunks, mentions, and source files. Its essential role is to let tests describe the evidence contract they need without restating SQLite schema and raw insertion mechanics.

A fixture document is a test database record representing one indexed source file. Its essential role is to give query code a real file referent with language and project-relative path.

A fixture symbol is a test database record representing one indexed definition or reference target. Its essential role is to let tests name code entities the same way SCIP-backed queries see them.

A fixture definition range is a test database record connecting a symbol to its source range. Its essential role is to make symbol lookup and query projection behave as though an indexer emitted definition evidence.

## Opportunity Ledger

| ID | Opportunity | Evidence | Disposition |
| --- | --- | --- | --- |
| T1 | Centralize the minimal SCIP SQLite schema used by hand-built tests. | `import-fallbacks` and `redundant-reexports-fallback` each declared their own schema. | extract |
| T2 | Replace raw `INSERT INTO` blocks with document/symbol/definition operations. | Both fallback tests only need documents, symbols, and definition ranges, but encoded that as SQL strings. | enforce |
| T3 | Centralize source-file writing for small fixture projects. | Both fallback tests manually created directories and wrote source files. | extract |
| T4 | Move large fixture suites onto the shared SCIP-like schema while keeping their domain rows local. | `command-accuracy-fixtures`, `stale-abstractions-accuracy`, and semantic-provider tests still need hand-built evidence rows, but not hand-built schema. | extract - landed |

## Compression Cluster

Cluster A: Evidence Fixture Contract

- Old mechanism: each fallback test owned schema creation, file writing, and SQL insertion.
- New mechanism: `tests/evidence-fixture.ts` owns the schema and exposes `writeFixtureFiles()` plus a chainable `evidenceFixtureDb()` builder.
- Large fixture suites now call `createEvidenceSchema()` for the shared database
  shape while keeping their command- or semantic-specific rows local.
- Behavior preserved: fallback tests still create the same project files and database rows, then query through `ScipDatabase`.

## Validation Plan

```bash
npm run typecheck
npm run lint
npm test -- tests/import-fallbacks.test.ts tests/redundant-reexports-fallback.test.ts
npm test
npm run build
node dist/cli.js reindex --force --allow-partial
node dist/cli.js health --json
node dist/cli.js drift --min-deviation 3
node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80
```

## Verification Log

- `npm run typecheck` passed.
- `npm run lint` passed.
- `npm test -- tests/import-fallbacks.test.ts tests/redundant-reexports-fallback.test.ts` passed: 2 files, 3 tests.
- `npm test` passed: 36 files, 177 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js health --json` reported score 100 and zero findings.
- `node dist/cli.js drift --min-deviation 3` reported no drift.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 80` reported no stale abstractions.
- `rg -n "function createSchema|INSERT INTO documents|new Database\\(join\\(tempDir, 'index.db'\\)" tests/import-fallbacks.test.ts tests/redundant-reexports-fallback.test.ts tests/evidence-fixture.ts` shows document insertion only in the shared fixture helper.

## 2026-06-07 Deferred-Task Closure Verification

- `createEvidenceSchema()` now serves fallback, command-accuracy, stale-abstraction, and TypeScript semantic-provider fixtures.
- `npm run lint` passed.
- `npm run typecheck` passed.
- `npm test` passed: 38 files, 185 tests.
- `npm run build` passed.
- `node dist/cli.js reindex --force --allow-partial` passed.
- `node dist/cli.js stale-abstractions --include-low-confidence --min-loc 1 --limit 120` reported no stale abstractions.
