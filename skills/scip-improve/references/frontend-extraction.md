# React/Vue extraction

Use to extract a React hook/component or a Vue composable/component once the
frontend scenario in `scip-audit` has produced confirmed candidate pairs. If
nothing is confirmed yet, run that scenario first, then cross-check, then act.

- A **component duplicate candidate** is a pair or group of rendered structures repeating the same user-facing arrangement, controls, states, props/bindings, or data-presentation shape enough that a shared component may reduce drift.
- A **hook candidate** (React) / **composable candidate** (Vue) is a pair or group of behaviors repeating the same state lifecycle, effects, requests, validation, persistence, or derived-data policy enough that a shared hook/composable may preserve behavior better.
- **Large component/view pressure** means one component, SFC, or linked view file contains several kinds of knowledge that change for different reasons — a large file or style block is pressure, not proof, by itself.

## Scan (only if not already done)

React: `scip-query react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `recent-duplicates`, `health` — all `--scope <scope> --full --json`, uncapped.

Vue: same shape, using `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`. Before scanning, when component references, imported composables, script blocks, or linked external scripts matter, run `scip-query augment-vue --project <path-to-tsconfig>` to add compiler-resolved Vue SFC references via Volar — Vue needs this step; React doesn't.

Record scope, counts, and uncapped/full status.

## Cross-check before acting

Use `scip-query outline <file>`, `deps <file>`, `rdeps <file>`, `similar-files --scope <scope>`, and either `scip-query similar <closest-existing-component-or-hook>` (React) or `scip-query recent-duplicates --scope <scope> --full --json` (Vue) to validate each candidate. Classify every top candidate as reuse, extract, split, skip, or blocked:

- Component-duplicate-only → look for a shared presentational component or existing reuse.
- Hook/composable-candidate-only → look for shared state lifecycle, effects, requests, validation, persistence, or derived-state policy.
- Both overlap → look for a feature-level concept that needs both a component boundary and a hook/composable boundary.
- Large-component/view-only → split by reason to change, not by line count.

## Act

Prefer reuse over extraction. Extract a component for repeated UI/template structure, props, slots/children, states, or design-system composition. Extract a hook for repeated state, effects, requests, subscriptions, memoized derivations, callbacks, or persistence; extract a composable for the Vue equivalent — repeated state, lifecycle, requests, validation, persistence, derived data, or event policy. Keep essential domain-specific variation at the call site.

Don't:
- Create boolean-soup APIs or wrapper components/composables with no policy as a side effect.
- Treat shared design-system primitives, icons, labels, route names, test IDs, or CSS utilities alone as sufficient evidence for a duplicate/hook/composable claim.
- Extract a shared hook or composable from templates that merely look similar but carry different domain lifecycles — that similarity may justify a shared presentational component, never a shared hook/composable.

## Verify and report

Invoke `scip-verify` and run its React or Vue postcheck rows, plus the applicable extraction, duplicate, parameter, wrapper, passthrough, and stale-abstraction checks. Work is complete only when the acted-on candidate pairs disappear, weaken materially, or are explicitly accepted as essential variation. Report: executive read, command evidence, candidate groups, recommended action taken, post-change proof, and remaining accepted variation.
