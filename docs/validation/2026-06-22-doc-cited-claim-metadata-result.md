# Doc Cited-Claim Metadata Result

Date: 2026-06-22

## Scope

This slice completes the doc output-schema follow-up for `doc-reference` and path-reference `doc-drift` rows.

A cited claim is the nearby documentation text that names a code file and gives that citation its review meaning. It is evidence because it lets a reviewer distinguish a current behavioral statement from a configuration example, guide pointer, or historical record.

Implemented changes:

- `DocDriftSubject` now includes optional `citationContexts`.
- `docsCitingFiles()` now returns cited files, structured citation contexts, and deduplicated `citedClaims`.
- `DiffGateFinding` now includes optional `citedClaims`.
- `doc-reference` classification reuses the structured citation contexts from `doc-drift` path extraction.
- Plain text `doc-drift` and `diff-gate` output prints compact cited-claim snippets when available.
- Overlapping doc windows from the same block are deduplicated so one configuration block renders as one cited claim.

## Regression Coverage

Updated focused tests:

- `tests/queries/impact/incomplete-migration.test.ts`
  - Configuration examples remain `citationKind: "configuration-example"` and `actionTier: "support"`.
  - Configuration examples now include `citedClaims`.
  - Behavioral prose references are `citationKind: "behavioral-claim"` and `actionTier: "direct"`, with `citedClaims`.
- `tests/analysis/git-history.test.ts`
  - A path-reference `doc-drift` subject now carries `citationContexts`.

## Local Field Result

On this repository, compiled `diff-gate` now reports the recurring README finding as:

- `check: "doc-reference"`
- `actionTier: "support"`
- `citationKind: "configuration-example"`
- `citedClaims`: one deduplicated JSON configuration block for the README declared-coupling example.

Text output now prints a single compact cited-claim line under the finding.

Current `doc-drift --json --limit 5` rows are co-change-only package churn against `README.md` and `docs/COMMAND_REFERENCE.md`, so they correctly do not include `citationContexts`; there is no path-cited stale subject in the current local top rows.

## Judgment

Confirmed. The doc analyzers now expose the citation evidence needed to decide whether doc work is direct, signal, or support. `doc-reference` support-tier configuration examples should stay visible but should not hard block. `doc-drift` staleness-only co-change rows remain contextual signal unless a path citation supplies stronger cited-claim evidence or the reference is broken.

## Verification

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts tests/analysis/git-history.test.ts` passed 30 tests.
- `npm test` passed 65 files and 330 tests after the final private-helper cleanup.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js cycles --json` returned no cycles.
- `node dist/cli.js isolated --min-loc 3 --json` returned no isolated symbols.
- `node dist/cli.js health --json` reported score, risk, and hygiene at 100 with no findings.
- `node dist/cli.js recent-duplicates --json` reported no findings after the final helper cleanup.
- `node dist/cli.js unused-params --json` returned no unused parameters.
- `node dist/cli.js wrapper-candidates --json` returned no wrapper candidates.
- `node dist/cli.js passthrough-candidates --json` returned no passthrough candidates.
- `node dist/cli.js dead --only-dead --min-loc 5 --json` reported no shown dead-code findings.
- `node dist/cli.js diff-gate --json` ended with only two accepted warnings:
  - `SQ36D93309ABEA`, `echo`: `isCompileTimeContractAssertion()` shares symbol-parser helpers with `indexedDefinitionFromRow()`, but the product semantics differ; this remains signal evidence only.
  - `SQ30E6CF5F9B38`, `doc-reference`: README cites the changed cleanup files inside a declared-coupling JSON configuration example. The finding is `actionTier: "support"`, `citationKind: "configuration-example"`, and now includes one deduplicated `citedClaims` block.

The focused test run prints an existing noisy `git diff` fixture warning, but the test process exits successfully.
