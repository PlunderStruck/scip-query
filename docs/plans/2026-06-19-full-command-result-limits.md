# Full Command Result Limits

## Gate A — Goal

The user needs `health --full` counts and the matching detail commands to agree. Done means a command such as `wrapper-candidates --full` does not silently stop at its default `--limit 30` when health counted more results. An explicit `--limit` still remains a user-chosen cap.

## Gate B — Current Flow

- [x] **File**: `src/queries/health.ts:461-494`
- **Source**: `scip-query code healthBudget -C 20`.
- **What**: `health --full` sets candidate and complexity result limits to `Number.POSITIVE_INFINITY`, so health can count every candidate.
- **Change**: Keep this behavior unchanged.
- **Why**: Health full mode is already doing the right thing.

- [x] **File**: `src/runtime/query-commands/cleanup.ts:178-231`
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup.ts:152-231'`.
- **What**: `extract-candidates`, `wrapper-candidates`, `passthrough-candidates`, and `stale-abstractions` pass `definedNumberOption(opts, 'limit', 20|30)` into their queries even when `--full` was supplied.
- **Change**: Use a shared full-aware limit helper so default limits become unbounded under `--full`, while explicit `--limit` values still apply.
- **Why**: These commands are the detail views users run after health reports extraction, wrapper, passthrough, or stale-abstraction counts.

- [x] **File**: `src/runtime/query-commands/cleanup.ts:233-310`, `src/runtime/query-commands/cleanup.ts:411-418`, `src/runtime/query-commands/cleanup.ts:604-611`, `src/runtime/query-commands/cleanup.ts:666-671`
- **Source**: `scip-query code handleSimilar -C 8`; `scip-query code handleComplexityHotspots -C 8`; `scip-query code handleSimilarSignatures -C 12`; `scip-query code handleRecentDuplicates -C 8`; `scip-query code handleUnusedParams -C 8`.
- **What**: Similar, complexity, recent-duplicates, unused-params, and similar-signatures also have both `--full` and default result limits.
- **Change**: Apply the same helper to every `--full` command whose query receives `limit`.
- **Why**: The same kind of mismatch should not reappear in another candidate command.

- [x] **File**: `src/runtime/command-execution.ts:192-208`
- **Source**: `scip-query code definedNumberOption -C 10`; `scip-query code numberOptionValue -C 8`.
- **What**: Existing option helpers can read numeric and boolean options, but there is no helper that expresses “explicit limit beats full; full beats fallback.”
- **Change**: Add one exported helper for full-aware limits.
- **Why**: One central helper makes the command contract consistent and testable.

## Gate C — Reuse Audit

- [x] **Existing option helpers**: Reuse `numberOptionValue`, `booleanOptionValue`, and `definedNumberOption` patterns from `src/runtime/command-execution.ts:192-208`; no existing helper implements full-aware limits.
- [x] **Existing health full behavior**: Reuse the health budget semantics from `src/queries/health.ts:461-494` instead of changing health scoring or detector profiles.

## Implementation

1. [x] Add `definedLimitOption(opts, key, fallback)` to `src/runtime/command-execution.ts:192-208`, returning an explicit numeric option if present, `Number.POSITIVE_INFINITY` when `opts.full` is true, otherwise the fallback.
2. [x] Update all cleanup command handlers that combine `--full` and `limit` to use `definedLimitOption`: unused-params, recent-duplicates, similar, extract-candidates, wrapper-candidates, passthrough-candidates, stale-abstractions, complexity-hotspots, and similar-signatures.
3. [x] Add tests for the helper semantics and a contract guard that prevents raw `definedNumberOption(opts, 'limit', ...)` from returning to `src/runtime/query-commands/cleanup.ts`.

## Verification

1. [x] Run focused tests covering command contracts and CLI support.
2. [x] Run `npm run typecheck`.
3. [x] Run `npm test`.
4. [x] Run `scip-query reindex`.
5. [x] Run `scip-query diff-gate`.
