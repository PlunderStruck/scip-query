# Root-Cause Grouping Plan

Date: 2026-06-22

## Goal

Repeated duplicate and baseline rows should not look like independent maintenance problems when they are evidence for the same repair. A root-cause group is a review item made from analyzer findings that point at one underlying cause; its essential trait is that one repair or one explicit acceptance should retire the grouped rows together. Done means duplicate-family output and diff-gate baseline output expose optional group summaries while preserving the existing flat findings for compatibility.

## Current State

- `src/queries/cleanup/recent-duplicates.ts:18-43` defines pairwise `RecentDuplicateFinding` rows and a `RecentDuplicatesResult` that contains only `findings`. Source: `node dist/cli.js code 'src/queries/cleanup/recent-duplicates.ts:1-240' --json`.
- `src/queries/cleanup/recent-duplicates.ts:85-123` orients duplicate pairs as `echo` or `twin`, sorts them, and returns the top findings without root-cause groups. Source: `node dist/cli.js code recentDuplicates --json`.
- `src/runtime/query-commands/cleanup/handlers.ts:804-849` renders `recent-duplicates` as one text block per pair, so repeated pairs can read as independent debt. Source: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:760-850' --json`.
- `src/queries/impact/diff-gate.ts:45-96` already gives each `DiffGateFinding` optional `groupKey`, `sourceAnalyzer`, and `rootCauseKey`, but `DiffGateResult` exposes only flat findings. Source: `node dist/cli.js code DiffGateFinding --json`; `node dist/cli.js code DiffGateResult --json`.
- `src/queries/impact/diff-gate.ts:737-775` makes baseline findings inherit analyzer metadata and sets `groupKey` to `baseline:${metadata.sourceAnalyzer}:${metadata.rootCauseKey}`. Source: `node dist/cli.js code runBaselineCheck --json`.
- `src/runtime/query-commands/impact.ts:162-218` renders each diff-gate finding directly and does not summarize grouped root causes. Source: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:140-240' --json`.
- `src/runtime/agent-setup.ts:52-63` formats hook blocking output from `DiffGateResult.findings`, so it should stay compatible with flat findings even if group metadata is added. Source: `node dist/cli.js code 'src/runtime/agent-setup.ts:1-90' --json`.

## Reuse Audit

- `recentDuplicates()` has no existing result-grouping helper. `node dist/cli.js similar recentDuplicates --json` found shared query scaffolding with other analyzers, not a root-cause grouping implementation.
- `DiffGateResult` has no existing group summary shape. `node dist/cli.js similar DiffGateResult --json` returned no rows.
- `runBaselineCheck()` already computes `groupKey` and `rootCauseKey`; reuse those fields instead of re-parsing baseline strings in a second place. Source: `node dist/cli.js code runBaselineCheck --json`; `node dist/cli.js code baselineFindingMetadata --json`.
- Existing command output should be extended in place because `recent-duplicates` is consumed only by `src/queries/index.ts` and `src/runtime/query-commands/cleanup/handlers.ts`, while `diff-gate.ts` is consumed by `src/queries/index.ts`, `src/runtime/agent-setup.ts`, and `src/runtime/query-commands/impact.ts`. Source: `node dist/cli.js rdeps src/queries/cleanup/recent-duplicates.ts --json`; `node dist/cli.js rdeps src/queries/impact/diff-gate.ts --json`.

## Design

### 1.1 - Add duplicate root-cause metadata

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:18-43`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/recent-duplicates.ts:1-240' --json`
- **What**: Duplicate output has pairwise rows only.
- **Change**: Add optional `groupKey` and `rootCauseKey` to `RecentDuplicateFinding`. Add optional `rootCauseGroups` to `RecentDuplicatesResult`, with a new exported `RecentDuplicateRootCauseGroup` summary containing the group key, kind, domain, basis, count, max similarity, representative symbols/files, related files, finding indexes, shared evidence, and recommendation.
- **Why**: JSON consumers can count review items separately from raw pair evidence.

