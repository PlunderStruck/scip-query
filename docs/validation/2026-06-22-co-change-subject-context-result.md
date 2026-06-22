# Co-Change Subject Context Result

Date: 2026-06-22

## Verdict

The co-change subject-context slice is complete. Co-change pairs now expose the local issue-like evidence that exists in git history: inferred subject labels, issue references, sampled commit subjects, and an explicit status saying external issue/PR labels are unavailable.

A commit-subject context is the summary of the commit messages that caused two files to move together. It is weaker than tracker metadata because it comes from the commit log rather than issue or pull-request records, but it still identifies whether the history looks like feature work, fixes, docs, releases, chores, or unlabeled maintenance.

External issue/PR label metadata means labels assigned by a hosting or tracker system, such as GitHub issue labels or pull-request labels. The current repository-local analyzer does not have that data source, so the output deliberately says `externalIssueLabelStatus: "unavailable"` rather than pretending commit messages are true tracker labels.

## Implementation

- `src/analysis/git-history.ts` adds `CoChangeSubjectContext` to `CoChangePair`, gathers pair-contributing commit subjects, infers conventional/keyword labels, extracts refs such as `#42` or `ABC-123`, and samples the newest unique subjects.
- `src/queries/impact/co-change.ts` carries `subjectContext` into `CoChangeFinding`.
- `src/queries/impact/diff-gate.ts` carries `subjectContext` into `co-change-partner` findings and adds a bounded `Subject context:` line to `why`.
- `src/runtime/query-commands/impact.ts` prints compact subject context in text `co-change` output.
- `src/queries/health/health.ts`, `src/queries/health/health-types.ts`, and `src/queries/impact/plan-context.ts` preserve the field in JSON-facing summaries.

2026-06-22 note: the later `diff-gate.ts` doc-reference same-diff fix does not change the co-change subject-context propagation described here.

## Coverage

- `tests/analysis/git-history.test.ts` covers conventional subject labels, issue refs, newest subject samples, and the explicit unavailable external-label status.
- `tests/queries/impact/co-change-partner-labels.test.ts` covers the standalone co-change analyzer and diff-gate propagation for a repeated docs/code pair.

## Judgment

This closes the local part of the issue/PR-label gap. The analyzer now gives reviewers concrete historical subject evidence without overstating it as external tracker truth.

The remaining co-change validation work is second-corpus score-weight confirmation. True issue/PR label ingestion should stay out of scope until there is a real metadata provider.

## Verification

Completed:

- `npx vitest run tests/analysis/git-history.test.ts tests/queries/impact/co-change-partner-labels.test.ts` passed: 2 files, 13 tests.
- `npm run typecheck` passed.
- `npm run build` passed.
- `node dist/cli.js recent-duplicates --json` returned 0 findings.
- `node dist/cli.js unused-params --json` returned 0 findings.
- `node dist/cli.js wrapper-candidates --json` returned 0 findings.
- `node dist/cli.js passthrough-candidates --json` returned 0 findings.
- `node dist/cli.js similar coChangeSubjectContext --json` returned 0 rows.
- `node dist/cli.js similar subjectLabelsFor --json` returned 0 rows.
- `node dist/cli.js co-change --json` returned 0 findings in this repository.
- `node dist/cli.js health --json` returned score 100, risk 100, hygiene 100, and 0 hidden-coupling pairs.
- `npm test` passed: 66 files, 335 tests. The run still prints the known noisy `git diff` fixture warning from the existing incomplete-migration fixture.
- `node dist/cli.js reindex` passed.
- `node dist/cli.js diff-gate --json` exited 1 with two accepted warning-level findings:
  - `SQ36D93309ABEA`: accepted signal-tier echo because `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` both use symbol leaf helpers but make different product decisions.
  - `SQ30E6CF5F9B38`: accepted support-tier doc-reference because the README citation is a fenced declared-coupling configuration example that still points at the intended files.
