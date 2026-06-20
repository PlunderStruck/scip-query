# Health Score Accuracy And Full Limits Plan

Date: 2026-06-19

## Goal

Make health scoring fairer without blinding the scanner. A reported frontend behavior candidate is a possible reuse lead; a score-charged candidate is the subset of those leads whose evidence still points at missing extraction rather than already-shared infrastructure. Done means React/Vue behavior commands can continue to over-report for discovery, while `health` uses a score-weighted count that moves when real duplicated behavior is removed. Done also means every command with a default result `--limit` can be run uncapped with `--full`, using the central `definedLimitOption()` conflict rule.

## Current State

- `health()` accepts `{ scope, full }` and calls `runHealthAnalyses()` under a health budget. Source: `scip-query plan-context health` (`src/queries/health.ts:195-203`).
- `runHealthAnalyses()` builds phase results and `summarizeReactHookCandidates()` currently summarizes raw `reactHookCandidates()` rows with `summarizePairLoc()`. Source: `scip-query code 'src/queries/health.ts:340-520'` (`src/queries/health.ts:418-430`).
- `buildHealthReport()` publishes raw finding counts and `computeHealthScore()` deducts from raw React/Vue behavior counts. Source: `scip-query plan-context buildHealthReport` and `scip-query code computeHealthScore -C 12` (`src/queries/health-report.ts:108-153`, `src/queries/health-report.ts:579-597`, `src/queries/health-report.ts:668-703`).
- `reactHookCandidates()` keeps rich evidence: `sharedHooks`, `sharedReactHooks`, `sharedState`, `sharedRequests`, `sharedHandlers`, and `sharedHandlerVerbs`. Source: `scip-query code 'src/queries/react-hook-candidates.ts:80-190'`.
- `vueComposableCandidates()` keeps equivalent rich evidence: `sharedComposables`, `sharedStores`, `sharedRequests`, `sharedLifecycle`, `sharedFunctions`, `sharedFunctionVerbs`, and `sharedBindings`. Source: `scip-query code 'src/queries/vue-composable-candidates.ts:80-202'`.
- `definedLimitOption()` already implements the desired `--full` semantics: explicit `--full --limit` throws, and `--full` returns `Number.POSITIVE_INFINITY`. Source: `scip-query code definedLimitOption -C 8` (`src/runtime/command-execution.ts:214-224`).
- Several capped commands still expose default limits without `--full` and use `definedNumberOption()`: `doc-drift`, `similar-files`, `similar-chains`, `redundant-reexports`, `hotspots`, top-mode `fan-in`, top-mode `fan-out`, top-mode `coupling`, `deep-chains`, `incomplete-migration`, and `co-change`. Sources: `scip-query code 'src/runtime/query-commands/cleanup.ts:863-1266'`, `scip-query code 'src/runtime/query-commands/graph.ts:143-257'`, `scip-query code 'src/runtime/query-commands/impact.ts:184-255'`, plus handler reads for `handleDocDrift`, `handleSimilarFiles`, `handleSimilarChains`, `handleIncompleteMigration`, and `handleCoChange`.

## Reuse Audit

- Reuse `definedLimitOption()` for all default result limits; do not create another full/limit parser. Source: `scip-query code definedLimitOption -C 8`.
- Reuse `CountLocSummary` for frontend health summaries by extending it additively with an optional `scoreCount`; do not create a parallel report type. Source: `scip-query code HealthAnalyses -C 8` and `scip-query code summarizePairLoc -C 8`.
- Reuse the existing rich candidate evidence arrays; do not change the candidate command output or suppress rows. Source: `scip-query code 'src/queries/react-hook-candidates.ts:80-190'` and `scip-query code 'src/queries/vue-composable-candidates.ts:80-202'`.

## Design Phases

### 1.1 - Add Score-Weighted Frontend Behavior Counts

- [ ] **File**: `src/queries/health-types.ts:39-44`
- **Source**: `scip-query code HealthAnalyses -C 8`
- **What**: `CountLocSummary` stores raw `count`, `loc`, and optional contributing `files`.
- **Change**: Add optional `scoreCount?: number` with a comment saying it is the score-pressure count and raw `count` remains the reported finding count.
- **Why**: Health can report all candidates while charging only actionable pressure.

### 1.2 - Compute Behavior Candidate Score Counts

- [ ] **File**: `src/queries/health.ts:418-476`
- **Source**: `scip-query code 'src/queries/health.ts:340-520'`
- **What**: React hook and Vue composable health phases call the candidate commands and summarize raw pair counts.
- **Change**: Add local scoring helpers and set `scoreCount` on only `reactHookCandidates` and `vueComposableCandidates`. Use full weight for pairs with concrete request/state/function behavior and no dominant existing shared abstraction; use a small fractional weight for pairs dominated by existing hooks/stores/composables so the signal remains visible but does not overwhelm hygiene.
- **Why**: Existing shared infrastructure is a real clue but not equivalent to missing extraction.

