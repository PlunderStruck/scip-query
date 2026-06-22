# Baseline Metadata Inheritance Plan

Date: 2026-06-21

## Goal

Baseline metadata inheritance is the act of carrying the analyzer identity and actionability of a health finding into the diff-gate baseline finding that reports it. Its real-world referents are baseline strings such as `dead:src/file.ts:symbol`, `similar:symbolA|symbolB`, and `drift:unused-import:file:dep`; its essential role is to make a baseline regression explain what kind of debt appeared instead of reporting an opaque ratchet string.

This slice keeps `.scipquery-baseline.json` backward-compatible and enriches only `diff-gate` output.

## Current State

- Source: `node dist/cli.js plan-context runBaselineCheck` reports `runBaselineCheck()` at `src/queries/impact/diff-gate.ts:729-756`; it calls `checkHealthBaseline()` and emits generic `baseline` errors.
- Source: `node dist/cli.js code runBaselineCheck -C 24` shows the current finding has no `actionTier`, `file`, `relatedFiles`, analyzer family, or root-cause grouping.
- Source: `node dist/cli.js code collectBaselineFindings -C 30` shows baseline identity prefixes: `dead`, `isolated`, `cycle`, `similar`, `extract`, `wrapper`, `passthrough`, `stale`, and `drift`.
- Source: `node dist/cli.js trace checkHealthBaseline --json` shows `checkHealthBaseline()` is used by `runBaselineCheck()`, `src/queries/index.ts`, and the health baseline CLI command.
- Source: `node dist/cli.js affected DiffGateFinding` reports no compiler-resolved affected symbols, so additive optional fields are low-risk for existing consumers.

## Steps

1. [x] Extend `DiffGateFinding` additively for inherited metadata.
   - **File**: `src/queries/impact/diff-gate.ts`
   - **Source**: `node dist/cli.js code runBaselineCheck -C 24`
   - **Change**: add optional `sourceAnalyzer` and `rootCauseKey` fields.
   - **Why**: baseline findings can point back to the underlying analyzer family and stable root cause.

2. [x] Parse baseline identity strings in diff-gate.
   - **File**: `src/queries/impact/diff-gate.ts:729-756`
   - **Source**: `node dist/cli.js code collectBaselineFindings -C 30`
   - **Change**: add a local `baselineFindingMetadata()` helper that derives analyzer family, action tier, primary file, related files, root-cause key, and remediation wording from existing baseline strings.
   - **Why**: this avoids changing `.scipquery-baseline.json` while still improving output.

3. [x] Attach metadata in `runBaselineCheck()`.
   - **File**: `src/queries/impact/diff-gate.ts:729-756`
   - **Source**: `node dist/cli.js plan-context runBaselineCheck`
   - **Change**: set `actionTier`, `sourceAnalyzer`, `rootCauseKey`, `groupKey`, `file`, `relatedFiles`, richer `why`, and tier-aware remediation on baseline findings.
   - **Why**: diff-gate baseline failures should explain whether the new finding is direct repair debt or contextual pressure.

4. [x] Add regression coverage.
   - **File**: `tests/queries/impact/incomplete-migration.test.ts`
   - **Source**: local test read; fixture already exercises `diffGate()`.
   - **Change**: write a temporary baseline missing one current health finding, run only the baseline check, and assert inherited metadata is present.
   - **Why**: protects the exact output-quality contract without needing a new baseline fixture.

## Verification

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "baseline"`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js diff-gate --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- Baseline identity parsing is string-based. Keep it defensive and preserve the raw finding string in the message.
- Do not change baseline writing in this slice; compatibility matters more than perfect schema shape.

## Result

Result recorded in `docs/validation/2026-06-21-baseline-metadata-inheritance-result.md`.

Judgment: confirmed. Baseline findings now inherit analyzer identity and action tier without changing `.scipquery-baseline.json`.
