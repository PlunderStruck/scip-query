# Maintainability Register Completion Plan - 2026-06-23

## Goal

Finish every actionable item in `docs/plans/2026-06-23-maintainability-register.md`. Done means C1, C2, and C3 are implemented, deferred or skipped register rows are explicitly closed with evidence, and the register records verification.

## Current State

- Frontend behavior analyzers are two public query modules consumed by recent-duplicates, health, query exports, and cleanup command rendering. Source: `scip-query plan-context reactHookCandidates`; `scip-query plan-context vueComposableCandidates`.
- `reactHookCandidates()` builds React profiles, compares them through local `compareProfiles()`, and emits `ReactHookCandidateResult`. Source: `scip-query plan-context reactHookCandidates`, definitions `src/queries/frontend/react-hook-candidates.ts:45-80`.
- `vueComposableCandidates()` builds Vue profiles, compares them through local `compareProfiles()`, and emits `VueComposableCandidateResult`. Source: `scip-query plan-context vueComposableCandidates`, definitions `src/queries/frontend/vue-composable-candidates.ts:44-73`.
- Both frontend analyzers locally classify shared behavior into the same evidence classes and action tiers. Source: `scip-query code classifyReactHookEvidence -C 8`, `src/queries/frontend/react-hook-candidates.ts:145-193`; `scip-query code classifyVueComposableEvidence -C 8`, `src/queries/frontend/vue-composable-candidates.ts:142-193`.
- `diffGate()` owns one shared diff impact plan, then runs seven local checks and applies structured suppressions/root-cause grouping. Source: `scip-query plan-context diffGate`, definitions `src/queries/impact/diff-gate.ts:158-221`.
- Diff-gate checks hand-build `DiffGateFinding` records and suppression hints. Source: `scip-query code runEchoCheck -C 6`, `src/queries/impact/diff-gate.ts:319-379`; `scip-query code runIncompleteMigrationCheck -C 6`, `src/queries/impact/diff-gate.ts:452-509`; `scip-query code runCoChangePartnerCheck -C 6`, `src/queries/impact/diff-gate.ts:511-595`; `scip-query code runBaselineCheck -C 6`, `src/queries/impact/diff-gate.ts:946-984`.
- Query command order exists in `queryCommandOrder`, but CLI registration repeats the query list as individual `query(...)` calls. Source: `scip-query code 'src/runtime/commands/query-command-specs.ts:10-99'`; `scip-query code 'src/runtime/commands/command-descriptors.ts:45-122'`.
- Tests are not part of the current SCIP index (`scip-query files 'tests/**/*.ts'` returned no indexed files), so test edits must be verified by running the test suite rather than citing indexed line references.

## Reuse Audit

- C1 should reuse `rankedPairwiseProfileResults()` rather than replacing pairwise ranking. Source: `scip-query plan-context reactHookCandidates`; `scip-query plan-context vueComposableCandidates`.
- C1 should keep framework-specific profile builders local: React uses `buildReactComponentBehaviorProfiles()`, Vue uses `buildVueComponentBehaviorProfiles()`. Source: `scip-query plan-context reactHookCandidates`; `scip-query plan-context vueComposableCandidates`.
- C1 has no existing shared frontend evidence classifier. `scip-query similar-signatures` shows only same-shape local functions such as `hasDomainBehaviorWords()` and `behaviorWords()` in the two frontend analyzers, which supports extracting one small private helper.
- C2 should reuse the existing `findingId()` function and `DiffGateFinding` type, not introduce a new finding identity scheme. Source: `scip-query code runEchoCheck -C 6`; `scip-query code runBaselineCheck -C 6`.
- C2 should keep the checks in `diff-gate.ts`; `scip-query plan-context diffGate` shows shared dependencies on one `DiffImpactPlan`, suppression pass, and grouping pass.
- C3 should reuse `queryCommandOrder` and `QUERY_COMMANDS_BY_ID` rather than introduce another command manifest. Source: `scip-query code 'src/runtime/commands/query-command-specs.ts:10-99'`.

## Design Phases

