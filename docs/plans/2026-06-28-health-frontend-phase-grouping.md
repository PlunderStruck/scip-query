# Health Frontend Phase Grouping Plan - 2026-06-28

## Goal

Make `scip-query health --json --full` faster without changing its report. A health phase is one detector slice of the composite health report: a named analysis such as Vue component duplicates, wrapper candidates, or git evidence. A grouped health worker is an internal child-process invocation that runs multiple related phases in one database process so source-derived caches can be reused before being cleared. Done means Vue and React frontend phases share cache work inside health, the final health JSON stays byte-identical on representative repos, and the change is proven by tests plus `diff-gate`.

## Current State

- `runIsolatedHealthReport` in `src/runtime/cli-support.ts:109-126` computes framework applicability, filters runnable phases, runs each phase through `runHealthPhaseProcess`, and rebuilds the final report with `healthReportFromPhases`. Source: `scip-query plan-context runIsolatedHealthReport`.
- `healthPhase` in `src/queries/health/health.ts:202-210` wraps one `HEALTH_PHASE_RUNNERS[phase]` call in `withHealthRun`. Source: `scip-query plan-context healthPhase`.
- `withHealthRun` in `src/queries/health/health.ts:212-225` computes `stats`, derives the health budget, and clears whole-project caches in `finally`. Source: `scip-query code withHealthRun -C 12`.
- Each individual phase runner calls `runHealthPhase`, and `runHealthPhase` clears health caches after its detector when `budget.releaseCachesBetweenPhases` is true. Source: `scip-query code runHealthPhase -C 20`.
- `health()` in `src/queries/health/health.ts:195-200` proves it is semantically valid to run many phase runners under one `withHealthRun` and build a report from the combined phase results. Source: `scip-query code health -C 20`.
- The hidden CLI command `__health-phase` is registered in `src/runtime/commands/command-descriptors.ts:81-91` and handled by `handleHealthPhase` in `src/runtime/commands/command-handlers.ts:199-211`. Source: `scip-query code 'src/runtime/commands/command-descriptors.ts:1-100'` and `scip-query code handleHealthPhase -C 20`.
- Phase timing evidence on Stable after the Vue profile cache: Vue component/composable/large-view phases cost about `948ms`, `864ms`, and `842ms` when run in separate child processes; self health is about `3.70s` wall and Stable health is about `6.83s` under concurrent command load. Source: measured `node dist/cli.js __health-phase <phase> --full` runs recorded in this work session.

## Reuse Audit

- Reuse `withHealthRun`, `HEALTH_PHASE_RUNNERS`, and `healthReportFromPhases`; do not add a second report builder. Source: `scip-query code health -C 20`, `scip-query code healthReportFromPhases -C 12`.
- Reuse the existing hidden `__health-phase` protocol by allowing a comma-separated phase argument to return an array for multi-phase calls. Do not expose a public command or public docs entry. Source: `scip-query code 'src/runtime/commands/command-descriptors.ts:1-100'`.
- Reuse `mapWithConcurrency` and `runIsolatedJsonProcessAsync` for child scheduling; do not add another scheduler. Source: `scip-query plan-context runIsolatedHealthReport`.

## Design

### 1.1 - Add a multi-phase health query helper

- [ ] **File**: `src/queries/health/health.ts:202-225`
- **Source**: `scip-query plan-context healthPhase`; `scip-query code runHealthPhase -C 20`.
- **What**: `healthPhase` runs one phase inside `withHealthRun`; each phase runner receives the budget whose `releaseCachesBetweenPhases` flag causes cache release after the detector.
- **Change**: Add `healthPhases(db, phases, opts)` beside `healthPhase`. It calls `withHealthRun` once and maps phases through `HEALTH_PHASE_RUNNERS`, but passes a cloned budget with `releaseCachesBetweenPhases: false`; `withHealthRun` still clears caches once after the group finishes. Change `healthPhase` to return `healthPhases(db, [phase], opts)[0]`.
- **Why**: Related frontend phases can share source-derived caches while preserving the final cleanup boundary.

### 1.2 - Let the hidden health worker return one phase or a phase array

