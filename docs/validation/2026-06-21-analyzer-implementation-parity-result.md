# Analyzer Implementation Parity Result

Date: 2026-06-21

## Verdict

AVL-005 is complete for the current public analyzer surface. Command descriptors, generated command docs, handler wiring, and health summary wiring are generally aligned with the inventory/protocol claims. The review found one implementation parity gap: `unused-imports` existed as a CLI command and root query export but was missing from the public query subpath manifest and package exports.

## Evidence

- `scip-query plan-context queryCommandDescriptor --full`: command descriptors use `queryCommandDescriptor()` and the descriptor registry guards ordered query ids.
- `scip-query code src/runtime/commands/command-descriptors.ts:1-220`: descriptor-backed query commands are registered through `query(...)`; composite and maintenance commands are registered separately.
- `scip-query code handleUnusedImports -C 8`: `unused-imports` calls `queries.unusedImports(...)`.
- `scip-query code src/queries/index.ts:1-120`: `unusedImports` is exported from `src/queries/navigation/imports.ts`.
- `scip-query code unusedImports -C 8`: `unusedImports()` returns unused imported bindings from the imports source module.
- `scip-query code src/queries/public-query-entries.ts:15-139`: before the fix, `PUBLIC_QUERY_ENTRIES` included `imports` but not `unused-imports`.
- `scip-query plan-context runHealthAnalyses --full`: health uses `HEALTH_PHASES`/`HEALTH_PHASE_RUNNERS`, so standalone command presence and health scoring are intentionally separate questions.

## Fix

- Added `unused-imports` to `PUBLIC_QUERY_ENTRIES`.
- Added `unused-imports` to `PUBLIC_QUERY_SOURCE_PATHS`, pointing at `src/queries/navigation/imports.ts`.
- Added `./queries/unused-imports` to `package.json`, pointing at the generated `dist/queries/unused-imports.js` and `dist/queries/unused-imports.d.ts`.
- Added a CLI contract test for command-level query aliases:
  - `fan-in` and `fan-out` publish through `fan`
  - `imported-by` publishes through `imports`
  - `kind-counts` publishes through `by-kind`
  - `unused-imports` publishes through `unused-imports`
- Updated the public/private source-file classification assertion to compare unique source paths, because public aliases can share one source module.

## Intentional Boundaries

- `cleanup-apply` remains an action command, not an analyzer or query subpath.
- `health` and `diff-impact` are public package query entries even though they are registered as composite/custom commands rather than descriptor-backed query commands.
- `fan-in`/`fan-out`, `imported-by`, and `kind-counts` remain command-level aliases over their module entries.

## 2026-06-22 Locality Addendum

`locality-candidates` is now an implemented public analyzer, not only a design note. It is registered through `src/runtime/query-commands/cleanup/descriptors.ts`, ordered in `src/runtime/commands/query-command-specs.ts`, exposed from `src/queries/index.ts`, included in `src/queries/public-query-entries.ts`, and exported as `./queries/locality-candidates` in `package.json`.

The command stays outside health scoring. Its defining output is a report-only directory-locality claim: a candidate symbol or file, directory ancestry, consumer files, consumer coverage, nearest common owner, suggested home, and counterevidence.

## 2026-06-22 Health Default Addendum

`src/runtime/commands/command-descriptors.ts` still owns the composite `health` command descriptor. The visible `--full` option is now a compatibility flag because the health report runs unbounded candidate analyses by default.

## Verification

Completed:

- `npx vitest run tests/runtime/cli-contract.test.ts`: 16 tests passed.
- `npm run typecheck`
- `npm test`: 64 files, 323 tests
- `npm run build`
- `node -e "import('./dist/queries/unused-imports.js')..."`
- `./dist/cli.js recent-duplicates --json`: no findings
- `./dist/cli.js unused-params --json`: no findings
- `./dist/cli.js reindex`
- `./dist/cli.js diff-gate`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

The next validation slice should be AVL-008, performance and budget behavior. The command surface is now covered and implementation parity is repaired, so the next risk is whether large-index defaults, `--full`, scan limits, and graceful degradation are documented and actually behave as intended.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice supersedes the earlier note that descriptor-backed query commands are registered through individual `query(...)` calls in `src/runtime/commands/command-descriptors.ts`. Query registration now consumes slices of `orderedQueryCommandDescriptors`, which is derived from `queryCommandOrder` in `src/runtime/commands/query-command-specs.ts`. The composite `health`, `diff-impact`, and maintenance commands still stay explicit in `command-descriptors.ts`.

## 2026-06-23 Setup Command Addendum

`src/runtime/commands/command-descriptors.ts` now also owns the public `setup` maintenance command. This does not change the analyzer parity judgment: descriptor-backed query commands still come from `orderedQueryCommandDescriptors`, while composite and maintenance commands such as `health`, `diff-impact`, `doctor`, and `setup` remain explicit descriptors.

## 2026-06-28 Bench Profiling Command Addendum

`src/runtime/commands/command-descriptors.ts` now also exposes
`bench --progress`, `bench --profile`, and `bench --profile-out`. This extends
the maintenance command surface for measurement only; descriptor-backed query
commands still come from `orderedQueryCommandDescriptors`, and composite plus
maintenance commands remain explicit descriptors.

## 2026-06-30 Health Cleanup Follow-Up

`src/queries/public-query-entries.ts` now keeps only the public query manifest
used by packaging. The private helper files are still checked for "not
published" parity, but that private list now lives in
`tests/runtime/cli-contract.test.ts` as a contract fixture instead of a
production export.

## 2026-07-01 TLA Model Command Addendum

`tla` is now ordered in `queryCommandOrder` and registered through
`tlaQueryCommandDescriptors`. It is a custom formal-model command rather than a
public package query entry or health analyzer. Its purpose is on-demand
verification of a TLA+ module, a model-to-TypeScript mapping contract, checker
output, and compiler-indexed implementation evidence.

2026-07-01 round-2 remediation note: the
`src/runtime/query-commands/cleanup/descriptors.ts` configuration example
remains current after command descriptors were regenerated. The parity result
still distinguishes public query entries from command-descriptor metadata.
