# Locality Suggested-Home Hardening

Date: 2026-06-22

## Goal

The user wants `locality-candidates` to stay useful for directory-organization review while becoming less overconfident about exact destination paths. Done means the command still reports consumer ownership evidence, but it withholds `suggestedHome` when the path would invent a generic `shared` folder, cross a source root, or erase a named architectural boundary.

## Current State

- `scip-query plan-context src/queries/cleanup/locality-candidates.ts --json` reports `src/queries/cleanup/locality-candidates.ts` as the implementation file, with `src/queries/index.ts` and `src/runtime/query-commands/cleanup/handlers.ts` as reverse dependencies.
- `scip-query code buildLocalityCandidate -C 10` shows `buildLocalityCandidate()` computes `nearestCommonOwner`, `recommendedTier`, `suggestedHome`, `counterevidence`, `reasons`, and `recommendation` in one pass.
- `scip-query code suggestedHomeFor -C 12` shows `suggestedHomeFor()` currently returns `${nearestCommonOwner}/shared` whenever the tier permits a destination and the nearest owner is not already a shared segment.
- `scip-query code LocalityCandidate -C 6` shows `suggestedHome` is already typed as `string | null`, so withholding unsafe destinations is not a public type break.
- `scip-query code 'src/runtime/query-commands/cleanup/handlers.ts:180-230'` shows the text renderer prints `Suggested home` only when `r.suggestedHome` exists, so `null` degrades cleanly in human output.

## Reuse Audit

- `scip-query outline src/queries/cleanup/locality-candidates.ts --json` shows existing helpers for path normalization, marker checks, tier selection, ancestry, and suggested-home construction. This change should extend that file rather than add a new module.
- `scip-query recent-duplicates --json` reports no recent duplicate findings, so adding small locality-specific predicates in the existing analyzer is acceptable.
- `scip-query surface src/queries/cleanup/locality-candidates.ts --json` shows consumers already depend on `LocalityCandidate` and `suggestedHome`; adding nullable-conservative behavior preserves the shape.

## Plan

### 1. Harden Destination Selection

- [x] **File**: `src/queries/cleanup/locality-candidates.ts:39-53`
- **Source**: `scip-query code LocalityCandidate -C 6`
- **What**: `LocalityCandidate` exposes `suggestedHome: string | null` but does not explain why a path was withheld.
- **Change**: Add `destinationConfidence` and `whyNoSuggestedHome` fields so consumers can distinguish good consumer evidence from unsafe destination evidence.
- **Why**: Stable Management validation showed the consumer signal was useful even when the literal destination was wrong.

### 2. Make `suggestedHomeFor` Conservative

- [x] **File**: `src/queries/cleanup/locality-candidates.ts:399-419`
- **Source**: `scip-query code suggestedHomeFor -C 12`
- **What**: The function appends `/shared` to the nearest common owner for most multi-consumer rows.
- **Change**: Replace it with a destination assessment that returns a home only when it already exists in the indexed directory set, stays inside the candidate's source root, and does not replace a named architectural boundary with generic `shared`.
- **Why**: The Stable Management review found false destinations such as `backend/src/shared`, `backend/shared`, and `backend/src/workflows/shared`.

### 3. Preserve Existing Evidence and Ranking

- [x] **File**: `src/queries/cleanup/locality-candidates.ts:186-236`
- **Source**: `scip-query code buildLocalityCandidate -C 10`
- **What**: `buildLocalityCandidate()` already keeps consumer files, coverage, nearest owner, boundary markers, tier, reasons, and counterevidence.
- **Change**: Keep that evidence intact; feed the indexed file set into destination assessment and thread the new confidence/withheld-reason fields into the returned candidate.
- **Why**: The validation pass found evidence collection useful; only the imperative destination was too eager.

### 4. Update Tests From Reviewed Cases

