# Frontend Behavior Evidence Classification Result

Date: 2026-06-21

## Scope

This slice implements the frontend behavior calibration action for React hook and Vue composable candidates. A frontend behavior evidence class is a label on the shared names that caused two files to be paired; it distinguishes common framework workflow, existing shared abstractions, product behavior, and mixed cases. Its role is to keep extraction leads visible while telling reviewers whether the row points to a real domain behavior candidate or only to ordinary UI mechanics.

Implemented changes:

- `ReactHookCandidateResult` now includes `evidenceClass`, `actionTier`, `evidenceClassReasons`, and `recommendation`.
- `VueComposableCandidateResult` now includes `evidenceClass`, `actionTier`, `evidenceClassReasons`, and `recommendation`.
- `react-hook-candidates` and `vue-composable-candidates` text output prints the evidence class, action tier, recommendation, and reasons.
- Generic workflow scaffolding remains visible but is downgraded to support evidence.
- Domain behavior and mixed behavior remain contextual signals.
- Existing generic shared hooks/composables are identified as shared-abstraction support when little domain evidence remains.

## Regression Coverage

Updated `tests/queries/frontend/react-frontend-rich-internals.test.ts`:

- The shared `useResource` fixture now asserts `evidenceClass: 'shared-abstraction'`.
- The row now asserts `actionTier: 'support'`.
- The evidence reasons explain that the shared hook is generic workflow.
- The recommendation points reviewers toward the existing shared hook instead of a new domain extraction.

Updated `tests/queries/frontend/vue-template-rich-internals.test.ts`:

- The Vue composable fixture now asserts `evidenceClass: 'mixed'`.
- The row now asserts `actionTier: 'signal'`.
- The evidence reasons preserve the domain term in `useToast`.
- The recommendation points reviewers toward domain-specific behavior extraction only after checking component intent.

## Vega React Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
Revision: `6288855333faf33ba395fa804eb9b03c0a04989e`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/react-hook-evidence-classification/react-hook-candidates-full.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js react-hook-candidates --full --json
```

Result:

- Total rows: 87
- Evidence classes: `mixed` 45, `shared-abstraction` 38, `generic-workflow-scaffolding` 4
- Action tiers: `signal` 45, `support` 42

Reviewed examples:

| Pair | Evidence class | Action tier | Judgment |
| --- | --- | --- | --- |
| `LocalCompanionConfigEditor` / `CreateProjectModal` | `generic-workflow-scaffolding` | `support` | Shared form and workflow shape, not a domain hook lead by itself. |
| `ForgotPassword` / `ResetPassword` | `shared-abstraction` | `support` | Existing shared workflow dominates; extraction should start from the current abstraction. |
| `Login` / `Register` | `mixed` | `signal` | Generic form workflow plus auth-domain behavior. |
| `useAuthStore` rows | `mixed` | `signal` | Existing store evidence is still useful because the repeated behavior points at auth domain boundaries. |

## Stable_Management Vue Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
Revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/vue-composable-evidence-classification/vue-composable-candidates-full.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js vue-composable-candidates --full --json
```

Result:

- Total rows: 0
- Evidence classes: none emitted in this corpus run.
- The fixture coverage is the live validation source for non-empty Vue evidence classification until a Vue corpus produces composable candidates.

## Verification

Commands run successfully:

- `npx vitest run tests/queries/frontend/react-frontend-rich-internals.test.ts`
- `npx vitest run tests/queries/frontend/vue-template-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js react-hook-candidates --json --limit 5`
- `node dist/cli.js vue-composable-candidates --json --limit 5`
- Vega `react-hook-candidates --full --json`
- Stable_Management `vue-composable-candidates --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with the same two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

`npm test` still prints a noisy `git diff` usage warning from an existing test path, but Vitest reports all 313 tests passed.

## Judgment

Confirmed. React hook candidates now separate generic UI workflow from domain behavior on the Vega corpus: 42 of 87 rows are support instead of contextual extraction signals. Vue composable candidates now have the same output contract and fixture coverage, but the Stable_Management run produced no rows, so Vue field calibration needs a richer Vue-composable corpus before score weighting changes.

## Next Action

Continue the contextual signal verdict review with extraction and stale-abstraction families, then use those results with the frontend behavior classifications in the score calibration memo.
