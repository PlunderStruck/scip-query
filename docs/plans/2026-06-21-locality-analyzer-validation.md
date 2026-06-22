# Locality Analyzer Validation

Date: 2026-06-21

## Goal

Validate the proposed `locality-candidates` analyzer before implementation. Done means the design has sampled evidence from React and Vue corpora, a go/no-go recommendation, and explicit limits about consumer coverage and score integration.

## Current State

- `docs/locality-analyzer-design.md` proposes a report-only analyzer that combines component pressure, extraction candidates, references, reverse dependencies, path boundaries, and co-change evidence.
- React pressure-kind output has already distinguished route pages from route-local and app-level components on `Vega_2.0`.
- Vue pressure-kind output has already distinguished style, template, script, route/page, and external-script pressure on `Stable_Management`.
- AVL-011 showed that signal rows should produce investigation plans, not automatic moves or extractions.

## Reuse Audit

The validation can reuse existing query commands: `react-large-component-pressure`, `vue-large-view-pressure`, `rdeps`, `imported-by`, and `co-change`. No new analyzer code should be written until the go/no-go result is recorded.

## Design

### 1. Validate React Placement Inputs

- [x] **Repo**: `Vega_2.0`
- **Commands**: `react-large-component-pressure --full --json`, `rdeps`, `co-change`
- **What**: Check whether pressure-kind rows can be paired with consumer evidence.
- **Why**: Locality recommendations need real consumers, not only file-size pressure.

### 2. Validate Vue Placement Inputs

- [x] **Repo**: `Stable_Management`
- **Commands**: `vue-large-view-pressure --full --review-thresholds --json`, `rdeps`, `imported-by`
- **What**: Check whether Vue pressure-kind rows can be paired with consumer evidence.
- **Why**: Vue SFC indexing differs from TypeScript indexing, so unsupported consumer evidence must be visible.

### 3. Decide Go/No-Go

- [x] **File**: `docs/validation/2026-06-21-locality-analyzer-validation-result.md`
- **What**: Record whether to implement `locality-candidates`, a workflow skill first, or defer.
- **Why**: The analyzer should not enter health scoring or automated repair paths without enough evidence.

## Stress Test

- React file dependencies produced useful direct reverse dependencies.
- Vue `rdeps` for sampled SFC files returned empty rows, while path-level `imported-by` returned broad textual/test-like references. This must be treated as a coverage caveat, not as proof of no consumers.
- Co-change can add domain/context evidence, but it does not replace the exact consumer set.

## Verification

- This slice is documentation and validation only.
- Standard repo checks still run after the ledger update: `npm run typecheck`, `npm run build`, `npm test`, `./dist/cli.js reindex`, and `./dist/cli.js diff-gate`.
