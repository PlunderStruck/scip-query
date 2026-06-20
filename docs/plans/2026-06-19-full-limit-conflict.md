# Full Limit Conflict

## Gate A — Goal

`--full` should mean a complete result set, and `--limit` should mean a capped result set. Done means commands reject an explicit `--full --limit N` combination, while still ignoring Commander default limits under `--full`.

## Gate B — Current Flow

- [x] **File**: `src/runtime/command-execution.ts:214-218`
- **Source**: `scip-query plan-context definedLimitOption`; `scip-query code definedLimitOption -C 12`.
- **What**: `definedLimitOption` returns an explicit limit when the option source is not `default`; otherwise it returns `Infinity` under `--full` or the fallback limit without `--full`.
- **Change**: If `--full` is true and `limit` was explicitly supplied, throw a clear option conflict error.
- **Why**: Full and limit are opposite result-set contracts; accepting both makes the CLI harder to reason about.

- [x] **File**: `src/runtime/query-commands/cleanup.ts:158-670`
- **Source**: `scip-query refs definedLimitOption`.
- **What**: Ten cleanup/detail commands call `definedLimitOption`, so the validation can be centralized.
- **Change**: Keep command handlers unchanged.
- **Why**: One shared rule keeps wrapper/stale/similar/extract and the other full-capable commands consistent.

- [x] **File**: `tests/cli-contract.test.ts:120-135`
- **Source**: `scip-query refs definedLimitOption`; local test file already covers the helper behavior.
- **What**: Tests currently assert explicit `full + limit` is accepted.
- **Change**: Assert it throws for explicit limits, while Commander default limits remain ignored under `--full`.
- **Why**: This protects the exact bug class: defaults are not user intent, explicit limits are.

## Gate C — Reuse Audit

- [x] Reuse `optionValueSource` from `src/runtime/command-execution.ts:220-222` to distinguish Commander defaults from user-supplied values.
- [x] Reuse the existing `definedLimitOption` call sites instead of adding per-command checks.

## Implementation

1. [x] Update `definedLimitOption` to throw when `full` and an explicit limit are both present.
2. [x] Update CLI contract tests for the new conflict rule.

## Verification

1. [x] Run focused CLI contract tests.
2. [x] Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
3. [x] Run `npm install -g .`.
4. [x] Verify `scip-query wrapper-candidates --full --limit 7 --json` fails in `Stable_Management`.
5. [x] Verify `scip-query wrapper-candidates --full --json` returns the uncapped `37` wrapper candidates in `Stable_Management`.
6. [x] Verify `scip-query wrapper-candidates --json` keeps the default capped `30` wrapper candidates in `Stable_Management`.
7. [x] Run `scip-query reindex` and `scip-query diff-gate`.
8. [x] Run `git diff --check`.
