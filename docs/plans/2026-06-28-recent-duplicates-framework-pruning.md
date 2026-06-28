# Recent Duplicates Framework Pruning - 2026-06-28

## Goal

Speed up `scip-query recent-duplicates` without reducing accuracy. The command should still compare callable code and framework-specific frontend structures, but it should not enter React parsers in projects that have no React source files or Vue parsers in projects that have no Vue source files.

Framework applicability is the source-file classification signal that tells a detector whether the project contains the file kinds required by a frontend framework. Here that means `.tsx`/`.jsx` files for React and `.vue` files for Vue.

Done means `recent-duplicates --json` keeps the same output on projects where a framework is present, skips irrelevant framework branches before parsing, and improves the measured no-finding case on `Stable_Management`.

## Current State

- `recentDuplicates()` fetches git add records, then calls `collectRecentDuplicateCandidates()` before orienting candidates into echo/twin findings. Source: `scip-query plan-context recent-duplicates` and `scip-query code recentDuplicates -C 8`.
- `collectRecentDuplicateCandidates()` always runs `callableDuplicateCandidates()`, `reactComponentDuplicateCandidates()`, `reactHookDuplicateCandidates()`, `vueComponentDuplicateCandidates()`, and `vueComposableDuplicateCandidates()`. Source: `scip-query code collectRecentDuplicateCandidates -C 8`.
- The frontend candidate adapters call `reactComponentDuplicates()`, `reactHookCandidates()`, `vueComponentDuplicates()`, and `vueComposableCandidates()` through `frontendDuplicateCandidates()`. Source: `scip-query code reactComponentDuplicateCandidates -C 8`, `scip-query code reactHookDuplicateCandidates -C 8`, `scip-query code vueComponentDuplicateCandidates -C 8`, `scip-query code vueComposableDuplicateCandidates -C 8`, and `scip-query code frontendDuplicateCandidates -C 8`.
- The React detectors build React behavior profiles before ranking pairs; the Vue detectors build Vue behavior profiles before ranking pairs. Source: `scip-query code reactComponentDuplicates -C 8`, `scip-query code reactHookCandidates -C 8`, `scip-query code vueComponentDuplicates -C 8`, and `scip-query code vueComposableCandidates -C 8`.
- `runIsolatedHealthReport()` already computes a local `HealthPhaseApplicability` and uses `shouldRunHealthPhase()` to skip React/Vue health phases when the project lacks matching source files. Source: `scip-query code 'src/runtime/cli-support.ts:100-150'` and `scip-query code 'src/runtime/cli-support.ts:1-85'`.
- `getSourceFiles()` is the canonical cached source-file set builder for indexed and auxiliary project sources. Source: `scip-query code getSourceFiles -C 5`.

## Reuse Audit

- Reuse `getSourceFiles()` for project source classification instead of rewalking the filesystem. Source: `scip-query similar getSourceFiles --json --full` returned no near-duplicate helper, and `scip-query affected getSourceFiles` shows the existing helper already feeds source-scanning queries.
- Extract the health-local applicability logic into a source-layer helper rather than importing runtime code from query code. Source: `scip-query code 'src/runtime/cli-support.ts:100-150'` shows `healthPhaseApplicability()` and `hasSourceFile()` are local runtime helpers; `scip-query change-surface src/runtime/cli-support.ts` shows the runtime module has broader CLI consumers.
- Keep the new helper beside `source-fileset.ts`, because `scip-query rdeps src/source/source-fileset.ts` shows source-scanning code already depends on that module and `scip-query surface src/source --json` shows `src/source` is the existing source-analysis boundary.

## Design

### 1. Extract Source Framework Applicability

- [ ] **File**: `src/source/source-fileset.ts:130-153`
- **Source**: `scip-query code getSourceFiles -C 5`
- **What**: `getSourceFiles()` returns a cached sorted list of project source paths, optionally filtered by extension.
- **Change**: Add exported `SourceFrameworkApplicability` and `sourceFrameworkApplicability(db, opts?: { scope?: string })` helpers in this module. React is true when a scoped `.tsx` or `.jsx` source exists; Vue is true when a scoped `.vue` source exists. The implementation should call `getSourceFiles()` once with the combined framework extension set, then classify paths in memory.
- **Why**: This makes framework presence a reusable query-layer fact and avoids duplicating filesystem/index scans.

### 2. Reuse Applicability In Health

