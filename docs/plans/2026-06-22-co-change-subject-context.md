# Co-Change Subject Context Plan

Date: 2026-06-22

## Goal

Co-change output should show the issue-like context that is locally available from git history without pretending that GitHub issue or PR labels are present. A commit-subject context is the compact set of labels, issue references, and sample subjects from the commits that made a file pair co-change. It is weaker than true issue/PR label metadata because it comes from commit messages, not tracker records, but it gives reviewers concrete evidence about whether a pair came from feature work, fixes, docs, releases, or broad maintenance.

## Current State

- `src/analysis/git-history.ts` stores `CommitRecord.subject`, but `CoChangePair` exposes only counts, confidence, scope, and recency.
- `src/queries/impact/co-change.ts` spreads pair fields into `CoChangeFinding`, so additive pair context can flow through the standalone analyzer.
- `src/queries/impact/diff-gate.ts` already renders co-change scope and recency in `co-change-partner` warnings; it should include the subject context there too.
- `src/runtime/query-commands/impact.ts`, `src/queries/health/health.ts`, `src/queries/health/health-types.ts`, and `src/queries/impact/plan-context.ts` consume co-change findings and should preserve the context in their outputs.

## Checklist

- [x] Add a `CoChangeSubjectContext` field to pair evidence, including `subjectLabels`, `issueRefs`, `sampleSubjects`, and `externalIssueLabelStatus`.
- [x] Derive subject labels and issue references from pair-contributing commit subjects in `getCoChangePairs()`.
- [x] Carry subject context into `coChange`, `diff-gate`, `health`, and `plan-context` output.
- [x] Render compact subject context in co-change CLI text and diff-gate `why` lines.
- [x] Add fixture coverage for conventional-style labels, issue refs, sampled subjects, and the explicit external-label-unavailable status.
- [x] Update validation records and run focused tests, typecheck, build, analyzer guardrails, reindex, and diff-gate.

## Verification

- `npx vitest run tests/analysis/git-history.test.ts tests/queries/impact/co-change-partner-labels.test.ts`
- `npx prettier --check ...`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js co-change --json`
- `node dist/cli.js health --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
