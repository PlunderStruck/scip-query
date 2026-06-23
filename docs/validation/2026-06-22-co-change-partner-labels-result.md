# Co-Change Partner Labels Result

Date: 2026-06-22

Plan: `docs/plans/2026-06-22-co-change-partner-labels.md`

## Scope

This slice implements the co-change calibration follow-up that asked the tool to distinguish high-confidence partner classes before recommending action. A partner class is an evidence label for two files that repeatedly changed together; it tells whether the pair looks like a coordination contract, such as doc/code or schema/script, or only a broader same-feature edit pattern.

## Implementation

- Added `CoChangePartnerClass`, `CoChangePartnerClassification`, and `DeclaredCouplingSuggestion` metadata to `CoChangeFinding`.
- Added reusable co-change helpers for pair classification, structural-link checking, and declared-coupling suggestions.
- Classified co-change pairs as `doc-code`, `config-code`, `schema-script`, `model-view`, `test-code`, `same-feature`, or `unknown`.
- Limited declared-coupling suggestions to unlinked pairs with at least 4 co-changes, confidence at or above 0.75, and a contract-like partner class.
- Reused the same helpers in diff-gate `co-change-partner` findings, adding `sourceAnalyzer`, `groupKey`, `rootCauseKey`, `actionTier`, partner-class reasons, and optional declared-coupling suggestions.
- Updated CLI text output so `co-change` and `diff-gate` show partner class and declaration suggestions.
- Added focused fixtures for repeated doc/code and schema/script histories plus a diff-gate changed-partner case.

2026-06-22 note: the later `diff-gate.ts` doc-reference same-diff fix does not change the co-change-partner label fields described here.

## Verification

- `npx prettier --check src/queries/impact/co-change.ts src/queries/impact/diff-gate.ts src/runtime/query-commands/impact.ts tests/queries/impact/co-change-partner-labels.test.ts` passed.
- `npx vitest run tests/queries/impact/co-change-partner-labels.test.ts` passed: 1 file, 2 tests.
- `npx vitest run tests/queries/impact/co-change-partner-labels.test.ts tests/analysis/git-history.test.ts tests/queries/impact/incomplete-migration.test.ts` passed: 3 files, 32 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm test` passed: 66 files, 332 tests. The run still prints the known noisy `git diff` warning from the existing incomplete-migration fixture.
- `node dist/cli.js recent-duplicates --json` returned 0 findings and no root-cause groups.
- `node dist/cli.js unused-params --json`, `wrapper-candidates --json`, `passthrough-candidates --json`, `cycles --json`, and `isolated --json` returned 0 findings.
- `node dist/cli.js dead --only-dead --json` still reports 0 dead-code findings; the large `symbols` inventory is file-internal only.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `node dist/cli.js co-change --json` reported 0 current hidden-coupling findings in this repository.
- `node dist/cli.js reindex && node dist/cli.js diff-gate --json` rebuilt the TypeScript index and exited 1 with the same two accepted warning-level findings:
  - `SQ36D93309ABEA`: signal-tier echo between `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()`. Accepted because both use symbol leaf helpers but make different product decisions.
  - `SQ30E6CF5F9B38`: support-tier README `configuration-example` citation for declared-coupling docs. Accepted because the README example still points at the intended cleanup files and does not require a doc edit for this slice.

Post-check judgment: the low-score `similar` rows on the new helpers are accepted structural-overlap signals. `classifyCoChangePartner()` and `declaredCouplingSuggestionForPair()` share local vocabulary because one classifies and the other consumes the classification; `coChangeStructuralLinkChecker()` overlaps graph-query vocabulary with existing graph analyzers but has distinct co-change semantics.

## Judgment

Verdict: implemented. The output now separates the fact that two files co-changed from the reviewer judgment about what kind of relationship the pair appears to express. That keeps broad same-feature churn visible as signal while promoting specific doc/code, config/code, schema/script, model/view, and test/code pairs into declared-coupling candidates only when repeated history is strong enough.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the `diff-gate.ts` citation in this result. The co-change-partner label fields and declared-coupling suggestion behavior are unchanged; only diff-gate finding emission now goes through `recordFinding()` for consistent suppression hints.