### 1.3 - Use Score Counts In Health Deductions

- [ ] **File**: `src/queries/health-report.ts:318-340` and `src/queries/health-report.ts:579-597`, `src/queries/health-report.ts:668-703`
- **Source**: `scip-query code buildHealthActions -C 12` and `scip-query code computeHealthScore -C 12`
- **What**: Actions and score breakdowns describe/deduct from raw counts.
- **Change**: Add `scoreCount()`/format helpers; use score-weighted counts for React hook and Vue composable deductions/pressure. Keep raw finding counts in `findings`.
- **Why**: Score becomes fair and measurable while CLI/JSON still reveal the uncapped raw findings.

### 2.1 - Wire `--full` Into Capped Cleanup Commands

- [ ] **File**: `src/runtime/query-commands/cleanup.ts:313-321`, `src/runtime/query-commands/cleanup.ts:519-527`, `src/runtime/query-commands/cleanup.ts:817-825`, `src/runtime/query-commands/cleanup.ts:986-1264`
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup.ts:863-1266'`, `scip-query code handleDocDrift -C 8`, `scip-query code handleSimilarFiles -C 8`, `scip-query code handleSimilarChains -C 8`
- **What**: `doc-drift`, `similar-files`, `similar-chains`, and `redundant-reexports` have default limits but no full override.
- **Change**: Add `--full` descriptors and replace result-limit parsing with `definedLimitOption()`.
- **Why**: Every capped result list gets the same uncapped contract.

### 2.2 - Wire `--full` Into Capped Graph And Impact Commands

- [ ] **File**: `src/runtime/query-commands/graph.ts:17-135`, `src/runtime/query-commands/graph.ts:143-236`, `src/runtime/query-commands/impact.ts:41-91`, `src/runtime/query-commands/impact.ts:225-252`
- **Source**: `scip-query code 'src/runtime/query-commands/graph.ts:33-118'`, `scip-query code 'src/runtime/query-commands/graph.ts:143-257'`, `scip-query code handleIncompleteMigration -C 8`, `scip-query code handleCoChange -C 8`
- **What**: graph top-list commands and impact candidate commands use default limits without full override.
- **Change**: Import/use `definedLimitOption()` in graph and impact; add `--full` options where default result limits exist.
- **Why**: `--full` should mean uncapped results everywhere users see a default cap.

### 3.1 - Test The Contracts

- [ ] **File**: `tests/health-full.test.ts`, `tests/cli-contract.test.ts`, plus focused command tests as needed
- **Source**: `rg --files tests` for available test files; production behavior sources above.
- **What**: Existing tests cover some full health behavior and CLI descriptors.
- **Change**: Add tests proving frontend behavior `scoreCount` can be lower than raw count, score breakdown uses it, all default `--limit` descriptors include `--full`, and `--full --limit` rejects on newly wired commands.
- **Why**: Prevent another command from silently drifting away from the full-limit contract.

## Stress Test

- Understand before touching: the candidate commands are exploratory finders; scoring is an opinionated summary. The plan keeps those jobs separate.
- Blast radius: change-surface marks the command modules and health report modules as medium risk because their descriptor arrays and exported report shape are consumed by the CLI. Sources: `scip-query change-surface src/runtime/query-commands/cleanup.ts --full`, `scip-query change-surface src/runtime/query-commands/graph.ts --full`, `scip-query change-surface src/runtime/query-commands/impact.ts --full`, `scip-query change-surface src/queries/health.ts --full`, `scip-query change-surface src/queries/health-report.ts --full`.
- Intermediate state: command descriptors and handlers must change together; adding only help text would lie.
- Reversibility: additive `scoreCount` is a two-way door; switching limit parsing to `definedLimitOption()` is internal CLI behavior and reversible.
- Boundary: CLI input validation is centralized by `definedLimitOption()`, so the new commands inherit the existing `--full --limit` error.
- Reuse: no new parser and no new candidate detector; reuse existing evidence arrays.

## Execution Order

1. Update health summary/report scoring.
2. Update command handlers/descriptors.
3. Add tests.
4. Run focused tests, then `scip-query reindex && scip-query diff-gate`.

## Summary

Expected modified files: `src/queries/health-types.ts`, `src/queries/health.ts`, `src/queries/health-report.ts`, `src/runtime/query-commands/cleanup.ts`, `src/runtime/query-commands/graph.ts`, `src/runtime/query-commands/impact.ts`, and focused tests/docs if assertions or command reference output require updates.
