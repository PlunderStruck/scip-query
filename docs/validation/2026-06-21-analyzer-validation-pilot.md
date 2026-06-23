# Analyzer Validation Pilot Run

Date: 2026-06-21

Raw output root:

```text
/tmp/scip-query-validation/2026-06-21-pilot
```

This is the first execution slice from `docs/plans/2026-06-21-analyzer-validation-pilot.md`. It started the validation work; the first-pass human verdict review is now complete.

Verdict review is recorded in `docs/validation/2026-06-21-analyzer-verdict-review.md`. That file reviews 68 rows from this pilot and records first-pass verdicts, calibration actions, and ledger impact.

Score and output calibration is recorded in `docs/validation/2026-06-21-analyzer-calibration-memo.md`.

## Scope

Pilot repositories:

- `/Users/aydansalois/Documents/GitHub/scip-query`
- `/Users/aydansalois/Documents/GitHub/Stable_Management`

Pilot analyzers:

- Direct repair candidates: `dead --only-dead`, `unused-params`, `passthrough-candidates`, `doc-drift`
- Contextual signals: `similar`, `wrapper-candidates`, `co-change`
- Vue-specific signals on Stable_Management: `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`

Source anchors:

- `scip-query code health --json` -> `src/queries/health/health.ts:194`
- `scip-query code diffGate --json` -> `src/queries/impact/diff-gate.ts:94`
- `scip-query trace queryCommandOrder --json` -> `src/runtime/commands/query-command-specs.ts:9`
- `scip-query trace DIFF_GATE_CHECKS --json` -> `src/queries/impact/diff-gate.ts:27`

2026-06-22 note: `queryCommandOrder` remains the correct public-command anchor after the `locality-candidates` implementation; the command list now includes that contextual analyzer.

2026-06-22 note: `src/queries/health/health.ts` remains the composite health implementation anchor after health became full-by-default. This pilot's historical raw commands are unchanged.

## Command Status

| Repository          | Revision                                   | Baseline status                                                                                        | Analyzer status                                                                             |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `scip-query`        | `7aa69e4c6701c04213106c803ce2c4a9e167ccec` | `revision`, `reindex`, `health`, `diff-gate`, and `capability-matrix` exited 0.                        | All selected analyzer commands exited 0.                                                    |
| `Stable_Management` | `2354b4e385088aa90559c20ea8b270f14bfa47f3` | `revision`, `reindex`, `health`, and `capability-matrix` exited 0. `diff-gate` exited 1 with findings. | All selected analyzer commands exited 0, including the threshold-edge Vue large-view probe. |

Stable_Management had a dirty working tree before validation, with many modified and untracked files. Its diff-gate result is therefore a validation of current-diff behavior, not a clean-repository baseline.

## Baseline Results

| Repository          | Health                                                          | Diff gate                                                   |
| ------------------- | --------------------------------------------------------------- | ----------------------------------------------------------- |
| `scip-query`        | score 100, risk 100, hygiene 100, no score breakdown deductions | exit 0; 5 changed files, 0 changed symbols, 0 findings      |
| `Stable_Management` | score 95, risk 95, hygiene 96                                   | exit 1; 53 changed files, 401 changed symbols, 121 findings |

Stable_Management health deductions:

- `similar`: -1 point for 109 similar function pairs.
- `wrappers`: -3 points for 48 wrapper candidates.
- `hidden-coupling`: -5 points for 22 co-changing pairs without a structural link.
- Warning: large index detected; `--full` ran without candidate scan or result caps.

Stable_Management diff-gate finding distribution:

| Check                  | Findings |
| ---------------------- | -------: |
| `echo`                 |       53 |
| `incomplete-migration` |        1 |
| `co-change-partner`    |        2 |
| `doc-reference`        |       17 |
| `new-dead`             |        1 |
| `baseline`             |       47 |

## Analyzer Output Counts

| Repository          | Analyzer                                                      | Result summary                                                          |
| ------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `scip-query`        | `dead --only-dead --json`                                     | `deadCodeCount` 0; `fileInternalCount` 665; JSON `symbols` length 665   |
| `scip-query`        | `unused-params --json`                                        | 0                                                                       |
| `scip-query`        | `passthrough-candidates --json`                               | 0                                                                       |
| `scip-query`        | `doc-drift --json`                                            | 2 findings                                                              |
| `scip-query`        | `similar --json`                                              | 3 rows                                                                  |
| `scip-query`        | `wrapper-candidates --json`                                   | 0                                                                       |
| `scip-query`        | `co-change --json`                                            | 0 findings                                                              |
| `Stable_Management` | `dead --only-dead --json`                                     | `deadCodeCount` 0; `fileInternalCount` 1211; JSON `symbols` length 1211 |
| `Stable_Management` | `unused-params --json`                                        | 0                                                                       |
| `Stable_Management` | `passthrough-candidates --json`                               | 0                                                                       |
| `Stable_Management` | `doc-drift --json`                                            | 20 findings                                                             |
| `Stable_Management` | `similar --json`                                              | 20 rows                                                                 |
| `Stable_Management` | `wrapper-candidates --json`                                   | 30 results                                                              |
| `Stable_Management` | `co-change --json`                                            | 22 findings                                                             |
| `Stable_Management` | `vue-component-duplicates --full --json`                      | 0                                                                       |
| `Stable_Management` | `vue-composable-candidates --full --json`                     | 0                                                                       |
| `Stable_Management` | `vue-large-view-pressure --full --json`                       | 0                                                                       |
| `Stable_Management` | `vue-large-view-pressure --full --min-total-lines 300 --json` | 59 results                                                              |

