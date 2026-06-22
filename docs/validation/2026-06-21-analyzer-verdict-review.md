# Analyzer Verdict Review

Date: 2026-06-21

Raw output root:

```text
/tmp/scip-query-validation/2026-06-21-pilot
```

This review classifies the first pilot findings from `docs/validation/2026-06-21-analyzer-validation-pilot.md`. It is a human verdict pass, not an implementation pass. No analyzer thresholds or score weights should change from this file alone; the calibration follow-up is recorded in `docs/validation/2026-06-21-analyzer-calibration-memo.md`.

## Review Scope

Reviewed rows:

| Area                                 | Rows |
| ------------------------------------ | ---: |
| Stable_Management diff-gate findings |   22 |
| Stable_Management wrapper candidates |   10 |
| Stable_Management similarity rows    |   10 |
| Stable_Management co-change rows     |   10 |
| Stable_Management Vue pressure rows  |    8 |
| scip-query self-check rows           |    6 |
| `dead --only-dead` output contract   |    2 |
| Total                                |   68 |

Verdict distribution:

| Verdict           | Count | Meaning in this pass                                                                                  |
| ----------------- | ----: | ----------------------------------------------------------------------------------------------------- |
| `tp`              |    28 | The analyzer found a real maintenance signal; for contextual analyzers this does not imply auto-fix.  |
| `fp`              |    10 | The evidence pattern exists, but the reported maintenance action is wrong for the inspected code.     |
| `accepted_design` |    18 | The pattern is real and intentionally kept; report wording or score weight should reflect that.       |
| `needs_judgment`  |    12 | The analyzer found plausible signal, but the raw evidence is not enough to justify a repair decision. |

High-level result:

- Direct cleanup signals worked best on tiny duplicated local utilities.
- `wrapper-candidates` over-reported intentional boundary helpers in its top results.
- `similar` was useful as a signal, but several rows were only shared workflow scaffolding.
- `co-change` gave the strongest contextual evidence among the non-direct analyzers.
- Vue large-view pressure is real, but the output needs to separate style pressure, script pressure, and route/page pressure.
- `dead --only-dead --json` has a schema clarity issue because `symbols.length` includes file-internal inventory even when `deadCodeCount` is 0.

## Evidence Commands

Source and implementation anchors:

- `scip-query code health --json`
- `scip-query code diffGate --json`
- `scip-query trace queryCommandOrder --json`
- `scip-query trace DIFF_GATE_CHECKS --json`

Stable_Management source checks:

- `scip-query code loadAccessibleHorseSummaryForWorkflow --json`
- `scip-query code getVetRecord --json`
- `scip-query code 'backend/src/workflows/horses.ts:67-68' --json`
- `scip-query code 'backend/src/workflows/horses.ts:411-416' --json`
- `scip-query code fakePaymentIntentSecret --json`
- `scip-query code ensureLinkedUserInStable --json`
- `scip-query code src:workflows:horses:writeAuditEntry --json`
- `scip-query code _AssertNotificationRowContract --json`
- `scip-query refs _AssertNotificationRowContract --json`
- `scip-query code exportWorkRequestsFamily --json`
- `scip-query code exportTrainingSessionsFamily --json`
- `scip-query change-surface <file> --json` on sampled co-change and Vue files
- `git log --oneline --max-count=3 -- <file>` on sampled co-change files

scip-query source checks:

- `scip-query code renderCapabilities --json`
- `scip-query code handleConfigValidate --json`
- `scip-query code handleDoctor --json`
- `scip-query code handleStatus --json`
- `scip-query code handleSuppress --json`
- `git log --oneline --max-count=5 -- README.md docs/COMMAND_REFERENCE.md package.json package-lock.json`

## Stable_Management Diff-Gate Verdicts

### Echo

