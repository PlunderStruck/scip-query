# Graph-Risk Family Result

Date: 2026-06-21

## Scope

This slice validates and calibrates the graph-risk family: `bottlenecks`, `coupling`, `deep-chains`, and `drift`.

Implemented changes:

- `bottlenecks` rows now include `actionTier`, `riskKind`, `evidenceReasons`, and `recommendation`.
- `coupling` rows now include `actionTier`, `couplingKind`, `evidenceReasons`, and `recommendation`.
- `deep-chains` rows now include `actionTier`, `chainKind`, `evidenceReasons`, and `recommendation`.
- `deep-chains` now removes strict suffix chains after ranking, so top results show distinct dependency-chain risks instead of one repeated tail.
- `drift` rows now include `actionTier`, optional `policyBasis`, `evidenceReasons`, and `recommendation`.
- Drift health scoring now uses direct drift rows for base score deductions and signal drift rows for pressure. Pattern deviations remain excluded from health scoring.

## Regression Coverage

Added `tests/queries/graph/graph-risk-output.test.ts`:

- Confirms bottleneck rows are contextual `signal` findings with `coordination-hotspot` risk kind.
- Confirms coupling rows are contextual `signal` findings with `shared-symbol-coupling` kind.
- Confirms `deep-chains` drops strict suffix duplicates while preserving the longest representative chain.
- Confirms explicit layer drift is `direct` and inferred layer drift is `signal`.

Updated `tests/queries/cleanup/drift-accuracy.test.ts`:

- Pins unused-import drift as direct cleanup evidence.

## Field Results

Raw output root:

```text
/tmp/scip-query-validation/2026-06-21-pilot
```

| Repository | Revision | Raw output directory |
| --- | --- | --- |
| `scip-query` | current working tree | `/tmp/scip-query-validation/2026-06-21-pilot/scip-query/graph-risk-family` |
| `Stable_Management` | `2354b4e385088aa90559c20ea8b270f14bfa47f3` | `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/graph-risk-family` |
| `Vega_2.0` | `6288855333faf33ba395fa804eb9b03c0a04989e` | `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/graph-risk-family` |

### scip-query

- `bottlenecks --limit 10`: 10 rows, all `signal`; top row `src:storage:scip-documents:indexedDocumentPaths()` with score 42.
- `coupling --limit 10`: 10 rows, all `signal`; top pair `src/queries/health/health-report.ts` and `src/runtime/cli-support.ts` with 65 shared symbols.
- `deep-chains --limit 10`: 10 rows, all `signal`; depths are `37, 32, 32, 31, 31, 31, 31, 31, 31, 30`, confirming the previous 37/36/35 suffix ladder is gone.
- `drift --json`: 0 rows.
- `health --json`: score 100; no drift score breakdown.

### Stable_Management

- `bottlenecks --limit 10`: 3 rows, all `signal`; top row `src:workflows:inventory:stockLedger:manualStockMovement:consumeInventory()` with score 20.
- `coupling --limit 10`: 10 rows, all `signal`; top pair `backend/src/workflows/horses.ts` and `backend/src/workflows/horsesWorkflow.spec.ts` with 113 shared symbols.
- `deep-chains --limit 10`: 10 rows, all `signal`; all depths are 16.
- `drift --json`: 251 rows, all `signal`, all `pattern-deviation`.
- `health --json`: score 94; `driftedFiles` 0; no drift score breakdown.

### Vega_2.0

- `bottlenecks --limit 10`: 10 rows, all `signal`; top row `src:components:common:UserAvatar:UserAvatar()` with score 76.
- `coupling --limit 10`: 10 rows, all `signal`; top pair `apps/web/src/content/guide/types.ts` and `apps/web/src/content/guide/en.ts` with 458 shared symbols.
- `deep-chains --limit 10`: 10 rows, all `signal`; depths are `37, 32, 31, 29, 27, 26, 26, 26, 26, 26`.
- `drift --json`: 894 rows, all `signal`, all `pattern-deviation`.
- `health --json`: score 79; `driftedFiles` 0; no drift score breakdown.

## Judgment

Confirmed. The graph-risk analyzers should remain contextual signal evidence. They report real graph pressure, but the right repair depends on ownership, public API intent, feature boundaries, layer policy, and product semantics.

The major precision finding is that `deep-chains` needed output de-duplication: strict suffix rows were valid graph facts but poor top-level review samples. The suffix filter improves review quality without hiding distinct chains.

The drift score split is also confirmed. In the larger corpora, drift output was dominated by pattern-deviation rows. Those rows are useful as architecture-review backlog, but the health score should not treat them as direct repair debt. Explicit layer violations and unused imports remain direct.

## Verification

Commands run successfully:

- `npx vitest run tests/queries/graph/graph-risk-output.test.ts`
- `npx vitest run tests/queries/graph/graph-risk-output.test.ts tests/queries/cleanup/drift-accuracy.test.ts tests/queries/navigation/command-accuracy.test.ts`
- `npm run typecheck`
- `npm run build`
- Local `bottlenecks`, `coupling`, `deep-chains`, `drift`, and `health` JSON smokes.
- Stable_Management `bottlenecks`, `coupling`, `deep-chains`, `drift`, and `health` JSON smokes.
- Vega_2.0 `bottlenecks`, `coupling`, `deep-chains`, `drift`, and `health` JSON smokes.
- `npm test` passed: 64 files, 318 tests. The existing incomplete-migration test still prints a `git diff` usage warning, but the suite exits 0.
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

Final gate:

- `node dist/cli.js diff-gate --json` exited 1 with two accepted warnings.
- Accepted `SQ36D93309ABEA`: signal-tier `echo` between `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()`. Judgment: the shared `leafName()`/`leafSuffix()` calls are symbol parsing mechanics; the product semantics are different.
- Accepted `SQ30E6CF5F9B38`: support-tier `doc-reference` because `README.md` cites `src/queries/cleanup/dead.ts` and `src/queries/cleanup/stale-abstractions.ts` as declared-coupling configuration examples. Judgment: those example paths still point at intended files; this slice did not change the README configuration contract.

## Next Action

Continue with config and declared-coupling freshness, because the inventory found stale `.scipquery.json` paths for moved analyzer files.
