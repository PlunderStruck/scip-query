# Suppression Comment Inventory Fix

## Gate A — Goal

The user needs the health report to count real detector suppressions, not code strings or documentation examples that merely mention suppression syntax. Done means `health --full` reports suppression totals from actual suppression comments only, and detector suppression checks use the same interpretation.

## Gate B — Current Flow

- [x] **File**: `src/analysis/suppressions.ts:37-67`
- **Source**: `scip-query plan-context getSuppressionInventory`; `scip-query code 'src/analysis/suppressions.ts:1-90'`.
- **What**: `getSuppressionInventory` delegates to `scanSuppressions`, which reads every source file from `getSourceFiles`/`getSourceText` and runs a broad raw-text regex over the whole file.
- **Change**: Replace whole-file raw-text matching with line-based matching that only accepts comment lines whose comment body starts with `scip-query: ignore...`.
- **Why**: String literals such as generated `suppressionHint` values and prose such as backticked examples are referents of documentation or UI text, not suppression directives.

- [x] **File**: `src/source/source-text.ts:43-72`
- **Source**: `scip-query code 'src/source/source-text.ts:1-80'`; `scip-query affected hasSuppressionComment`.
- **What**: `hasSuppressionComment` walks nearby lines before a definition but uses the same broad substring-style suppression regex.
- **Change**: Tighten the matcher to the same directive-comment shape used by the inventory.
- **Why**: The inventory and the detectors should share the same boundary between real suppression comments and examples that mention the syntax.

- [x] **Consumers**: `src/queries/health.ts:415-419`, `src/queries/plan-context.ts:147-170`, `src/queries/stale-abstractions.ts:150-165`, `src/queries/cleanup-plan.ts:83-94`
- **Source**: `scip-query code summarizeSuppressions -C 8`; `scip-query code buildPlanContextHistory -C 8`; `scip-query code 'src/queries/stale-abstractions.ts:150-175'`; `scip-query code 'src/queries/cleanup-plan.ts:80-100'`.
- **What**: Health reports suppression totals, plan-context reports suppressions in the target file, and stale/cleanup filters suppress definitions through `hasSuppressionComment`.
- **Change**: Keep these consumers unchanged and verify behavior through the updated matcher.
- **Why**: This is a bug in suppression recognition, not a change to health scoring or downstream query contracts.

## Gate C — Reuse Audit

- [x] **Existing source loading**: Reuse `getSourceFiles` and `getSourceText`; `scip-query code getSourceFiles -C 10` and `scip-query code getSourceText -C 10` show the scanner already reads relative project paths from the index/on-disk sources.
- [x] **Existing suppression matcher**: Extend the existing matcher in `src/source/source-text.ts:43-72` rather than adding a new public suppression subsystem; `scip-query similar getSuppressionInventory` found cache/scan similarities but no reusable directive parser.

## Implementation

1. [x] In `src/source/source-text.ts:43-72`, change `SUPPRESS_COMMENT_RE` so it anchors to the start of a line after optional comment markers (`//`, `#`, `/*`, `*`) and only matches when the directive begins the comment body.
2. [x] In `src/analysis/suppressions.ts:30-67`, use the same directive-comment regex shape and iterate source lines, preserving category normalization and per-file totals.
3. [x] Add a regression test that writes a temp source file containing a string literal, JSDoc prose, and real `// scip-query...` comments, then verifies only the real comments are counted.

## Verification

1. [x] Run focused Vitest coverage for the suppression inventory and health full tests.
2. [x] Run `npm run typecheck`.
3. [x] Run `scip-query reindex`.
4. [x] Run `scip-query health --full --json` to inspect the new suppression count.
5. [x] Run `scip-query diff-gate` and address or explicitly accept findings.
