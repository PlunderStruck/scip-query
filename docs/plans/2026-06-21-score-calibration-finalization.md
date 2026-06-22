# Score Calibration Finalization

Date: 2026-06-21

## Goal

Close AVL-006 by turning the completed direct/contextual verdicts into a final score-calibration record. Done means the validation ledger states how direct repair evidence, contextual signal evidence, support evidence, suppressions, and validation gaps should affect score and gate severity.

A score calibration is a recorded rule for converting analyzer evidence into health-score pressure. It is not a detector verdict by itself; it is the policy that decides how strongly different kinds of validated evidence should change the composite score.

## Current State

- `node dist/cli.js code computeHealthScore --json` resolves `computeHealthScore()` in `src/queries/health/health-report.ts`. It already has separate base deductions and pressure deductions.
- `node dist/cli.js code healthAnalysesFromPhases --json` resolves `healthAnalysesFromPhases()` in `src/queries/health/health.ts`, where health phases are normalized into `HealthAnalyses`.
- `node dist/cli.js code summarizeHealthStaleAbstractions --json` resolves `summarizeHealthStaleAbstractions()`, which now separates unused stale abstractions from single-consumer signals.
- `docs/validation/2026-06-21-health-score-action-tier-counts-result.md` records the implemented score-count split for extraction and stale abstractions.
- `docs/validation/2026-06-21-contextual-signal-closure-result.md` records the contextual family verdicts.
- `docs/validation/2026-06-21-direct-deletion-family-closure-result.md` records direct repair verdicts.

## Reuse Audit

This is a policy closure slice. It reuses the existing health scoring implementation and validation results rather than introducing new scoring helpers.

## Design

### 1. Consolidate Score Rules

- [x] **Files**: validation result documents.
- **Source**: `node dist/cli.js code computeHealthScore --json`; `node dist/cli.js code 'src/queries/health/health-report.ts:552-825' --json`.
- **What**: Record which analyzer families should produce direct base deductions, contextual backlog pressure, or support-only evidence.
- **Why**: AVL-006 should finish with a score model, not only isolated detector verdicts.

### 2. Record Blocked Or Conservative Score Decisions

- [x] **Files**: validation result documents.
- **Source**: contextual and direct closure result files.
- **What**: Mark Vue composable scoring, locality scoring, and passthrough direct scoring as intentionally conservative or blocked until stronger evidence exists.
- **Why**: A calibrated score model should say where evidence is not yet strong enough.

### 3. Close AVL-006

- [x] **Files**: `docs/analyzer-validation-ledger.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- **Source**: `rg -n "AVL-006|score calibration|Implementation Priority|Ledger Judgments" ...`
- **What**: Mark score calibration complete and point to the final result.
- **Why**: The remaining validation work should move to output/schema quality.

## Verification

- Run Markdown formatting on changed docs.
- Run the standard repository verification gate after doc updates.

## Result

Completed in `docs/validation/2026-06-21-score-calibration-finalization-result.md`.
