# Vue Pressure-Kind Output Plan

Date: 2026-06-21

## Purpose

A Vue pressure kind is the part of a Vue single-file component whose size creates the review concern: template markup, script behavior, style rules, an external script module, a custom block, or total file size. Its real-world referents are concrete line-count concentrations in `.vue` files and linked external script files; its essential role is to turn "large view" from one vague warning into a specific review direction.

A route/page context is a Vue file that represents a routed screen, page, or view rather than a small reusable component. Its real-world referents are files under route/page/view folders or files named like `*View.vue` or `*Page.vue`; its essential role is to tell reviewers when orchestration should be separated from panels/controllers instead of blindly extracting a generic component or composable.

## Code Anchors

- `node dist/cli.js plan-context vueLargeViewPressure` resolves `vueLargeViewPressure()` at `src/queries/frontend/vue-large-view-pressure.ts:21-59`, `VueLargeViewPressureResult` at `src/queries/frontend/vue-large-view-pressure.ts:6-19`, and the CLI handler at `src/runtime/query-commands/cleanup/handlers.ts:479`.
- `node dist/cli.js code vueLargeViewPressure -C 14` shows the detector already has total, SFC, template, script, style, external-script, custom-block, and dominant-pressure measurements.
- `sed -n '470,515p' src/runtime/query-commands/cleanup/handlers.ts` shows text output currently prints dominant pressure and block counts, but no recommendation kind.
- `tests/queries/frontend/vue-template-rich-internals.test.ts` already exercises external-script pressure through `SharedBehaviorExternal.vue`.
- `docs/validation/2026-06-21-analyzer-calibration-memo.md` records the Stable_Management finding: default threshold returns zero, `--min-total-lines 300` returns useful review rows, and recommendations need pressure-kind separation.

## Steps

1. Extend `VueLargeViewPressureResult` additively.
   - Add `pressureKinds: VueLargeViewPressureAxis[]`.
   - Add `contextKind: 'route-page' | 'component'`.
   - Add `recommendationKind`.
   - Add `recommendation`.

2. Compute pressure kinds from existing measurements.
   - Include threshold-crossing total/template/script/style axes.
   - Include external-script/custom-block when they dominate or independently cross the script threshold.
   - Keep `dominantPressure` for backward compatibility.

3. Emit recommendation kinds.
   - Template: component/template decomposition.
   - Script: behavior/controller/composable extraction.
   - Style: UI/style decomposition, not composable extraction.
   - External script: external controller/module boundary review.
   - Route/page: route orchestration split when route-like context dominates.
   - Total/custom-block: general review or custom-block ownership review.

4. Add review-mode threshold support without changing health scoring.
   - Add a CLI-only `--review-thresholds` flag for `vue-large-view-pressure`.
   - Use `minTotalLines = 300` when the flag is present and the user does not provide `--min-total-lines`.
   - Leave `health()` defaults unchanged.

5. Update output and tests.
   - Render context, pressure kinds, and recommendation in text output.
   - Keep JSON additive through the result shape.
   - Extend the existing Vue fixture test to assert external-script pressure kind and recommendation.

## Verification

- `npx vitest run tests/queries/frontend/vue-template-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js vue-large-view-pressure --review-thresholds --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- The result shape changes add fields only; existing `dominantPressure`, `reasons`, and block counts remain stable.
- `--review-thresholds` affects only the explicit command, not health scoring or default hygiene score thresholds.

## Result

Completed. See `docs/validation/2026-06-21-vue-pressure-kind-output-result.md`.
