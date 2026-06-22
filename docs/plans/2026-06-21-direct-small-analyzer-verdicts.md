# Direct Small Analyzer Verdicts

Date: 2026-06-21

## Goal

Close the next AVL-002 direct-repair slice for `unused-imports`, `unused-params`, and `redundant-reexports`. Done means the slice records live-corpus verdicts, fixes any precision defect found, and updates the ledger with the remaining direct-family gaps.

## Current State

- `unused-imports` is file-scoped and reports imports that have no source/semantic usage in the inspected file.
- `unused-params` is repo-scoped and reports function parameters with no local usage evidence.
- `redundant-reexports` is repo-scoped and should report true barrel re-exports with no consumers, not executable entrypoints that merely import startup dependencies.

## Reuse Audit

No new analyzer family is needed. This slice reuses the current CLI, existing redundant-reexport fixture helpers, and the validation corpus.

## Design

### 1. Collect Corpus Output

- [x] **Repos**: `scip-query`, `Vega_2.0`, `Stable_Management`, `SynthRunnerRust`
- **Commands**: `unused-params --json`, `redundant-reexports --json`
- **What**: Count repo-wide findings across the validation corpus.
- **Why**: These commands should either produce local direct fixes or explain why the corpus is clean.

### 2. Sample File-Scoped Unused Imports

- [x] **Repos**: `Vega_2.0`, `Stable_Management`
- **Command**: `unused-imports <file> --json`
- **What**: Scan representative TypeScript/Vue files until finding positive rows.
- **Why**: `unused-imports` has no whole-repo mode, so field validation needs sampled files.

### 3. Fix Precision Defects

- [x] **File**: `src/queries/cleanup/redundant-reexports.ts`
- **What**: If the field run finds false positives, patch the detector and add a regression test.
- **Why**: Direct analyzers must be conservative before they can guide repair.

### 4. Record the Result

- [x] **File**: `docs/validation/2026-06-21-direct-small-analyzer-verdicts-result.md`
- **What**: Record TP/FP/clean-corpus verdicts and remaining gaps.
- **Why**: AVL-002 should close one direct family at a time instead of staying as a vague bucket.

## Stress Test

- External repositories were read-only.
- `Stable_Management` had a dirty working tree owned outside this task; no files were modified there.
- `Vega_2.0` was clean during this slice.

## Verification

- Targeted regression: `npx vitest run tests/queries/cleanup/redundant-reexports-fallback.test.ts`
- Standard repo checks still run after docs: `npm run typecheck`, `npm run build`, `npm test`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.