| Finding          | Reported pair                                                                      | Verdict | Precision action       | Review note                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------------- | ------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `SQ6BD3CB945E64` | `loadAccessibleHorseSummaryForWorkflow` vs `getVetRecord`                          | `fp`    | evidence/wording       | Both call horse-access helpers, but one loads a reusable horse summary and the other loads a vet record with record-specific include/response.  |
| `SQ37ED6D2BC66E` | `horses:hasOwn` vs `horseUpdateRules:hasOwn`                                       | `tp`    | grouping               | Same one-line `hasOwnProperty.call` helper; direct cleanup is plausible.                                                                        |
| `SQDEF7A4F50FE7` | `horses:hasOwn` vs `horseCarePlanInputs:hasOwn`                                    | `tp`    | grouping               | Same duplicated helper as above; should be grouped with the same root cause.                                                                    |
| `SQA7ACC6FBDBC5` | `horses:hasOwn` vs `horseProviderAssignments:hasOwn`                               | `tp`    | grouping               | Same duplicated helper as above; the analyzer should avoid counting each pair as independent debt.                                              |
| `SQBA67281840C4` | `horses:normalizeNullableString` vs `horseCarePlanInputs:normalizeNullableString`  | `tp`    | grouping               | Same string normalization pattern; direct shared helper is plausible.                                                                           |
| `SQ7038B8A7733F` | `horses:normalizeNullableString` vs `horseProviderAssignments:normalizeNullableId` | `tp`    | domain-name evidence   | Behavior appears shared, but the `Id` name may encode a domain-specific constraint; report should show whether value constraints differ.        |
| `SQA84D5885B0E7` | `fakePaymentIntentSecret` vs `routes:auth:generateCsrfToken`                       | `fp`    | token-kind evidence    | Shared `crypto.randomBytes().toString("hex")` shape does not mean fake payment intent secrets and CSRF tokens share semantics or length policy. |
| `SQ83AD18828DDE` | `fakePaymentIntentSecret` vs `authAccounts:generateOpaqueToken`                    | `fp`    | token-kind evidence    | The established token uses 32 bytes; the fake payment-intent helper uses 8 bytes and a `fake_` prefix.                                          |
| `SQAF5523BBE6A0` | `fakePaymentIntentSecret` vs `authSessions:generateCsrfToken`                      | `fp`    | token-kind evidence    | Same random-token primitive, different security and product role.                                                                               |
| `SQBD32843F29F8` | `ensureLinkedUserInStable` vs `resolveVetRecordType`                               | `fp`    | domain-token weighting | Both are lookup-and-error workflows, but one checks active stable membership and the other resolves a vet record type option.                   |

Echo calibration:

- Keep direct blocking for exact tiny helper duplication.
- Group many pairwise hits into one root cause.
- Downweight shared framework/workflow scaffolding when domain tokens and selected data differ.
- For token helpers, compare entropy, prefix, and security purpose before recommending reuse.

### Baseline

| Finding          | Reported pair                                                   | Verdict          | Precision action       | Review note                                                                                      |
| ---------------- | --------------------------------------------------------------- | ---------------- | ---------------------- | ------------------------------------------------------------------------------------------------ |
| `SQ7AE426DC3F9E` | `editConversationMessage` vs `sendConversationMessage`          | `needs_judgment` | evidence fields        | Shared message workflow scaffolding is plausible signal, but repair depends on product behavior. |
| `SQ8FAA81B2C104` | `resolveEmergencyBroadcast` vs `updateEmergencyBroadcast`       | `needs_judgment` | evidence fields        | Same emergency-broadcast domain; needs source review before recommending extraction.             |
| `SQFB08E9EEFB1A` | `createFarrierVisitAttachment` vs `restoreFarrierVisit`         | `needs_judgment` | evidence fields        | Same workflow area, but the operations likely have different side effects.                       |
| `SQ8547745A7D9F` | `loadAccessibleHorseSummaryForWorkflow` vs `getVetRecord`       | `fp`             | align with echo result | Same false-positive cause as `SQ6BD3CB945E64`.                                                   |
| `SQFAAC9D3B7B05` | `exportCareOccurrencesFamily` vs `exportTrainingSessionsFamily` | `needs_judgment` | locality evidence      | Export-family structure repeats, but each CSV family has domain-specific fields and permissions. |

Baseline calibration:

- The baseline gate correctly identifies newly introduced findings, but its user-facing result should carry the underlying finding family and action tier.
- Baseline rows should inherit verdict grouping from the underlying analyzer so one false-positive root cause does not appear as multiple independent gate failures.

