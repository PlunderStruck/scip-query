# Cross-Language Capability Boundaries

Date: 2026-06-21

## Goal

Validate how the analyzer suite behaves on a Rust project, then make any narrow correction needed so cross-language output distinguishes real Rust support from TypeScript- or frontend-specific affordances. Done means the ledger records which commands are supported, which commands correctly return unavailable or empty results, and any misleading output found during the Rust probe is corrected or explicitly accepted.

## Current State

- `scip-query plan-context src/queries/cleanup/similar.ts` reports `src/queries/cleanup/similar.ts` as the shared similarity implementation used by `recent-duplicates`, `health`, `diff-gate`, `incomplete-migration`, and cleanup CLI handlers.
- `scip-query change-surface src/queries/cleanup/similar.ts` reports 20 external consumers and marks `similar()`, `similarAll()`, `SimilarEvidenceClass`, and related exported result types as medium-risk surfaces.
- `scip-query code src/queries/cleanup/similar.ts:439-505` shows `classifySimilarityEvidence()` currently falls through to `framework-scaffolding` whenever shared evidence has no domain or access/query hits, even when no framework tokens were matched.
- A Rust probe on `/Users/aydansalois/Documents/GitHub/SynthRunnerRust` showed graph/source/checker capabilities are available, semantic-oracle self-audit is correctly unavailable, React/Vue analyzers correctly return empty arrays, and `similar --json` currently labels Rust gameplay callee overlap as `framework-scaffolding` with empty reasons.

## Reuse Audit

No new query or analyzer is needed. The existing `classifySimilarityEvidence()` hook is already applied by `similar()`, `similarAll()`, `recent-duplicates`, health, and diff-gate through the shared result shape. The correction should extend the existing evidence vocabulary rather than duplicate scoring logic.

## Design

### 1. Add a Neutral Similarity Evidence Class

- [x] **File**: `src/queries/cleanup/similar.ts:34-38`
- **Source**: `scip-query code src/queries/cleanup/similar.ts:34-46`
- **What**: `SimilarEvidenceClass` can describe access/query scaffolding, domain behavior, framework scaffolding, or mixed evidence.
- **Change**: Add `structural-overlap` for shared call/source evidence that has no recognized domain, access/query, or framework category.
- **Why**: Rust callee overlap can be real structural evidence without being framework scaffolding.

### 2. Preserve Existing Classified Paths

- [x] **File**: `src/queries/cleanup/similar.ts:439-505`
- **Source**: `scip-query code src/queries/cleanup/similar.ts:439-505`
- **What**: The classifier currently defaults all non-domain/non-access pairs to `framework-scaffolding`.
- **Change**: Keep direct domain, mixed, access/query, explicit framework, and generic source-token classifications intact; return `structural-overlap` only when no known semantic category matched.
- **Why**: This narrows the Rust fix without changing the meaning of existing framework or generic-source cases.

### 3. Lock the Boundary With Tests

- [x] **File**: `tests/queries/cleanup/similar-topk.test.ts`
- **Source**: `scip-query refs classifySimilarityEvidence`
- **What**: Existing unit tests cover domain, access/query, strong domain, and generic source-token scaffolding.
- **Change**: Add a test for callee evidence with no known domain/scaffolding tokens and assert `structural-overlap` plus a signal-tier recommendation.
- **Why**: The next cross-language probe should not regress to a misleading frontend-flavored label.

### 4. Record the Cross-Language Result

- [x] **File**: `docs/validation/2026-06-21-cross-language-capability-boundaries-result.md`
- **Source**: Rust probe commands run against `/Users/aydansalois/Documents/GitHub/SynthRunnerRust`; `scip-query status --json`, `capability-matrix --json`, `health --full --json`, `dead`, `cleanup-plan`, `wrapper-candidates`, `extract-candidates`, `similar`, React/Vue analyzers, and `self-audit`.
- **What**: The ledger needs a durable verdict for the Rust support boundary.
- **Change**: Record supported capabilities, unavailable semantic oracle behavior, frontend analyzer empty-result behavior, the similarity classifier correction, and verification commands.
- **Why**: Future analyzer work should know which boundaries are real guarantees and which are contextual leads.

## Stress Test

- Blast radius is medium because `SimilarEvidenceClass` is exported; the change is additive and does not remove existing labels.
- The correction is reversible by removing one enum-like union member and the fallback branch.
- No data integrity, concurrency, or trust-boundary behavior changes are involved; this is deterministic CLI output classification.
- Human-facing behavior improves because Rust users will see a neutral structural signal instead of an unsupported framework explanation.

## Verification

- Focused unit test: `npx vitest run tests/queries/cleanup/similar-topk.test.ts`
- Rust repro command: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js similar --json` in `/Users/aydansalois/Documents/GitHub/SynthRunnerRust`
- Standard gates: `npm run typecheck`, `npm run build`, `npm test`, `./dist/cli.js recent-duplicates --json`, `./dist/cli.js unused-params --json`, `./dist/cli.js reindex`, `./dist/cli.js diff-gate`
