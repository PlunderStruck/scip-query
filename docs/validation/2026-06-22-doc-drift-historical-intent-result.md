# Doc Drift Historical Intent Result

Date: 2026-06-22

Plan: `docs/plans/2026-06-22-doc-drift-historical-intent.md`

## Scope

This slice implements historical-note intent classification for `doc-drift` co-change-only staleness rows. A historical note is a document section or file that records what happened or what used to be true; it differs from current guidance because its purpose is preserving context rather than instructing future changes.

## Implementation

- Added `DocDriftIntent` and `DocDriftActionTier` metadata to `DocDriftSubject`.
- Added subject fields: `actionTier`, `docIntent`, and `docIntentReasons`.
- Classified document intent from bounded doc text and path context.
- Kept co-change-only current or unknown docs as `signal`.
- Classified co-change-only historical notes as `support`.
- Kept explicit reference and `both` evidence direct unless the doc text itself is historical-note shaped.
- Rendered action tier and doc intent in `doc-drift` text output.
- Added a regression fixture with a historical note and a current guide that both co-change with code before code moves on.
- Tightened historical-note terms after local output showed generic "history" language would over-discount README-style docs.

2026-06-22 note: the later `doc-drift.ts` lint cleanup only removes a useless initial assignment and does not change historical-intent classification behavior.

## Verification

- `npx vitest run tests/analysis/git-history.test.ts` passed: 1 file, 11 tests.
- `npx prettier --check src/queries/cleanup/doc-drift.ts tests/analysis/git-history.test.ts` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js doc-drift --json` now reports local co-change-only README and command-reference subjects as `signal/current-guidance`, not historical notes.
- `node dist/cli.js similar classifyDocDriftIntent --json` and `node dist/cli.js similar docDriftSubjectMetadata --json` returned no rows.
- `node dist/cli.js recent-duplicates --json` returned no findings and no root-cause groups.
- `node dist/cli.js unused-params --json`, `wrapper-candidates --json`, `passthrough-candidates --json`, `cycles --json`, and `isolated --json` returned no findings.
- `node dist/cli.js dead --only-dead --json` reported `deadCodeCount: 0`.
- `node dist/cli.js health --json` reported score 100, risk score 100, hygiene score 100, and no pressure rows.
- `npm test` passed: 66 files, 334 tests.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js diff-gate --json` returned the two previously accepted warnings only:
  - `SQ36D93309ABEA`: accepted signal-tier echo for `isCompileTimeContractAssertion()` vs. `indexedDefinitionFromRow()` because both use symbol leaf helpers but answer different questions.
  - `SQ30E6CF5F9B38`: accepted support-tier README configuration-example doc-reference because the example still points at the intended cleanup detector files.

## Judgment

Verdict: implemented. Co-change-only doc drift now says whether the document reads like current guidance, historical context, or neither, and the action tier follows that intent. The detector still shows historical-note drift as evidence, but it no longer frames that evidence as a direct doc-update demand.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked the `doc-drift.ts` citation after the generic doc-term matcher moved into `src/queries/cleanup/doc-terms.ts`. Historical-intent classification and action-tier behavior remain unchanged; only the shared term-matching helper location changed.

## 2026-06-27 Diff-Gate Performance Refresh

The `src/queries/cleanup/doc-drift.ts` change now narrows `docsCitingFiles()` so diff-gate resolves target path tokens before building citation contexts. Historical-intent classification is still owned by `classifyDocDriftIntent()`, and its behavior is unchanged. Verification reran `tests/queries/cleanup/drift-accuracy.test.ts`, `tests/queries/cleanup/drift-policy.test.ts`, the full `npm test` suite, and `scip-query doc-drift --json`.

## 2026-06-28 Path Evidence Cache Refresh

The path-evidence cache changes `docsCitingFiles()` and `doc-drift` to reuse cached path candidates and citation contexts. Historical-intent classification is still owned by `classifyDocDriftIntent()`, and its behavior is unchanged.

## 2026-06-30 Evidence Product Follow-Up

The `src/queries/cleanup/doc-drift.ts` historical-intent reference remains
accurate after the file evidence product registry migration. Path evidence
still stores the same candidates and citation contexts behind the content hash;
the persistent cache access now goes through `src/storage/evidence-products.ts`.

2026-07-01 round-2 remediation note: the `src/queries/cleanup/doc-drift.ts`
configuration example remains current after doc-drift started using the shared
citation-kind classifier. Historical-intent classification remains the policy
layer; citation contexts are now tiered with the same vocabulary diff-gate uses.
