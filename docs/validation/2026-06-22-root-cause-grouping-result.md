# Root-Cause Grouping Result

Date: 2026-06-22

## Scope

This slice closes the output-schema follow-up for repeated duplicate and baseline rows.

A root-cause group is a review item made from analyzer findings that point at one underlying cause. It is useful because a repeated pairwise report can describe one repair problem many times; grouping keeps raw evidence visible while giving reviewers the smaller unit they should accept or repair.

Implemented changes:

- `recent-duplicates` pair rows now carry optional `groupKey` and `rootCauseKey`.
- `recent-duplicates` results now include `rootCauseGroups`.
- Echo duplicate groups use the established side as the root cause, so several new echoes of one older owner become one review item.
- Twin duplicate groups use domain, basis, and shared evidence because neither side is the established owner yet.
- `diff-gate` results now include `rootCauseGroups` built after structured suppressions are applied.
- Diff-gate text and hook output now report root-cause group counts.
- `recent-duplicates` text output prints multi-finding groups before pair details.

## Regression Coverage

Updated focused tests:

- `tests/queries/frontend/frontend-recent-duplicates.test.ts`
  - Adds two recent React echoes against one established component.
  - Asserts the `react-component` echo group has `count: 2`, the established component, both echo files, related files, and group recommendation text.
- `tests/queries/impact/incomplete-migration.test.ts`
  - Asserts a baseline finding has a matching `rootCauseGroups` entry with the inherited analyzer, root-cause key, finding id, and remediation.
- `tests/runtime/agent-setup.test.ts`
  - Asserts hook output includes the root-cause group count.

## Local Field Result

On this repository:

- `node dist/cli.js recent-duplicates --json` returns no findings and an empty `rootCauseGroups` array.
- `node dist/cli.js diff-gate --json` still returns the same two accepted warnings, now with two root-cause groups:
  - `echo`, `actionTier: "signal"`, for `isCompileTimeContractAssertion()` vs `indexedDefinitionFromRow()`.
  - `doc-reference`, `actionTier: "support"`, `citationKind: "configuration-example"`, for the README declared-coupling JSON example.
- `node dist/cli.js diff-gate` reports `2 finding(s), 2 root-cause group(s)`.

## Judgment

Confirmed. The tool now separates raw pair/finding evidence from grouped review items for the duplicate and baseline families. This does not make similarity evidence more direct; it prevents repeated evidence rows from overstating independent debt.

## Verification

- `npx vitest run tests/queries/frontend/frontend-recent-duplicates.test.ts tests/queries/impact/incomplete-migration.test.ts tests/runtime/agent-setup.test.ts` passed 31 tests.
- `npm test` passed 65 files and 330 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js reindex` rebuilt the TypeScript index successfully.
- `node dist/cli.js cycles --json` returned no cycles.
- `node dist/cli.js isolated --min-loc 3 --json` returned no isolated symbols.
- `node dist/cli.js health --json` reported score, risk, and hygiene at 100 with no findings.
- `node dist/cli.js recent-duplicates --json` returned no findings and `rootCauseGroups: []`.
- `node dist/cli.js unused-params --json` returned no unused parameters.
- `node dist/cli.js wrapper-candidates --json` returned no wrapper candidates.
- `node dist/cli.js passthrough-candidates --json` returned no passthrough candidates.
- `node dist/cli.js dead --only-dead --min-loc 5 --json` reported no shown dead-code findings.
- `node dist/cli.js similar recentDuplicateRootCauseGroups --json`, `node dist/cli.js similar diffGateRootCauseGroups --json`, and `node dist/cli.js similar recentDuplicateRootCauseKey --json` returned no rows.
- Tiny enum-rank helpers in `diff-gate.ts` have expected structural-overlap signals with each other; they compare different output enums and are intentionally kept explicit rather than abstracted.
- `node dist/cli.js diff-gate --json` showed the two accepted warnings above and emitted `rootCauseGroups`.
- `node dist/cli.js diff-gate` printed the grouped count in text output.

The focused test run prints the existing noisy `git diff` fixture warning, but the test process exits successfully.
