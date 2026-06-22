# Analyzer Precision Implementation Plan

Date: 2026-06-21

## Goal

Implement the first small set of analyzer precision fixes approved by `docs/validation/2026-06-21-analyzer-calibration-memo.md`. The user wants the analyzer validation work carried forward with judgments recorded. Done for this implementation slice means `dead --only-dead --json` is harder to misread, `new-dead` ignores compile-time contract assertions, and `echo` diff-gate findings are grouped and worded according to the evidence strength.

## Current State

`scip-query code DeadSummary --json` resolves `src/queries/cleanup/dead.ts:36`, where `DeadSummary` exposes `symbols`, `totalCount`, `deadCodeCount`, `fileInternalCount`, and `totalLoc`.

`scip-query trace deadSummary --json` resolves `src/queries/cleanup/dead.ts:189`, where `deadSummary()` builds `symbols`, classifies each row as `dead-code` or `file-internal`, and returns the current count fields.

`scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:1-120' --json` resolves `handleDead`, where the CLI splits `result.symbols` into `deadCode` and `fileInternal`, applies `--only-dead` / `--only-internal`, and adds JSON-only `shown` and `totals` fields.

`scip-query code summarizeHealthDead --json` resolves `src/queries/health/health.ts:320`, where health already filters dead results with `filterHealthDeadSymbols()`.

`scip-query code collectBaselineFindings --json` resolves `src/queries/health/health-baseline.ts:61`, where baseline collection already skips non-`dead-code` rows.

`scip-query trace runNewDeadCheck --json` resolves `src/queries/impact/diff-gate.ts:441`, where `new-dead` currently reports changed production symbols with fan-in 0 unless they are tests, entry surfaces, rooted symbols, or moved preexisting symbols.

`scip-query code 'src/queries/impact/diff-impact.ts:1-80' --json` resolves `DiffImpactResult`, where `changedSymbols` include symbol, short name, file, lines, and fan-in, but not symbol kind.

`scip-query code leafName --json` resolves `src/symbols/symbol-parser.ts:277`, and `scip-query code leafSuffix --json` resolves `src/symbols/symbol-parser.ts:291`. These functions expose SCIP descriptor identity and should be reused for type-contract filtering.

`scip-query code runEchoCheck --json` resolves `src/queries/impact/diff-gate.ts:177`, where `echo` currently emits one finding per similar match and always says to extend or reuse the established symbol.

`scip-query code SimilarSymbolResult --json` resolves `src/queries/cleanup/similar.ts:10`, where similarity output includes `similarityBasis`, `sharedCallees`, and unique evidence for both sides.

`scip-query code DiffGateFinding --json` resolves `src/queries/impact/diff-gate.ts:41`, where findings include severity, evidence, confidence, file/symbol, related files, message, why, remediation, and suppression hint.

`npm pkg get scripts` reports `test`, `typecheck`, and `build` scripts: `vitest run`, `tsc --noEmit`, and the `tsup` build command.

## Reuse Audit

Use existing symbols and patterns:

- Use `DeadSummary` and `deadSummary()` rather than creating a separate dead-output model.
- Use the existing `handleDead` JSON envelope site for `shown`/`totals` changes, because that is where command-specific display filtering already lives.
- Use `leafName()` and `leafSuffix()` from `src/symbols/symbol-parser.ts` instead of parsing SCIP symbol strings manually.
- Use `SimilarSymbolResult.similarityBasis`, `sharedCallees`, `uniqueToA`, and `uniqueToB` for echo wording rather than adding a new similarity query.
- Use `DiffGateFinding` as the output carrier; add only optional fields if grouping metadata is needed.

No equivalent helper already groups echo findings or identifies compile-time contract assertions. The implementation should add those as local diff-gate helpers first; extract later only if another gate needs them.

## Design Phases

### 1. Clarify Dead JSON Counts

- [x] **File**: `src/queries/cleanup/dead.ts:36-45`
- **Source**: `scip-query code DeadSummary --json`
- **What**: `DeadSummary` has top-level count fields but no nested machine-readable count object.
- **Change**: Add a backward-compatible `counts` object to `DeadSummary`, for example:

  ```ts
  counts: {
    total: number;
    deadCode: number;
    fileInternal: number;
    loc: number;
  }
  ```

  Keep existing `totalCount`, `deadCodeCount`, `fileInternalCount`, and `totalLoc` fields for compatibility.

- **Why**: Existing raw JSON can be misread when `symbols.length` includes file-internal inventory while `deadCodeCount` is 0.

