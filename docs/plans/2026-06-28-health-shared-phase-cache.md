# Health Shared Phase Cache Plan - 2026-06-28

## Goal

Make `scip-query health --json` faster on large repositories without changing
the health report contract. Done means Vega_2.0 `health --json` and
`health --json --full` keep the same exit code and output hash while reducing
warm runtime, and the local scip-query tests plus diff gate still pass.

## Current State

Freshness is proven by `node dist/cli.js status --capabilities`: the local
scip-query index is fresh, TypeScript semantic evidence is available, and
cleanup detectors plus diff-gate are available.

Vega_2.0 is the benchmark corpus. Current `bench --json --include-heavy`
reported 103,982 symbols, 1,779 indexed files, and these slow commands:
`health --json` 2.178s, `diff-gate --json` 1.896s,
`dead --json --full` 1.515s, `complexity-hotspots --json --full` 1.469s,
and `recent-duplicates --json --full` 1.442s. Three direct repeats put
`health --json` at 2.120s, 2.136s, and 2.161s with stable SHA
`edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`.
`health --json --full` repeated at 2.095s, 2.198s, and 2.142s with stable SHA
`04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff`.

`scip-query plan-context health --json` resolves the entrypoint to
`src/queries/health/health.ts:194-199`, where `health()` calls
`withHealthRun()`, then `runHealthAnalyses()`, then `buildHealthReport()`.

`scip-query code HEALTH_PHASES -C 30` shows the composite phase list at
`src/queries/health/health.ts:53-73`: overview, dead, isolated, cycles,
similar, React/Vue frontend phases, extract, wrapper, passthrough, stale,
drift, complexity, git evidence, and suppressions.

`scip-query code healthPhases -C 40` shows `healthPhases()` at
`src/queries/health/health.ts:210-218` already creates a
`sharedCacheBudget` with `releaseCachesBetweenPhases: false` for grouped phase
execution.

`scip-query code runHealthAnalyses -C 120` shows `runHealthAnalyses()` at
`src/queries/health/health.ts:319-327` maps every `HEALTH_PHASES` entry through
`HEALTH_PHASE_RUNNERS[phase](db, scope, budget, statsResult)` with the original
budget. That keeps phase output assembly simple, but it means full
`health()` does not use the shared-cache behavior already used by grouped
health phases.

`scip-query code runHealthPhase -C 80` shows `runHealthPhase()` at
`src/queries/health/health.ts:646-652` calls `releaseHealthPhaseCaches()` in a
`finally` block after every phase. `scip-query code releaseHealthPhaseCaches
-C 80` shows that release calls `clearWholeProjectEvidenceCaches(db)` and
`requestGarbageCollection()` when `budget.releaseCachesBetweenPhases` is true.

`scip-query trace clearWholeProjectEvidenceCaches --json` and
`scip-query code clearWholeProjectEvidenceCaches -C 40` show the invalidation
boundary at `src/queries/internal/cache-invalidation.ts:14-17`, where it clears
registered `whole-project` caches for the current `ScipDatabase`.
`withHealthRun()` still clears `whole-project` and `semantic-provider` caches
after the full command at `src/queries/health/health.ts:221-233`.

Vega per-phase timings through `__health-phase <phase> --full` identify the
largest standalone phases as isolated 1.207s, wrapper 1.176s, stale 1.125s,
complexity 1.138s, dead 0.812s, React component duplicates 0.764s, drift
0.724s, similar 0.661s, extract 0.643s, passthrough 0.587s, and git evidence
0.857s. Since the composite command is only about 2.1s, repeated process
startup is not the issue; repeated per-phase cache invalidation is the likely
shared-work loss.

`scip-query change-surface src/queries/health/health.ts --json --full` marks
the module and public `health()`, `healthPhase()`, `healthPhases()`, and
`healthReportFromPhases()` surfaces as medium risk. `scip-query co-change
src/queries/health/health.ts --json --full` reports no co-change partners.

## Reuse Audit

No new helper is planned. The change reuses the existing `sharedCacheBudget`
pattern already present in `healthPhases()` at
`src/queries/health/health.ts:215-218`.

`scip-query similar releaseHealthPhaseCaches --json --full` only finds
`withHealthRun()` as similar cache-clear scaffolding. That confirms the cache
release behavior is already centralized; the plan should change orchestration,
not add a new invalidation helper.