### Doc Reference

| Finding          | Doc                                              | Verdict          | Precision action | Review note                                                                                                       |
| ---------------- | ------------------------------------------------ | ---------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `SQ5CB33D3BC59A` | `FEATURE_CATALOG.md`                             | `needs_judgment` | doc intent       | Broad feature catalogs cite many workflow files; a changed file does not prove the feature catalog claim changed. |
| `SQ1B13818D8E0C` | `agent-os/standards/api/families/horses.md`      | `needs_judgment` | doc intent       | API family standards are more likely to need review, but the analyzer must show the cited claim.                  |
| `SQ03C543426E91` | `agent-os/standards/frontend/feature-folders.md` | `needs_judgment` | doc intent       | Changed `frontend/src/shared/workspace/index.ts` may or may not affect a feature-folder standard.                 |

Doc-reference calibration:

- Keep the finding as a review prompt, not a direct blocker, unless the doc citation is broken or the changed range overlaps a cited claim.
- Add doc intent or citation-kind evidence: API standard, feature catalog, historical note, migration plan, or broken path.

### Incomplete Migration, Co-Change Partner, New Dead

| Finding          | Check                  | Location                                                                | Verdict           | Precision action      | Review note                                                                                                                                        |
| ---------------- | ---------------------- | ----------------------------------------------------------------------- | ----------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SQ5C782F143236` | `incomplete-migration` | `backend/src/workflows/horseAccessWorkflow.ts`                          | `fp`              | semantic containment  | The new helper returns accessible horse summary data; remaining sites perform record-specific or workflow-specific lookups, not a partial rollout. |
| `SQB51A339ACC53` | `co-change-partner`    | `setupInterviewModel.ts` missing `SetupInterviewPanel.vue`              | `tp`              | none                  | History says model and panel changed together 7 times at 100 percent confidence; this is a legitimate review prompt.                               |
| `SQ3F635F96AF79` | `co-change-partner`    | `setupInterviewModel.spec.ts` missing `SetupInterviewPanel.vue`         | `tp`              | none                  | History says spec and panel changed together 6 times at 100 percent confidence; this is a legitimate review prompt.                                |
| `SQ686A3BE8840F` | `new-dead`             | `backend/src/workflows/notifications.ts:_AssertNotificationRowContract` | `accepted_design` | type-assertion filter | The symbol has only its definition as a reference, but it is a compile-time DTO contract assertion, not runtime dead code.                         |

Direct-gate calibration:

- `incomplete-migration` needs stronger semantic containment evidence before suggesting migration.
- `new-dead` should treat type-level contract assertions differently from unused runtime symbols.
- `co-change-partner` is a high-quality signal when it reports exact historical partners, but it should remain a review prompt unless the partner is a test/schema/doc that obviously must move with the change.

## Stable_Management Wrapper Candidate Verdicts

| Candidate                            | Location                              | Verdict           | Precision action            | Review note                                                                                                           |
| ------------------------------------ | ------------------------------------- | ----------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `runDbRequestContextWithTransaction` | `backend/src/db/contextStore.ts`      | `accepted_design` | boundary-role evidence      | One caller, but it preserves the request-context/transaction boundary.                                                |
| `applyDbRequestContext`              | `backend/src/db/contextStore.ts`      | `accepted_design` | boundary-role evidence      | Applies local transaction settings; the function name carries DB request-context policy.                              |
| `assignRouterMount`                  | `backend/src/effect/routeRegistry.ts` | `accepted_design` | comment/evidence extraction | Source comment explains why the stamp-once behavior exists.                                                           |
| `notFoundHandler`                    | `backend/src/middleware/error.ts`     | `accepted_design` | framework allowlist         | Express middleware handlers are intentionally named entry points even when small.                                     |
| `writeAuditLog`                      | `backend/src/audit/auditWriter.ts`    | `accepted_design` | boundary-role evidence      | Central audit writer is a side-effect boundary, not an avoidable wrapper.                                             |
| `validateQuery`                      | `backend/src/middleware/validate.ts`  | `accepted_design` | framework allowlist         | Zod-to-Express request validation middleware is an intentional boundary.                                              |
| `validateBody`                       | `backend/src/middleware/validate.ts`  | `accepted_design` | framework allowlist         | Same validation boundary as `validateQuery`, with body-specific error behavior.                                       |
| `validateParams`                     | `backend/src/middleware/validate.ts`  | `accepted_design` | framework allowlist         | Same validation boundary as `validateQuery`, with params mutation behavior.                                           |
| `registerRoute`                      | `backend/src/effect/routeRegistry.ts` | `accepted_design` | registry-role evidence      | Route registration guards duplicate routes and owns registry mutation.                                                |
| `isBinaryResponse`                   | `backend/src/utils/respond.ts`        | `accepted_design` | type-guard filter           | Tiny type guards can be valuable even with one caller because they name a runtime shape and narrow a TypeScript type. |

Wrapper calibration:

- Top 10 had zero direct cleanup wins.
- The analyzer's graph fact is true: each row has a single indexed caller.
- The maintenance interpretation is mostly wrong unless the output can identify boundary roles, middleware conventions, type guards, registry functions, and policy names.
- Health score should not subtract heavily for these rows without a confidence split.

## Stable_Management Similarity Verdicts

| Row | Reported pair                                                   | Verdict          | Precision action       | Review note                                                                                                 |
| --: | --------------------------------------------------------------- | ---------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------- |
|   1 | `exportWorkRequestsFamily` vs `exportTrainingSessionsFamily`    | `needs_judgment` | locality evidence      | Shared export-family mechanics are real, but CSV fields, permissions, and row summaries differ.             |
|   2 | `loadAccessibleHorseSummaryForWorkflow` vs `getVetRecord`       | `fp`             | domain-token weighting | Same cause as the echo false positive: access scaffolding is shared, behavior is different.                 |
|   3 | `useTrainingBehavior` vs `useIncidents`                         | `needs_judgment` | framework downweight   | Shared composables may be feature-workspace convention rather than extractable duplication.                 |
|   4 | `getStableDetail` vs `setStableStatus`                          | `needs_judgment` | mutation/query split   | Same platform-admin file and audit scaffolding, but read and mutation flows differ.                         |
|   5 | `updateFacilitySlotTemplate` vs `createFacilitySlotTemplate`    | `tp`             | none                   | Create/update pairs sharing validation and conflict checks are credible extraction candidates.              |
|   6 | `deleteServiceTaskTemplate` vs `deleteCareType`                 | `tp`             | none                   | Same delete/archive style with `NotFoundError`, `ConflictError`, and configuration event publishing.        |
|   7 | `listFarrierVisitAttachments` vs `getFarrierVisit`              | `needs_judgment` | operation-kind fields  | Same access and lookup guards, but listing attachments and loading the visit may be intentionally separate. |
|   8 | `useVetRecords` vs `useFarrierCare`                             | `needs_judgment` | framework downweight   | Repeated frontend resource composables are signal, but product-specific workspaces may be right to keep.    |
|   9 | `setStorefrontLogo` vs `uploadStorefrontPhoto`                  | `tp`             | none                   | Same image-file workflow with cleanup, audit, and response shaping; extraction looks plausible.             |
|  10 | `deleteHorseCareScheduleItem` vs `archiveHorseCareScheduleItem` | `needs_judgment` | lifecycle semantics    | Delete and archive can share cleanup/event code, but lifecycle semantics need product review.               |

Similarity calibration:

- Similarity is useful, but the correct action tier is contextual signal.
- Rows based only on framework/resource/access scaffolding need lower confidence than rows sharing domain-specific validation, cleanup, or side-effect sequences.
- Create/update or upload/set pairs are more actionable than generic query/mutation pairs.

## Stable_Management Co-Change Verdicts

| Row | Files                                                                                    | Verdict          | Precision action      | Review note                                                                                 |
| --: | ---------------------------------------------------------------------------------------- | ---------------- | --------------------- | ------------------------------------------------------------------------------------------- |
|   1 | `docs/security/stable-scope-table-inventory.md` and `scripts/stable-scope-inventory.mjs` | `tp`             | declared coupling     | Inventory docs and the inventory script are a true hidden coupling candidate.               |
|   2 | `backend/src/schemas/platformAdmin.ts` and `docs/platform-admin-buildout-plan.md`        | `tp`             | doc intent            | Platform-admin schema and buildout docs have a plausible design-doc coupling.               |
|   3 | `backend/src/routes/onboarding/horses.ts` and `backend/src/routes/onboarding/payment.ts` | `needs_judgment` | same-feature grouping | Same onboarding feature area, but broad feature commits may explain the correlation.        |
|   4 | `backend/src/routes/platformAdmin.ts` and `docs/platform-admin-buildout-plan.md`         | `tp`             | doc intent            | Platform-admin route and platform-admin plan are a plausible hidden doc/code coupling.      |
|   5 | `backend/prisma/schema.prisma` and `docs/security/stable-scope-table-inventory.md`       | `tp`             | declared coupling     | Schema and scope table inventory should likely move together or be generated.               |
|   6 | `backend/prisma/schema.prisma` and `scripts/stable-scope-inventory.mjs`                  | `tp`             | declared coupling     | Schema and schema-inspection script are a genuine coordination risk.                        |
|   7 | `DailyChecklistView.script.ts` and `operationsModel.ts`                                  | `tp`             | none                  | Feature view script and its operations model changed together in checklist feature commits. |
|   8 | `DailyChecklistView.vue` and `operationsModel.ts`                                        | `tp`             | none                  | View and model coupling is a legitimate review prompt.                                      |
|   9 | `ConfigurationHomeView.script.ts` and `SetupInterviewPanel.vue`                          | `needs_judgment` | same-feature grouping | Same templates/configuration area; needs source review before declaring hidden coupling.    |
|  10 | `ConfigurationHomeView.vue` and `SetupInterviewPanel.vue`                                | `needs_judgment` | same-feature grouping | Same as row 9; could be feature-wide churn rather than a missing dependency.                |

Co-change calibration:

- This family performed well as a support signal.
- Doc/code and schema/script pairs are especially actionable.
- Same-feature correlations should show whether commits were broad feature sweeps before being scored as hidden coupling.

## Stable_Management Vue Large-View Verdicts

| File                                                                                     | Dominant pressure | Verdict           | Precision action    | Review note                                                                                         |
| ---------------------------------------------------------------------------------------- | ----------------- | ----------------- | ------------------- | --------------------------------------------------------------------------------------------------- |
| `frontend/src/features/templates/stable-documents/components/StableDocumentsPanel.vue`   | script            | `tp`              | locality checklist  | 690 lines with large template, script, and style sections; true concentration of reasons to change. |
| `frontend/src/shared/workspace/actions/FilterSortMenu.vue`                               | style             | `tp`              | pressure-kind split | 357 style lines dominate; output should recommend style/component pressure, not script extraction.  |
| `frontend/src/features/operations/facility-schedule/components/BookingMonthCalendar.vue` | style             | `tp`              | pressure-kind split | Calendar complexity plus 345 style lines is real pressure, but likely needs UI-specific review.     |
| `frontend/src/features/templates/shared/components/template-tree/TemplateTreeNode.vue`   | style             | `tp`              | pressure-kind split | Recursive tree node with 420 style lines; true pressure, probably not composable extraction.        |
| `frontend/src/features/account/actions/AccountActionsView.vue`                           | style             | `tp`              | pressure-kind split | 361 style lines and external script indicate layout/style pressure more than behavioral pressure.   |
| `frontend/src/features/horse-care/horse-profile/components/HorseProfileSectionBar.vue`   | script            | `tp`              | locality checklist  | 212 script and 204 template lines make it a credible locality review target.                        |
| `frontend/src/features/marketing/landing/LandingView.vue`                                | template          | `accepted_design` | route/page filter   | Landing pages can be intentionally long, mostly static pages; score should be softer.               |
| `frontend/src/features/organization/organization/OrganizationView.vue`                   | external-script   | `tp`              | locality checklist  | External script remains 286 lines; true behavioral pressure remains after script extraction.        |

Vue calibration:

- The `--min-total-lines 300` probe produced useful true positives.
- Default threshold returning 0 is likely too high for review mode, but any score integration must distinguish pressure kind.
- Style-heavy files should not be routed to composable extraction.
- Route/landing pages need a softer action tier than reusable components or workflow-heavy views.

## scip-query Self-Check Verdicts

| Analyzer                     | Finding                                                                   | Verdict           | Precision action          | Review note                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------- | ----------------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| `doc-drift`                  | `README.md` after `package.json` and `package-lock.json` changes          | `needs_judgment`  | doc intent                | Package churn may affect install/usage docs, but the analyzer needs the cited README claim.               |
| `doc-drift`                  | `docs/COMMAND_REFERENCE.md` after `package.json` changes                  | `needs_judgment`  | doc intent                | Command reference may not need updates for package metadata changes; needs cited command/option evidence. |
| `similar`                    | `renderCapabilities` vs `handleConfigValidate`                            | `accepted_design` | command-handler allowlist | Both use command option/json envelope plumbing, but command handlers are intentionally parallel.          |
| `similar`                    | `handleDoctor` vs `handleStatus`                                          | `accepted_design` | command-handler allowlist | Shared CLI report pattern is useful consistency, not a direct extraction target by itself.                |
| `similar`                    | `handleConfigValidate` vs `handleSuppress`                                | `accepted_design` | command-handler allowlist | Shared CLI scaffolding differs in validation and mutation behavior.                                       |
| `health`/`diff-gate` anchors | `health`, `diffGate`, `queryCommandOrder`, and `DIFF_GATE_CHECKS` resolve | `tp`              | none                      | Source anchors used by the ledger still resolve to current code.                                          |

Self-check calibration:

- `similar` should downweight command-handler boilerplate unless shared domain logic appears below the command-shell layer.
- `doc-drift` should expose the exact referenced claim or path before it is treated as a direct stale-doc finding.

## Dead Output Contract Verdicts

| Repository          | Observation                                                      | Verdict | Precision action | Review note                                                                                     |
| ------------------- | ---------------------------------------------------------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `scip-query`        | `deadCodeCount` 0, `shown.deadCode` empty, `symbols.length` 665  | `tp`    | output schema    | The analyzer found no dead code, but raw JSON invites consumers to miscount file-internal data. |
| `Stable_Management` | `deadCodeCount` 0, `shown.deadCode` empty, `symbols.length` 1211 | `tp`    | output schema    | Same contract issue as `scip-query`; verdict counting must not use `symbols.length`.            |

Output-contract calibration:

- Rename or split `symbols` so machine consumers can distinguish `dead` from file-internal inventory.
- Add a top-level `counts` object with `dead`, `fileInternal`, and `shown` fields.
- Keep `dead --only-dead` faithful to dead-only output when `--json` is used, or name the extra inventory explicitly.

## Calibration Actions

1. Add grouping to `echo`/baseline output so repeated pairwise duplicates produce one root cause.
2. Add semantic containment checks to `incomplete-migration`; shared callee fingerprints are not enough.
3. Add a type-assertion or compile-time-contract filter to `new-dead`.
4. Add boundary-role evidence to `wrapper-candidates` and reduce score weight for single-caller boundary helpers.
5. Split similarity scoring into framework scaffolding, access/query scaffolding, and domain-specific behavior.
6. Keep `co-change` as support signal, with stronger promotion for doc/code, schema/script, and model/view pairs.
7. Split Vue large-view pressure by template, script, style, and external script; map each pressure kind to a different recommendation.
8. Improve `doc-drift` and `doc-reference` output with cited-claim or citation-kind evidence.
9. Clarify `dead --only-dead --json` so file-internal inventory is not mistaken for dead-code findings.

## Ledger Impact

- AVL-002 remains `running`: direct analyzer verdicts now have first-pass evidence, but the precision actions need implementation plans and second-repo confirmation.
- AVL-003 remains `running`: contextual analyzer verdicts now support lower direct score weight for wrappers/similarity and higher support value for co-change.
- AVL-006 should begin after these verdicts are reviewed: score calibration now has evidence that direct and contextual findings need separate weights.
- AVL-007 should begin after these verdicts are reviewed: output schema and evidence-field gaps are now explicit.
- AVL-012 remains `running`: Vue pressure results validate the locality-analyzer idea, especially pressure-kind split and route/page filters.
