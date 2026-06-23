# Maintainability Current Sweep Closure Plan - 2026-06-23

This closure slice is a bounded source-and-documentation change that takes the five actionable rows from the current maintainability sweep and either implements the smaller mechanism they call for or records the verified reason no code change should happen. The affected real-world referents are the diff-gate check policies, cleanup command presentation handlers, doc-drift operating guidance, the private cleanup command barrel, and declared coupling configuration.

## Evidence

- `scip-query plan-context diffGate` shows `diffGate()` as the single orchestration entry point, with private doc-reference and baseline policy helpers inside `src/queries/impact/diff-gate.ts`.
- `scip-query code 'src/queries/impact/diff-gate.ts:648-854'` identifies the doc-reference policy cluster: citation classification, context extraction, citation labels, remediation copy, and static import/export filtering.
- `scip-query code 'src/queries/impact/diff-gate.ts:949-1093'` identifies the baseline policy cluster: baseline metadata, analyzer action tier, remediation copy, and finding-key splitting.
- `scip-query change-surface src/queries/impact/diff-gate.ts --json` reports 17 external consumers on the file, but zero external consumers for the private doc-reference and baseline helpers, so extraction can preserve public query types and the `diffGate()` entry point.
- `scip-query plan-context src/runtime/query-commands/cleanup/handlers.ts` and `scip-query change-surface src/runtime/query-commands/cleanup/handlers.ts --json` show 27 exported cleanup handlers consumed by descriptors, with React/Vue report handlers forming one detector-family presentation cluster.
- `scip-query redundant-reexports --json` still reports `src/runtime/query-commands/cleanup/index.ts` as a direct cleanup barrel signal for `cleanupCommand()` even though the source exports only `cleanupQueryCommandDescriptors`; changing the barrel to import-then-export should preserve the public name while avoiding the direct re-export attribution.
- `scip-query co-change .scipquery.json --limit 20 --json` reports no findings, so the declared coupling row closes by evidence rather than by speculative config growth.

## Steps

1. Extract `diff-gate` doc-reference policy into `src/queries/impact/diff-gate-doc-policy.ts`, leaving `runDocReferenceCheck()` in `diff-gate.ts`.
2. Extract `diff-gate` baseline metadata policy into `src/queries/impact/diff-gate-baseline-policy.ts`, leaving `runBaselineCheck()` in `diff-gate.ts`.
3. Move React and Vue cleanup report handlers from `handlers.ts` to `frontend-handlers.ts`, and import them from descriptors as a detector-family presentation module.
4. Rewrite the cleanup command barrel from a direct re-export to import-then-export so the private descriptor helper is no longer treated as cleanup barrel surface.
5. Update the maintainability register with a closure table: implemented, verified/no-op, and deferred-to-API-impact outcomes.

## Verification

- `npm run typecheck`
- `npm test -- tests/queries/impact/incomplete-migration.test.ts tests/queries/impact/co-change-partner-labels.test.ts tests/runtime/cli-contract.test.ts`
- `scip-query incomplete-migration`
- `scip-query recent-duplicates --full`
- `scip-query unused-params`
- `scip-query wrapper-candidates`
- `scip-query passthrough-candidates`
- `scip-query stale-abstractions --include-low-confidence`
- `scip-query redundant-reexports --json`
- `scip-query config-validate --json`
- `scip-query reindex && scip-query diff-gate --json`

## Result

Completed. TypeScript, focused tests, health, wrapper/passthrough/stale/unused/recent-duplicate checks, private query manifest classification, config validation, redundant-reexport review, reindex, and `diff-gate` all pass for this closure. The only remaining redundant-reexport rows are package-public API-impact signals, not direct cleanup-barrel findings.
