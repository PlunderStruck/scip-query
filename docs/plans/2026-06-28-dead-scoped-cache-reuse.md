# Dead Scoped Cache Reuse Plan

Date: 2026-06-28

## Goal

Make `scip-query dead --json --full` and the dead health phase faster on large
repositories without changing the dead-symbol result. Cache reuse here means
letting one phase's source-backed definition work remain available to a later
phase in the same command process, rather than discarding it immediately and
parsing the same source again.

Done means Vega_2.0 keeps the same `dead --json --full` SHA-256
`28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`, the dead
health phase keeps SHA-256
`648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`, and the
focused warm timing improves without materially slowing `health` or
`diff-gate`.

## Current State

- `dead()` loads candidate definitions, indexed reference counts, source/AST
  fallback references, semantic caller-map references, rows, and summary output.
  Source: `scip-query plan-context dead`; `scip-query trace dead`.
- `deadCandidateDefinitions()` manually iterates indexed document paths, calls
  `getDefinitionsForFile()` for each file, applies `deadCandidateDecision()`,
  and clears source-file/definition caches in a `finally` block per file.
  Source: `scip-query code 'src/queries/cleanup/dead.ts:1-190'`;
  `scip-query dataflow deadCandidateDefinitions`.
- `getScopedDefinitions()` already owns catalog-wide document iteration and
  ignored-path filtering by flatMapping `getDefinitionsForFile()` over
  `indexedDocumentPaths()`. Source: `scip-query code getScopedDefinitions -C 8`;
  `scip-query refs getScopedDefinitions`.
- `getDefinitionsForFile()` is the authoritative per-file definition path:
  primary rows, fallback rows, mixed-row merge policy, and source-corrected
  ranges. Source: `scip-query code getDefinitionsForFile`;
  `scip-query code correctDefinitionRangesFromSource -C 4`;
  `scip-query code mergeMixedSymbolQueryRows -C 4`.

## Reuse Audit

- Reuse `getScopedDefinitions()` for dead candidates instead of keeping a
  bespoke document loop in `deadCandidateDefinitions()`. Source:
  `scip-query code getScopedDefinitions -C 8`;
  `scip-query dataflow deadCandidateDefinitions`.
- Reuse `deadCandidateDecision()` unchanged so candidate policy stays exactly
  where it is. Source: `scip-query code deadCandidateDecision -C 4`.
- Rejected reuse/extension: adding a batch SQL implementation under
  `getScopedDefinitions()` plus a `PerDbCache.set()` API. Focused Vega probes
  preserved hashes but made `health --json` and `diff-gate --json` slower, so
  the shared-catalog batch path was removed before shipping.

## Design Phases

### 1.1 — Route dead candidates through the scoped catalog

- [x] **File**: `src/queries/cleanup/dead.ts:1-178`
- **Source**: `scip-query code 'src/queries/cleanup/dead.ts:1-190'`;
  `scip-query dataflow deadCandidateDefinitions`
- **What**: `deadCandidateDefinitions()` owns its own indexed-path loop and
  clears file-scoped source/definition caches immediately after each file.
- **Change**: Import `getScopedDefinitions()` and iterate its definitions,
  applying the existing `deadCandidateDecision()` for every definition.
- **Why**: This removes duplicated document iteration and preserves definition
  source facts for the source-reference fallback phase that runs immediately
  afterward.

### 1.2 — Do not batch the shared catalog primitive

- [x] **File**: `src/symbols/definition-catalog.ts:147-157`
- **Source**: `scip-query code getScopedDefinitions -C 8`;
  focused Vega hash/timing probes after the batch trial.
- **What**: A batch SQL prototype gathered all primary and fallback definition
  rows for a scope and grouped them by file.
- **Change**: Remove the batch prototype and keep `getScopedDefinitions()` on
  its original flatMap-over-files implementation.
- **Why**: The broad batch path was not an across-the-board win: it preserved
  output but slowed `health` and `diff-gate`, so keeping it would violate the
  goal.

### 1.3 — Verify output and broad command neutrality

- [x] **File**: `src/queries/cleanup/dead.ts`
- **Source**:
  `scip-query change-surface src/queries/cleanup/dead.ts --json --full`;
  focused Vega hash probes.
- **What**: Dead feeds standalone cleanup output and the health dead phase.
- **Change**: Verify focused tests, typecheck, build, Vega `dead`,
  `__health-phase dead`, `health`, and `diff-gate` hash/timing probes, full
  Vega matrix, full tests, `scip-query reindex`, `scip-query diff-impact`, and
  `scip-query diff-gate`.
- **Why**: The accepted change is intentionally narrow, but dead is a shared
  signal in health and cleanup workflows.

## Stress-Test Findings

- **Understand before touching**: Dead's candidate gate is policy; this change
  only changes how candidate definitions are fed into that policy.
- **Blast radius**: Medium. `dead()` has callers from cleanup-plan,
  health-baseline, health, query exports, and runtime cleanup handlers. Source:
  `scip-query trace dead`.
- **Intermediate validity**: The exported API, result shape, and candidate
  decision function are unchanged.
- **Reversibility**: This is a two-way door. Reverting the import and loop
  restores per-file cache clearing.
- **Failure design**: SQL/source failures still surface from the same underlying
  catalog functions.
- **Concurrency**: Caches are per `ScipDatabase` instance inside one synchronous
  command process.
- **Data integrity**: The SQLite index remains readonly; no persistent data is
  written.
- **Reuse**: Uses the existing scoped catalog primitive and does not add new
  public APIs.

## Execution Order

1. Route `deadCandidateDefinitions()` through `getScopedDefinitions()`.
2. Reject and remove the slower shared-catalog batch prototype.
3. Format, typecheck, run focused tests, build, benchmark, update ledgers, run
   scip gates, then commit/push without a version bump.

## Summary

Expected files:

- `src/queries/cleanup/dead.ts`
- `docs/benchmarks/2026-06-28-dead-full-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- `docs/plans/2026-06-28-dead-scoped-cache-reuse.md`
