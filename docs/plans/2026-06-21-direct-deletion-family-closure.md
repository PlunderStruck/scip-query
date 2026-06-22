# Direct Deletion Family Closure

Date: 2026-06-21

## Goal

Close AVL-002 by gathering the remaining deletion-family and direct-gate evidence into one verdict. Done means every analyzer named in AVL-002 has a reviewed outcome, a linked result slice, or a documented residual precision action.

## Current State

- `cleanup-plan`, `dead`, and Rust capability were validated in the cross-language and repair-outcome slices.
- `unused-imports`, `unused-params`, and `redundant-reexports` were validated in the direct small-analyzer slice.
- `passthrough-candidates`, `cycles`, and `doc-drift` were validated in the remaining-direct slice.
- `doc-reference`, `new-dead`, and `incomplete-migration` were calibrated in earlier diff-gate precision slices.

## Reuse Audit

This is a synthesis slice. It reuses existing validation documents and only reruns `dead --only-dead` and `isolated` on scip-query and SynthRunnerRust to confirm the remaining deletion-family state.

## Design

### 1. Confirm Deletion Outputs

- [x] **Repos**: `scip-query`, `SynthRunnerRust`
- **Commands**: `dead --only-dead --json`, `isolated --json`
- **What**: Confirm sampled deletion outputs after earlier schema/action-tier work.
- **Why**: AVL-002 should close on current command behavior, not only earlier notes.

### 2. Synthesize Direct-Gate Evidence

- [x] **Docs**: previous validation results.
- **What**: Summarize `new-dead`, `doc-reference`, and `incomplete-migration` verdicts.
- **Why**: These are diff-gate checks rather than standalone deletion commands, but they affect direct repair guidance.

### 3. Close AVL-002

- [x] **Docs**: ledger and calibration memo.
- **What**: Mark AVL-002 complete with residual precision actions assigned to future output/score work.
- **Why**: The direct analyzer set now has reviewed verdict coverage.

## Verification

- This slice is documentation and validation only.
- Standard repo checks still run after the ledger update: `npm run typecheck`, `npm run build`, `npm test`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.
