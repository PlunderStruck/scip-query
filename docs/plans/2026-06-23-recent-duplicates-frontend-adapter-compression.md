# Recent Duplicates Frontend Adapter Compression - 2026-06-23

## Goal

Implement the P2 follow-up item in `docs/plans/2026-06-23-maintainability-register.md`: reduce repeated frontend duplicate-to-`RecentDuplicateCandidate` mapping in `src/queries/cleanup/recent-duplicates.ts` while preserving React/Vue detector behavior and public result shapes.

Done means `recentDuplicates()` still returns the same candidate domains, bases, symbols, files, similarity, evidence labels, and empty `sharedCallees` for frontend detectors, but the shared candidate-envelope rule lives in one local helper.

## Current State

- `recentDuplicates()` builds candidate rows through `collectRecentDuplicateCandidates()`, orients them with git file-add history, sorts echoes before twins, limits results, and groups root causes. Source: `scip-query plan-context recentDuplicates`; `scip-query code recentDuplicates -C 8`.
- `collectRecentDuplicateCandidates()` calls one callable adapter and four frontend adapters with a shared option envelope: `scope`, `minSimilarity`, `limit`, and `scanLimit`. Source: `scip-query code collectRecentDuplicateCandidates -C 5`.
- `reactComponentDuplicateCandidates()`, `reactHookDuplicateCandidates()`, `vueComponentDuplicateCandidates()`, and `vueComposableDuplicateCandidates()` are private functions with no external consumers; each is called only by `collectRecentDuplicateCandidates()`. Source: `scip-query plan-context reactComponentDuplicateCandidates`; `scip-query plan-context reactHookDuplicateCandidates`; `scip-query plan-context vueComponentDuplicateCandidates`; `scip-query plan-context vueComposableDuplicateCandidates`.
- Each frontend adapter calls its detector, filters `pair.fileA !== pair.fileB`, maps `domain`, `basis`, `symbolA`, `fileA`, `symbolB`, `fileB`, `similarity`, `sharedEvidence`, and `sharedCallees: []`. Source: `scip-query code 'src/queries/cleanup/recent-duplicates.ts:155-360'`.
- `evidenceFromBuckets()` already owns deduplicated `prefix:value` evidence formatting, and `fileStem()` already owns Vue file-name display fallback. Source: `scip-query code evidenceFromBuckets -C 5`; `scip-query code fileStem -C 5`.
- Change risk is medium at file level because `recentDuplicates()` has two external consumers through `src/queries/index.ts` and cleanup command handlers, but the adapter functions themselves are private. Source: `scip-query change-surface src/queries/cleanup/recent-duplicates.ts`.
- `scip-query doc-drift docs/plans/2026-06-23-maintainability-register.md` reports no drift for the register item before implementation.

## Reuse Audit

- Reuse `evidenceFromBuckets()` for evidence formatting instead of creating another string formatter. Source: `scip-query code evidenceFromBuckets -C 5`.
- Reuse `fileStem()` for Vue symbol display instead of duplicating file-name extraction. Source: `scip-query code fileStem -C 5`.
- No existing candidate-envelope mapper was found. `scip-query similar reactComponentDuplicateCandidates` reports the other frontend adapters as 85%, 83%, and 79% similar signal rows, but no shared helper. `scip-query similar-chains` reports unrelated index/domain chains. `scip-query similar-signatures` reports unrelated same-signature utilities, plus only the existing `fileStem()` helper in this file. `scip-query recent-duplicates` reports no fresh reimplementations.

## Design Phases

### 1.1 - Add A Local Frontend Candidate Mapper

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:69-89`
- **Source**: `scip-query plan-context recentDuplicates`; `scip-query code 'src/queries/cleanup/recent-duplicates.ts:155-360'`.
- **What**: The file has a `RecentDuplicateCandidate` envelope type, then four private frontend adapters each hand-build that envelope.
- **Change**: Add private local types for frontend pair inputs and a `frontendDuplicateCandidates()` helper that accepts a detector callback, `domain`, `basis`, symbol selectors, and evidence-bucket selector. The helper must filter same-file pairs, call `evidenceFromBuckets()`, and set `sharedCallees: []`.
- **Why**: This names the shared candidate-envelope policy while keeping detector-specific buckets and symbol selectors local.

### 1.2 - Rewire The Four Frontend Adapters

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:225-350`
- **Source**: `scip-query plan-context reactComponentDuplicateCandidates`; `scip-query plan-context reactHookDuplicateCandidates`; `scip-query plan-context vueComponentDuplicateCandidates`; `scip-query plan-context vueComposableDuplicateCandidates`.
- **What**: Each adapter repeats detector call, same-file filtering, envelope mapping, evidence bucket formatting, and empty `sharedCallees`.
- **Change**: Keep the four function names and detector-specific query calls, but delegate envelope construction to `frontendDuplicateCandidates()`. Preserve each existing `domain`, `basis`, symbol selector, and evidence-bucket list exactly.
- **Why**: Call sites and framework-specific evidence stay readable, but future candidate-envelope changes happen once.

