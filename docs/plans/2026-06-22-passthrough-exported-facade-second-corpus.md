# Passthrough Exported Facade Second-Corpus Validation

Date: 2026-06-22

## Goal

Validate the remaining passthrough-candidate precision gap against the clean Vega corpus and close it with code if the analyzer cannot distinguish exported facade evidence from ordinary boundary evidence. Done means users can tell why a passthrough row is discounted: because it crosses a runtime boundary, because it preserves a public/exported facade, or both.

## Current State

- `passthrough-candidates` returns literal one-callee forwarding functions after a body-shape gate and emits `actionTier`, `boundaryEvidence`, and `recommendation`. Source: `scip-query plan-context passthrough-candidates`; `scip-query code passthroughCandidateForSymbol -C 8`.
- The analyzer already computes public facade evidence through `publicFacadeEvidence()`, using exported declarations plus package-surface or rooted-entry checks. Source: `scip-query trace publicFacadeEvidence`; `scip-query code src/queries/cleanup/passthrough-candidates.ts:90-152`.
- The exported result contract does not contain a separate `publicFacadeEvidence` field, and `passthroughCandidateForSymbol()` currently merges public facade evidence into `boundaryEvidence`. Source: `scip-query code PassthroughCandidate -C 5`; `scip-query code passthroughCandidateForSymbol -C 8`.
- Health scoring already discounts passthrough rows by `actionTier`, so separating the evidence fields should not change the weighted count for rows that were already signals. Source: `scip-query code summarizeHealthPassthroughs -C 8`; `scip-query code passthroughHealthScore -C 8`.
- A clean Vega rerun with the current built CLI produced 91 passthrough rows: 74 signal, 17 direct. Two rows carried public-surface-shaped evidence, but only inside `boundaryEvidence`; no row exposed a separate `publicFacadeEvidence` field.

## Reuse Audit

- Reuse `publicFacadeEvidence()` rather than adding a second exported-surface classifier. Source: `scip-query trace publicFacadeEvidence`.
- Reuse `passthroughRecommendation()` and extend its inputs rather than creating a parallel recommendation helper. Source: `scip-query code src/queries/cleanup/passthrough-candidates.ts:90-152`.
- Reuse `passthroughHealthScore()` unchanged because the scoring input remains `actionTier`. Source: `scip-query code passthroughHealthScore -C 8`.
- Similarity check found only access-query scaffolding overlap for `publicFacadeEvidence`, not a reusable duplicate. Source: `scip-query similar publicFacadeEvidence --json`.

## Design

### 1. Split Evidence In The Passthrough Result

- [x] **File**: `src/queries/cleanup/passthrough-candidates.ts:16-29`
- **Source**: `scip-query code PassthroughCandidate -C 5`.
- **What**: `PassthroughCandidate` has `boundaryEvidence` but no dedicated public facade field.
- **Change**: Add `publicFacadeEvidence: string[]` to the result contract.
- **Why**: Consumers should not string-scrape `boundaryEvidence` to tell public/exported facade evidence from runtime-boundary evidence.

### 2. Preserve Scoring While Separating Evidence

- [x] **File**: `src/queries/cleanup/passthrough-candidates.ts:59-88`
- **Source**: `scip-query code passthroughCandidateForSymbol -C 8`.
- **What**: `passthroughCandidateForSymbol()` appends public facade evidence into `boundaryEvidence` and sets `actionTier` from the merged list.
- **Change**: Compute `boundaryEvidence` and `publicFacadeEvidence` separately; set `actionTier` to `signal` when either list is non-empty; return both fields.
- **Why**: The verdict remains the same, but the reason becomes machine-readable.

### 3. Make Recommendations Prefer Public Facade Evidence

- [x] **File**: `src/queries/cleanup/passthrough-candidates.ts:110-118`
- **Source**: `scip-query code src/queries/cleanup/passthrough-candidates.ts:90-152`.
- **What**: `passthroughRecommendation()` detects public API advice by looking for public-surface text inside `boundaryEvidence`.
- **Change**: Pass both evidence lists and choose public-API wording when `publicFacadeEvidence` is present or the boundary list itself contains public-surface terms.
- **Why**: Exported facade rows should explain that callers may depend on the public name.

### 4. Cover The Output Contract

- [x] **File**: `tests/queries/cleanup/passthrough-candidates-output.test.ts`
- **Source**: `scip-query files '*passthrough*'` could not find the untracked test, so this step is anchored to the existing validation file in the working tree and the production contract citations above.
- **What**: Current output tests cover action tier and boundary evidence, but the schema gap escaped because public facade evidence was folded into the same array.
- **Change**: Add a fixture/assertion where an exported package-surface passthrough emits `publicFacadeEvidence`, remains `signal`, and does not pollute `boundaryEvidence`.
- **Why**: Future schema changes should fail loudly if the two evidence types collapse again.

### 5. Record The Second-Corpus Verdict

- [x] **File**: `docs/validation/2026-06-22-passthrough-exported-facade-second-corpus-result.md`
- **Source**: Vega rerun at `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/passthrough-candidates-200-current.json`.
- **What**: The clean corpus exposed a schema distinction problem rather than a scoring problem.
- **Change**: Record before/after counts, the implementation judgment, and gates.
- **Why**: The validation ledger needs an auditable trail for why this slice changed code.

## Stress Test

- Understand before touch: the body-shape gate and one-callee rule remain unchanged, so this does not widen detection.
- Blast radius: `PassthroughCandidate` has only local query, health, and public index consumers. Source: `scip-query refs PassthroughCandidate`.
- Intermediate validity: adding a non-optional field is safe because all candidates are constructed in one function.
- Reversibility: this is a two-way output-schema refinement; rollback removes the field and tests.
- Failure design: empty `publicFacadeEvidence` preserves existing direct/signal behavior.
- Boundary defense: exported facade evidence is kept separate from runtime boundary evidence so users can review the correct boundary.
- Reuse: existing public-surface checks are reused.
- Human impact: recommendations become clearer without changing direct cleanup rows.

## Verification Plan

- Focused tests for passthrough output.
- `npm run typecheck`.
- `npm run build`.
- Re-run Vega `passthrough-candidates --json --limit 200` with current dist and compare field/count shape.
- Matching guardrails: `similar publicFacadeEvidence`, `recent-duplicates`, `unused-params`, `wrapper-candidates`, `passthrough-candidates`.
- Final gate: `node dist/cli.js reindex && node dist/cli.js diff-gate --json`, accepting only previously documented unrelated findings if they remain.