### 1. Extract Frontend Behavior Evidence Helper

- [x] **File**: `src/queries/internal/frontend-behavior-evidence.ts`
- **Source**: `scip-query code classifyReactHookEvidence -C 8`; `scip-query code classifyVueComposableEvidence -C 8`; `scip-query similar-signatures`.
- **What**: React and Vue analyzers duplicate evidence-class selection, domain-word filtering, behavior similarity, token sorting, and token extraction.
- **Change**: Add a private helper exporting shared types plus `classifyFrontendBehaviorEvidence()`, `behaviorSimilarity()`, `tokenValues()`, `sortedTokens()`, and `behaviorWords()`. The helper accepts generic word sets, prefix-stripping rules, primitive reason strings, named groups, and recommendation selection from the caller.
- **Why**: This names the shared evidence-class policy while leaving React/Vue profile collection and meaningful-overlap thresholds local.

- [x] **File**: `src/queries/frontend/react-hook-candidates.ts:145-309`
- **Source**: `scip-query code classifyReactHookEvidence -C 8`; `scip-query plan-context reactHookCandidates`.
- **What**: React owns duplicated classification helpers and generic token utilities.
- **Change**: Replace local evidence classification and utility helpers with calls to `classifyFrontendBehaviorEvidence()`, shared `behaviorSimilarity()`, `tokenValues()`, and `sortedTokens()`. Keep React-specific `hasMeaningfulBehaviorOverlap()`, recommendation strings, and `GENERIC_REACT_BEHAVIOR_WORDS`.
- **Why**: React keeps its essential behavior thresholds while delegating the shared evidence policy.

- [x] **File**: `src/queries/frontend/vue-composable-candidates.ts:142-320`
- **Source**: `scip-query code classifyVueComposableEvidence -C 8`; `scip-query plan-context vueComposableCandidates`.
- **What**: Vue owns the same classification and token utility shape with Vue-specific token groups.
- **Change**: Replace local duplicated helpers with the shared frontend behavior helper. Keep Vue-specific overlap thresholds, recommendation strings, and `GENERIC_VUE_BEHAVIOR_WORDS`.
- **Why**: Vue keeps framework-specific facts while sharing the output classification policy.

### 2. Normalize Diff-Gate Finding Emission

- [x] **File**: `src/queries/impact/diff-gate.ts:54-95`
- **Source**: `scip-query plan-context diffGate`; `scip-query code runEchoCheck -C 6`; `scip-query code runBaselineCheck -C 6`.
- **What**: Each check pushes a full `DiffGateFinding` and hand-writes `suppressionHint`.
- **Change**: Add a local `recordFinding(result, finding)` helper plus a `DiffGateFindingDraft` type that omits `suppressionHint`. The helper appends `scip-query: ignore ${finding.check} ${finding.id} -- <reason>` and pushes the final finding.
- **Why**: This centralizes the suppression-hint invariant without changing check-specific evidence fields.

- [x] **File**: `src/queries/impact/diff-gate.ts:319-984`
- **Source**: `scip-query code runEchoCheck -C 6`; `scip-query code runIncompleteMigrationCheck -C 6`; `scip-query code runCoChangePartnerCheck -C 6`; `scip-query code runBaselineCheck -C 6`.
- **What**: Seven checks call `result.findings.push({ ... suppressionHint })`.
- **Change**: Replace each finding push with `recordFinding(result, { ... })` and remove per-check `suppressionHint` fields.
- **Why**: A future check can no longer drift on suppression-hint shape.

### 3. Generate Query Command Registration From Order

- [x] **File**: `src/runtime/commands/query-command-specs.ts:10-99`
- **Source**: `scip-query plan-context queryCommandDescriptor`; `scip-query code 'src/runtime/commands/query-command-specs.ts:10-99'`.
- **What**: `queryCommandOrder` is private and only used to validate that descriptors are ordered.
- **Change**: Export `orderedQueryCommandDescriptors`, derived by mapping `queryCommandOrder` through `QUERY_COMMANDS_BY_ID`; preserve the missing-descriptor error path.
- **Why**: The ordered query command surface becomes a real reusable mechanism.

