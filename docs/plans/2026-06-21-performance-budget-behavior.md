# Performance and Budget Behavior

Date: 2026-06-21

## Goal

Validate that large-index analyzer runs are bounded by default, explicit about caps, unbounded only when `--full` is supplied, and clear when option combinations are invalid. Done means the validation ledger records timing, warning, and count behavior on large corpora without checking bulky raw JSON into the repo.

## Current State

- `scip-query plan-context healthBudget --full` shows `healthBudget()` in `src/queries/health/health.ts:588-616`.
- `scip-query code src/queries/health/health.ts:47-60` shows large-index thresholds of 75,000 symbols or 5,000 documents, a default candidate scan cap of 2,500 symbols, a default candidate result cap of 50, and a default complexity result cap of 10.
- `scip-query plan-context definedLimitOption --full` shows `definedLimitOption()` in `src/runtime/commands/command-execution.ts:215-227`, where `--full` returns `Infinity` unless the user also supplied an explicit limit.
- `scip-query plan-context budgetedListCommand --full` shows list-style commands flow through `budgetedDbCommand()` and `renderRows()`.

## Reuse Audit

No new benchmark harness is needed. The existing command output already exposes warnings and counts; `/usr/bin/time -p` plus JSON summaries is enough to validate behavior for this slice.

## Design

### 1. Measure Composite Health on Large Repos

- [x] **Repos**: `Stable_Management`, `Vega_2.0`
- **Source**: `scip-query status --json` in each repo.
- **What**: Both repos are fresh large indexes: Stable has 108,885 symbols and Vega has 102,689 symbols.
- **Change**: Run `health --json` and `health --full --json`, capture raw JSON under `/tmp/scip-query-validation/2026-06-21-budget`, and record only summary timing/counts.
- **Why**: Health is the user-facing composite where caps matter most.

### 2. Measure Standalone Candidate Limit Behavior

- [x] **Repo**: `Vega_2.0`
- **Source**: `react-hook-candidates` descriptor and `definedLimitOption()`.
- **What**: Standalone candidate commands should cap by default and uncap with `--full`.
- **Change**: Run `react-hook-candidates --json` and `react-hook-candidates --full --json`.
- **Why**: Composite health behavior is not enough; individual commands also need predictable budget semantics.

### 3. Verify Invalid Option Guard

- [x] **Repo**: `Vega_2.0`
- **Source**: `scip-query plan-context definedLimitOption --full`.
- **What**: `--full` plus an explicit limit should fail instead of ambiguously choosing one.
- **Change**: Run `react-hook-candidates --full --limit 5 --json`.
- **Why**: Clear failure is part of graceful degradation.

### 4. Record the Result

- [x] **File**: `docs/validation/2026-06-21-performance-budget-behavior-result.md`
- **Source**: Commands above.
- **What**: Need a durable AVL-008 verdict.
- **Change**: Record timings, caps, warnings, count deltas, and residual risk.
- **Why**: Future optimization work should start from measured behavior, not vibes.

## Stress Test

- The slice is read-only outside scip-query docs; external repos were not modified.
- Stable had an existing dirty working tree; the result names that fact and treats the run as current-tree measurement.
- Vega was clean at the time of the run.

## Verification

- No code change is required for AVL-008.
- Standard scip-query gates still run after doc updates: `npm run typecheck`, `npm run build`, `npm test`, `./dist/cli.js reindex`, `./dist/cli.js diff-gate`.
