# Analyzer Precision Implementation Result

Date: 2026-06-21

## Scope

This records the first production precision slice approved by `docs/validation/2026-06-21-analyzer-calibration-memo.md` and planned in `docs/plans/2026-06-21-analyzer-precision-implementation.md`.

Implemented changes:

- `dead` now returns a backward-compatible `counts` object with `total`, `deadCode`, `fileInternal`, and `loc`.
- `dead --json` now includes `shownCounts` and fuller `totals`, so command filters such as `--only-dead` can be counted without reading `symbols.length`.
- `diff-gate` `new-dead` now skips type-level `_Assert*` and `Assert*` compile-time contract assertions.
- `diff-gate` `echo` now groups outside matches by changed symbol, exposes optional `groupKey` and `actionTier`, and softens remediation when the evidence is contextual rather than direct.

## Regression Coverage

Added or extended tests:

- `tests/queries/cleanup/dead-output.test.ts`
- `tests/queries/impact/incomplete-migration.test.ts`

Covered regressions:

- Dead summary counts match the legacy flat count fields.
- A same-file reference is counted as `file-internal`, while unreferenced symbols remain `dead-code`.
- Echo emits one grouped finding for one changed symbol with multiple outside matches.
- Echo findings expose `groupKey` and `actionTier`.
- `_Assert*` type contract aliases do not produce `new-dead` findings.

## Verification So Far

Commands run successfully:

- `npx vitest run tests/queries/cleanup/dead-output.test.ts`
- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "groups echo evidence|compile-time type contract"`
- `npm run typecheck`
- `npx vitest run tests/queries/cleanup/dead-output.test.ts tests/queries/impact/incomplete-migration.test.ts`
- `npm test`
- `npm run build`
- `scip-query recent-duplicates --json`
- `scip-query unused-params --json`
- `scip-query reindex`
- `node dist/cli.js reindex`
- `node dist/cli.js dead --only-dead --json`

Note: the full test suite still prints an existing git warning from the "outside a git repository" fixture in `incomplete-migration.test.ts`, but the suite passed.

Local dead-output spot check:

- `counts`: `{ total: 665, deadCode: 0, fileInternal: 665, loc: 7968 }`
- `shownCounts`: `{ total: 0, deadCode: 0, fileInternal: 0, loc: 0 }`
- `shown.deadCode.length`: `0`

Final diff-gate status:

- `node dist/cli.js diff-gate --json` exited 1 with two accepted findings.
- `scip-query diff-gate --json` also exited 1 with the same two finding subjects; this installed binary is the currently released `0.10.1`, so its echo wording does not include this branch's new `actionTier` and grouped remediation fields.

Accepted findings:

- `echo` on `isCompileTimeContractAssertion()` vs `indexedDefinitionFromRow()` is accepted. Both call `leafSuffix()` and `leafName()`, but the new helper is a narrow diff-gate policy predicate, while `indexedDefinitionFromRow()` constructs full definition records. Reuse would package together different responsibilities.
- `doc-reference` on `README.md` citing `src/queries/cleanup/dead.ts` is accepted. The README citation is a `.scipquery.json` declared-coupling example, not a stale claim about the `dead` JSON output contract.

## Judgment

This slice resolves three first-pass validation issues without changing health scoring:

- The dead-code output contract is clearer for automated verdict review.
- New-dead no longer treats compile-time type assertions as runtime dead code.
- Echo duplicate evidence is less inflated because related outside matches become one grouped review item.

The remaining echo limitation is evidence classification. Very high source-token matches are marked `direct`; other matches are marked `signal`. The next validation pass should confirm whether this split is right on `Stable_Management`, `Vega_2.0`, and at least one Rust corpus.

## Next Actions

1. Run the updated `dead --only-dead --json` and `diff-gate --json` on `Stable_Management`.
2. Review whether grouped echo findings are easier to triage and whether any pairwise detail was lost.
3. Continue the next implementation item from the calibration memo: wrapper boundary evidence or Vue pressure-kind output.

Update after `Stable_Management` confirmation:

- The dead output schema and `_Assert*` new-dead filter were confirmed.
- Echo grouping was confirmed.
- Echo `direct` tier is still too broad for generic token-generation scaffolding. See `docs/validation/2026-06-21-stable-management-second-confirmation.md`.
