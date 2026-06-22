# Extract Candidate Evidence Classification Plan

Date: 2026-06-21

## Goal

An extraction candidate is a large callable whose callees form one or more separable groups. The real-world referents are functions such as `cleanupPlan()`, `diffGate()`, and `incompleteMigration()` where one body coordinates several helper groups; the essential value of the detector is to point reviewers at possible extraction seams, not to prove that a new abstraction should be created.

Done means `extract-candidates` still emits the same rows, while each row also tells agents and maintainers what kind of extraction signal they are seeing, why it was classified that way, and what review action is appropriate.

## Current State

- `node dist/cli.js plan-context extractCandidates --json` resolved `extractCandidates()` at `src/queries/cleanup/extract-candidates.ts:51-79`. It selects production callables, builds a callee map, evaluates each symbol with `extractionCandidateForSymbol()`, sorts by cluster count and LOC, and returns the bounded list.
- `node dist/cli.js code ExtractCandidate --json` resolved `ExtractCandidate` at `src/queries/cleanup/extract-candidates.ts:7-22`. The current result contains symbol identity, location, LOC, total callee count, and clusters with callee names plus isolation.
- `node dist/cli.js code extractionCandidateForSymbol --json` resolved `extractionCandidateForSymbol()` at `src/queries/cleanup/extract-candidates.ts:84-111`. The row is created after a minimum callee count, multiple connected callee clusters, and at least one sufficiently isolated cluster.
- `node dist/cli.js code scoreExtractionCluster --json` resolved `scoreExtractionCluster()` at `src/queries/cleanup/extract-candidates.ts:183-208`. Isolation is computed from cross-cluster co-occurrence edges and currently the only review hint.
- `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:120-150' --json` resolved the CLI text rendering. It prints each row and raw cluster details without action tier, extraction kind, reasons, or recommendation.
- `node dist/cli.js code countExtractionHealthCandidates --json` resolved `countExtractionHealthCandidates()` at `src/queries/health/health.ts:360-373`. Health counts only result length, so additive fields do not change health scoring.
- `node dist/cli.js code collectBaselineFindings --json` resolved `collectBaselineFindings()` at `src/queries/health/health-baseline.ts:61-111`. Baseline identity uses `extract:${candidate.relativePath}:${candidate.shortName}`, so additive fields do not churn baseline IDs.

The local smoke command `node dist/cli.js extract-candidates --json --limit 20` showed that top rows are mostly orchestration functions with helper clusters. That confirms the detector is useful contextual evidence, but the current output is easy to misread as a direct extraction mandate.

## Reuse Audit

- `node dist/cli.js plan-context extractCandidates --json` showed this analyzer is already implemented as a focused query with no shared action-tier classifier for extraction seams.
- `node dist/cli.js code ExtractCandidate --json` showed the existing result type is the right place for additive evidence fields.
- `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:120-150' --json` showed the existing cleanup handler rendering pattern can be extended in place.
- Existing frontend behavior classification is conceptually similar, but its vocabulary is framework-specific. This slice should add local extraction vocabulary rather than reusing React/Vue domain-word classifiers.

## Design

### 1. Extend ExtractCandidate Additively

- [ ] **File**: `src/queries/cleanup/extract-candidates.ts:7-22`
- **Source**: `node dist/cli.js code ExtractCandidate --json`
- **What**: `ExtractCandidate` exposes raw cluster evidence only.
- **Change**: Add `extractionKind`, `actionTier`, `evidenceReasons`, and `recommendation`. Keep every existing field and cluster shape.
- **Why**: The detector should identify signal type without changing result visibility or baseline identity.

### 2. Classify Extraction Evidence

- [ ] **File**: `src/queries/cleanup/extract-candidates.ts:84-111`
- **Source**: `node dist/cli.js code extractionCandidateForSymbol --json`
- **What**: `extractionCandidateForSymbol()` constructs rows after cluster filtering.
- **Change**: Classify each row from its short name, LOC, total callees, cluster count, isolation, and callee vocabulary.
- **Why**: This is the narrow point where all evidence needed for reviewer guidance is available.

### 3. Keep Scoring Stable

- [ ] **File**: `src/queries/health/health.ts:360-373`
- **Source**: `node dist/cli.js code countExtractionHealthCandidates --json`
- **What**: Health counts extraction rows by length.
- **Change**: No scoring change in this slice.
- **Why**: Classification needs field validation before score-weight calibration.

### 4. Render Reviewer Guidance

- [ ] **File**: `src/runtime/query-commands/cleanup/handlers.ts:127-150`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/cleanup/handlers.ts:120-150' --json`
- **What**: Text output prints raw cluster details.
- **Change**: Print extraction kind, action tier, recommendation, and evidence reasons before cluster details.
- **Why**: CLI users should see that extraction candidates are contextual signals.

### 5. Add Regression Coverage

- [ ] **File**: `tests/queries/navigation/queries-advanced.test.ts`
- **Source**: `rg -n "extractCandidates|extract-candidates|staleAbstractions|stale-abstractions" tests src --glob '*.{ts,tsx,vue}'`
- **What**: The advanced fixture already exercises graph and complexity queries against the hot `process()` service function.
- **Change**: Assert that `queries.extractCandidates()` emits classification fields for the fixture.
- **Why**: This pins the output contract without building another test database.

## Verification

- `npx vitest run tests/queries/navigation/queries-advanced.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js extract-candidates --json --limit 5`
- Corpus smoke on `Vega_2.0` or `Stable_Management`: `extract-candidates --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

Classification is vocabulary-sensitive. The implementation must preserve rows and use contextual `signal` wording rather than suppressing uncertain cases.

## Result

Completed in `docs/validation/2026-06-21-extract-candidate-evidence-classification-result.md`.
