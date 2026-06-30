# Locality Positive Suggested-Home Result

Date: 2026-06-22

## Outcome

This pass validates where `locality-candidates` should still emit `suggestedHome` after the earlier conservative withholding pass.

A positive suggested-home validation is a reviewed analyzer run that starts from exact destinations rather than withheld destinations. Its essential job is to prove that the command still names useful homes when the evidence is strong enough, while identifying exact-looking rows that are semantically wrong.

Raw output root:

```text
/tmp/scip-query-validation/2026-06-22-locality-positive-suggested-home
```

Commands:

```sh
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js reindex
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 1000
```

Repositories:

| Repo | Revision | Status | Output |
| --- | --- | --- | --- |
| `scip-query` | `53e7a3e` plus this worktree | Dirty by this slice | `scip-query-locality-after-boundary-n1000.json` |
| `Stable_Management` | `2354b4e38` plus existing local changes | Dirty before this pass | `stable-management-locality-after-boundary-n1000.json` |
| `Vega_2.0` | `628885533` | Clean | `vega-locality-after-boundary-n1000.json` |

## Emission Counts

| Repo | Reviewed rows | Exact `suggestedHome` before boundary-destination tightening | Exact `suggestedHome` after tightening | Manual read |
| --- | ---: | ---: | ---: | --- |
| `scip-query` | 218 | 56 | 56 | All exact rows were single-consumer sibling-folder suggestions; useful as low-action locality signals, not repair instructions. |
| `Stable_Management` | 923 | 321 | 248 | False exact rows from `stores` and `middleware` are now withheld; feature-local shared rows still emit. |
| `Vega_2.0` | 1000 | 175 | 150 | False exact rows from `ui`, `repositories`, and service boundary subfolders are now withheld; proposal module shared rows still emit. |

## Reviewed Exact Rows

| Candidate | Emitted home | Verdict | Judgment |
| --- | --- | --- | --- |
| `frontend/src/features/horse-care/training-lesson-records/trainingBehavior.types.ts` | `frontend/src/features/horse-care/training-lesson-records/shared` | True positive owner | The types are consumed by feature root modules and existing `shared/composables`; the feature already has a shared boundary. |
| `frontend/src/features/horse-care/vet-records/vetRecordsModel.ts` | `frontend/src/features/horse-care/vet-records/shared` | True positive owner, coarse destination | The model is pure vet-records logic used across facilities, profiles, forms, and workspace controls. A subfolder under `shared` may be more precise, but the emitted owner is right. |
| `frontend/src/features/templates/service-plans/servicePlanModel.ts` | `frontend/src/features/templates/shared` | Plausible owner, coarse destination | Consumers cross service-plan and configuration setup; the existing `templates/shared` tree includes shared models. The analyzer does not yet choose `shared/models`. |
| `apps/api/src/modules/proposals/tools/proposal-software-dev-tool-contracts.ts` | `apps/api/src/modules/proposals/shared` | True positive owner | The file is consumed by proposal context, runtime, service, repository, and tool modules, and already imports shared tool contracts. |
| `apps/web/src/components/issues/IssueHoverPreview.tsx` | `apps/web/src/components` | Remaining false exact | The component is issue-domain UI reused by board, notifications, relationships, and sprints. Moving it to the components root would hide the issue concept; Vega should likely configure `issues` as a locality boundary if this pattern repeats. |
| `src/queries/internal/dead-candidate-gate.ts` | `src/queries/cleanup` | Low-action exact | Only one consumer exists. The destination is mechanically exact, but the counterevidence is right: this should stay a review signal, not an imperative. |

2026-06-30 health cleanup note: `src/queries/internal/dead-candidate-gate.ts` still intentionally stays in the internal query-policy area; today's change only documents `looksValueLikeDefinition()` as named dead-candidate policy for wrapper scoring.

## Withheld After Tightening

| Candidate | Previous emitted home | New result | Why it is better |
| --- | --- | --- | --- |
| `frontend/src/stores/auth.ts` | `frontend/src/shared` | Withheld | `stores` is a state ownership boundary; broad consumers do not make the Pinia store a generic shared helper. |
| `backend/src/middleware/validate.ts` | `backend/src/effect` | Withheld | `middleware` is an Express boundary; one Effect consumer does not prove the middleware belongs under Effect. |
| `apps/web/src/components/ui/LoadingSpinner.tsx` | `apps/web/src/components` | Withheld | `ui` is a reusable component boundary; moving a spinner to the broad components root would make organization worse. |
| `apps/api/src/modules/codebase-analysis/repositories/repo-intel.repository.ts` | `apps/api/src/modules/codebase-analysis/services` | Withheld | `repositories` is a persistence boundary; service consumers should not move repository code into services. |
| `apps/api/src/modules/codebase-analysis/services/indexing/indexing-strategy.ts` | `apps/api/src/modules/codebase-analysis/services` | Withheld | `services/indexing` is already an indexing boundary; broad service ownership is too coarse for an exact move. |

## Implementation Result

The validation prompted one additional tightening:

- `.scipquery.json` now supports `locality.architecturalBoundarySegments`.
- Built-in boundary segments now include `store`, `stores`, `repository`, `repositories`, and `ui`.
- Boundary-folder withholding now applies to direct one-consumer destinations and existing shared-owner destinations, not just invented `*/shared` destinations.

Updated judgment: `suggestedHome` should be emitted when an existing destination matches the real owner, especially feature/module `shared` homes with multiple consumers. It should be withheld when the current directory is a named ownership boundary and the suggested destination would move the file out of that boundary.

Residual risk: one-consumer sibling-folder exact rows remain noisy. They are still useful as low-action locality hints because the single consumer owner is mechanically exact, but future schema work may want a narrower confidence value than `exact`.