- [ ] **File**: `src/runtime/commands/command-handlers.ts:199-211`
- **Source**: `scip-query code handleHealthPhase -C 20`.
- **What**: The hidden worker validates one phase name and prints one JSON phase result.
- **Change**: Parse a comma-separated phase list from the single hidden positional argument. Validate every phase against `queries.HEALTH_PHASES`. For one phase, keep printing the existing object result. For multiple phases, call `queries.healthPhases` and print a JSON array.
- **Why**: This preserves the existing hidden single-phase protocol while allowing grouped child invocations.

### 1.3 - Schedule frontend phase groups in health

- [ ] **File**: `src/runtime/cli-support.ts:109-172`
- **Source**: `scip-query plan-context runIsolatedHealthReport`; `scip-query change-surface src/runtime/cli-support.ts`.
- **What**: `runIsolatedHealthReport` turns runnable phases into one child process per phase.
- **Change**: Build health tasks as arrays of phases. Put present React frontend phases into one task and present Vue frontend phases into one task; keep all other phases as single-phase tasks. Run tasks with `mapWithConcurrency`, flatten returned arrays, and place each result in `resultByPhase` by its `phase`.
- **Why**: Vue and React frontend detectors can share expensive source profile caches inside one child process without changing report assembly.

### 1.4 - Cover task grouping and output contract

- [ ] **File**: `tests/runtime/cli-support.test.ts`
- **Source**: `scip-query change-surface src/runtime/cli-support.ts`.
- **What**: Existing tests cover phase concurrency and framework pruning, but not task grouping.
- **Change**: Export a small pure helper for grouping health phases and test that Vue/React phases are grouped only when applicable, with non-frontend phases left as singletons.
- **Why**: The grouping rule is the correctness center of this optimization.

## Stress Test Findings

- Understand before touch: health isolation exists to keep detector memory bounded; grouping only the three frontend phases per framework limits the larger cache lifetime to a narrow slice. Source: `scip-query code runHealthPhase -C 20`.
- Blast radius: `runIsolatedHealthReport` is consumed by `handleHealth` and setup health only. Source: `scip-query plan-context runIsolatedHealthReport`.
- Intermediate validity: hidden single-phase output remains an object, so existing callers of `__health-phase <phase>` keep working.
- Reversibility: remove `healthPhases`, restore the one-phase scheduler, and tests/outputs return to prior behavior.
- Failure/concurrency: grouped child processes remain independent OS processes; a failed grouped child still fails the health command through `runIsolatedJsonProcessAsync`. Source: `scip-query plan-context runIsolatedHealthReport`.
- Data integrity: no persistent data or index schema changes.
- Human impact: visible `health` JSON/text output must be compared before and after.

## Verification

- Compare `health --json --full` output byte-for-byte on this repo and Stable before/after.
- Benchmark `health --json --full` sequential warm runs on this repo and Stable.
- Run focused tests: `tests/runtime/cli-support.test.ts`, health tests, frontend Vue tests.
- Run `npm run typecheck`, `npm run build`, and `npm test -- --run`.
- Run `scip-query doctor`, `scip-query status --capabilities`, `scip-query diff-impact --json`, `scip-query recent-duplicates --json --full`, `scip-query incomplete-migration --json --full`, `scip-query unused-params --json --full`, `scip-query stale-abstractions --json --full`, `scip-query config-validate`, then `scip-query reindex` if stale and `scip-query diff-gate --json`.

## Execution Order

1. Add `healthPhases` in the query layer.
2. Extend the hidden health worker to accept comma-separated groups.
3. Add pure task grouping in runtime support and use it in `runIsolatedHealthReport`.
4. Add grouping tests and compare health output/timing.
5. Run full verification and gate.

## Summary

- Files to modify: `src/queries/health/health.ts`, `src/runtime/commands/command-handlers.ts`, `src/runtime/cli-support.ts`, `tests/runtime/cli-support.test.ts`.
- Files to add: this plan.
- Expected effect: faster visible health by sharing frontend source caches within grouped child processes, with unchanged report output.

## Measurement Addendum

- After implementation, `health --json --full` output was byte-identical on this repo and Stable.
- Direct Vue phase timing on this repo: separate child processes totaled about `1626ms`; grouped child process took about `368ms`.
- Direct Vue phase timing on Stable: separate child processes totaled about `7657ms`; grouped child process took about `2490ms`.
- Visible health timing remains noisy because other heavy phases still run concurrently, but Stable warm runs dropped across repeated samples from `6.48s` to `4.98s` to `3.54s` after cache warmup.
