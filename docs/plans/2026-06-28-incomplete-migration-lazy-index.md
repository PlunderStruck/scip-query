# Incomplete Migration Lazy Index Plan

Date: 2026-06-28

## Goal

Make `diff-gate --json` faster on large repositories without changing any
findings. Done means Vega_2.0 keeps the same `diff-gate --json` output hash and
the same `incomplete-migration --json --full` output hash, while the expensive
callee fingerprint index is skipped when every new helper is too small to
score.

## Current State

- The refreshed Vega_2.0 heavy matrix ranks `health --json` at 2.971s,
  `diff-gate --json` at 2.870s, and `dead --json --full` at 2.666s. Source:
  `scip-query bench --json --include-heavy --timeout-ms 600000`.
- `diffGate()` creates one `DiffImpactPlan`, computes `diffImpact()`, creates a
  base-content reader, then runs `echo`, `incomplete-migration`,
  `co-change-partner`, `doc-reference`, `unused-params`, and `new-dead`.
  Source: `scip-query code diffGate -C 16 --json`.
- `runIncompleteMigrationCheck()` delegates to `incompleteMigration()` with the
  already-created diff plan and base-content reader. Source:
  `scip-query code runIncompleteMigrationCheck -C 12 --json`.
- `incompleteMigration()` finds new callables, slices them to `maxHelpers`,
  builds `getCalleeFingerprintIndex()`, then computes helper callees and skips
  helpers with fewer than `minCallees` meaningful callees. Source:
  `scip-query code incompleteMigration -C 16 --json`.
- Vega_2.0 currently has two new helpers in the diff, and both are skipped as
  `fewer than 3 meaningful callees — too small to score`; there are no
  incomplete-migration findings. Source:
  `scip-query incomplete-migration --json --full` in Vega_2.0.
- `getCalleeFingerprintIndex()` builds or returns the global callee fingerprint
  index and is also used by `similar()`. Source:
  `scip-query code getCalleeFingerprintIndex -C 12 --json`;
  `scip-query refs getCalleeFingerprintIndex --json`.

## Reuse Audit

- Reuse `getCalleeFingerprintIndex()` exactly as the canonical global callee
  fingerprint index. This plan changes when it is called, not what it returns.
  Source: `scip-query code getCalleeFingerprintIndex -C 12 --json`.
- Reuse `meaningfulCallees()` for the cheap helper-callee gate before building
  the global index. Source: `scip-query code meaningfulCallees -C 12 --json`.
- No new helper is needed. A local lazy variable inside `incompleteMigration()`
  preserves the current result construction order. Source:
  `scip-query change-surface src/queries/impact/incomplete-migration.ts --json --full`.

## Design Phases

### 1.1 — Lazily create the callee fingerprint index

- [x] **File**: `src/queries/impact/incomplete-migration.ts:126-166`
- **Source**: `scip-query code incompleteMigration -C 16 --json`
- **What**: `incompleteMigration()` builds `candidateIndex` before it knows
  whether any helper has enough meaningful callees to score.
- **Change**: Replace the eager `const candidateIndex = ...` with a local
  `let candidateIndex: CalleeFingerprintIndex | undefined` plus a small
  `getCandidateIndex()` closure. Call it only after the
  `callees.size < minCallees` skip has passed.
- **Why**: When every helper is too small, the current command pays for a
  global index that cannot affect output.

### 1.2 — Preserve skip/finding order

- [x] **File**: `src/queries/impact/incomplete-migration.ts:139-201`
- **Source**: `scip-query code incompleteMigration -C 16 --json`
- **What**: Skipped helper rows are appended while iterating
  `helperFingerprints` in helper order.
- **Change**: Keep the same loop and append the same skip rows before calling
  `getCandidateIndex()`.
- **Why**: JSON output should stay byte-identical, including skipped row order.

### 1.3 — Verify through diff-gate and incomplete-migration

- [x] **File**: `src/queries/impact/incomplete-migration.ts`
- **Source**:
  `scip-query change-surface src/queries/impact/incomplete-migration.ts --json --full`
- **What**: `incompleteMigration()` is exported and consumed by diff-gate and
  the public `incomplete-migration` command.
- **Change**: Run focused incomplete-migration tests, typecheck/build, Vega
  hash comparisons for `incomplete-migration --json --full` and
  `diff-gate --json`, then final `scip-query reindex && scip-query diff-gate`.
- **Why**: The optimization is acceptable only if both public surfaces preserve
  output.

## Execution Notes

- Paired Vega baseline/current comparison after implementation:

| Command                                         | Baseline median | Current median | stdout bytes | SHA-256                                                            |
| ----------------------------------------------- | --------------: | -------------: | -----------: | ------------------------------------------------------------------ |
| `scip-query incomplete-migration --json --full` |          1.623s |         1.432s |        1,101 | `8c9573e427ee68a30e74bb1d27fbd9d4b49ec02b095c3d7fa7440d2317fd4c51` |
| `scip-query diff-gate --json`                   |          2.860s |         2.872s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `scip-query health --json`                      |          2.997s |         2.923s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

- Accepted as an incomplete-migration optimization: the public command improves
  by 191ms median on this Vega diff because both new helpers are too small to
  score. Diff-gate remains hash-identical but wall time is flat because other
  checks dominate the combined command.

## Stress-Test Findings

- **Understand before touching**: The global callee index is only needed after a
  helper has enough meaningful callees to score; tiny helpers always produce
  the same skip row without consulting the index.
- **Blast radius**: `incompleteMigration()` has medium risk and is consumed by
  the public command plus `diffGate()`. Source:
  `scip-query trace incompleteMigration --json`;
  `scip-query change-surface src/queries/impact/incomplete-migration.ts --json --full`.
- **Intermediate validity**: One function changes internally; exported types
  and JSON shapes stay unchanged.
- **Reversibility**: Reverting the local lazy closure restores the eager index.
- **Failure design**: No new IO, async work, or cache invalidation path.
- **Concurrency**: The existing per-DB fingerprint cache is still the owner;
  this only defers access to it.
- **Data integrity**: Readonly analysis only.
- **Observability**: Ledger records before/after timings and hashes.
- **Reuse**: Existing `getCalleeFingerprintIndex()` and `meaningfulCallees()`
  remain canonical.

## Execution Order

1. Patch `incompleteMigration()` to lazily initialize `candidateIndex`.
2. Format and run focused tests for incomplete migration and diff-gate.
3. Build and compare Vega hashes/timings.
4. Update diff-gate ledger and scoreboard, run scip gates, commit/push without
   a version bump if accepted.

## Summary

Touched files:

- `src/queries/impact/incomplete-migration.ts`
- `docs/plans/2026-06-28-incomplete-migration-lazy-index.md`
- `docs/benchmarks/2026-06-28-diff-gate-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
