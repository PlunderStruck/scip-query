# Analyzer Calibration Pass Plan

Date: 2026-06-21

## Goal

Continue the analyzer validation sequence after the first verdict review. The user wants the work carried forward, with results and judgments recorded as we go. Done for this pass means a calibration memo exists, it states first-pass score and output judgments, and the ledger points to the next concrete implementation work.

## Current State

`scip-query plan-context health --full --json` resolves `health()` at `src/queries/health/health.ts:194`, where the public health report runs `runHealthAnalyses()` and then `buildHealthReport()`.

`scip-query code buildHealthReport --json` resolves `src/queries/health/health-report.ts:119`, where the report exposes `score`, `riskScore`, `hygieneScore`, `findings`, `validation`, `pressure`, and warnings.

`scip-query code computeHealthScore --json` resolves `src/queries/health/health-report.ts:552`, where score deductions are computed. The current formula deducts for `similar`, `wrappers`, `hidden-coupling`, Vue pressure, and other analyzer families.

`scip-query plan-context diffGate --full --json` resolves `diffGate()` at `src/queries/impact/diff-gate.ts:94`, where `echo`, `incomplete-migration`, `co-change-partner`, `doc-reference`, `unused-params`, `new-dead`, and `baseline` run in sequence.

`scip-query code runEchoCheck --json`, `scip-query code runIncompleteMigrationCheck --json`, `scip-query code runNewDeadCheck --json`, `scip-query code runDocReferenceCheck --json`, and `scip-query code runBaselineCheck --json` resolve the diff-gate checks that produced the highest-value first-pass verdicts.

`scip-query code wrapperCandidates --json`, `scip-query code similarAll --json`, `scip-query code coChange --json`, `scip-query code vueLargeViewPressure --json`, and `scip-query code deadSummary --json` resolve the analyzer surfaces tied to the calibration actions.

Stable_Management's captured health output reports score 95, hygiene 96, risk 95, 109 similar pairs, 48 wrapper candidates, 22 hidden-coupling pairs, and deductions of 1 point for `similar`, 3 points for `wrappers`, and 5 points for `hidden-coupling`.

The verdict review in `docs/validation/2026-06-21-analyzer-verdict-review.md` reviewed 68 rows: 28 `tp`, 10 `fp`, 18 `accepted_design`, and 12 `needs_judgment`.

## Reuse Audit

No production code, helper, type, or new analyzer command is planned in this pass. The pass reuses:

- `docs/validation/2026-06-21-analyzer-verdict-review.md` for reviewed outcomes.
- `docs/validation/2026-06-21-analyzer-validation-pilot.md` for raw-output paths and command counts.
- `docs/analyzer-validation-ledger.md` for status language and next-action tracking.
- Existing raw output under `/tmp/scip-query-validation/2026-06-21-pilot`.

## Design Phases

### 1. Record The Calibration Pass

- [x] **File**: `docs/plans/2026-06-21-analyzer-calibration-pass.md`
- **Source**: `scip-query plan-context health --full --json`; `scip-query plan-context diffGate --full --json`
- **What**: The verdict review exists, but there is no written calibration pass tying verdicts back to score/output behavior.
- **Change**: Add this plan to show the next step and its evidence anchors.
- **Why**: Validation work should stay auditable, especially when judgments affect score or gate behavior.

### 2. Write The Calibration Memo

- [x] **File**: `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- **Source**: `scip-query code computeHealthScore --json`; `scip-query code buildHealthReport --json`; captured Stable_Management health JSON.
- **What**: The current health score mixes direct repair debt and contextual pressure in a single score breakdown.
- **Change**: Record first-pass judgments for score weights, action tiers, diff-gate severity, and output schema.
- **Why**: The next implementation should not tune thresholds until we have explicit maintainer judgments.

### 3. Update The Ledger

- [x] **File**: `docs/analyzer-validation-ledger.md`
- **Source**: `scip-query trace DIFF_GATE_CHECKS --json`; `scip-query trace queryCommandOrder --json`
- **What**: The ledger points to the verdict review but not to the calibration memo.
- **Change**: Link the memo, update AVL-006 and AVL-007 next actions, and keep validation items running until second-repo confirmation.
- **Why**: The ledger should show which evidence exists and which decisions still need confirmation.

## Stress-Test Findings

1. Understand before touching: this pass reads the score and gate surfaces before making judgments.
2. Blast radius: docs-only; no CLI behavior changes.
3. Intermediate validity: the memo can exist before implementation because it is a decision record, not a shipped score change.
4. Reversibility: all changes are documentation.
5. Failure design: inconclusive verdicts stay `needs_judgment`; they do not become hidden score changes.
6. Concurrency: raw output remains in the dated pilot directory.
7. Boundaries: foreign-repo outputs are cited but not modified.
8. Data integrity: no raw JSON is promoted into the repo.
9. Observability: the memo records commands, verdict counts, and explicit judgments.
10. Human use: decisions are phrased as implementation actions, not abstract preferences.
11. Reuse: the memo reuses existing ledger vocabulary and verdict categories.

## Execution Order

1. Add this plan.
2. Write `docs/validation/2026-06-21-analyzer-calibration-memo.md`.
3. Update `docs/analyzer-validation-ledger.md`.
4. Format docs.
5. Run `scip-query reindex`.
6. Run `scip-query diff-gate --json`.

## Ship Order

This should ship as one documentation-only validation update. Analyzer behavior should change only after the memo is converted into a separate implementation plan.

## Summary

Files created or updated by this pass:

- `docs/plans/2026-06-21-analyzer-calibration-pass.md`
- `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- `docs/analyzer-validation-ledger.md`

No production code changes are planned.
