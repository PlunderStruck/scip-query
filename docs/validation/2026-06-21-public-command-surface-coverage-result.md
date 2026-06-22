# Public Command Surface Coverage Result

Date: 2026-06-21

## Verdict

AVL-014 is complete. The public query command registry exposes 61 commands, and the validation docs now name all of them either as analyzers, support/evidence providers, composite reports, or action commands.

## Source of Truth

`scip-query code src/runtime/commands/query-command-specs.ts:10-83` reported the complete `queryCommandOrder` list. `scip-query code queryCommandDescriptor -C 8` showed that descriptor lookup throws for unknown command ids, and that the registry checks every descriptor id is present in the order list.

## Coverage Findings

The pre-patch mechanical coverage check found:

- `docs/analyzer-validation-protocol.md`: 0 missing commands.
- `docs/analyzer-inventory.md`: missing `unused-imports` and `cleanup-apply`.
- `docs/analyzer-validation-ledger.md`: 20 command names absent from explicit prose because support commands were grouped by family rather than listed one by one.

## Fixes

- `docs/analyzer-inventory.md` now includes `unused-imports` as a direct cleanup analyzer.
- `docs/analyzer-inventory.md` now classifies `cleanup-apply` as an action command rather than an analyzer.
- `docs/analyzer-validation-ledger.md` now includes a public command coverage checklist naming all 61 commands from `queryCommandOrder`.
- `docs/validation/2026-06-21-analyzer-calibration-memo.md` now marks public command surface coverage complete and routes the next slice to AVL-005 implementation parity.

## Command Groups

- Direct cleanup analyzers: `dead`, `isolated`, `unused-imports`, `cleanup-plan`, `unused-params`, `passthrough-candidates`, `redundant-reexports`
- Contextual cleanup/reuse analyzers: `similar`, `similar-files`, `similar-chains`, `similar-signatures`, `recent-duplicates`, `extract-candidates`, `wrapper-candidates`, `stale-abstractions`, `doc-drift`, `drift`, `convergence`
- Frontend analyzers: `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`
- Graph/risk analyzers: `hotspots`, `fan-in`, `fan-out`, `coupling`, `cycles`, `bottlenecks`, `deep-chains`, `complexity-hotspots`, `complexity`
- Diff/impact analyzers and composites: `affected`, `change-surface`, `co-change`, `diff-gate`, `incomplete-migration`, `plan-context`
- Support/evidence providers: `stats`, `files`, `methods`, `refs`, `trace`, `deps`, `rdeps`, `system`, `surface`, `imports`, `imported-by`, `outline`, `members`, `by-kind`, `kind-counts`, `hierarchy`, `call-graph`, `code`, `dataflow`, `slice`, `self-audit`
- Action command: `cleanup-apply`

## Verification

Completed:

- mechanical command coverage script:
  - `docs/analyzer-inventory.md missing 0/61`
  - `docs/analyzer-validation-protocol.md missing 0/61`
  - `docs/analyzer-validation-ledger.md missing 0/61`
- `npm run typecheck`
- `npm test`: 64 files, 322 tests
- `./dist/cli.js reindex`
- `./dist/cli.js diff-gate`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

The next validation slice should be AVL-005, analyzer implementation parity. It should walk command descriptors, handler wiring, query entrypoints, and health summaries to verify that documented behavior matches implementation behavior.
