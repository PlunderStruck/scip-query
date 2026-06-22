# React Pressure-Kind Output Plan

Date: 2026-06-21

## Purpose

A React pressure kind is the concrete part of a React component that creates the review concern: component size, whole-file size, JSX structure, or hook-driven behavior. Its real-world referents are line-count and token-count concentrations in `.jsx` and `.tsx` components; its essential role is to turn "large component" from a size warning into a specific review direction.

A React component context is whether the file behaves like a routed page/screen or like a reusable component. Its real-world referents are files under page, route, screen, or view folders and components named like pages or views; its essential role is to keep reviewers from treating route orchestration as the same problem as reusable component extraction.

## Code Anchors

- `node dist/cli.js plan-context reactLargeComponentPressure` resolves `reactLargeComponentPressure()` at `src/queries/frontend/react-large-component-pressure.ts:18-56`, `ReactLargeComponentPressureResult` at `src/queries/frontend/react-large-component-pressure.ts:6-16`, and the CLI handler at `src/runtime/query-commands/cleanup/handlers.ts:396`.
- `node dist/cli.js code reactLargeComponentPressure -C 12` shows the detector already has component LOC, file LOC, JSX token, behavior token, and dominant-pressure measurements.
- `sed -n '360,460p' src/runtime/query-commands/cleanup/handlers.ts` shows text output currently prints dominant pressure and counts, but no context or recommendation.
- `tests/queries/frontend/react-frontend-rich-internals.test.ts` already exercises React large-component pressure through the `IssuePanel` and `LargeDashboard` fixtures.
- `docs/validation/2026-06-21-rust-wrapper-react-pressure-review.md` records the second-repo finding: Vega's React pressure output is useful but still needs pressure-kind, context, and recommendation fields like Vue.

## Steps

1. Extend `ReactLargeComponentPressureResult` additively.
   - Add `pressureKinds: ReactLargeComponentPressureAxis[]`.
   - Add `contextKind: 'component' | 'route-page'`.
   - Add `recommendationKind`.
   - Add `recommendation`.

2. Compute pressure kinds from existing measurements.
   - Include threshold-crossing component, file, JSX, and behavior axes.
   - Keep `dominantPressure` for backward compatibility.
   - Include the dominant axis when total/file size is the trigger so JSON explains what made the large file large.

3. Emit recommendation kinds.
   - JSX structure: presentational decomposition.
   - Hook behavior: hook/controller extraction.
   - File size: file-level split before changing behavior.
   - Route/page context: route orchestration split.
   - Component size: component boundary review.

4. Update output and tests.
   - Render context, pressure kinds, and recommendation in text output.
   - Keep JSON additive through the result shape.
   - Extend the existing React fixture test to assert pressure kind and recommendation fields.

## Verification

- `npx vitest run tests/queries/frontend/react-frontend-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js react-large-component-pressure --json --limit 5`
- Vega `react-large-component-pressure --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- The result shape changes add fields only; existing counts, reasons, and `dominantPressure` remain stable.
- Recommendation wording is intentionally review-oriented rather than auto-fix-oriented because large UI components often mix legitimate page layout with extractable local panels.

## Result

Completed. See `docs/validation/2026-06-21-react-pressure-kind-output-result.md`.
