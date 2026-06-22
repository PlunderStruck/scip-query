# Stable Management Locality Suggested-Home Review

Date: 2026-06-22

## Outcome

This pass validates the implemented `locality-candidates` command against `Stable_Management` by manually inspecting whether the reported `suggestedHome` is actually the right directory.

A suggested home is the directory the analyzer proposes as the smallest honest owner for a file after looking at its consumers. It is correct only when moving the file there would make ownership clearer without making the file easier to import from places that should not own the concept.

An ownership boundary is an existing folder, module, or project convention that groups code by one reason to change. In this repo, examples include `backend/src/effect`, `backend/src/errors`, `backend/src/workflows`, `backend/src/workflows/serviceTasks`, and frontend feature folders such as `frontend/src/features/operations/inventory`.

The command works well as a review signal: the inspected candidates all had real consumer sets and the nearest common owner was usually explainable. The literal `suggestedHome` is too aggressive, though. It often invents a missing `shared` folder even when the current named boundary is more precise.

Raw output root:

```text
/tmp/scip-query-validation/2026-06-22-stable-locality-repair-outcome
```

Commands:

```sh
scip-query reindex
scip-query locality-candidates --json -n 20
scip-query locality-candidates --scope backend/src/workflows --json -n 20
scip-query locality-candidates --scope frontend/src --json -n 20
scip-query locality-candidates backend/src/workflows/horseAccessWorkflow.ts --json -n 10
```

Repository context:

- Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
- Branch: `dev`
- Revision: `2354b4e38`
- Status: already dirty before this validation pass; this pass was observational.
- Index: TypeScript index reused successfully.

## Reviewed Candidates

| Candidate | Analyzer suggestion | Manual verdict | Judgment |
| --- | --- | --- | --- |
| `backend/src/effect/services.ts` | `backend/src/shared` | False positive for destination; true broad-dependency signal. | This file defines Effect service tags and the `AppServices` union. `backend/src/effect` is the real architectural boundary; `shared` would hide the Effect runtime concept behind a generic folder. |
| `backend/src/errors/AppError.ts` | `backend/src/shared` | False positive for destination; true broad-dependency signal. | The module is the backend error type used by middleware, services, utilities, tests, and workflows. `backend/src/errors` is a clearer boundary than a generic shared folder. |
| `backend/src/prisma.ts` | `backend/shared` | False positive with high precision-action value. | The project explicitly names `backend/src/prisma.ts` as the shared Prisma client in `docs/security/prisma-access-boundary.md`. The suggested home also escapes `backend/src` because `backend/prisma/seed.ts` is a consumer, so source-root clamping is needed. |
| `backend/src/workflows/configurationEvents.ts` | `backend/src/workflows/shared` | Plausible signal, not confirmed destination. | Consumers are workflow modules that publish stable configuration changes. A workflow-shared helper could be reasonable, but the repo has no `backend/src/workflows/shared` convention yet and the current name is already specific. |
| `backend/src/workflows/templateOptions.ts` | `backend/src/workflows/shared` | False positive for destination. | This is a route-facing template-option workflow module plus domain helpers. Moving it under shared would obscure its feature owner because `backend/src/routes/templateOptions.ts` imports it as the workflow implementation. |
| `backend/src/workflows/horseAccessWorkflow.ts` | `backend/src/workflows/shared` | Plausible signal, exact destination needs human design. | Consumers span horse activity, exports, horses, service entitlements, medical records, notifications, service-task horse access, and vet records. It is genuinely cross-workflow, but a better move would need naming review, not blind placement in a new `shared` folder. |
| `backend/src/workflows/serviceTasks/occurrenceStatus.ts` | `backend/src/workflows/shared` | False positive for destination; true cross-workflow signal. | The helper is used by several record-producing workflows, but the concept remains service-task occurrence status. Moving it to generic workflow shared would erase the service-task owner. |
| `frontend/src/features/operations/inventory/inventoryPlanningModel.ts` | `frontend/src/features/operations/inventory/shared` | False positive for destination; correct feature-local tier. | All consumers are inside the inventory feature. The file is already the inventory feature model at the feature root; creating `inventory/shared` would add ceremony without a clearer owner. |
| `frontend/src/features/horse-care/farrier-care/visit-log/farrierVisitModel.ts` | `frontend/src/features/horse-care/farrier-care/shared` | Best true positive in the sample. | Consumers live across farrier-care parent components, professionals, visit-log components, and visit-log composables. The model has outgrown `visit-log`; a farrier-care shared/model home would likely clarify ownership. |
| `frontend/src/features/horse-care/horse-profile/schedule/scheduleModel.ts` | `frontend/src/features/horse-care/horse-profile/shared` | False positive for destination; true feature-local signal. | Schedule, medication, nutrition, dialogs, and profile controller consumers all use schedule concepts. The `schedule` folder remains the domain owner; generic `horse-profile/shared` would make schedule-specific rules less discoverable. |
| `frontend/src/features/operations/billing/useBillingViewController.ts` | `frontend/src/features/operations/billing/shared` | False positive for destination. | The file is a view controller that provides billing view context to child components. The current feature root is appropriate; it is not a reusable shared model. |

