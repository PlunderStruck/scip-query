# React Pressure-Kind Output Result

Date: 2026-06-21

## Scope

This slice implements the React large-component calibration action: the detector should not only say "large React component"; it should expose the pressure kind, component context, and review recommendation.

Implemented changes:

- `ReactLargeComponentPressureResult` now includes `pressureKinds`.
- `ReactLargeComponentPressureResult` now includes `contextKind: 'component' | 'route-page'`.
- `ReactLargeComponentPressureResult` now includes `recommendationKind`.
- `ReactLargeComponentPressureResult` now includes `recommendation`.
- `react-large-component-pressure` text output prints context, pressure kinds, and recommendation.
- Route/page classification distinguishes routed screens from route-local components such as dialogs, modals, cards, panels, rails, and tables.

## Regression Coverage

Updated `tests/queries/frontend/react-frontend-rich-internals.test.ts`:

- Normal component pressure now asserts `pressureKinds`, `contextKind`, `recommendationKind`, and recommendation text.
- A generated `src/pages/AccountPage.tsx` fixture asserts route/page context.
- Generated route-local component fixtures under `src/routes/account/components/AccountModal.tsx` and `src/routes/account/AccountDialog.tsx` assert component context rather than route/page context.

## Vega Smoke

Repository: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
Revision: `6288855333faf33ba395fa804eb9b03c0a04989e`

Raw output:

- `/tmp/scip-query-validation/2026-06-21-pilot/Vega_2.0/react-pressure-kind-output/react-large-component-pressure-full.json`

Command:

```text
node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js react-large-component-pressure --full --json
```

Result:

- Total rows: 248
- Dominant pressure: `jsx-structure` 147, `file` 101
- Pressure kinds: `jsx-structure` 246, `file` 9
- Contexts: `component` 220, `route-page` 28
- Recommendation kinds: `jsx-decomposition` 218, `route-page-decomposition` 28, `file-decomposition` 2

Top sample rows now separate routed pages from route-local UI components:

| File | Component | Dominant | Pressure kinds | Context | Recommendation kind |
| --- | --- | --- | --- | --- | --- |
| `apps/web/src/routes/legal/TermsOfService.tsx` | `TermsOfService` | `jsx-structure` | `jsx-structure` | `route-page` | `route-page-decomposition` |
| `apps/web/src/routes/landing/BetaApplicationPage.tsx` | `BetaApplicationPage` | `jsx-structure` | `jsx-structure` | `route-page` | `route-page-decomposition` |
| `apps/web/src/components/integrations/IntegrationCard.tsx` | `IntegrationCard` | `file` | `jsx-structure` | `component` | `jsx-decomposition` |
| `apps/web/src/components/coding-agents/ProjectAgentSettings.tsx` | `ProjectAgentSettings` | `file` | `jsx-structure` | `component` | `jsx-decomposition` |
| `apps/web/src/routes/proposals/components/CreateProjectModal.tsx` | `CreateProjectModal` | `file` | `jsx-structure` | `component` | `jsx-decomposition` |
| `apps/web/src/routes/proposals/SessionShareDialog.tsx` | `SessionShareDialog` | `jsx-structure` | `jsx-structure` | `component` | `jsx-decomposition` |

## Verification

Commands run successfully:

- `npx vitest run tests/queries/frontend/react-frontend-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js react-large-component-pressure --json --limit 5`
- Vega `react-large-component-pressure --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`

`node dist/cli.js diff-gate --json` still exits 1 with the same two accepted warning findings:

- `echo` on `isCompileTimeContractAssertion()` remains a signal-only shared `leafName`/`leafSuffix` call pattern with `indexedDefinitionFromRow()`.
- `doc-reference` on `README.md` remains accepted because the citation is a declared-coupling config example, not stale documentation about the dead output contract.

`npm test` still prints a noisy `git diff` usage warning from an existing test path, but Vitest reports all 312 tests passed.

## Judgment

Confirmed. React large-component pressure now has structured pressure-kind output and review recommendations. Vega's output is now more actionable: most rows are JSX decomposition review, true route/page rows remain visible, and route-local UI components no longer get mislabeled as page orchestration.

## Next Action

Continue the next contextual calibration slice: Rust/general-domain wrapper boundary vocabulary.
