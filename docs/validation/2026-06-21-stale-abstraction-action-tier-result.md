# Stale Abstraction Action-Tier Result

Date: 2026-06-21

## Scope

This slice implements the stale-abstraction output-quality action: the detector should not only report confidence; it should distinguish unused abstractions from one-consumer ownership questions.

Implemented changes:

- `StaleAbstraction` now includes `actionTier`.
- `StaleAbstraction` now includes `stalenessKind`.
- `StaleAbstraction` now includes `recommendation`.
- `stale-abstractions` text output prints the staleness kind, action tier, and recommendation.
- Detection, confidence, health scoring, and result filtering are unchanged.

## Regression Coverage

Updated `tests/queries/cleanup/stale-abstractions-accuracy.test.ts`:

- A zero-consumer type now asserts `actionTier: 'direct'` and `stalenessKind: 'unused-abstraction'`.
- A one-consumer type with one barrel re-export now asserts `actionTier: 'signal'` and `stalenessKind: 'misplaced-single-consumer-type'`.
- A one-consumer class now asserts `actionTier: 'signal'` and `stalenessKind: 'one-to-one-class-encapsulation'`.
- A one-consumer misplaced type now asserts `actionTier: 'signal'` and `stalenessKind: 'misplaced-single-consumer-type'`.
- A one-consumer self-used type now asserts `actionTier: 'signal'` and `stalenessKind: 'single-consumer-abstraction'`.

## Local Smoke

Repository: `/Users/aydansalois/Documents/GitHub/scip-query`

Command:

```text
node dist/cli.js stale-abstractions --json --limit 5
```

Result:

- Total rows: 0

## Vega Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
Revision: `6288855333faf33ba395fa804eb9b03c0a04989e`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/stale-abstraction-action-tier/stale-abstractions-full.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js stale-abstractions --full --json
```

Result:

- Total rows: 108
- Confidence: `high` 2, `medium` 106
- Action tiers: `direct` 1, `signal` 107
- Staleness kinds: `unused-abstraction` 1, `misplaced-single-consumer-type` 1, `single-consumer-abstraction` 106

Top sample split:

| Symbol | Consumers | Confidence | Tier | Kind |
| --- | --- | --- | --- | --- |
| `src:coding-agent-runtime:CompanionAgentConfigs` | 1 | `high` | `signal` | `misplaced-single-consumer-type` |
| `src:types:express.d:global:Express:Request` | 0 | `high` | `direct` | `unused-abstraction` |
| `src:api:issues:Subtask` | 1 | `medium` | `signal` | `single-consumer-abstraction` |

## Stable_Management Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
Revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/stale-abstraction-action-tier/stale-abstractions-full.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js stale-abstractions --full --json
```

Result:

- Total rows: 63
- Confidence: `high` 9, `medium` 54
- Action tiers: `direct` 3, `signal` 60
- Staleness kinds: `unused-abstraction` 3, `misplaced-single-consumer-type` 6, `single-consumer-abstraction` 54

The top three rows were zero-consumer organization types and now correctly render as direct cleanup candidates. The remaining rows are one-consumer ownership signals.

## Verification

Commands run successfully before final gate:

- `npx vitest run tests/queries/cleanup/stale-abstractions-accuracy.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js stale-abstractions --json --limit 5`
- Vega `stale-abstractions --full --json`
- Stable_Management `stale-abstractions --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citations to `src/queries/cleanup/dead.ts` and `src/queries/cleanup/stale-abstractions.ts` are declared-coupling configuration examples, not stale documentation about the analyzer output contracts.

`npm test` still prints a noisy `git diff` usage warning from an existing test path, but Vitest reports all 315 tests passed.

## Judgment

Confirmed. `stale-abstractions` now carries the direct-vs-signal distinction the ledger needs: zero-consumer rows are direct cleanup candidates, and one-consumer rows remain contextual even when confidence is high. This matches the field data, where almost all stale-abstraction rows in Vega and Stable_Management are one-consumer signals rather than direct repair findings.

## Next Action

Use the completed frontend behavior, extraction, and stale-abstraction classifications to update the score calibration memo before moving to graph-risk families.
