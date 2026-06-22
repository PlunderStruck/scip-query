# Agent Repair Outcomes Result

Date: 2026-06-21

## Verdict

AVL-011 is complete. The action tiers now have a validated agent meaning:

- Direct deletion findings can be acted on when `cleanup-plan --verify` proves the batch against the project's checker.
- Signal findings should become review plans or locality investigations, not blind edits.
- Support findings should remain evidence for another decision and should not drive automatic refactors.

Raw output was captured under `/tmp/scip-query-validation/2026-06-21-budget`.

## Direct Repair Outcome

Repository: `SynthRunnerRust`

Command:

```text
cleanup-plan --verify --json
```

Outcome: `improved`

The verified cleanup plan contained one batch:

| Symbol                               | File                |     Lines | LOC | Evidence     |
| ------------------------------------ | ------------------- | --------: | --: | ------------ |
| `physics:is_kinematic_sensor()`      | `src/physics.rs`    | 1001-1003 |   3 | `graph-fact` |
| `visualizer:reset_visualizer_bars()` | `src/visualizer.rs` | 1227-1232 |   6 | `graph-fact` |

Verification:

- Checker: `cargo check --quiet --manifest-path Cargo.toml`
- Batch status: `verified`
- `baselineErrors`: 0
- `uncoveredFiles`: []
- `dirtyOverlap`: []
- `blocked`: []

Judgment: this is the repair model direct analyzers should aspire to. The analyzer did not merely report unused symbols; it produced an ordered deletion plan and the target compiler accepted the result in a throwaway worktree.

## Signal Non-Repair Outcome

Repository: `Vega_2.0`

Command:

```text
react-hook-candidates --full --json
```

Sample:

- `apps/web/src/components/board/BoardFilters.tsx` / `useBoardFiltersController`
- `apps/web/src/routes/projects/components/settings/ProjectDangerZone.tsx` / `ProjectTransferOwnershipSection`
- `evidenceClass`: `mixed`
- `actionTier`: `signal`
- Shared evidence: `useAsyncLoader`, `useCallback`, `useEffect`, `useMemo`, `useReducer`, `loadMembers`, `load`
- Recommendation: separate generic React mechanics from domain-specific behavior before extracting a shared hook.

Outcome: `not_attempted`

Judgment: this is a valid review signal, but not a safe automatic repair. The shared shape mixes generic React mechanics with one domain-looking handler. An agent should inspect whether the common behavior has a real product concept before extracting anything.

## Support Non-Repair Outcome

Repository: `Vega_2.0`

Command:

```text
react-hook-candidates --full --json
```

Sample:

- `apps/web/src/components/coding-agents/AgentConfigEditors.tsx` / `LocalCompanionConfigEditor`
- `apps/web/src/routes/proposals/components/CreateProjectModal.tsx` / `CreateProjectModal`
- `evidenceClass`: `generic-workflow-scaffolding`
- `actionTier`: `support`
- Shared evidence: `useMemo`, `useState`, `handleSubmit`, `submit`
- Recommendation: treat as support evidence for a repeated workflow shape, not direct hook-extraction evidence.

Outcome: `not_attempted`

Judgment: the output correctly prevents churn. A shared submit/form shape is useful context, but it is not itself a reusable domain behavior. This row should not reduce health as direct debt or trigger an automatic refactor.

## Calibration Decision

Action tiers are validated for agent workflow:

- `direct`: can produce edits only when the analyzer has local evidence and the repair can be verified by the project checker or an equivalent contract.
- `signal`: should create an investigation or narrowly scoped plan; edits require a separate domain/locality judgment.
- `support`: should enrich context for another decision; it should not create edits by itself.

This supports keeping wrapper, extraction, large-component pressure, generic hook/composable rows, graph-risk rows, and doc-reference configuration examples out of direct automated repair paths unless a later analyzer supplies stronger evidence.

## Residual Risk

- Only deletion-class direct repair was exercised with an actual checker-backed repair.
- Other direct families such as `unused-params`, `unused-imports`, `redundant-reexports`, and broken doc references still need per-family repair outcomes before they can be trusted for automatic edits.
- Signal/support non-repair outcomes were sampled from React hook candidates; other contextual analyzers should keep their action-tier wording conservative until similar repair-outcome evidence exists.

## Verification

Completed after this doc update:

- `npm run typecheck`
- `npm run build`
- `npm test`: 64 files, 323 tests. Vitest passed; it still prints the existing noisy `git diff` usage warning from one test path.
- `node dist/cli.js recent-duplicates --json`: no findings.
- `node dist/cli.js unused-params --json`: no findings.
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

The next validation slice should finish AVL-012, locality analyzer validation. Agent repair outcomes now show why locality findings must distinguish direct repairs from review pressure before implementation.
