# SQLite Statement Cache Plan

Date: 2026-06-28

## Goal

Make all SQLite-backed commands faster without changing query results. Done means
`ScipDatabase.all()` and `ScipDatabase.get()` reuse prepared statements for the
same SQL text within one database connection, preserving every existing caller's
observable rows while reducing repeated prepare work seen in the Vega_2.0
`dead --json --full` profile.

## Current State

- `ScipDatabase` is the readonly SQLite connection wrapper for the converted
  SCIP schema. It owns the connection, pragmas, path/symbol SQL fragments,
  `all()`, `get()`, and `close()`. Source:
  `scip-query code ScipDatabase -C 30`.
- `ScipDatabase.all()` currently calls `this.db.prepare(sql).all(...params)` on
  every invocation. Source: `scip-query code ScipDatabase.all -C 20`.
- `ScipDatabase.get()` currently calls `this.db.prepare(sql).get(...params)` on
  every invocation. Source: `scip-query code ScipDatabase.get -C 20`.
- The storage change surface is high because `ScipDatabase` has 130 external
  consumers, `all()` has 21 external consumers, and `get()` has 13 external
  consumers. Source: `scip-query change-surface src/storage/db.ts --json --full`.
- `ScipDatabase.all()` is referenced by 36 call sites across storage, symbols,
  navigation, graph, impact, and cleanup modules. Source:
  `scip-query refs 'ScipDatabase#all' --json`.
- `ScipDatabase.get()` is referenced by 20 call sites across analysis, symbols,
  stats, navigation, graph, impact, cleanup, quality, and code modules. Source:
  `scip-query refs 'ScipDatabase#get' --json`.

## Reuse Audit

- `ScipDatabase.all()` and `ScipDatabase.get()` are near-duplicates today; the
  shared work is preparing a SQL statement from text before running it. Source:
  `scip-query similar 'ScipDatabase#all' --json --full`.
- Existing per-db caches in `src/storage/per-db-cache.ts` are for derived
  analysis values and register with cache invalidation groups. A prepared
  statement cache is connection-owned state that should close with
  `ScipDatabase`, not semantic evidence; therefore it belongs as a private
  field on `ScipDatabase`. Source: `scip-query code createPerDbCache -C 30`.
- No new public storage API is needed. The existing public API remains `all()`,
  `get()`, and `close()`. Source: `scip-query surface src/storage --json`.

## Design Phases

### 1.1 — Add a private statement lookup

- [x] **File**: `src/storage/db.ts:37-53`
- **Source**: `scip-query code ScipDatabase -C 30`
- **What**: `ScipDatabase` stores the readonly better-sqlite3 connection and
  has no per-SQL statement state.
- **Change**: Add `private statementCache = new Map<string, Database.Statement>();`
  and a private `statement(sql: string): Database.Statement` helper that returns
  the cached statement or prepares/stores it once.
- **Why**: Reusing prepared statements removes repeated prepare work while
  keeping parameter binding per call.

### 1.2 — Route `all()` and `get()` through the cache

- [x] **File**: `src/storage/db.ts:122-129`
- **Source**: `scip-query code ScipDatabase.all -C 20`;
  `scip-query code ScipDatabase.get -C 20`
- **What**: Both methods prepare the same SQL text every time a caller invokes
  them.
- **Change**: Replace `this.db.prepare(sql)` with `this.statement(sql)` in both
  methods.
- **Why**: This preserves method signatures and result types while reducing
  repeated work across all command paths.

### 1.3 — Clear cached statements on close

- [x] **File**: `src/storage/db.ts:131-133`
- **Source**: `scip-query code ScipDatabase -C 30`
- **What**: `close()` closes the database connection only.
- **Change**: Clear `statementCache` before closing the database connection.
- **Why**: The cache is connection-owned state; clearing it makes the ownership
  boundary explicit and avoids retaining statement references after close.

### 1.4 — Verify storage behavior and performance

- [x] **File**: `tests/storage/db-path-exclusions.test.ts`
- **Source**: `scip-query change-surface src/storage/db.ts --json --full`
- **What**: Existing tests exercise `ScipDatabase` query behavior through real
  fixture databases.
- **Change**: Reuse existing storage/query tests rather than adding a test for
  private cache internals; verify by running storage, command accuracy, and full
  test suites plus Vega hash benchmarks.
- **Why**: The observable contract is unchanged row data from `all()`/`get()`,
  not cache size.

## Stress-Test Findings

- **Understand before touching**: The wrapper centralizes readonly access,
  pragmas, and SQL fragments. The cache must stay private to this connection.
- **Blast radius**: High, because almost every query can call `all()` or `get()`;
  verification must include full tests and scip gates.
- **Intermediate validity**: One atomic code change keeps all existing method
  signatures intact.
- **Reversibility**: Two-way door. Reverting the helper returns to preparing per
  call.
- **Failure design**: `better-sqlite3` statement preparation errors should still
  occur at the first attempted query using that SQL text; caching does not hide
  failures.
- **Concurrency**: Commands run synchronously in a process; parameter binding
  happens per `.all()` / `.get()` call on the statement.
- **Data integrity**: Database remains readonly and query-only; no writes are
  introduced.
- **Reuse**: Reuses the existing `ScipDatabase` boundary instead of adding a
  second query helper API.

## Execution Order

1. Add the private statement cache/helper.
2. Route `all()` and `get()` through it.
3. Clear the cache in `close()`.
4. Run tests, build, Vega hash/timing probes, `scip-query reindex`, and
   `scip-query diff-gate --json`.

## Summary

Implemented outcome:

- `ScipDatabase` now keeps a private SQL-text to prepared-statement map for the
  life of one readonly connection.
- `all()` and `get()` keep the same public signatures and bind params per call.
- Vega_2.0 `dead --json --full` stayed byte-identical and improved from 3.289s
  focused median to 2.928s focused median.
- The profile's `prepare` self-time dropped from 225.0ms to a 15.9ms
  `statement()` helper entry.

Expected files:

- `src/storage/db.ts`
- `docs/benchmarks/2026-06-28-dead-full-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- `docs/plans/2026-06-28-sqlite-statement-cache.md`