### 2. Populate Dead Counts At The Source

- [x] **File**: `src/queries/cleanup/dead.ts:189-227`
- **Source**: `scip-query trace deadSummary --json`
- **What**: `deadSummary()` computes counts and returns only flat count fields.
- **Change**: Return the new `counts` object from the same computed values:

  ```ts
  counts: {
    total: symbols.length,
    deadCode: deadCodeCount,
    fileInternal: fileInternalCount,
    loc: totalLoc,
  }
  ```

- **Why**: The query result should carry unambiguous counts before command-specific filtering adds `shown`.

### 3. Clarify Dead Command JSON

- [x] **File**: `src/runtime/query-commands/cleanup/handlers.ts:26-61`
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:1-120' --json`
- **What**: `handleDead` adds `shown.deadCode`, `shown.fileInternal`, and `totals.deadCode` / `totals.fileInternal` to JSON output.
- **Change**: Extend JSON output with command-filtered counts:

  ```ts
  shownCounts: {
    total: shownDeadCode.length + shownFileInternal.length,
    deadCode: shownDeadCode.length,
    fileInternal: shownFileInternal.length,
    loc: shownDeadCodeLoc + shownFileInternalLoc,
  }
  ```

  Keep existing `shown` and `totals` for compatibility. If `totals` remains, include `total` and `loc` so it is not a partial count object.

- **Why**: Consumers need to distinguish total analyzer inventory from what this command invocation actually displayed under `--only-dead` or `--only-internal`.

### 4. Preserve Health And Baseline Semantics

- [x] **File**: `src/queries/health/health.ts:320-325`
- **Source**: `scip-query code summarizeHealthDead --json`
- **What**: Health already calls `filterHealthDeadSymbols(db, deadResult.symbols)`.
- **Change**: Do not change this behavior in the dead-output slice. Existing health tests passed after the change; no health scoring behavior was edited.
- **Why**: This implementation is output clarity, not a health scoring change.

- [x] **File**: `src/queries/health/health-baseline.ts:61-111`
- **Source**: `scip-query code collectBaselineFindings --json`
- **What**: Baseline collection already ignores non-`dead-code` symbols.
- **Change**: Do not change baseline finding identities in this slice.
- **Why**: Baseline ratchet behavior is already aligned with the verdict review; the problem is command JSON clarity.

### 5. Filter Compile-Time Contract Assertions From New-Dead

- [x] **File**: `src/queries/impact/diff-gate.ts:441-474`
- **Source**: `scip-query trace runNewDeadCheck --json`; `scip-query code leafName --json`; `scip-query code leafSuffix --json`
- **What**: `runNewDeadCheck()` reports any changed, zero-fan-in production symbol that is not rooted or an entry surface. It reported `_AssertNotificationRowContract`, a type-level compile-time assertion.
- **Change**: Import `leafName` and `leafSuffix` from `src/symbols/symbol-parser.ts`. Add a local helper such as `isCompileTimeContractAssertion(symbol: string): boolean` that returns true when:
  - `leafSuffix(symbol) === 'type'`
  - `leafName(symbol)` starts with `_Assert` or `Assert`

  Skip those symbols before emitting a `new-dead` finding.

- **Why**: Type-level assertion aliases can intentionally have no runtime consumers while still protecting DTO contracts at compile time.

### 6. Group Echo Findings By Changed Symbol

- [x] **File**: `src/queries/impact/diff-gate.ts:177-222`
- **Source**: `scip-query code runEchoCheck --json`; `scip-query code SimilarSymbolResult --json`
- **What**: `runEchoCheck()` emits one finding per similar match. In the verdict review, one changed helper produced several pairwise duplicate rows that represented one root cause.
- **Change**: For each changed symbol, collect eligible matches where `otherFile` is outside the diff. Emit at most one grouped finding for that changed symbol. The grouped finding should:
  - set `relatedFiles` to all matched outside files, sorted and deduped
  - compute confidence as the highest match similarity
  - include `why` lines for the top matches and their shared evidence
  - build the id from the changed symbol, changed file, and sorted related symbols/files
- **Why**: Pairwise duplicate reports inflate finding counts and make one helper look like multiple independent failures.

### 7. Soften Echo Remediation When Evidence Is Contextual

