# Health Frontend Phase Pruning Plan — 2026-06-28

## Goal

Make `scip-query health` faster in non-frontend or partially frontend repositories without changing the health report's meaning. Done means the parent health command avoids launching React/Vue phase subprocesses when the project or scoped path has no matching source files, and still feeds `healthReportFromPhases` a complete phase list.

## Current State

`src/runtime/cli-support.ts:96-103` runs every entry in `queries.HEALTH_PHASES` through `runHealthPhaseProcess`, then passes the collected results to `queries.healthReportFromPhases`. Source: `scip-query plan-context runIsolatedHealthReport`.

`src/queries/health/health.ts:53-73` includes three React phases and three Vue phases in the full health phase list. `src/queries/health/health.ts:77-96` shows each frontend phase result is only a named `CountLocSummary`. Source: `scip-query code src/queries/health/health.ts:53-96`.

`src/source/react-profile.ts:117-134` discovers React work by calling `getSourceFiles(db, { extensions: REACT_EXTENSIONS })`, filtering by `opts.scope`, and returning an empty profile list when no `.tsx`/`.jsx` files match. Source: `scip-query plan-context buildReactComponentBehaviorProfiles`.

`src/source/vue/vue-profile.ts:49-66` discovers Vue work by calling `getSourceFiles(db, { extensions: ['.vue'] })`, filtering by `opts.scope`, and returning an empty profile list when no `.vue` files match. Source: `scip-query plan-context buildVueComponentBehaviorProfiles`.

`src/source/source-fileset.ts:130-154` already centralizes source-file discovery, includes indexed plus auxiliary sources by default, filters by extension, applies ignore rules, and caches the result per DB. Source: `scip-query plan-context getSourceFiles`.

## Reuse Audit

Reuse `getSourceFiles` instead of adding a new project walk. It already has the exact file discovery semantics used by the React and Vue detectors. Source: `scip-query plan-context getSourceFiles`.

Reuse `healthReportFromPhases` and `HEALTH_PHASES`; do not change the report builder or phase contract. Source: `scip-query code healthReportFromPhases -C 6` and `scip-query code HEALTH_PHASES -C 8`.

No structurally similar runtime module exists to reuse for phase pruning. Source: `scip-query similar-files src/runtime/cli-support.ts --json` returned no rows.

## Design Phases

### 1.1 — Add Frontend Applicability Detection

- [x] **File**: `src/runtime/cli-support.ts:1-103`
- **Source**: `scip-query code src/runtime/cli-support.ts:1-130`; `scip-query plan-context getSourceFiles`
- **What**: `runIsolatedHealthReport` currently starts child processes for every health phase.
- **Change**: Import `getSourceFiles`, add internal React/Vue phase sets, and compute whether `.tsx`/`.jsx` or `.vue` files exist after applying the current `opts.scope`.
- **Why**: This mirrors the detector entry conditions once in the parent process, avoiding subprocess startup for phases that can only return zero.

### 1.2 — Synthesize Empty Skipped Phase Results

- [x] **File**: `src/runtime/cli-support.ts:96-117`
- **Source**: `scip-query code src/queries/health/health.ts:53-96`; `scip-query code healthReportFromPhases -C 6`
- **What**: `healthReportFromPhases` expects one result per phase, and frontend phases use simple count/LOC summaries.
- **Change**: For inapplicable frontend phases, create `{ count: 0, loc: 0, files: [] }` results with the existing phase-specific property names. Run only applicable phases through `runHealthPhaseProcess`, then reassemble results in `HEALTH_PHASES` order before calling `healthReportFromPhases`.
- **Why**: The output contract remains complete and ordered while avoiding known-no-op work.

### 1.3 — Add Focused Unit Coverage

- [x] **File**: `tests/runtime/cli-support.test.ts`
- **Source**: `scip-query outline tests/runtime/cli-support.test.ts`; `scip-query code src/runtime/cli-support.ts:183-210`
- **What**: The runtime support tests cover scheduling helpers but not frontend phase pruning.
- **Change**: Add tests for exported pure helpers that prove inapplicable React/Vue phases are skipped and zero results have the expected phase-specific shape.
- **Why**: The optimization is easy to regress because the skipped phases still need to look exactly like real phase outputs.

## Stress Test

- Understand before touch: this is a parent-process precheck for no-op child phases; detector internals stay untouched. Sources: `scip-query plan-context buildReactComponentBehaviorProfiles`; `scip-query plan-context buildVueComponentBehaviorProfiles`.
- Blast radius: `runIsolatedHealthReport` is consumed by `handleHealth` and setup health. Source: `scip-query plan-context runIsolatedHealthReport`.
- Intermediate validity: after phase pruning, all non-frontend phases still execute through the same subprocess path, and skipped frontend phases feed the same result type into the existing report builder. Source: `scip-query code healthReportFromPhases -C 6`.
- Reversibility: this is an internal runtime optimization with no schema/config changes; rollback is deleting the applicability helper and restoring `queries.HEALTH_PHASES` as the `mapWithConcurrency` input.
- Failure handling: if the DB cannot open or source discovery fails, the parent command fails before child launch, which is equivalent to the current health command failing in the first child phase.
- Concurrency: the change reduces child-process count; no shared mutable state is added beyond a local result map.
- Boundary: `HealthCliOptions.scope` remains the only user input used, and it is applied with the same `file.includes(opts.scope)` rule the detectors already use. Sources: `scip-query plan-context buildReactComponentBehaviorProfiles`; `scip-query plan-context buildVueComponentBehaviorProfiles`.
- Data integrity: read-only SQLite/source-file discovery only.
- Observability: skipped phases are indistinguishable from real empty detector results in JSON, preserving downstream consumers.
- Human outcome: `health` gets faster in repos without React/Vue files and behaves the same in repos that contain them.
- Reuse: the plan reuses `getSourceFiles`, `HEALTH_PHASES`, and `healthReportFromPhases`. Sources above.

## Execution Order

1. Implement `cli-support.ts` helper logic.
2. Add focused runtime tests.
3. Run typecheck, focused tests, build, benchmarks, post-checks, `reindex`, and `diff-gate --json`.

## Ship Order

Single deployable phase. No one-way doors.

## Summary

Files changed: `src/runtime/cli-support.ts`, `tests/runtime/cli-support.test.ts`, and this plan file.

## Results

- This repo: warm `health --json` was `1340ms` after pruning; the same run still reports complete React/Vue zero summaries when no matching files exist.
- Stable_Management: warm `health --json` was `3386ms`, down from the earlier `~4297ms-4407ms` range, because the repo has Vue files and no React files, so the three React child phases are skipped.
- Verification passed: typecheck, focused runtime/source-reference tests, full `npm test -- --run`, helper duplicate checks, `scip-query reindex`, and `scip-query diff-gate --json`.