### 1.2 - Build duplicate groups after orientation

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:85-123`
- **Source**: `node dist/cli.js code recentDuplicates --json`
- **What**: `recentDuplicates()` sorts and slices oriented findings without grouping.
- **Change**: Compute group keys after orientation and before returning. Echo groups should use the established side as the root cause because many new echoes can duplicate the same owner. Twin groups should use domain, basis, and shared-evidence fingerprint because both sides are new and no established owner exists yet.
- **Why**: This groups the exact repeated-pair family called out in the validation review while keeping the old `findings` array intact.

### 1.3 - Render duplicate groups in text output

- [x] **File**: `src/runtime/query-commands/cleanup/handlers.ts:804-849`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:760-850' --json`
- **What**: Text output lists every pair directly.
- **Change**: Print a compact root-cause group section before pair rows when any group has more than one finding. Keep the existing pair rows below it.
- **Why**: Human reviewers should see the smaller review-item count before reading pair evidence.

### 2.1 - Add diff-gate root-cause summaries

- [x] **File**: `src/queries/impact/diff-gate.ts:45-96`
- **Source**: `node dist/cli.js code DiffGateFinding --json`; `node dist/cli.js code DiffGateResult --json`
- **What**: Findings can carry `groupKey`, but the result has no group list.
- **Change**: Add exported `DiffGateRootCauseGroup` and optional `rootCauseGroups` to `DiffGateResult`. Build groups from unsuppressed findings after `applyStructuredSuppressions()`.
- **Why**: Baseline and echo rows can be counted as grouped review items without dropping the existing flat list or suppression behavior.

### 2.2 - Render diff-gate groups for CLI and hooks

- [x] **File**: `src/runtime/query-commands/impact.ts:162-218`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:140-240' --json`
- **What**: CLI text prints one row per finding.
- **Change**: Print root-cause groups before finding rows when grouping reduces the count. Keep JSON output as the full object. Optionally let hook output include the grouped count while still listing every finding for actionable remediation.
- **Why**: Diff-gate should be strict about new debt while avoiding inflated independent-failure language.

### 2.3 - Add regression coverage

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: Production behavior anchored by `node dist/cli.js code recentDuplicates --json`, `node dist/cli.js code runBaselineCheck --json`, and existing diff-gate fixture usage in this test file.
- **What**: Existing tests assert pairwise echo grouping and baseline metadata, but not result-level root-cause groups.
- **Change**: Add focused assertions that `recentDuplicates()` groups multiple echoes against one established symbol, and that `diffGate()` emits `rootCauseGroups` for baseline findings. Update the hook formatting test only if the required `DiffGateResult` object shape changes.
- **Why**: The validation slice should be protected by behavior tests, not only docs.

## Stress Test

- Understand before touching: `recent-duplicates` orients similarity pairs with git age; `diff-gate` wraps baseline strings into structured findings. Sources: `plan-context recentDuplicates`, `plan-context diffGate`, and code excerpts above.
- Blast radius: Both result interfaces are public query surfaces. Optional fields avoid breaking existing consumers.
- Intermediate validity: Add metadata fields first, then render them. Existing flat findings stay unchanged.
- Reversibility: This is additive output metadata; rollback removes optional fields and text summaries.
- Failure design: Empty findings and unavailable git history should return empty or absent group arrays, matching current no-finding behavior.
- Concurrency: No shared mutable state beyond local arrays.
- Boundaries: CLI input remains unchanged; JSON output only gains optional fields.
- Data integrity: No persisted schema or baseline-file format change.
- Observability: Reviewers can compare raw finding count with grouped root-cause count.
- Human impact: Text output should make the grouped review item obvious without hiding pair evidence.
- Reuse: Reuse existing `groupKey`, `rootCauseKey`, and orientation metadata; no new package-level abstraction.

## Execution Order

1. Add recent-duplicates grouping types, group-key assignment, and group builder.
2. Update recent-duplicates text output and tests.
3. Add diff-gate grouping types, group builder, and result wiring after suppressions.
4. Update diff-gate text/hook output and tests.
5. Record validation result and update the ledger/protocol docs.
6. Run focused tests, typecheck, build, full test suite, reindex, and diff-gate.

## Ship Order

This is one backward-compatible output slice. It has no one-way door because it adds optional metadata and text summaries only.

## Summary

Expected files: `src/queries/cleanup/recent-duplicates.ts`, `src/queries/impact/diff-gate.ts`, cleanup and impact command renderers, focused tests, and validation documentation.
