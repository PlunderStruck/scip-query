# Vue Pressure-Kind Output Result

Date: 2026-06-21

## Scope

This slice implements the Vue large-view calibration action: the detector should not only say "large Vue view"; it should expose the kind of pressure and a matching review recommendation.

Implemented changes:

- `VueLargeViewPressureResult` now includes `pressureKinds`.
- `VueLargeViewPressureResult` now includes `contextKind: 'component' | 'route-page'`.
- `VueLargeViewPressureResult` now includes `recommendationKind`.
- `VueLargeViewPressureResult` now includes `recommendation`.
- `vue-large-view-pressure` text output prints context, pressure kinds, and recommendation.
- The CLI adds `--review-thresholds`, which uses the pilot's 300-line review threshold for the command while leaving health defaults unchanged.
- `docs/COMMAND_REFERENCE.md` was regenerated from descriptors.

## Regression Coverage

Updated `tests/queries/frontend/vue-template-rich-internals.test.ts`:

- External-script pressure now asserts `pressureKinds`, `contextKind`, `recommendationKind`, and recommendation text.
- A generated `src/views/LandingView.vue` fixture asserts route/page context and route-template recommendation text.

## Stable_Management Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Stable_Management`
Revision: `2354b4e385088aa90559c20ea8b270f14bfa47f3`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Stable_Management/vue-pressure-kind/review-thresholds-full-final.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js vue-large-view-pressure --full --review-thresholds --json
```

Result:

- Total review rows: 59
- `script-behavior-extraction`: 6
- `style-decomposition`: 32
- `template-decomposition`: 16
- `external-script-boundary`: 4
- `route-page-decomposition`: 1

Top sample rows now include actionable pressure kinds:

| File                                                                                     | Dominant         | Pressure kinds                 | Context      | Recommendation kind          |
| ---------------------------------------------------------------------------------------- | ---------------- | ------------------------------ | ------------ | ---------------------------- |
| `StableDocumentsPanel.vue`                                                               | `script`         | `total`, `script`              | `component`  | `script-behavior-extraction` |
| `FilterSortMenu.vue`                                                                     | `style`          | `total`, `style`               | `component`  | `style-decomposition`        |
| `BookingMonthCalendar.vue`                                                               | `style`          | `total`, `style`               | `component`  | `style-decomposition`        |
| `AccountActionsView.vue`                                                                 | `style`          | `total`, `style`               | `route-page` | `style-decomposition`        |
| `LandingView.vue`                                                                        | `template`       | `total`, `template`            | `route-page` | `template-decomposition`     |
| `OrganizationView.vue`                                                                   | `external-script` | `total`, `external-script`     | `route-page` | `external-script-boundary`   |

## Verification

Commands run successfully:

- `npx vitest run tests/queries/frontend/vue-template-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js vue-large-view-pressure --review-thresholds --json --limit 5`
- Stable_Management `vue-large-view-pressure --full --review-thresholds --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with the same two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

## Judgment

Confirmed. Vue large-view pressure now has structured pressure-kind output and review-mode thresholds. Style-heavy files route to style/UI decomposition, external-script files route to module-boundary review, and route/page context is visible without changing health scoring.

## Next Action

Continue the next contextual calibration slice: similarity evidence split.
