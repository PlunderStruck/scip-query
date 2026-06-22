# Echo Tier Refinement Result

Date: 2026-06-21

## Scope

This slice follows `docs/validation/2026-06-21-stable-management-second-confirmation.md`, which showed that grouped echo findings worked but the `direct` tier was still too broad for generic token-generation source matches.

Implemented changes:

- `echoActionTier()` now receives the changed symbol identity.
- Direct source-token echo requires exact or compatible leaf-name tokens.
- Generic token/random/crypto scaffolding stays `signal` unless the helper leaf names are exactly the same.
- Added regression coverage for same-name direct helper echoes and token-generation signal echoes.

## Regression Coverage

Updated `tests/queries/impact/incomplete-migration.test.ts`:

- `formatThing` vs site functions is now a grouped `signal`, leaving incomplete-migration to carry the stronger migration-specific claim.
- Same-name `hasOwn` helpers remain `direct`.
- `fakePaymentIntentSecret` vs token helpers is grouped but classified as `signal`.
- `_Assert*` new-dead coverage remains intact.

## Verification

Commands run successfully:

- `npx vitest run tests/queries/impact/incomplete-migration.test.ts -t "groups echo evidence|same-name helper|generic token-generation|compile-time type contract"`
- `npm run typecheck`
- `npx vitest run tests/queries/impact/incomplete-migration.test.ts`
- `npm test`
- `npm run build`
- `node dist/cli.js similar isDirectSourceEcho --json`
- `node dist/cli.js similar haveCompatibleLeafTokens --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

Local `diff-gate` still exits 1 with two accepted findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

## Stable_Management Confirmation

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/second-confirmation/diff-gate-echo-tier-refined-local.json`

Result:

- Echo findings: 30
- Signal echo findings: 24
- Direct echo findings: 6
- `fakePaymentIntentSecret` moved from `direct` to `signal`

The finding remains visible and grouped:

```text
fakePaymentIntentSecret -> generateCsrfToken / generateOpaqueToken / auth token helpers
shared evidence: bytes, crypto, hex, num, random
action tier: signal
```

## Judgment

Confirmed. Echo now distinguishes "same tiny helper" from "same generic scaffolding" more accurately without hiding contextual evidence.

## Next Action

Wrapper boundary evidence is implemented in `docs/validation/2026-06-21-wrapper-boundary-evidence-result.md`; next confirm it against `Stable_Management`.
