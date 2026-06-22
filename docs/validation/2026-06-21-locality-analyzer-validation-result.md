# Locality Analyzer Validation Result

Date: 2026-06-21

## Verdict

AVL-012 is complete. The recommendation is **go for a report-only `locality-candidates` prototype or workflow skill, but no health scoring and no automatic moves yet**.

A locality finding is a placement claim about whether a file or symbol lives at the smallest ownership home that its actual consumers justify. Its essential evidence is the consumer set plus path-boundary context; size pressure alone can choose review targets, but cannot prove placement debt.

Consumer coverage is the analyzer's ability to identify the files that truly import, call, render, or otherwise depend on the candidate. It is decisive because a locality recommendation without trustworthy consumers can make an API too broad or too private for the real codebase.

Raw output was captured under `/tmp/scip-query-validation/2026-06-21-budget` and `/tmp/scip-query-validation/2026-06-21-pilot`.

## React Evidence

Repository: `Vega_2.0`

Pressure command:

```text
react-large-component-pressure --full --json
```

Summary:

- Total rows: 248
- Contexts: 28 `route-page`, 220 `component`
- Recommendation kinds: 28 `route-page-decomposition`, 218 `jsx-decomposition`, 2 `file-decomposition`

Sample validation:

| Candidate                                                         | Pressure output                          | Consumer evidence                                                                                             | Locality verdict                                                                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/routes/legal/TermsOfService.tsx`                    | `route-page`, `route-page-decomposition` | `rdeps` shows `apps/web/src/App.tsx`                                                                          | True signal: page-level decomposition target, not shared-component extraction.                                                                                                          |
| `apps/web/src/routes/proposals/components/CreateProjectModal.tsx` | `component`, `jsx-decomposition`         | `rdeps` shows `SoftwareDevChat.tsx`, `useProposalProjectCreation.ts`, and a local test                        | True signal: route-local component with nearby consumers; locality review should avoid app-global extraction.                                                                           |
| `apps/web/src/components/integrations/IntegrationCard.tsx`        | `component`, `jsx-decomposition`         | `rdeps` shows `IntegrationsManager.tsx` plus a local test; `co-change` shows integration API/service partners | True signal with domain context: app-level path may be justified by integration-domain reuse, but consumer set is still narrow enough to require review before globalizing more pieces. |

Judgment: React has enough evidence for a signal-only locality prototype. `rdeps` can produce concrete consumers, while pressure-kind output chooses the review target and co-change adds domain context.

## Vue Evidence

Repository: `Stable_Management`

Pressure command:

```text
vue-large-view-pressure --full --review-thresholds --json
```

Summary:

- Total rows: 59
- Contexts: 41 `component`, 18 `route-page`
- Recommendation kinds: 6 `script-behavior-extraction`, 32 `style-decomposition`, 16 `template-decomposition`, 4 `external-script-boundary`, 1 `route-page-decomposition`

Sample validation:

| Candidate                                                                              | Pressure output                           | Consumer evidence                                                                                                                              | Locality verdict                                                                                                                   |
| -------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `frontend/src/features/templates/stable-documents/components/StableDocumentsPanel.vue` | `component`, `script-behavior-extraction` | `rdeps` returned no rows; path-level `imported-by` returned broad references that look too coarse for exact consumer truth                     | Valid pressure target, but consumer coverage is insufficient for an automatic locality recommendation.                             |
| `frontend/src/shared/workspace/actions/FilterSortMenu.vue`                             | `component`, `style-decomposition`        | `rdeps` returned no rows; `imported-by` returned many production-looking references across features                                            | Possible app-shared UI primitive, but current evidence cannot separate true imports from broad path references confidently enough. |
| `frontend/src/features/marketing/landing/LandingView.vue`                              | `route-page`, `template-decomposition`    | Pressure-kind output alone identifies route/page decomposition; exact extracted-child placement still needs consumer evidence after extraction | True signal for route/page review, not enough for a move recommendation.                                                           |
| `frontend/src/features/organization/organization/OrganizationView.vue`                 | `route-page`, `external-script-boundary`  | External script boundary is visible; reverse dependency coverage is weak                                                                       | True signal for boundary review, but not direct repair.                                                                            |

Judgment: Vue pressure-kind output is useful for choosing review targets, but Vue consumer coverage is not strong enough yet for confident file-placement recommendations. The locality prototype must expose a `consumerCoverage` or equivalent caveat when reverse dependencies are unavailable or coarse.

## Go/No-Go Decision

Go, with constraints:

- Ship as `signal` only.
- Start with a workflow skill or report-only command.
- Require exact consumer rows before recommending a concrete destination.
- Emit a coverage caveat when consumer evidence comes from broad path references, tests only, unsupported SFC import edges, or empty reverse dependencies.
- Use pressure-kind output as target selection, not as proof of wrong placement.
- Use co-change only as supporting domain evidence, not as a consumer substitute.
- Keep all locality rows out of health scoring until a second repair-outcome pass shows that acting on them improves ownership without churn.

No-go for:

- Automatic file moves.
- Direct health deductions.
- Vue SFC placement claims that do not expose weak consumer coverage.
- Recommendations whose nearest common ancestor is the repository root or a generic `src` directory without domain evidence.

## Implementation Shape

The first implementation should report:

- `candidate`
- `currentTier`
- `recommendedTier` when supported, otherwise `recommendedTier: "needs-review"`
- `confidence`
- `consumerCoverage`
- `consumers`
- `nearestCommonAncestor`
- `reasons`
- `counterevidence`
- `suggestedHome` only when exact consumer evidence supports it
- `actionTier: "signal"`

This matches `docs/locality-analyzer-design.md`, but adds the required consumer-coverage field learned from validation.

## Residual Risk

- React evidence is stronger than Vue evidence because file-level `rdeps` was cleaner for `.tsx` samples.
- Vue validation needs improved SFC import/reference coverage or a narrower Vue-specific consumer collector before the analyzer can recommend destinations confidently.
- Locality repair outcomes still need a later slice: moving an extracted component, hook, or composable and verifying imports/tests is a different proof than reporting placement pressure.

## Verification

Completed after this doc update:

- `npm run typecheck`
- `npm run build`
- `npm test`: 64 files, 323 tests. Vitest passed; it still prints the existing noisy `git diff` usage warning from one test path.
- `node dist/cli.js recent-duplicates --json`: no findings.
- `node dist/cli.js unused-params --json`: no findings.
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`: two known accepted warnings:
  - `echo`: `isCompileTimeContractAssertion()` and `indexedDefinitionFromRow()` share symbol leaf/suffix parsing shape but serve different semantics.
  - `doc-reference`: `README.md` cites changed cleanup files as a configuration example; the target remains intentional.

## Next Slice

The remaining open ledger work is AVL-002 direct repair analyzer verdicts, AVL-003 contextual signal analyzer verdicts, AVL-006 score calibration, and AVL-007 output/schema quality. The next practical slice should use the now-completed action-tier and repair-outcome evidence to close one analyzer family at a time, starting with direct repair verdict coverage for `unused-imports`, `unused-params`, and `redundant-reexports`.