## Precision Summary

Reviewed sample size: 11 candidates.

- Consumer-set usefulness: 11/11. Every reviewed row pointed at a real dependency cluster worth looking at.
- Literal suggested-home precision: 1 strong true positive, 2 plausible-but-needs-design, 8 false positives.
- Action tier judgment: still `signal`. The command should not drive automatic file moves or direct health scoring.

The true positive is `farrierVisitModel.ts`: the current `visit-log` location is narrower than its actual farrier-care consumers. The strongest false positive is `backend/src/prisma.ts`: the existing project standard makes the current path canonical, and the analyzer should not suggest `backend/shared`.

## Precision Actions

1. Do not emit a concrete `suggestedHome` merely because the nearest owner lacks the current leaf folder. Emit `suggestedHome: null` or a lower-confidence review note unless the destination already exists or the repo has a visible sibling convention for that destination.
2. Treat named architectural folders such as `effect`, `errors`, `schemas`, `types`, `utils`, `access`, `db`, `services`, and `workflows` as ownership boundaries. A broad consumer set inside the app can mean "central boundary is doing its job," not "move to shared."
3. Clamp suggestions to the candidate's source root or package source root. `backend/src/prisma.ts` should never become `backend/shared` just because `backend/prisma/seed.ts` is also a consumer.
4. Distinguish route-facing workflow modules from workflow helper modules. If a route imports the candidate as its workflow implementation, broad workflow consumers should not demote it to `workflows/shared`.
5. Keep the nearest-owner and consumer-count fields. They are useful and explainable; the precision issue is destination naming, not evidence collection.

## Updated Judgment

`locality-candidates` is good enough for directory-organization review in Stable Management, but not yet good enough to phrase its destination as an imperative. The command should say "these consumers imply this ownership level" more often than "move this file to this exact shared folder."

The next code improvement should tighten `suggestedHome` emission while preserving the consumer evidence that made this pass useful.

## Implementation Follow-Up

Implemented in the hardening slice recorded at:

```text
docs/plans/2026-06-22-locality-suggested-home-hardening.md
```

The command now separates consumer evidence from destination confidence:

- `suggestedHome` remains nullable and is emitted only for exact destinations.
- `destinationConfidence` records whether the destination is exact or withheld.
- `whyNoSuggestedHome` explains why the command kept the ownership signal but refused to invent a path.

Post-change Stable Management smoke output was captured under:

```text
/tmp/scip-query-validation/2026-06-22-stable-locality-hardening
```

Key reviewed outcomes:

- `backend/src/effect/services.ts`: `suggestedHome: null`; withheld because `backend/src/effect` is a named architectural boundary.
- `backend/src/errors/AppError.ts`: `suggestedHome: null`; withheld because `backend/src/errors` is a named architectural boundary.
- `backend/src/prisma.ts`: `suggestedHome: null`; withheld because `backend/shared` would leave the `backend/src` source root.
- `backend/src/workflows/horseAccessWorkflow.ts`: `suggestedHome: null`; withheld because `backend/src/workflows` is a named architectural boundary.
- `frontend/src/features/operations/inventory/inventoryPlanningModel.ts`: `suggestedHome: null`; withheld because `frontend/src/features/operations/inventory/shared` does not exist.
- `frontend/src/features/horse-care/farrier-care/visit-log/farrierVisitModel.ts`: `suggestedHome: null`; withheld because `frontend/src/features/horse-care/farrier-care/shared` does not exist.

Updated judgment: consumer ownership precision remains useful, and literal destination precision is now conservative. The analyzer no longer phrases missing `shared` folders as exact recommendations.

## Stable Management Locality Config Follow-Up

The setup pass added repo-specific mature boundaries to:

```text
/Users/aydansalois/Documents/GitHub/Stable_Management/.scipquery.json
```

Configured segments:

```json
["app", "audit", "composables", "contracts", "features", "motion", "navigation", "router", "workspace"]
```

These are mature enough for config because they recur as real ownership surfaces in the tree and project instructions: backend audit writing is named as a persistence boundary, shared contracts are the frontend/backend wire contract surface, frontend features are the primary product ownership layout, and navigation/router/motion/workspace/composables are explicit frontend infrastructure surfaces. Legacy broad folders such as `components` and `views` were not added because they are less reliable ownership signals.