## Early Findings

The first run already produced validation work:

1. `dead --only-dead --json` should be reviewed for output-schema clarity. In both repos, `deadCodeCount` is 0, but the JSON still includes file-internal totals and a nonzero `symbols` array. Verdict counting must use `deadCodeCount` and `shown`, not `symbols.length`, until the output contract is clarified.
2. Stable_Management's repo-wide health score is 95 even though the `findings` count object reports zeros for the named health finding buckets. The score breakdown does carry signal-pressure deductions for similarity, wrappers, and hidden coupling. This is a score/reporting calibration item, not necessarily an analyzer bug.
3. Stable_Management's default Vue large-view pressure returned 0, but `--min-total-lines 300` returned 59 results. That is a threshold calibration candidate for `vue-large-view-pressure`.
4. Stable_Management diff-gate produced 121 findings on the current working tree. This is useful for diff-gate validation, but verdict review must account for the active local changes.

## Vue Threshold Probe

Top Stable_Management `vue-large-view-pressure --full --min-total-lines 300` results:

| File                                                                                     | Total | Dominant pressure |
| ---------------------------------------------------------------------------------------- | ----: | ----------------- |
| `frontend/src/features/templates/stable-documents/components/StableDocumentsPanel.vue`   |   690 | script            |
| `frontend/src/shared/workspace/actions/FilterSortMenu.vue`                               |   602 | style             |
| `frontend/src/features/operations/facility-schedule/components/BookingMonthCalendar.vue` |   588 | style             |
| `frontend/src/features/templates/shared/components/template-tree/TemplateTreeNode.vue`   |   586 | style             |
| `frontend/src/features/account/actions/AccountActionsView.vue`                           |   568 | style             |
| `frontend/src/features/horse-care/horse-profile/components/HorseProfileSectionBar.vue`   |   561 | script            |
| `frontend/src/features/marketing/landing/LandingView.vue`                                |   526 | template          |
| `frontend/src/features/organization/organization/OrganizationView.vue`                   |   516 | external-script   |

## Review Queue

Use the verdict template from `docs/analyzer-validation-ledger.md` for the next pass.

First-pass review result:

- Verdict review: `docs/validation/2026-06-21-analyzer-verdict-review.md`
- Calibration memo: `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- Reviewed rows: 68
- Distribution: 28 `tp`, 10 `fp`, 18 `accepted_design`, 12 `needs_judgment`
- Main result: direct cleanup works best for exact tiny helper duplication; wrappers and similarity need stronger action-tier separation; co-change is the strongest contextual signal; Vue large-view pressure needs pressure-kind split.

Completed first-pass samples:

1. Stable_Management diff-gate: review 10 `echo`, 5 `baseline`, 3 `doc-reference`, the 1 `incomplete-migration`, and the 1 `new-dead` finding.
2. Stable_Management contextual signals: review 10 `wrapper-candidates`, 10 `similar`, and 10 `co-change` findings.
3. Stable_Management Vue threshold probe: review the top 8 large-view results above for true pressure, accepted design, and locality implications.
4. scip-query small set: review 2 `doc-drift` findings and 3 `similar` rows.
5. Output contract: record a schema-quality verdict for `dead --only-dead --json`.

The first target was at least 30 reviewed verdicts before changing analyzer thresholds or score weights; this pass reviewed 68 rows. The next step is calibration planning, not threshold changes directly from this pilot.

## 2026-06-23 Citation Refresh

The maintainability-register completion slice rechecked the pilot's diff-gate and query-order citations. `diffGate()` still runs the same check family, with finding construction now normalized by `recordFinding()`. `queryCommandOrder` still starts the public query command surface, and `orderedQueryCommandDescriptors` now exposes that order for CLI registration.

## 2026-06-23 Current Sweep Citation Refresh

The current maintainability sweep rechecked the pilot's `diff-gate.ts` citation after doc-reference and baseline helper policy moved into private modules. The pilot remains a historical validation record: `diffGate()` and `DIFF_GATE_CHECKS` still identify the same diff-gate surface.
