# Co-Change Recency and Broad-Sweep Context Result

Date: 2026-06-22

Plan: `docs/plans/2026-06-22-co-change-recency-sweep.md`

## Scope

This slice implements the co-change follow-up that asked for broad-feature-sweep and recency context. A broad feature sweep is a commit that changes many files or directory areas as part of one work batch; it can make a pair look coupled even when the files were only swept into the same migration, release, or cleanup. Recency context is the age and count of the pair's latest shared commits within the analyzed history window; it distinguishes current coordination pressure from stale historical correlation.

## Implementation

- Added `CoChangeCommitScope` and `CoChangeRecency` to git-history pair evidence.
- Added pair-level context fields: `focusedTogether`, `broadTogether`, `broadCommitRatio`, `lastTogetherAt`, `recentTogether`, `commitScope`, and `recency`.
- Classified pair history as `focused`, `mixed`, or `broad-sweep` from the commits that actually contributed to the pair count.
- Classified recency relative to the newest analyzed commit timestamp, keeping fixtures deterministic instead of dependent on wall-clock time.
- Stopped declared-coupling suggestions for stale or broad-sweep pairs while keeping the raw co-change signal visible.
- Carried commit scope and recency into standalone `co-change`, diff-gate `co-change-partner`, CLI text output, and health hidden-coupling summaries.
- Added diff-gate explanation lines for broad-sweep and stale history caveats.
- Added regression coverage for focused/recent, broad-sweep/recent, and focused/stale pair history.

2026-06-22 note: the later `diff-gate.ts` doc-reference same-diff fix does not change the co-change commit-scope or recency behavior described here.

2026-06-22 note: the later health full-default change in `src/queries/health/health.ts` does not change how commit scope or recency flow into health hidden-coupling summaries.

## Verification

- `npx vitest run tests/analysis/git-history.test.ts` passed: 1 file, 10 tests.
- `npx vitest run tests/queries/impact/co-change-partner-labels.test.ts` passed: 1 file, 2 tests.
- `npx prettier --check src/analysis/git-history.ts src/queries/impact/co-change.ts src/queries/impact/diff-gate.ts src/runtime/query-commands/impact.ts src/queries/health/health.ts src/queries/health/health-types.ts tests/analysis/git-history.test.ts tests/queries/impact/co-change-partner-labels.test.ts docs/plans/2026-06-22-co-change-recency-sweep.md` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js similar isBroadCoChangeCommit --json` and `node dist/cli.js similar coChangeHistorySummary --json` returned no rows.
- `node dist/cli.js recent-duplicates --json` returned no findings and no root-cause groups.
- `node dist/cli.js co-change --json` returned no current hidden-coupling findings in this repository.
- `node dist/cli.js unused-params --json`, `wrapper-candidates --json`, `passthrough-candidates --json`, `cycles --json`, and `isolated --json` returned no findings.
- `node dist/cli.js dead --only-dead --json` reported `deadCodeCount: 0`.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `npm test` passed: 66 files, 333 tests. The run still prints the known noisy `git diff` warning from the existing incomplete-migration fixture.
- `node dist/cli.js reindex` rebuilt the TypeScript index successfully.
- `node dist/cli.js diff-gate --json` exited 1 with the same two accepted warning-level findings:
  - `SQ36D93309ABEA`: signal-tier echo between `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()`. Accepted because both use symbol leaf helpers but make different product decisions.
  - `SQ30E6CF5F9B38`: support-tier README `configuration-example` citation for declared-coupling docs. Accepted because the README example still points at the intended cleanup files and does not require a doc edit for this slice.

## Judgment

Verdict: implemented. Co-change remains a contextual signal, but the output now says whether the history came from focused repeated edits, a mixed history, or broad sweeps, and whether the pair is still current in the analyzed history window. That keeps real coordination warnings visible without treating stale or broad batch history as equally strong declared-coupling evidence.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the `diff-gate.ts` citation in this result. Commit-scope and recency propagation into diff-gate output are unchanged; the slice only centralized finding emission after those fields are assembled.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked this result after private doc-reference and baseline policy helpers moved out of `diff-gate.ts`. Commit-scope and recency evidence still flow through the same co-change-partner check before finding emission.

## 2026-06-27 Citation Refresh

The persistent-refresh coordination slice rechecked the `diff-gate.ts` and `src/runtime/query-commands/impact.ts` citations. Commit-scope and recency evidence still flow through the same co-change surfaces; index freshness and watcher coordination do not change the analyzer behavior recorded here.

## 2026-06-28 Diff-Gate Echo Follow-Up

The `diff-gate.ts` recency-sweep references remain accurate. The follow-up only
avoids echo similarity scoring for non-callable changed symbols and does not
change co-change recency evidence or health integration.

## 2026-06-28 Health Drift Performance Follow-Up

The `src/queries/health/health.ts` recency-sweep reference remains accurate.
The health drift optimization does not change commit scope, recency, or
hidden-coupling summaries; it only skips advisory drift pattern rows outside
the co-change scoring path.

## 2026-06-28 Raw Git Path Follow-Up

The `diff-gate.ts` recency-sweep reference remains accurate. Co-change recency
evidence is unchanged; diff-gate now only checks partner presence against raw
git changed paths so non-indexed changed docs are counted.

## 2026-06-28 Focused Co-Change History Follow-Up

The `src/analysis/git-history.ts` and `diff-gate.ts` recency-sweep references
remain accurate. The focused history path carries the newest non-bulk timestamp
from the same global analysis window into the changed-file subset, so recency
classification remains anchored to the original bounded history.

## 2026-06-28 File-Add Cache Follow-Up

The `src/analysis/git-history.ts` recency-sweep reference remains accurate.
The new HEAD-keyed file-add evidence cache only persists `getFileAddRecords()`
for recent-duplicate orientation; it does not change commit-scope, recency, or
co-change pair construction.
