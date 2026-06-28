# Incomplete Migration Containment Result

Date: 2026-06-22

Plan: `docs/plans/2026-06-22-incomplete-migration-containment.md`

## Scope

This slice implements the diff-gate calibration follow-up for incomplete migrations. Semantic containment is a comparison between a new helper's meaningful callees and an old site's meaningful callees; it is useful only when the old site contains the helper pattern and that pattern is a material share of the old site. Helper shape is call-pattern evidence that says whether a new helper is focused enough to score from callee overlap.

## Implementation

- Added `siteCoverage` and `uniqueSiteCalleeCount` to each incomplete-migration leftover.
- Added `minSiteCoverage`, defaulting to `0.4`, so broad orchestration sites no longer qualify merely because they contain a small helper fragment.
- Added helper-shape metadata to findings: `helperShape`, `helperCalleeCount`, and `specificHelperCalleeCount`.
- Skipped helpers whose callee pattern is only project-wide infrastructure, with an explicit skipped-helper reason.
- Updated diff-gate confidence to use the weaker side of each leftover's helper containment and site coverage.
- Updated diff-gate and CLI text output to show helper shape, helper/site containment, and extra site callees.
- Extended the incomplete-migration fixture with a broad unchanged site that contains the helper calls plus many extra calls, proving that broad embedded-fragment matches are rejected.

2026-06-22 note: the later `diff-gate.ts` doc-reference same-diff fix does not change the incomplete-migration containment behavior described here.

## Verification

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts` passed: 1 file, 21 tests. The run still prints the known noisy `git diff` warning from the fixture.
- `npx prettier --check src/queries/impact/incomplete-migration.ts src/queries/impact/diff-gate.ts src/runtime/query-commands/impact.ts tests/queries/impact/incomplete-migration.test.ts` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js similar specificCalleeCount --json` returned only low-score structural overlap with map/count helpers; accepted because the domains differ.
- `node dist/cli.js recent-duplicates --json`, `unused-params --json`, `wrapper-candidates --json`, `passthrough-candidates --json`, `cycles --json`, and `isolated --json` returned no findings.
- `node dist/cli.js incomplete-migration --json` returned no findings in the current repository after the refinement.
- `node dist/cli.js dead --only-dead --json` reported `deadCodeCount: 0`; its large `symbols` list remains file-internal inventory.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `npm test` passed: 66 files, 332 tests. The run still prints the known noisy `git diff` warning from the existing incomplete-migration fixture.
- `node dist/cli.js reindex` reused the cached TypeScript shard and rebuilt the SQLite index successfully.
- `node dist/cli.js diff-gate --json` exited 1 with the same two accepted warning-level findings:
  - `SQ36D93309ABEA`: signal-tier echo between `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()`. Accepted because both use symbol leaf helpers but make different product decisions.
  - `SQ30E6CF5F9B38`: support-tier README `configuration-example` citation for declared-coupling docs. Accepted because the README example still points at the intended cleanup files and does not require a doc edit for this slice.

## Judgment

Verdict: implemented. The detector still catches the intended failure mode, a newly introduced helper that is adopted in some places while equivalent old sites remain. It now refuses a weaker claim: that any broad old function containing the helper calls is itself an incomplete migration. The output exposes both sides of the comparison so reviewers can distinguish a direct leftover from a broad site that happens to include the same small fragment.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the `diff-gate.ts` citation in this result. Incomplete-migration containment, helper-shape metadata, and broad-site rejection are unchanged; diff-gate finding emission now derives the suppression hint centrally after the incomplete-migration finding is built.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked this result after doc-reference and baseline policy helpers moved out of `diff-gate.ts`. Incomplete-migration containment still runs through the same diff-gate check, and the private helper extraction does not alter the containment behavior recorded here.

## 2026-06-27 Citation Refresh

The persistent-refresh coordination slice rechecked the `diff-gate.ts`, `incomplete-migration.ts`, and `src/runtime/query-commands/impact.ts` citations. Incomplete-migration containment and CLI output remain on the same surfaces; refresh coordination does not change the containment behavior validated here.

## 2026-06-28 Performance Citation Refresh

The hyper-optimization slice rechecked the `src/queries/impact/incomplete-migration.ts` citation after incomplete-migration began reusing the cached callee-fingerprint index from `src/queries/cleanup/similar.ts`. Containment semantics, helper-shape metadata, skipped-helper reasons, and CLI/diff-gate output remain unchanged; the update only avoids rebuilding the same callee index during diff-gate.