- [x] **File**: `src/runtime/commands/command-descriptors.ts:45-122`
- **Source**: `scip-query plan-context commandDescriptors`; `scip-query code 'src/runtime/commands/command-descriptors.ts:45-122'`.
- **What**: `commandDescriptors` repeats 61 individual query registrations.
- **Change**: Import `orderedQueryCommandDescriptors` and spread the relevant ordered query slices around the explicit custom commands. Remove the local `query` alias and the hand-written `query('...')` list.
- **Why**: CLI registration now derives from the same command order list used by command coverage.

### 4. Close The Register

- [x] **File**: `docs/plans/2026-06-23-maintainability-register.md`
- **Source**: this completion plan and post-change verification commands.
- **What**: The register currently lists C1-C3 as future recommendations and P2/P3 as deferred or skipped.
- **Change**: Add a completion status section marking C1, C2, and C3 done; keep suppression comments deferred with the June 21 validation evidence; keep `ProjectIndex`, watcher/CLI-context, and parser similarity closed as false or net-negative compression.
- **Why**: The goal is to finish every item in the register, including explicit closure of non-actionable rows.

## Stress Test Findings

- Understand before touch: each phase preserves existing entry points and public result types. Sources: `scip-query plan-context reactHookCandidates`; `scip-query plan-context vueComposableCandidates`; `scip-query plan-context diffGate`; `scip-query plan-context commandDescriptors`.
- Blast radius: frontend analyzer files each have 10 external consumers; `diff-gate.ts` has 14; command descriptors and query specs are medium-risk runtime command surfaces. Sources: the same `plan-context` outputs above.
- Valid intermediate states: phase 1 is internal helper extraction; phase 2 is local normalizer extraction; phase 3 preserves descriptor order; each phase can typecheck independently.
- Reversibility: all changes are internal TypeScript refactors with no schema or data changes.
- Failure/concurrency/data integrity: no new async, persistence, watcher, process, or DB write path is introduced.
- Boundary defense: CLI command descriptors remain the only CLI registration boundary; C3 removes duplicated metadata rather than accepting new input.
- Observability/human effect: command order and output strings should remain unchanged; tests must verify command descriptors and generated docs.
- Reuse: each new helper removes duplicated local policy and preserves existing ranking, finding identity, and command descriptor mechanisms.

## Execution Order

1. Phase 1 frontend helper extraction.
2. Phase 2 diff-gate finding normalizer.
3. Phase 3 ordered command descriptor export.
4. Phase 4 register completion update.
5. Verification and follow-up cleanup from SCIP findings.

## Verification

- `npm run typecheck` passed.
- Focused CLI contract test passed. The requested frontend test paths were not present as standalone indexed test files, so the full suite was used as the stronger behavioral check.
- `npm test` passed: 68 test files, 354 tests.
- `scip-query incomplete-migration` passed with no incomplete migrations.
- `scip-query recent-duplicates --full` reported no recent reimplementations.
- `scip-query similar classifyFrontendBehaviorEvidence` reported only low-similarity internal helper overlap inside the new helper.
- `scip-query unused-params`, `wrapper-candidates`, `passthrough-candidates`, `stale-abstractions --include-low-confidence`, `drift`, and `co-change src/runtime/commands/query-command-specs.ts` reported no actionable findings.
- `scip-query health --json` reported score 100, with one accepted heuristic React/Vue component comparer similarity signal.
- `scip-query health --write-baseline` recorded the accepted comparer signal in `.scipquery-baseline.json`; `scip-query health --baseline` then passed with no new findings.
- `scip-query similar-files` still reports accepted false/intentional compression boundaries and intentional frontend analyzer family pairings.
- `scip-query redundant-reexports` and `doc-drift` report existing public API and historical-doc signals outside this register's C1-C3 implementation.
- `scip-query diff-impact` reports 8 changed code files, 37 changed symbols, and 1 affected consumer file.
- Final `scip-query reindex && scip-query diff-gate` passed with no gate findings.