`scip-query code createPerDbCache -C 60` shows per-DB caches are scoped to the
current `ScipDatabase` and registered by clear group. Keeping them alive across
one health command does not cross project boundaries, and `withHealthRun()`
still clears them at the command boundary.

## Design

### 1.1 - Reuse phase caches within one composite health run

- [x] **File**: `src/queries/health/health.ts:319-327`
- **Source**: `scip-query code runHealthAnalyses -C 120`
- **What**: `runHealthAnalyses()` currently passes the original `budget` to
  every phase runner, so `runHealthPhase()` clears whole-project caches after
  each phase.
- **Change**: Mirror `healthPhases()` by creating
  `const sharedCacheBudget = { ...budget, releaseCachesBetweenPhases: false };`
  inside `runHealthAnalyses()` and pass `sharedCacheBudget` to each phase
  runner.
- **Why**: This keeps pure per-DB evidence caches available across phases that
  repeatedly inspect the same indexed definitions, source facts, semantic
  provider state, and graph evidence, while preserving the final cleanup in
  `withHealthRun()`.
- **Result**: Rejected. The output hashes stayed identical, but Vega
  `health --json` remained in the same warm band after the first outlier
  (2.187s, 2.139s, 2.151s, 2.165s), and `health --json --full` repeated at
  2.115s, 2.155s, 2.184s, 2.156s, and 2.128s. The code change was reverted.

### 1.2 - Prove unchanged output and record the speed delta

- [x] **File**: `docs/benchmarks/2026-06-28-health-ledger.md`
- **Source**: Vega repeat timing command and `scip-query code health -C 40`
- **What**: The ledger already records previous Vega health measurements and
  phase timings.
- **Change**: Add a "Post Shared Phase Cache" section with before/after
  timings, hashes, command corpus, and whether the experiment is accepted.
- **Why**: Hyper-optimization changes are accepted only when timing improves
  and output stays stable.
- **Result**: Record the rejected shared phase-cache experiment so future
  health passes do not retry it without new evidence.

### 1.3 - Refresh the current scoreboard

- [x] **File**: `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- **Source**: Vega heavy benchmark matrix and repeat timing command
- **What**: The scoreboard is the current cross-command view for the active
  Vega corpus.
- **Change**: Update the health row and next-target notes with the new timing
  band if the change is accepted.
- **Why**: The next optimization target should be chosen from the current
  scoreboard, not stale memory.
- **Result**: Refresh the current warm bands from the current local CLI.

## Stress Test

1. Understand before touch: `health()` is a composite read-only analyzer
   command. The change does not alter detector thresholds, phase order, or
   report assembly.
2. Blast radius: `change-surface` marks health public surfaces as medium risk;
   verification must include health-focused tests, output hash comparisons,
   and `diff-gate`.
3. Intermediate validity: the change is one internal orchestration edit; the
   repo should typecheck and build immediately after it.
4. Reversibility: revert is one line in `runHealthAnalyses()`.
5. Failure design: if a cache payload is corrupt or stale, existing cache
   readers already rebuild or fall back; this plan only extends cache lifetime
   within one process.
6. Concurrency: caches are per `ScipDatabase` and held in `WeakMap`s; one
   health process does not share memory with another project or command.
7. Boundaries: CLI input and output are unchanged.
8. Data integrity: persistent evidence writes, if any, keep their existing
   content-hash and fingerprint guards; this plan does not add storage writes.
9. Observability: `SCIP_QUERY_HEALTH_TRACE=1` phase labels remain unchanged.
10. Human impact: faster health keeps the same warnings and action list.
11. Reuse: no new abstraction; use the established `healthPhases()`
    shared-cache budget shape.

## Execution Order

1. Implement 1.1.
2. Build and compare Vega `health --json` and `health --json --full` hashes
   against the baseline hashes above.
3. Benchmark repeated Vega health and top heavy commands.
4. If accepted, update 1.2 and 1.3.
5. Run focused health tests, typecheck, build, full tests, reindex, and
   `diff-gate`.

## Ship Order

Single two-way-door internal optimization. Ship only if output hashes match and
the health timing band improves without increasing diff-gate findings.

## Summary

Accepted code delta: none; the measured implementation did not improve health.
Documentation delta: benchmark ledger, scoreboard, and this rejected-probe
plan.
