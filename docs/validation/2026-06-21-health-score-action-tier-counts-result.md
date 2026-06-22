# Health Score Action-Tier Counts Result

Date: 2026-06-21

## Scope

This slice implements the score-count calibration decision from the analyzer memo: direct and signal rows should not share one raw-count score deduction.

Implemented changes:

- Removed the base `extract` score deduction.
- Kept extraction candidates visible in findings, actions, and pressure.
- Changed the base `stale-abstractions` deduction to use `analyses.stale.unused`.
- Changed stale pressure to use `analyses.stale.singleUse`.
- Reworded health actions so extraction is reviewable seam pressure and stale abstractions distinguish unused cleanup from single-consumer ownership review.

## Regression Coverage

Updated `tests/queries/cleanup/extract-candidates-output.test.ts`:

- The extraction fixture still reports extraction candidates.
- The health score breakdown does not include a base `extract` deduction.
- The extraction action uses review wording rather than direct extraction wording.

Updated `tests/queries/navigation/command-accuracy.test.ts`:

- The stale health action still aligns with the stale query output.
- The action says to remove unused abstractions and review ownership before moving or inlining.
- The stale score breakdown uses the direct unused count: `1 unused stale abstraction(s); 0 single-consumer signal(s)`.

## Local Smoke

Repository: `/Users/aydansalois/Documents/GitHub/scip-query`

Command:

```text
node dist/cli.js health --json
```

Result:

- Score: 100
- Risk score: 100
- Hygiene score: 100
- Score breakdown: empty
- Extraction candidates: 0
- Stale types: 0

## Stable_Management Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
Revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/health-score-action-tier-counts/health-json.out`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js health --json
```

Result excerpt:

- Score: 94
- Risk score: 95
- Hygiene score: 94
- Default health stale types: 50
- Extraction candidates: 0
- Stale score deduction: 3 points for `3 unused stale abstraction(s); 47 single-consumer signal(s)`
- Stale action: `3 unused, 47 single-consumer (not in types file)` with ownership-review wording
- No stale pressure penalty was emitted at the default threshold.

## Verification

Commands run successfully:

- `npx vitest run tests/queries/navigation/command-accuracy.test.ts`
- `npx vitest run tests/queries/cleanup/extract-candidates-output.test.ts`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js health --json`
- Stable_Management `health --json`
- `npm test`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

Final gate:

- `node dist/cli.js diff-gate --json` exited 1 with two accepted warnings.
- Accepted `SQ36D93309ABEA`: signal-tier `echo` between `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()`. Judgment: both use symbol leaf parsing, but one classifies compile-time contract assertions while the other builds indexed definition records; the shared `leafName()`/`leafSuffix()` evidence is not a shared product behavior.
- Accepted `SQ30E6CF5F9B38`: support-tier `doc-reference` because `README.md` cites `src/queries/cleanup/dead.ts` and `src/queries/cleanup/stale-abstractions.ts` in a `.scipquery.json` configuration example. Judgment: the example still points at intended declared-coupling paths; this slice changed analyzer output/scoring semantics, not that configuration contract.

## Judgment

Confirmed. Health scoring now follows the action-tier model for these families: extraction candidates no longer reduce the base score as direct debt, and stale abstractions score direct cleanup only for unused rows. Single-consumer stale rows still appear in actions and pressure, but they no longer share the direct unused deduction.

## Next Action

Continue contextual graph-risk review: bottlenecks, coupling, deep chains, and drift.
