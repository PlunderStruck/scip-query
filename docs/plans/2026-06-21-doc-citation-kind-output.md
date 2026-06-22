# Doc Citation-Kind Output Plan

Date: 2026-06-21

## Goal

A doc citation kind is a classification of why a living document names a changed code file. Its real-world referents are prose claims, command guides, configuration examples, and intentional records that mention paths such as `src/queries/cleanup/dead.ts`; its essential role is to tell reviewers whether an untouched doc probably needs a behavioral update or only contains a stable reference/example.

This slice keeps `doc-reference` visible in `diff-gate`, but adds enough structured evidence to stop treating every citation as the same kind of stale-doc risk.

## Current State

- Source: `node dist/cli.js plan-context diffGate` reports `diffGate()` at `src/queries/impact/diff-gate.ts:110-168`; `diffGate()` calls `runDocReferenceCheck()` after `co-change-partner`.
- Source: `node dist/cli.js code runDocReferenceCheck -C 24` reports `runDocReferenceCheck()` at `src/queries/impact/diff-gate.ts:421-450`; it emits one `doc-reference` warning with `file`, `relatedFiles`, `message`, `why`, and `remediation`, but no citation kind or action tier.
- Source: `node dist/cli.js trace docsCitingFiles --json` reports `docsCitingFiles()` at `src/queries/cleanup/doc-drift.ts:216-229`; its only current consumer is `runDocReferenceCheck()`.
- Source: `node dist/cli.js code docsCitingFiles -C 24` reports that `docsCitingFiles()` returns `{ doc, cited }` after resolving path-shaped references from living docs.
- Source: `node dist/cli.js code extractFileReferences -C 24` reports that path extraction is cached and currently returns only resolved and broken path sets, not line snippets.
- Source: `node dist/cli.js affected docsCitingFiles` reports only `runDocReferenceCheck()` and `diffGate()` as affected symbols.

## Steps

1. [x] Extend `DiffGateFinding` additively.
   - **File**: `src/queries/impact/diff-gate.ts:44-64`
   - **Source**: `node dist/cli.js code 'src/queries/impact/diff-gate.ts:1-260' -C 0`
   - **Change**: add optional `citationKind` and `citationKindReasons` fields, plus a `DocCitationKind` union local to diff-gate.
   - **Why**: JSON consumers get structured citation intent without breaking existing finding fields.

2. [x] Classify doc-reference findings.
   - **File**: `src/queries/impact/diff-gate.ts:421-450`
   - **Source**: `node dist/cli.js code runDocReferenceCheck -C 24`
   - **Change**: before emitting a finding, read the citing doc, inspect nearby lines around each cited path/suffix, and classify as:
     - `behavioral-claim`: prose appears to describe behavior or implementation.
     - `configuration-example`: surrounding text is `.scipquery.json`, declared coupling, suppression, config, or JSON example text.
     - `guide-reference`: surrounding text is command/usage-oriented.
     - `intentional-record`: surrounding text states the citation is retained, accepted, historical, or intentional.
   - **Why**: the current README `declaredCouplings` example should not receive the same wording as a stale behavioral claim.

3. [x] Calibrate action tier and message text.
   - **File**: `src/queries/impact/diff-gate.ts:421-450`
   - **Source**: `node dist/cli.js code runDocReferenceCheck -C 24`
   - **Change**: set `actionTier: 'direct'` for `behavioral-claim`, `signal` for `guide-reference`, and `support` for `configuration-example` or `intentional-record`; render kind-specific remediation.
   - **Why**: doc-reference can remain a diff-gate finding while review urgency matches the citation kind.

4. [x] Add regression coverage.
   - **File**: `tests/queries/impact/incomplete-migration.test.ts`
   - **Source**: local test read; `scip-query` does not index this file for `outline`.
   - **Change**: add a git-backed fixture where README cites a changed source file inside a `.scipquery.json` declared-coupling example and assert `citationKind: 'configuration-example'`, `actionTier: 'support'`, and kind-specific remediation.
   - **Why**: this captures the exact accepted `README.md` finding that has been recurring in the validation ledger.

## Verification

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "citation kind"`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js diff-gate --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- The classifier is lexical, so it should affect action tier and wording, not hide findings.
- `docsCitingFiles()` stays unchanged for now; citation classification belongs in diff-gate because it needs changed-file review wording rather than doc-drift scoring.

## Result

Result recorded in `docs/validation/2026-06-21-doc-citation-kind-output-result.md`.

Judgment: confirmed. The recurring README declared-coupling citation is now `citationKind: configuration-example` and `actionTier: support`.
