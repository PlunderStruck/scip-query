# Passthrough Boundary Evidence

Date: 2026-06-22

## Goal

Passthrough candidates should stop reading like direct inline/delete advice when a forwarding function preserves a boundary, facade, public vocabulary, provider contract, lifecycle name, or other stable concept. Done means the analyzer emits `actionTier`, boundary evidence, and recommendation text; health scoring discounts signal-tier passthrough rows; CLI output shows the distinction; tests pin direct and signal behavior.

A passthrough candidate is a small production callable whose body literally forwards its parameters to exactly one callee. Its useful maintenance question is whether the forwarding name is needless indirection or a boundary that keeps consumers speaking the right API.

## Current State

- `node dist/cli.js plan-context passthrough-candidates --json` reports `src/queries/cleanup/passthrough-candidates.ts` as a medium-risk module with `PassthroughCandidate` at lines 8-18, `passthroughCandidates()` at lines 31-46, and `passthroughCandidateForSymbol()` at lines 48-72.
- `node dist/cli.js code 'src/queries/cleanup/passthrough-candidates.ts:1-140' --json` shows `PassthroughCandidate` currently exposes `symbol`, location, LOC, and `forwardsTo*` fields, while `passthroughCandidateForSymbol()` only checks one unique callee plus `isLiteralPassthrough()`.
- `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:150-190' --json` shows passthrough CLI text currently prints only the forwarded callee, unlike wrapper output which prints action tier and boundary evidence.
- `node dist/cli.js code summarizeHealthPassthroughs --json` shows health summarizes passthroughs through `summarizeHealthLocQuery()` as a plain `CountLocSummary`.
- `node dist/cli.js code wrapperCandidates --json` and `node dist/cli.js code 'src/queries/cleanup/wrapper-candidates.ts:260-520' --json` show the established boundary-evidence pattern: `actionTier`, `boundaryEvidence`, boundary token collection, and recommendation by implication through direct/signal split.
- `node dist/cli.js doc-drift docs/analyzer-validation-protocol.md --json` returned no findings.
- `node dist/cli.js recent-duplicates --json` returned no findings.

## Reuse Audit

- Reuse the wrapper boundary vocabulary and evidence collector rather than creating a second passthrough-only vocabulary. Source: `node dist/cli.js code 'src/queries/cleanup/wrapper-candidates.ts:260-520' --json`.
- Reuse the existing `healthScoreCount()` / `scoreWeightedDetail()` scoring pattern, already used for wrappers and frontend behavior. Source: `node dist/cli.js code healthScoreCount --json` and `node dist/cli.js code scoreWeightedDetail --json`.
- Reuse the fixture database pattern from `tests/fixtures/evidence-fixture.ts` for focused tests; test files are not part of the SCIP index, so fixture validation is grounded by actual query execution.
- `node dist/cli.js similar wrapperBoundaryEvidence --json --limit 5` found only broad structural overlap, so no existing helper beyond the wrapper boundary vocabulary should be extracted from another family.

## Design

### 1. Share Boundary Vocabulary From Wrappers

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts:260-520`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/wrapper-candidates.ts:260-520' --json`
- **What**: Boundary token vocabulary and ignore-comment detection are private to wrapper candidates.
- **Change**: Export a reusable boundary helper or move the helper to a small shared cleanup module. Keep wrapper behavior unchanged.
- **Why**: Passthrough and wrapper analyzers ask the same boundary-role question over different graph shapes.

### 2. Add Passthrough Action-Tier Output

- [x] **File**: `src/queries/cleanup/passthrough-candidates.ts:8-72`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/passthrough-candidates.ts:1-140' --json`
- **What**: Passthrough rows expose forwarding shape but no boundary evidence, action tier, or recommendation.
- **Change**: Add `actionTier: 'direct' | 'signal'`, `boundaryEvidence: string[]`, and `recommendation`. Classify rows with boundary evidence as signal; rows without boundary evidence remain direct.
- **Why**: Prior validation found passthrough rows that were adapters, facades, service/provider boundaries, public entrypoints, or object API vocabulary.

### 3. Render Passthrough Evidence In CLI Output

- [x] **File**: `src/runtime/query-commands/cleanup/handlers.ts:175-190`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:150-190' --json`
- **What**: CLI text prints only `Forwards to`.
- **Change**: Print tier, recommendation, and boundary evidence when present.
- **Why**: Plain text output should carry the same evidence as JSON.

### 4. Discount Signal Passthroughs In Health

- [x] **File**: `src/queries/health/health.ts:477-490`
- **Source**: `node dist/cli.js code summarizeHealthPassthroughs --json`
- **What**: Health currently returns a plain count/LOC summary.
- **Change**: Compute `scoreCount` for passthrough rows, with direct rows counted as 1 and signal rows counted fractionally.
- **Why**: Accepted boundary-shaped passthrough rows should remain visible without scoring like direct cleanup debt.

- [x] **File**: `src/queries/health/health-report.ts:552-825`
- **Source**: `node dist/cli.js code 'src/queries/health/health-report.ts:552-825' --json`
- **What**: Base and pressure deductions currently use raw passthrough count.
- **Change**: Use `healthScoreCount(analyses.passthroughs)` and `scoreWeightedDetail(...)` for base and pressure passthrough scoring.
- **Why**: This matches wrapper score handling.

### 5. Add Focused Regression Coverage

- [x] **File**: `tests/queries/cleanup/passthrough-candidates-output.test.ts`
- **Source**: fixture pattern from `tests/fixtures/evidence-fixture.ts` and existing query output tests.
- **What**: There is no dedicated passthrough output-quality regression.
- **Change**: Add fixture rows for a boundary-shaped passthrough, such as `StorageService.delete()` forwarding to a provider method, and a generic passthrough with no boundary vocabulary. Assert signal/direct action tiers, boundary evidence, recommendation text, and health `scoreCount`.
- **Why**: The calibrated output contract should be pinned by tests.

## Stress Test

- Understand before touch: the body-shape gate remains `isLiteralPassthrough()`, so this change reclassifies rows without broadening detection.
- Blast radius: `plan-context` shows the analyzer is consumed by health, baseline, and CLI handlers; the plan updates health and text output with tests.
- Intermediate validity: additive result fields preserve JSON compatibility for existing consumers.
- Reversibility: the shared helper or export can be reverted without data migration.
- Failure/concurrency/data integrity: no runtime state, I/O, or persisted schema changes.
- Boundary defense: this slice improves boundary representation; it does not relax entry/root exclusions.
- Observability/human review: text output will show why a row is direct or signal.
- Reuse: wrapper boundary evidence is reused as the local source of truth.

## Verification

- `npx vitest run tests/queries/cleanup/passthrough-candidates-output.test.ts`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js passthrough-candidates --json`
- `node dist/cli.js health --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Result

Completed in `docs/validation/2026-06-22-passthrough-boundary-evidence-result.md`.
