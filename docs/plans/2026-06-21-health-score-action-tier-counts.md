# Health Score Action-Tier Counts Plan

Date: 2026-06-21

## Goal

A health score is a compressed maintainer-facing estimate of direct repair debt and accumulated design pressure. Its referents are the report's score deductions, pressure entries, actions, and finding counts; its essential job is to communicate what kind of work the repository most needs without treating every analyzer row as the same kind of debt.

Done means health scoring uses the action-tier evidence from the completed extraction and stale-abstraction slices: extraction candidates remain contextual pressure, unused stale abstractions score as direct cleanup, and single-consumer stale abstractions score only as contextual pressure.

## Current State

- `node dist/cli.js code computeHealthScore --json` resolved `computeHealthScore()` at `src/queries/health/health-report.ts:557-818`. It currently applies a base `extract` deduction from raw `analyses.extractCount`, applies a base `stale-abstractions` deduction from raw `analyses.stale.count`, and applies pressure deductions for both families.
- `node dist/cli.js code summarizeHealthStaleAbstractions --json` resolved `summarizeHealthStaleAbstractions()` at `src/queries/health/health.ts:492-513`. It already computes `unused` and `singleUse` counts.
- `node dist/cli.js code buildHealthActions --json` resolved `buildHealthActions()` at `src/queries/health/health-report.ts:299-513`. It describes extraction candidates as "extract method opportunities" and stale abstractions as "premature abstraction".
- `node dist/cli.js code buildHealthAxes --json` resolved `buildHealthAxes()` at `src/queries/health/health-report.ts:170-201`. Evidence quality still counts candidate-style findings raw; this slice will not alter that meta count.

Field evidence:

- Vega extraction candidates: 213 rows, all `signal`.
- Vega stale abstractions: 1 `direct`, 107 `signal`.
- Stable_Management stale abstractions: 3 `direct`, 60 `signal`.

## Reuse Audit

- Reuse `StaleSummary.unused` and `StaleSummary.singleUse`; do not add another stale scan.
- Reuse existing `pressureDeduct()` for contextual backlog pressure.
- Reuse the existing health action categories; change descriptions only.
- Do not introduce a new score axis in this slice. Keep axes stable while changing the counts that feed them.

## Design

### 1. Remove Extraction Base Deduction

- [ ] **File**: `src/queries/health/health-report.ts:660-661`
- **Source**: `node dist/cli.js code computeHealthScore --json`
- **What**: Raw extraction candidate count currently creates a base hygiene deduction.
- **Change**: Remove the base `deduct('extract', ...)` call and keep `extract-pressure`.
- **Why**: Extraction candidates are all contextual signal rows; they should accumulate as backlog pressure, not direct debt.

### 2. Split Stale Direct And Signal Counts

- [ ] **File**: `src/queries/health/health-report.ts:671-676`
- **Source**: `node dist/cli.js code computeHealthScore --json`; `node dist/cli.js code summarizeHealthStaleAbstractions --json`
- **What**: Raw stale count currently creates a base hygiene deduction.
- **Change**: Base-score only `analyses.stale.unused`. Feed `analyses.stale.singleUse` into stale pressure.
- **Why**: Zero-consumer stale abstractions are direct cleanup; one-consumer abstractions are contextual ownership signals.

### 3. Update Health Actions Wording

- [ ] **File**: `src/queries/health/health-report.ts:423-470`
- **Source**: `node dist/cli.js code buildHealthActions --json`
- **What**: Extraction action says "extract method opportunities"; stale action says "premature abstraction".
- **Change**: Reword extraction as reviewable extraction seams and stale as unused direct cleanup plus single-consumer ownership signal.
- **Why**: Health actions should match the new action-tier semantics.

### 4. Add Regression Coverage

- [ ] **File**: `tests/queries/navigation/command-accuracy.test.ts`
- **Source**: `node dist/cli.js code computeHealthScore --json`; `node dist/cli.js code buildHealthActions --json`; `node dist/cli.js code summarizeHealthStaleAbstractions --json`
- **What**: Existing test already verifies stale action count and description on a zero-consumer stale type.
- **Change**: Assert that the stale score breakdown uses the direct unused count and that extraction candidates do not produce a base `extract` deduction when only pressure applies.
- **Why**: The score contract should pin direct-vs-signal behavior.

## Verification

- `npx vitest run tests/queries/navigation/command-accuracy.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js health --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

Scores may increase on repositories with many extraction or single-consumer stale rows. That is intentional: these rows are still reported as signal pressure, but they should not reduce the base score like dead code.

## Result

Completed in `docs/validation/2026-06-21-health-score-action-tier-counts-result.md`.