- [ ] **File**: `src/runtime/cli-support.ts:25-36`
- **Source**: `scip-query code 'src/runtime/cli-support.ts:1-85'`
- **What**: The runtime module declares React/Vue extension arrays only to compute health phase applicability.
- **Change**: Remove local extension constants and import `sourceFrameworkApplicability` from `../source/source-fileset.js`.
- **Why**: Health and cleanup detectors should agree on framework detection.

- [ ] **File**: `src/runtime/cli-support.ts:133-142`
- **Source**: `scip-query code 'src/runtime/cli-support.ts:100-150'`
- **What**: `healthPhaseApplicability()` wraps the local `hasSourceFile()` helper.
- **Change**: Replace its body with `return sourceFrameworkApplicability(db, { scope: opts.scope });` and delete the local `hasSourceFile()` helper.
- **Why**: Keeps existing health behavior while moving the reusable fact to the source layer.

### 3. Gate Recent Duplicate Frontend Branches

- [ ] **File**: `src/queries/cleanup/recent-duplicates.ts:177-215`
- **Source**: `scip-query code collectRecentDuplicateCandidates -C 8`
- **What**: `collectRecentDuplicateCandidates()` always invokes all React and Vue duplicate candidate builders.
- **Change**: Compute `const applicability = sourceFrameworkApplicability(db, { scope: opts.scope });`, build a mutable candidate array, always append callable candidates, append React candidates only when `applicability.react`, and append Vue candidates only when `applicability.vue`.
- **Why**: Avoids irrelevant parser/profile work while preserving all currently applicable comparisons.

### 4. Tests And Measurement

- [ ] **File**: `tests/runtime/cli-support.test.ts`
- **Source**: `scip-query code 'src/runtime/cli-support.ts:100-150'`
- **What**: Existing health pruning tests cover `shouldRunHealthPhase()` and skipped phase results.
- **Change**: Update or add tests that assert health phase pruning uses the shared source framework applicability result.
- **Why**: Protects the earlier health performance work.

- [ ] **File**: `tests/queries/cleanup/recent-duplicates.test.ts`
- **Source**: `scip-query code collectRecentDuplicateCandidates -C 8`
- **What**: `collectRecentDuplicateCandidates()` is private, so behavior should be covered through `recentDuplicates()` or exported test seams only if an existing pattern exists.
- **Change**: Add a focused test fixture where React/Vue framework files are absent and assert `recentDuplicates()` returns callable-only output without requiring frontend candidates.
- **Why**: Verifies the new skip path does not change callable duplicate behavior.

## Stress Test

- Understanding: The command is an echo detector, not a generic similarity report; `orientRecentDuplicate()` filters candidates by git add age after candidate collection. Source: `scip-query code recentDuplicates -C 8`.
- Blast radius: `recent-duplicates.ts` has seven external consumers and `recentDuplicates()` has two consumers, so output shape must not change. Source: `scip-query change-surface src/queries/cleanup/recent-duplicates.ts`.
- Intermediate validity: The helper extraction is additive first; health and recent-duplicates can switch to it independently.
- Reversibility: This is a two-way internal refactor. Reverting the import and branch guards restores prior behavior.
- Failure modes: `getSourceFiles()` already honors ignored paths and indexed/auxiliary source handling. Source: `scip-query code getSourceFiles -C 5`.
- Concurrency: The new helper only reads from the per-db source-file cache; no mutable global state is introduced. Source: `scip-query code getSourceFiles -C 5`.
- Boundaries: No CLI options or JSON result contracts change.
- Data integrity: No persisted data is written.
- Observability: Existing command outputs remain unchanged; benchmark timings provide the performance signal.
- Human impact: Users get faster no-op and single-framework runs without losing framework-specific findings.
- Reuse: The implementation reuses `getSourceFiles()` and removes the health-local duplicate logic.

## Execution Order

1. Add source applicability helpers.
2. Switch health pruning to the shared helper.
3. Gate `recent-duplicates` frontend candidate collection.
4. Add/update focused tests.
5. Run typecheck, focused tests, build, full tests, benchmark `recent-duplicates` on `Stable_Management`, then run freshness/diff-gate.

## Summary

Expected files changed: `src/source/source-fileset.ts`, `src/runtime/cli-support.ts`, `src/queries/cleanup/recent-duplicates.ts`, `tests/runtime/cli-support.test.ts`, and `tests/queries/cleanup/recent-duplicates.test.ts`.