- [x] **File**: `tests/queries/cleanup/locality-candidates.test.ts`
- **Source**: `scip-query files 'tests/queries/cleanup/locality-candidates.test.ts' --json` could not read this fixture from the SCIP index, so the test file was inspected directly after noting the index limitation.
- **What**: Existing tests assert `src/features/horses/shared` for a feature-local candidate.
- **Change**: Update the fixture to include an existing shared directory where a destination should be emitted, and add regressions for source-root clamping and architectural-boundary suppression.
- **Why**: The Stable Management false positives need to become executable guardrails.

### 5. Update Validation Docs

- [x] **File**: `docs/validation/2026-06-22-stable-management-locality-suggested-home-review.md`
- **Source**: `scip-query diff-gate` from the previous pass reported this doc as a clean two-file documentation change.
- **What**: The doc records the discovered precision actions.
- **Change**: Add an implementation follow-up note after the code change lands.
- **Why**: The validation ledger should say which precision action was taken.

## Stress Test

- Understand before touching: `buildLocalityCandidate()` keeps the analyzer's useful evidence; only destination assessment changes.
- Blast radius: `rdeps` and `surface` show only the query export and CLI handler consume the public result shape.
- Intermediate validity: Adding nullable fields is reversible and keeps `suggestedHome` nullable.
- Failure design: Unsafe destinations become `null` with a reason instead of a wrong path.
- Boundary defense: Named folders such as `effect`, `errors`, `workflows`, `serviceTasks`, `db`, `access`, `types`, and `schemas` are treated as ownership boundaries.
- Human impact: CLI output remains readable because the renderer already omits missing `Suggested home`.

## Verification

Run:

```sh
npm test -- tests/queries/cleanup/locality-candidates.test.ts
npm run typecheck
npm run build
node dist/cli.js locality-candidates --scope src/queries/cleanup --json -n 5
node dist/cli.js recent-duplicates --json
node dist/cli.js unused-params --json
scip-query reindex
scip-query diff-gate
```

## Vega Follow-Up

Date: 2026-06-22

After running `locality-candidates --json --full` on `/Users/aydansalois/Documents/GitHub/Vega_2.0`, the command correctly emitted zero exact `suggestedHome` rows, but some withheld reasons were awkward:

- `apps/web/src/hooks/useAsyncLoader.ts`, `apps/web/src/lib/utils.ts`, and `apps/web/src/test-utils/render.ts` were withheld because `apps/web/src/shared` did not exist, even though `hooks`, `lib`, and `test-utils` are already recognizable ownership folders.
- `packages/companion/src/*` rows were withheld because `packages/companion/src/shared` did not exist, even when the candidate already lived at the nearest common owner.

Plan update:

- [x] **File**: `src/queries/cleanup/locality-candidates.ts:135-159`
- **Source**: `scip-query trace DEFAULT_ARCHITECTURAL_BOUNDARY_SEGMENTS --json`
- **Change**: Add `hooks`, `lib`, and `test-utils` to the default architectural boundary set.
- **Why**: Vega shows these folders acting as mature local ownership surfaces; generic `shared` should not be proposed or used as the withheld reason.

- [x] **File**: `src/queries/cleanup/locality-candidates.ts:463-501`
- **Source**: `scip-query trace destinationAssessmentFor --json`
- **Change**: If `currentDirectory` is already the normalized `nearestCommonOwner`, withhold with an explicit "already nearest common owner" reason before proposing `<owner>/shared`.
- **Why**: A file already sitting at the common owner is a placement signal, not evidence that a new `shared` folder should exist.

- [x] **File**: `tests/queries/cleanup/locality-candidates.test.ts`
- **Source**: `scip-query outline tests/queries/cleanup/locality-candidates.test.ts --json` returned no indexed symbols for the markdown fixture, so this file is inspected directly and covered by focused Vitest.
- **Change**: Add fixture rows for `hooks` boundary withholding and already-at-owner withholding.
- **Why**: The Vega findings should become executable guardrails.