### 1.3 - Update Register Completion Notes

- [x] **File**: `docs/plans/2026-06-23-maintainability-register.md:128-153`
- **Source**: `scip-query doc-drift docs/plans/2026-06-23-maintainability-register.md`; `scip-query change-surface src/queries/cleanup/recent-duplicates.ts`.
- **What**: The follow-up review currently marks the P2 recent-duplicate frontend adapter compression as "`extract` when this file is next touched".
- **Change**: Mark that row as done after implementation and add verification commands to the follow-up probe list or a short completion note.
- **Why**: The register should reflect that the item was handled, not leave a stale future recommendation.

## Stress Test Findings

- Understand before touch: this is a local query-layer refactor. The public `recentDuplicates()` lifecycle remains unchanged: collect candidates, orient with file-add history, sort, limit, and group. Source: `scip-query code recentDuplicates -C 8`.
- Blast radius: only `src/queries/cleanup/recent-duplicates.ts` code changes are planned; its external consumers are `src/queries/index.ts` and `src/runtime/query-commands/cleanup/handlers.ts`. Source: `scip-query plan-context recentDuplicates`; `scip-query change-surface src/queries/cleanup/recent-duplicates.ts`.
- Valid intermediate state: phase 1.1 can compile before 1.2 only if the helper is private and unused; phase 1.2 completes the migration. There is no schema, storage, async, or CLI boundary change.
- Reversibility: this is a two-way internal refactor. Reverting the helper restores the original four local maps.
- Failure/concurrency/data integrity: no new IO, shared mutable state, persistence, or concurrency behavior is introduced.
- Boundary defense: CLI command options and public query exports remain unchanged.
- Human effect: command output should be identical because the existing domains, bases, symbols, evidence labels, and root-cause grouping inputs are preserved.
- Reuse: the plan reuses `evidenceFromBuckets()` and `fileStem()` and introduces only one local helper for a repeated rule no existing helper owns.

## Execution Order

1. Add the local helper and types.
2. Rewire the four frontend adapters.
3. Update the register row and verification note.
4. Run focused type/test/SCIP checks.

## Verification Plan

- `npm run typecheck` passed.
- `npm test -- tests/queries/cleanup/frontend-recent-duplicates.test.ts` was attempted first, but that path does not exist.
- `npm test -- tests/queries/frontend/frontend-recent-duplicates.test.ts` passed: 1 file, 1 test.
- `npm test` passed: 68 files, 354 tests. The run still prints the known noisy `git diff` usage text from existing fixtures.
- `scip-query incomplete-migration` passed with 1 changed file and 1 new helper scored; no incomplete migrations.
- `scip-query recent-duplicates --full` reported no recent reimplementations.
- `scip-query similar frontendDuplicateCandidates` reported no similar symbols.
- `scip-query unused-params` reported no trailing unused parameters.
- `scip-query wrapper-candidates`, `passthrough-candidates`, and `stale-abstractions --include-low-confidence` reported no findings.
- `scip-query doc-drift docs/plans/2026-06-23-maintainability-register.md` reported no drifting docs.
- `scip-query doc-drift docs/plans/2026-06-23-recent-duplicates-frontend-adapter-compression.md` reported no drifting docs.
- `scip-query co-change src/queries/cleanup/recent-duplicates.ts` reported no co-change partners in 192 commits.
- `scip-query similar-files` still reports the accepted watcher/context and frontend-family signals; it reports no new `recent-duplicates.ts` file-level signal.
- `git diff --check` passed.
- `scip-query health --json` reported score 100 with no active dead, wrapper, passthrough, stale, drift, cycle, hidden-coupling, or recent-duplicate findings. It still reports the one accepted heuristic similarity signal.
- `scip-query diff-impact` reports 1 changed code file, 8 changed symbols, and 0 affected consumer files.
- `scip-query reindex && scip-query diff-gate` passed: 1 changed indexed file, 8 changed symbols, and no gate findings.
