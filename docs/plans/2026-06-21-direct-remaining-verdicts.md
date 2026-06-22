# Direct Remaining Verdicts

Date: 2026-06-21

## Goal

Continue AVL-002 by validating `passthrough-candidates`, real `cycles`, and broken `doc-drift` references. Done means the slice distinguishes direct repairs from contextual signals and records any required tier or precision changes.

## Current State

- `passthrough-candidates` uses a literal body-shape gate, but the output does not yet expose whether the wrapper is a domain boundary, adapter, facade, or public API.
- `cycles` already classifies cycles as `real` or `module-hierarchy`.
- `doc-drift` emits both staleness evidence and broken references; only broken references are direct doc cleanup.

## Reuse Audit

No new analyzer code is required for this validation pass. The current commands already expose enough structure to separate direct from signal for this slice.

## Design

### 1. Collect Corpus Output

- [x] **Repos**: `scip-query`, `Vega_2.0`, `Stable_Management`, `SynthRunnerRust`
- **Commands**: `passthrough-candidates --full --json`, `cycles --json`, `doc-drift --json`
- **What**: Count and sample the remaining direct-family analyzers.
- **Why**: AVL-002 needs analyzer-family verdicts, not just individual bug fixes.

### 2. Review Representative Positives

- [x] **Samples**: Vega passthrough rows, SynthRunnerRust cycle rows, Vega broken doc references, staleness-only doc drift rows.
- **What**: Classify `tp`, `accepted_design`, or `signal`.
- **Why**: These analyzers have mixed action implications.

### 3. Record Tier Corrections

- [x] **Docs**: inventory, calibration memo, ledger.
- **What**: Keep real cycles and broken references direct; mark passthrough as signal/direct only when boundary evidence is absent.
- **Why**: Avoid telling agents to inline adapters and facades simply because their bodies forward.

## Stress Test

- External repositories were read-only.
- `Stable_Management` and `SynthRunnerRust` had existing dirty user worktrees; this slice did not modify them.
- `Vega_2.0` was clean during status checks.

## Verification

- This slice is documentation and validation only.
- Standard repo checks still run after the ledger update: `npm run typecheck`, `npm run build`, `npm test`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.