Validation commands:

```sh
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js config-validate --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js reindex
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js status --json
python3 /Users/aydansalois/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/scip-query-setup
```

Results:

- Stable Management config validation: `diagnostics: []`.
- Stable Management status after reindex: `ok: true`, index freshness `fresh`, TypeScript semantic provider available.
- Locality candidate count before config: 20 rows, 0 with non-null `suggestedHome`.
- Locality candidate count after config: 20 rows, 0 with non-null `suggestedHome`.
- Setup skill validation: `Skill is valid!`.

Judgment: the Stable Management locality config is conservative and valid. It does not suppress any currently emitted exact `suggestedHome` rows because none were emitted before the config change; it only gives future locality analysis the repo-specific boundary vocabulary it needs to avoid generic homes when these mature surfaces are involved.

## Post-Boundary-Reason Regression Pass

After the Vega boundary-reason hardening, the Stable Management client was rechecked with the current local `scip-query` build:

```sh
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js status --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js config-validate --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full --scope frontend/src
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full --scope backend/src
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json --full --scope frontend/src/features
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 100
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 100 --scope frontend/src
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 100 --scope backend/src
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 100 --scope frontend/src/features
```

Readiness:

- Status: `ok: true`.
- Index freshness: `fresh`.
- TypeScript semantic provider: available.
- Config validation: `diagnostics: []`.
- Stable Management worktree: already dirty before this pass; this pass did not edit the Stable Management repo.

Result summary:

| Scope | Rows reviewed | Exact `suggestedHome` rows | Judgment |
| --- | ---: | ---: | --- |
| root `--full` | 20 | 0 | Correctly withheld broad backend infrastructure and source-root-crossing cases. |
| `backend/src --full` | 20 | 0 | Correctly withheld Effect, error, Prisma, type, utility, audit, config, DB, and service boundaries. |
| `frontend/src --full` | 20 | 0 | Correctly withheld feature-local models/controllers that are already at their nearest common owner or would need a new feature-local `shared` folder. |
| `frontend/src/features --full` | 20 | 0 | Same as frontend source scope. |
| root `-n 100` | 100 | 0 | No deeper exact homes appeared. |
| `backend/src -n 100` | 100 | 0 | No backend exact homes appeared; most rows were central boundaries doing real work. |
| `frontend/src -n 100` | 100 | 0 | No frontend exact homes appeared; existing `shared` folders did not line up with the candidate nearest owners. |
| `frontend/src/features -n 100` | 100 | 0 | No feature exact homes appeared. |

Manual inspection:

- `backend/src/effect/services.ts` is an Effect service-tag module. Its consumers span workflows, tests, and the Effect runtime helpers, but `backend/src/effect` is the concept owner. Moving it to `backend/src/shared` would replace a precise architectural boundary with a generic bucket.
- `backend/src/prisma.ts` is the contextual Prisma client boundary. Root-scope analysis sees `backend/prisma/seed.ts` as a consumer and therefore computes `backend` as the nearest common owner, but the analyzer correctly withholds `backend/shared` because that would leave `backend/src`.
- `frontend/src/features/operations/inventory/inventoryPlanningModel.ts` is already at `frontend/src/features/operations/inventory`, the nearest common owner for its consumers.
- `frontend/src/features/horse-care/farrier-care/visit-log/farrierVisitModel.ts` remains the best review signal in the sample: its consumers span the farrier-care parent, professionals, and visit-log files. However, `frontend/src/features/horse-care/farrier-care/shared` does not exist, so withholding the exact home is still right; a human should decide whether the correct owner is a new `shared/model` area, a renamed farrier-care model file, or the current visit-log module.
- `frontend/src/features/templates/configuration/setup/setupInterviewModel.ts` is consumed by setup and configuration files, but `frontend/src/features/templates/configuration/shared` does not exist and the setup interview is still a named sub-flow, so the command should keep this as a review signal.

Updated judgment: the Stable Management result is conservative in the right way. The command found real locality pressure, but it did not emit an exact `suggestedHome` where the destination would be a newly invented `shared` folder, a generic replacement for a named infrastructure boundary, or a path outside the source root. No additional Stable-specific `suggestedHome` emission case was confirmed in this pass.

## Actionability Review

The next pass reviewed the locality signals as migration candidates. A migration candidate is a file or small file set whose imports show that the current folder no longer names the clearest owner. It should be done only when a move or extraction makes future placement decisions easier, not merely because several files import it.

Commands:

```sh
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js reindex
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 150
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 150 --scope backend/src
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 150 --scope frontend/src
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js locality-candidates --json -n 150 --scope frontend/src/features
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js rdeps frontend/src/features/horse-care/farrier-care/visit-log/farrierVisitModel.ts --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js rdeps frontend/src/features/templates/service-plans/servicePlanModel.ts --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js rdeps frontend/src/features/templates/shared/api/configuration.ts --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js co-change frontend/src/features/horse-care/farrier-care/visit-log/farrierVisitModel.ts --json
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js co-change frontend/src/features/templates/service-plans/servicePlanModel.ts --json
```

Result counts:

- Backend `-n 150`: 126 rows withheld because the current directory is a named boundary; 24 rows already at the nearest common owner.
- Frontend `-n 150`: 93 rows already at the nearest common owner; 57 rows withheld because the current directory is a named boundary.
- Co-change evidence for the two recommended frontend candidates did not meet the default threshold, so these recommendations are based on import ownership and source inspection rather than repeated historical co-edits.

### Should Do

| Priority | Slice | Proposed structure | Why it should be done | Verification |
| --- | --- | --- | --- | --- |
| 1 | Promote `frontend/src/features/horse-care/farrier-care/visit-log/farrierVisitModel.ts` and its spec. | Move to `frontend/src/features/horse-care/farrier-care/farrierVisitModel.ts`; keep `visit-log` for visit-log implementation files. | The model is imported by parent farrier-care composables, farrier professional management, workspace controls, parent components, and visit-log files. It contains feature-level farrier visit/professional types, option builders, filters, payload builders, and attachment helpers, so `visit-log` is narrower than the real owner. A new `shared` folder is unnecessary; the farrier-care feature root is the owner. | Update imports, run the farrier-care specs, run frontend typecheck, then reindex and diff-gate. |
| 2 | Extract the shared service-plan facility-access helpers from `frontend/src/features/templates/service-plans/servicePlanModel.ts`. | Create `frontend/src/features/templates/shared/models/servicePlanFacilityAccessModel.ts` for `minimumPlanOptions`, `sortFacilityAccessFacilities`, `sortFacilityAccessSlotTemplates`, `minimumPlanSelectValue`, `facilityAccessCapabilityLabel`, `bookingWindowAccessLabel`, `facilityAccessMinimumLabel`, `buildServicePlanFacilityAccessPatch`, and `eligibleDefaultFacilities`. Keep service-plan page-only derivations in `service-plans/servicePlanModel.ts`. | `configuration/components/usePlansPanelController.ts` imports this helper subset from the service-plans feature. That is a real ownership leak: configuration setup and the service-plans page both need the facility-access model, but neither should own it privately. Extracting the subset is better than moving the whole 600+ line service-plan model into `shared`. | Move helper tests or add focused shared-model tests, update imports in configuration and service-plans controllers, run service-plan/configuration specs and frontend typecheck, then reindex and diff-gate. |

### Watch, But Do Not Move Now

| Signal | Judgment |
| --- | --- |
| `frontend/src/features/templates/configuration/setup/setupInterviewModel.ts` | Keep in `configuration/setup`. Parent configuration files host or persist the setup flow, but the setup interview remains the named owner. |
| Horse-profile subfeature models such as `scheduleModel.ts`, `feedingModel.ts`, `recordEntryModel.ts`, `medicationModel.ts`, and `useHorseProfileMedicalFiles.ts` | Do not move individual files into `horse-profile/shared` yet. These imports mostly show the profile controller composing subfeatures. A future horse-profile architecture pass may find extractable profile-wide primitives, but the locality rows alone do not justify broad moves. |
| `frontend/src/features/templates/shared/api/configuration.ts` | Keep under `templates/shared/api`. It is an endpoint-family wrapper used by configuration and service-plans surfaces; the API boundary is the owner. |
| `frontend/src/shared/workspace/tabs/tabStripModel.ts` and `frontend/src/shared/workspace/actions/filterFacets.ts` | Keep with the concrete workspace UI submodules. They are re-exported through `frontend/src/shared/workspace/index.ts`, and their consumers are using the workspace package surface. |

### Do Not Move

| Signal group | Judgment |
| --- | --- |
| Backend `effect`, `errors`, `prisma`, `types`, `utils`, `audit`, `config`, `db`, `services`, `schemas`, `access`, and route-facing `workflows` rows | Do not move. These are mature backend infrastructure and workflow boundaries. Broad consumers prove the boundary is doing its job, not that the code belongs in generic `shared`. |
| Rows whose nearest owner is already the current directory | Do not move. These are good locality signals but not migration work. |
| Rows whose only destination would be a newly invented `shared` folder | Do not move without a named concept and a migration design. Generic shared folders would hide ownership rather than clarify it. |

Migration order: do the farrier-care model promotion first because it is small, import-only, and low risk. Then do the service-plan facility-access extraction because it touches a larger model and should carry focused tests with it.
