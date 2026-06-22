# Analyzer Validation Pilot Plan

Date: 2026-06-21

## Goal

Start the actual analyzer validation effort with a small, reviewable pilot. The user wants the validation approach written down and then started, not expanded into a full-suite run before the review process proves itself.

Done for this pilot means:

- The pilot plan is checked into docs.
- Raw command output is captured outside the repo.
- A dated validation summary is created under `docs/validation/`.
- The first run covers `scip-query` and `Stable_Management`.
- The first analyzer set includes direct repair, contextual signal, and Vue-specific analyzer families.
- The results identify what needs human verdict review next.

## Current State

`scip-query code health --json` reports `src/queries/health/health.ts:194`, where `health()` runs `runHealthAnalyses()` and then `buildHealthReport()`. This is the repo-wide analyzer aggregation surface.

`scip-query code diffGate --json` reports `src/queries/impact/diff-gate.ts:94`, where `diffGate()` runs `echo`, `incomplete-migration`, `co-change-partner`, `doc-reference`, `unused-params`, `new-dead`, and `baseline`. This is the change-time analyzer gate.

`scip-query trace queryCommandOrder --json` reports `src/runtime/commands/query-command-specs.ts:9`, where the public query command order begins. This is the public command coverage guard.

`scip-query trace DIFF_GATE_CHECKS --json` reports `src/queries/impact/diff-gate.ts:27`, where the canonical diff-gate check list is exported. This is the diff-gate coverage guard.

`scip-query plan-context health --full --json` shows `health()` depends on the health module, detector profiles, navigation stats, graph cleanup analyzers, and health report building. This confirms score calibration cannot be validated by one analyzer family alone.

## Reuse Audit

No production code or new helper module is planned in this pilot. The plan reuses:

- `docs/analyzer-validation-ledger.md` for ledger IDs, run batches, and status language.
- `docs/analyzer-validation-protocol.md` for verdict definitions and review criteria.
- `docs/analyzer-inventory.md` for analyzer action-tier grouping.
- `docs/locality-analyzer-design.md` for locality-specific review prompts.

Because this is a validation workflow, the only new artifacts are a dated plan and a dated validation summary. Raw analyzer output belongs outside the repo unless a small sample later becomes a fixture.

## Design Phases

### 1. Write the Pilot Plan

- [x] **File**: `docs/plans/2026-06-21-analyzer-validation-pilot.md`
- **Source**: `scip-query code health --json`; `scip-query code diffGate --json`; `scip-query trace queryCommandOrder --json`; `scip-query trace DIFF_GATE_CHECKS --json`
- **What**: The existing docs define the ledger and protocol, but do not yet state the exact first execution slice.
- **Change**: Add this plan as the concrete pilot execution record.
- **Why**: The validation effort needs a small first step with a clear stop condition.

### 2. Capture Corpus Baseline Output

- [x] **File**: `docs/validation/2026-06-21-analyzer-validation-pilot.md`
- **Source**: `scip-query code health --json`; `scip-query code diffGate --json`
- **What**: The ledger says Batch 1 starts with corpus baselines, but no dated run summary exists yet.
- **Change**: For `scip-query` and `Stable_Management`, capture revision, reindex result, `health --full --json`, `diff-gate --json`, and `capability-matrix`.
- **Why**: Baseline output gives later verdict reviews a stable revision and broad score context.

### 3. Capture Pilot Analyzer Output

- [x] **File**: `docs/validation/2026-06-21-analyzer-validation-pilot.md`
- **Source**: `scip-query trace queryCommandOrder --json`
- **What**: The full analyzer set is too broad for a first pass.
- **Change**: Capture direct repair commands (`dead`, `unused-params`, `passthrough-candidates`, `doc-drift`), contextual signal commands (`similar`, `wrapper-candidates`, `co-change`), and Vue commands on Stable_Management (`vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`).
- **Why**: This mix tests all three judgment modes without requiring every analyzer to be reviewed immediately.

### 4. Summarize the Started Run

- [x] **File**: `docs/validation/2026-06-21-analyzer-validation-pilot.md`
- **Source**: `scip-query code health --json`; `scip-query code diffGate --json`; `scip-query trace queryCommandOrder --json`
- **What**: Raw JSON is useful for inspection but not useful as the main repo artifact.
- **Change**: Write a compact summary with raw-output paths, command status, broad counts, and the next verdict-review queue.
- **Why**: The repo should retain human-readable state, not bulky temporary output.

### 5. Update the Ledger State

- [x] **File**: `docs/analyzer-validation-ledger.md`
- **Source**: `scip-query trace queryCommandOrder --json`; `scip-query trace DIFF_GATE_CHECKS --json`
- **What**: The ledger currently marks all validation items as `ready`.
- **Change**: Add a note that the first pilot slice has started and point to the dated validation summary.
- **Why**: The ledger should reflect that AVL-001, AVL-002, AVL-003, and AVL-012 are now in motion, even though the full validation matrix is not complete.

## Stress-Test Findings

1. Understand before touching: this pilot validates process, not production analyzer logic. The source anchors above identify the current analyzer aggregation and gate surfaces.
2. Blast radius: docs-only changes affect validation docs and do not change CLI behavior.
3. Intermediate validity: after Phase 2, raw outputs can exist without the summary being complete; after Phase 4, the summary should stand on its own.
4. Reversibility: every change is documentation or temporary raw output.
5. Failure design: failed commands should be recorded as failed, not hidden; missing JSON support should be recorded as plain text output.
6. Concurrency: raw output path includes the date, so another run can use a different directory without clobbering this pilot.
7. Boundaries: validation against foreign repos must not modify those repos beyond normal index/cache artifacts.
8. Data integrity: raw JSON stays outside the repo unless intentionally promoted.
9. Observability: the summary records command status and output paths.
10. Human use: the first verdict queue should be small enough for review.
11. Reuse: the pilot reuses the ledger, protocol, and inventory instead of inventing new status vocabulary.

## Execution Order

1. Add this plan.
2. Create `/tmp/scip-query-validation/2026-06-21-pilot/`.
3. Run Batch 1 for `scip-query`.
4. Run selected pilot analyzers for `scip-query`.
5. Run Batch 1 for `Stable_Management`.
6. Run selected pilot analyzers for `Stable_Management`.
7. Write `docs/validation/2026-06-21-analyzer-validation-pilot.md`.
8. Update `docs/analyzer-validation-ledger.md` with the started pilot note.
9. Format docs, reindex, and run diff gate.

## Ship Order

This can ship as one documentation-only change. The only one-way door would be promoting raw analyzer JSON into the repo; this plan avoids that.

## Summary

Files created or updated by this pilot:

- `docs/plans/2026-06-21-analyzer-validation-pilot.md`
- `docs/validation/2026-06-21-analyzer-validation-pilot.md`
- `docs/analyzer-validation-ledger.md`

No production code changes are planned.
