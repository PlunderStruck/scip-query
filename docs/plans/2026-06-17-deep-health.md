# Deep Health Counts
**Date:** 2026-06-17

## Goal

Make `scip-query health --full` mean a complete health run: it must remove the large-index candidate scan budget and the top-N finding caps that make categories stop at 50. Done means normal `health` and `health --baseline` stay bounded, while `health --full` reports uncapped counts for candidate-style findings and hidden coupling.

## Current State

- `src/queries/health.ts:149-157` passes `opts.full` into `withHealthRun`, and `src/runtime/command-handlers.ts:156-177` already forwards the CLI `--full` option into `runIsolatedHealthReport`. Source: `scip-query plan-context health`; `scip-query code 'src/runtime/command-handlers.ts:141-177' -C 5`.
- `src/queries/health.ts:432-464` only uses `full` to remove `candidateScanLimit`; it does not remove detector result limits. Source: `scip-query code 'src/queries/health.ts:432-493'`.
- `src/queries/internal/health-detector-profiles.ts:7-15` caps similar, extract, wrapper, passthrough, and stale results at `limit: 50`. Source: `scip-query code 'src/queries/internal/health-detector-profiles.ts:1-220'`.
- `src/queries/health.ts:361-384` caps hidden coupling with `coChange(db, undefined, { limit: 50 })`. Source: `scip-query code 'src/queries/health.ts:361-430'`.
- `src/queries/health-baseline.ts:1-159` intentionally shares `HEALTH_DETECTOR_PROFILES` and bounded large-index behavior for the ratchet. Source: `scip-query code 'src/queries/health-baseline.ts:1-159'`.

## Reuse Audit

- Reuse the existing `full` option rather than adding a second `--deep` flag. Source: `scip-query code 'src/runtime/command-descriptors.ts:120-134'`.
- Reuse detector `limit` options by passing an explicit unbounded numeric limit for full health. Source: `scip-query trace 'runCandidateAnalysis'`; `scip-query trace 'insertTopSimilarResult'`.
- No new public helper is needed. `scip-query recent-duplicates` found no recent re-implementation pressure, and `scip-query similar-signatures --min-loc 5` did not show an existing health-budget helper to reuse.

## Design

### 1.1 - Track result caps in the health budget

- [x] **File**: `src/queries/health.ts:33-37`
- **Source**: `scip-query outline src/queries/health.ts`.
- **What**: `HealthBudget` tracks scan limits, cache release behavior, and warnings.
- **Change**: Add a `candidateResultLimit: number` field. Normal health uses `50`; full health uses `Number.POSITIVE_INFINITY`.
- **Why**: The scan limit answers "how many candidate symbols may we inspect"; the result limit answers "how many findings may each detector return." Deep health must lift both.

### 1.2 - Pass the budgeted result limit to capped detectors

- [x] **File**: `src/queries/health.ts:303-359`
- **Source**: `scip-query code 'src/queries/health.ts:303-359'`.
- **What**: Candidate detectors spread `HEALTH_DETECTOR_PROFILES.*`, which supplies `limit: 50`.
- **Change**: Override `limit` after the spread with `budget.candidateResultLimit` for similar, extract, wrapper, passthrough, and stale detectors.
- **Why**: Spread order lets normal health keep the profile default while full health deliberately unbounds it.

### 1.3 - Uncap hidden coupling and complexity counts in full health

- [x] **File**: `src/queries/health.ts:361-430`
- **Source**: `scip-query code 'src/queries/health.ts:361-430'`; `scip-query trace 'coChange'`; `scip-query trace 'complexityHotspots'`.
- **What**: Hidden coupling uses `limit: 50`; complexity uses `limit: 10`, so its extreme count can only count inside the top 10.
- **Change**: Use `budget.candidateResultLimit` for hidden coupling and complexity result limits. Keep the rendered top complexity list at five entries.
- **Why**: The report should still be readable, but counts and score inputs should reflect the full run.

### 1.4 - Clarify the full-health warning

- [x] **File**: `src/queries/health.ts:432-464`
- **Source**: `scip-query code 'src/queries/health.ts:432-464'`.
- **What**: The existing warning only mentions unbounded health analyses on large indexes.
- **Change**: Say that `--full` removes scan and result caps.
- **Why**: Users need to know when the command is intentionally doing the slow complete scan.

## Stress Test

- The change is reversible and internal to health reporting; it does not alter detector defaults or the baseline ratchet. Source: `scip-query trace 'HEALTH_DETECTOR_PROFILES'`.
- Baseline behavior remains bounded because it still calls detector profiles directly and has its own large-index `baselineScanLimit`. Source: `scip-query code 'src/queries/health-baseline.ts:30-115'`.
- The failure mode is runtime cost on very large repositories, and it is only triggered by the explicit `--full` flag. Normal `health` remains bounded.

## Verification

- Run `npm run typecheck`.
- Run `npm test -- --runInBand` if Vitest accepts the flag; otherwise run `npm test`.
- Run `scip-query reindex && scip-query diff-gate`.
- Run normal and full health against `VegaAssistant` and compare capped categories.
