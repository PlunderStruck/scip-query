# Stable_Management Second Confirmation

Date: 2026-06-21

## Scope

This confirms the first analyzer precision implementation slice against `Stable_Management`, using the locally built `scip-query` CLI from this repository.

Repository state:

- Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
- Base revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`
- Worktree: dirty, with 53 changed files and 401 changed symbols by `diff-impact`
- Index status before run: fresh

Raw outputs:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/second-confirmation/dead-only-dead-local.json`
- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/second-confirmation/diff-gate-local.json`
- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/second-confirmation/diff-impact-local.txt`

## Dead Output Contract

Command:

```bash
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js dead --only-dead --json
```

Result:

```json
{
  "counts": {
    "total": 1211,
    "deadCode": 0,
    "fileInternal": 1211,
    "loc": 15980
  },
  "shownCounts": {
    "total": 0,
    "deadCode": 0,
    "fileInternal": 0,
    "loc": 0
  },
  "symbols": 1211,
  "shownDead": 0,
  "shownInternal": 0
}
```

Judgment: confirmed. The old counting trap is now explicit: `symbols.length` still exposes the full inventory, while `shownCounts` correctly reports zero rows under `--only-dead`.

## Diff-Gate Summary

Command:

```bash
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js diff-gate --json
```

Result summary:

| Check                  | Findings |
| ---------------------- | -------- |
| `echo`                 | 30       |
| `incomplete-migration` | 1        |
| `co-change-partner`    | 2        |
| `doc-reference`        | 15       |
| `baseline`             | 47       |
| `new-dead`             | 0        |

Echo tier summary:

| Tier     | Findings |
| -------- | -------- |
| `signal` | 23       |
| `direct` | 7        |

Grouping summary:

- All 30 echo findings include `groupKey`.
- 16 echo findings group more than one related file.

Judgment: grouping confirmed. The pairwise duplicate inflation is reduced: one changed symbol now gets one grouped echo finding with multiple related files when applicable.

## New-Dead Type Contract Filter

`diff-impact` still reports this changed zero-fan-in type contract symbol:

```text
backend/src/workflows/notifications.ts  src:workflows:notifications:_AssertNotificationRowContract  (fan-in: 0)
```

`diff-gate` reports zero `new-dead` findings and contains no `Assert` findings.

Judgment: confirmed. The `_Assert*` type-contract filter is active on a real changed symbol, not just on a synthetic unit test.

## Echo Tier Calibration Finding

The second repo exposed one remaining precision problem: the current direct-tier rule is still too broad for tiny exact source-token matches.

Example:

```text
fakePaymentIntentSecret -> generateCsrfToken / generateOpaqueToken
shared evidence: bytes, crypto, hex, num, random
current tier: direct
```

Judgment: false-positive directness. These helpers share token-generation scaffolding, but their product semantics and token contracts differ. This should be a `signal`, not direct reuse advice.

Other direct rows are more plausible:

- `hasOwn` helpers with the same name across workflow files
- `normalizeNullableString` / `normalizeNullableId` style helpers
- date cursor where-builders with matching query shape
- publish-event helpers with matching event-sync shape

However, this pass shows that source-token exactness alone is not enough. Echo directness needs at least one stronger compatibility fact, such as similar leaf names, same suffix role, or domain-token compatibility.

## Decision

Confirmed:

- `dead` output schema fix.
- `new-dead` `_Assert*` compile-time contract filter.
- Echo grouping mechanics.

Not fully confirmed:

- Echo `direct` tier classification. It is improved by grouping and softer signal wording, but the `direct` rule still over-promotes generic token-generation scaffolding.

## Next Action

Before wrapper boundary evidence, implement a small echo-tier refinement:

1. Keep grouped echo findings.
2. Keep source-token exact matches as eligible for direct tier only when names or role suffixes suggest the same reusable behavior.
3. Downgrade generic token/random/crypto scaffolding matches to `signal`.
4. Add a regression fixture for `fakePaymentIntentSecret`-style token helpers.

Update: implemented in `docs/validation/2026-06-21-echo-tier-refinement-result.md`.
