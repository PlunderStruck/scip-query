---
name: scip-vue-maintainability
description: Vue frontend maintainability review using scip-query's Vue SFC, template-duplicate, composable-candidate, large-view, and health commands. Use when reviewing Vue or Nuxt codebases, investigating duplicated components or composables, checking frontend health score pressure, or asking whether agents are reusing Vue code correctly.
allowed-tools: [Bash, Read, Grep, Glob]
---

# SCIP Vue Maintainability Review

This skill reviews Vue frontends by treating `.vue` single-file components as first-class code units. It uses `scip-query` evidence to decide where templates, scripts, styles, external scripts, components, and composables are carrying duplicated concepts or too many reasons to change.

A Vue component duplicate candidate is a pair or group of rendered interface structures that repeat the same user-facing arrangement, controls, states, or data-presentation shape enough that a shared component may reduce future divergence.

A Vue composable candidate is a pair or group of script behaviors that repeat the same state lifecycle, effects, requests, validation, persistence, or derived-data policy enough that a shared composable may make the behavior easier to preserve.

Large view pressure is a maintainability signal that one SFC or linked view file contains several kinds of knowledge that change for different reasons, such as layout structure, state management, data loading, styling, and feature policy.

Vue health is a repo-grounded frontend pressure map. It is useful for ranking review attention, but it is not proof that code is bad and not the goal of a refactor.

## Quick Start

Refresh the code intelligence before trusting graph facts:

```bash
scip-query status
scip-query reindex
```

If Vue files need rich internals, find the relevant TypeScript project and augment the index:

```bash
find . -name 'tsconfig*.json' -not -path '*/node_modules/*'
scip-query augment-vue --project <path-to-tsconfig>
```

Run the Vue review commands uncapped when doing a serious frontend pass. Do not combine `--full` with `--limit`.

```bash
scip-query vue-component-duplicates --scope <vue-source-scope> --full --json
scip-query vue-composable-candidates --scope <vue-source-scope> --full --json
scip-query vue-large-view-pressure --scope <vue-source-scope> --full --json
scip-query health --full --json
```

## Workflow

1. Bound the review to a Vue source root, feature area, or changed files. Prefer the narrowest scope that still includes likely reuse partners.
2. Run `augment-vue` when component references, imported composables, script blocks, or linked external scripts matter to the question.
3. Run the three Vue commands: component duplicates, composable candidates, and large view pressure.
4. Cross-check the result sets before recommending an extraction:
   - Component duplicate only: inspect for a shared presentational component or an existing component that callers should reuse.
   - Composable candidate only: inspect for a shared behavior, lifecycle, request pattern, validation rule, persistence rule, or derived-state policy.
   - Both component and composable candidate: inspect for a feature-level concept that may need both a component boundary and a composable boundary.
   - Large view only: split by reason to change, not by line count alone.
5. Open the source files for the top candidates. Similarity is evidence to inspect, not a verdict.
6. Check existing exports, imports, and call sites before proposing anything new:

```bash
scip-query outline <file>
scip-query deps <file>
scip-query rdeps <file>
scip-query similar-files --scope <vue-source-scope>
scip-query recent-duplicates --scope <vue-source-scope> --full --json
```

## Acting on Findings

Prefer reuse before extraction. If an existing component or composable already names the concept, migrate callers to it instead of creating another one.

When extracting:

- Extract a component when the repeated knowledge is rendered template structure, props, slots, empty/loading/error states, or design-system composition.
- Extract a composable when the repeated knowledge is state, lifecycle, requests, validation, persistence, derived data, or shared event policy.
- Split a large view by reason to change: data loading, permission/policy, layout shell, table/list rendering, form state, and action handling are different reasons.
- Keep domain-specific variation at the call site when the variation is essential. Do not hide different product rules behind broad option objects.

## Post-Change Verification

After implementing a component reuse, composable extraction, or large-view split, prove both sides of the work: the new abstraction exists and the old inline copies were migrated.

Run the checks that match what changed:

```bash
scip-query diff-impact
scip-query vue-component-duplicates --scope <vue-source-scope> --full --json
scip-query vue-composable-candidates --scope <vue-source-scope> --full --json
scip-query vue-large-view-pressure --scope <vue-source-scope> --full --json
scip-query recent-duplicates --scope <vue-source-scope> --full --json
scip-query incomplete-migration
scip-query unused-params
scip-query wrapper-candidates --scope <vue-source-scope> --full --json
scip-query passthrough-candidates --scope <vue-source-scope> --full --json
scip-query stale-abstractions --scope <vue-source-scope> --include-low-confidence --full --json
scip-query reindex && scip-query diff-gate
```

Use the results this way:

- `incomplete-migration`: if a new composable/helper was created and wired somewhere, migrate every unchanged site that still contains the same logic or document why it is not the same behavior.
- `recent-duplicates`: if the new component/composable is still an echo of established code, delete the echo or reuse the established concept.
- Vue duplicate commands: the specific candidate pair you acted on should disappear, weaken materially, or be explicitly accepted as essential variation.
- `unused-params`: remove speculative props/options introduced "for later."
- wrapper/pass-through/stale checks: remove local wrapper components, composable aliases, or type abstractions that do not enforce a real policy.
- `diff-gate`: treat every finding as unfinished work unless there is a written reason to accept it.

## False Positive Checks

- Shared design-system primitives, CSS utility classes, icons, labels, or test IDs are not enough to justify an extraction.
- Similar templates with different domain lifecycles may justify a presentational component but not a composable.
- Shared composable usage may mean the right concept is already extracted; look for drift around the shared call, not just another extraction.
- A large style block creates review pressure, but it is not proof that behavior is duplicated.
- A local wrapper is justified only when it names a real product concept, enforces a policy, or prevents drift across callers.

## Reporting Shape

Report findings as a frontend maintainability register:

- Executive read: whether the Vue code is consolidating or drifting.
- Command evidence: exact commands, scope, counts, and whether results were uncapped.
- Candidate groups: files, repeated UI structure, repeated behavior, and large-view pressure.
- Recommended extractions: component, composable, view split, reuse existing API, or no action.
- Post-change proof: commands rerun, candidate pairs resolved or accepted, migration completeness checked, and `diff-gate` result.

## Stable Management Calibration

When validating against Stable Management, use these known shapes as calibration examples, not hard-coded rules:

- `IncidentCategoriesPanel.vue` and `RecordLabelsPanel.vue` should read as both component and behavior pressure.
- `CardActionMenu.vue` and `CardStatusMenu.vue` should read as behavior/composable pressure.
- `HorseProfileFarrierVisitsSection.vue` and `HorseProfileVetRecordsSection.vue` should read as component pressure without forcing a composable.
- `InventoryView.vue` and `FacilityBookingView.vue` should count linked external script pressure when measuring large views.
