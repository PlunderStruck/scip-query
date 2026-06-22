# Agent Repair Outcomes

Date: 2026-06-21

## Goal

Validate that the analyzer action tiers predict what an agent should do with findings. Done means at least one direct finding has a checker-backed repair outcome, and representative signal/support findings are recorded as non-automatic repair outcomes rather than treated as code-edit instructions.

## Current State

- `cleanup-plan --verify` flows through `handleCleanupPlan()` in `src/runtime/query-commands/cleanup/handlers.ts` and `verifyCleanupPlan()` in `src/runtime/cleanup-verify.ts`.
- `verifyCleanupPlan()` creates a temporary detached worktree, applies cleanup batches cumulatively, runs detected project checkers, and reports only new checker errors beyond the baseline.
- React/Vue behavior analyzers now emit `actionTier`, `evidenceClass`, and `recommendation`, so their outputs can say "inspect this pressure" without implying "extract a shared hook now."

## Reuse Audit

No new repair harness is needed. `cleanup-plan --verify` is already the repair oracle for deletion-class findings, and existing React hook output is sufficient for signal/support non-repair samples.

## Design

### 1. Verify a Direct Repair

- [x] **Repo**: `SynthRunnerRust`
- **Command**: `cleanup-plan --verify --json`
- **What**: Confirm that direct deletion findings can be checked by the target project's compiler.
- **Why**: Direct analyzers should earn trust through repair outcomes, not only static evidence.

### 2. Record Signal and Support Non-Repairs

- [x] **Repo**: `Vega_2.0`
- **Command**: `react-hook-candidates --full --json`
- **What**: Sample one `signal` row and one `support` row.
- **Why**: These rows should guide review and locality judgment, not cause automatic extraction.

### 3. Record the Result

- [x] **File**: `docs/validation/2026-06-21-agent-repair-outcomes-result.md`
- **What**: Capture repair outcomes, raw-output paths, and calibration judgment.
- **Why**: Future agents need a durable example of when to edit and when to stop at evidence.

## Stress Test

- The Rust repair was verified in a temporary worktree, not applied to the external repository.
- The external Rust repository had pre-existing dirty files, and the verification result reported `dirtyOverlap: []`, so the checked cleanup did not overlap those changes.
- React hook signal/support rows came from a read-only large-corpus run.

## Verification

- This slice is documentation and validation only.
- Standard repo checks still run after the ledger update: `npm run typecheck`, `npm run build`, `npm test`, `./dist/cli.js reindex`, and `./dist/cli.js diff-gate`.
