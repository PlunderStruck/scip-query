# Similarity Evidence Split Result

Date: 2026-06-21

## Scope

This slice implements the similarity calibration action: high similarity should expose what kind of evidence caused the match, and direct reuse wording should be reserved for concrete shared behavior.

Implemented changes:

- `SimilarSymbolResult` now includes `evidenceClass`.
- `SimilarSymbolResult` now includes `actionTier: 'direct' | 'signal'`.
- `SimilarSymbolResult` now includes `evidenceClassReasons`.
- `SimilarSymbolResult` now includes `recommendation`.
- `similar` text output prints evidence class, tier, reasons, and recommendation.
- Callee evidence is classified as `domain-behavior`, `mixed`, `access-query-scaffolding`, or `framework-scaffolding`.
- Strong domain behavior can remain `direct` even when ordinary persistence or framework scaffolding is also shared.
- Source-token fallback keeps generic random/token/crypto overlap as a `signal`.

## Regression Coverage

Updated `tests/queries/cleanup/similar-topk.test.ts`:

- Concrete domain behavior is classified as `domain-behavior` and `direct`.
- Access/query scaffolding is classified as `access-query-scaffolding` and `signal`.
- Strong shared domain behavior with `tryPrisma` and error scaffolding remains `direct`.
- Generic source-token overlap stays `framework-scaffolding` and `signal`.

## Local Smoke

Repository: `/Users/aydansalois/Documents/GitHub/scip-query`
Revision: `7aa69e4c6701c04213106c803ce2c4a9e167ccec`

Raw output:

- `/tmp/scip-similar-evidence-split-final.json`

Command:

```text
node dist/cli.js similar --json --limit 10
```

Result:

- Total rows: 3
- `access-query-scaffolding`: 3
- `signal`: 3
- `direct`: 0

The local findings are command/config handler similarities, so contextual signal wording is appropriate.

## Stable_Management Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
Revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/similarity-evidence-split/similar-full-final.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js similar --full --json
```

Result:

- Total rows: 217
- `domain-behavior`: 43
- `mixed`: 81
- `access-query-scaffolding`: 84
- `framework-scaffolding`: 9
- `direct`: 43
- `signal`: 174

Representative rows:

| Pair | Evidence class | Tier | Judgment |
| ---- | -------------- | ---- | -------- |
| `createFacilitySlotTemplate` / `updateFacilitySlotTemplate` | `domain-behavior` | `direct` | Shared slot-window, service-plan, and facility-write behavior is a plausible reuse lead. |
| `setStorefrontLogo` / `uploadStorefrontPhoto` | `domain-behavior` | `direct` | Shared validated image write, cleanup, audit, and response shaping is a plausible reuse lead. |
| `deleteCareType` / `deleteServiceTaskTemplate` | `mixed` | `signal` | Shared persistence/error scaffolding plus configuration event publishing needs product judgment before extraction. |
| `getStableDetail` / `setStableStatus` | `mixed` | `signal` | Shared DB context and audit behavior is contextual evidence, not enough by itself for direct reuse. |
| `exportWorkRequestsFamily` / `exportTrainingSessionsFamily` | `access-query-scaffolding` | `signal` | Shared package-builder and access/query scaffolding should remain visible but soft. |

## Verification

Commands run successfully:

- `npx vitest run tests/queries/cleanup/similar-topk.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js similar --json --limit 10`
- `node dist/cli.js similar --limit 3`
- Stable_Management `similar --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

`recent-duplicates` and `unused-params` returned zero rows.

`node dist/cli.js diff-gate --json` still exits 1 with the same two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

## Judgment

Confirmed. Similarity now distinguishes concrete shared behavior from scaffolding-driven similarity without hiding contextual results. The direct tier is narrow enough to identify likely reuse leads, while access/query, framework, and mixed evidence stay review-first signals.

## Next Action

Continue the output-quality calibration queue with doc citation-kind output so `doc-drift` and `doc-reference` findings can distinguish stale behavioral docs from config examples, guides, and intentional citations.