- [x] **File**: `src/queries/impact/diff-gate.ts:177-222`
- **Source**: `scip-query code runEchoCheck --json`; `scip-query code SimilarSymbolResult --json`
- **What**: Echo remediation always says to extend or reuse the established symbol.
- **Change**: Add a local helper that classifies echo evidence:
  - `direct` when `similarityBasis === 'source-tokens'` and similarity is very high, or when shared evidence is a tiny exact helper pattern.
  - `signal` otherwise.

  Direct rows can keep reuse language. Signal rows should say: "Review whether the changed symbol is intentionally parallel to the established implementation, or extract the shared behavior if the product semantics match."

- **Why**: The verdict review found false positives where code shared random-token, access, or query scaffolding but represented different domain operations.

### 8. Keep The Finding Shape Backward Compatible

- [x] **File**: `src/queries/impact/diff-gate.ts:41-57`
- **Source**: `scip-query code DiffGateFinding --json`
- **What**: `DiffGateFinding` has no grouping or action-tier fields.
- **Change**: Prefer not to change the interface for this slice. If grouping metadata is necessary, add optional fields only, such as `groupKey?: string` and `actionTier?: 'direct' | 'signal' | 'support'`.
- **Why**: Diff-gate consumers read `message`, `why`, and `remediation`; the first precision fix should avoid broad API churn.

### 9. Add Focused Regression Coverage

- [x] **File**: `tests/queries/cleanup/dead-output.test.ts`
- **Source**: `scip-query files '*test*' --json`; `npm pkg get scripts`
- **What**: Indexed file search found no current `*test*` files, but `npm test` runs `vitest run`.
- **Change**: Add a focused test for dead output shaping. The implemented test asserts the query-level count contract and the dead-code vs file-internal split that the command JSON now exposes through `shownCounts`.
- **Why**: The bug is a consumer-counting trap; a regression should lock the JSON contract.

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: `scip-query files '*test*' --json`; `npm pkg get scripts`
- **What**: Diff-gate coverage already lives beside the incomplete-migration fixture, which has a real git diff and similar call patterns.
- **Change**: Added focused tests for:
  - `_Assert*` type aliases do not produce `new-dead`
  - echo emits one grouped finding for one changed symbol with multiple outside matches
  - grouped echo exposes action-tier metadata and direct rows keep reuse language
- **Why**: These are the exact verdict-review regressions.

## Stress-Test Findings

1. Understand before touching: source anchors show the dead issue is partly query output and partly command JSON shaping.
2. Blast radius: dead changes affect exported JSON; keep old flat fields and `shown` for compatibility.
3. Intermediate validity: implement dead output first; it can ship without the diff-gate changes.
4. Reversibility: all behavior changes are additive except filtered `new-dead` findings and grouped echo rows.
5. Failure design: if echo grouping is uncertain, emit fewer but clearer warnings rather than more direct repair claims.
6. Concurrency: no shared mutable runtime state is introduced.
7. Boundaries: diff-gate output is a CLI/API boundary; keep existing fields stable.
8. Data integrity: no data persistence changes.
9. Observability: grouped echo findings should include enough `why` evidence to inspect the grouped matches.
10. Human use: remediation wording should separate "do this" from "review this."
11. Reuse: use `leafName`, `leafSuffix`, existing similarity evidence, and existing dead command shaping.

## Execution Order

1. Implement dead counts and command `shownCounts`.
2. Add or adapt focused dead output coverage.
3. Add `new-dead` compile-time contract assertion filter.
4. Add or adapt focused `new-dead` coverage.
5. Group echo findings by changed symbol.
6. Soften echo remediation based on evidence class.
7. Add or adapt focused echo coverage.
8. Run `npm run typecheck`.
9. Run `npm test`.
10. Run `npm run build`.
11. Run `scip-query reindex`.
12. Run `scip-query diff-gate --json`.

## Ship Order

Ship these as one small precision PR or as three commits:

1. Dead JSON clarity.
2. New-dead type-contract filter.
3. Echo grouping and remediation wording.

The one possible compatibility concern is consumers expecting only `totals.deadCode` and `totals.fileInternal`. Keep those fields and add new fields rather than replacing them.

## Summary

Planned production files:

- `src/queries/cleanup/dead.ts`
- `src/runtime/query-commands/cleanup/handlers.ts`
- `src/queries/impact/diff-gate.ts`

Planned test files:

- `tests/queries/cleanup/dead-output.test.ts`
- `tests/queries/impact/diff-gate-calibration.test.ts`

This plan does not change health score weights yet. Score changes wait for the second-repo confirmation described in the calibration memo.

## Implementation Result

Implemented on 2026-06-21. The detailed result is recorded in `docs/validation/2026-06-21-analyzer-precision-implementation-result.md`.
