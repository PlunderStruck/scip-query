---
name: scip-vue-maintainability
description: Review Vue maintainability with scip-query. Use for Vue, Nuxt, SFCs, duplicated templates, composable candidates, large views, frontend health pressure, or verifying Vue reuse after refactors.
commands:
  - template: 'scip-query augment-vue --project <path-to-tsconfig>'
    when: 'Bound and augment: add compiler-resolved Vue SFC references first.'
  - template: 'scip-query vue-component-duplicates --scope <scope> --full --json'
    when: 'Scan: duplicated template structure candidates.'
  - template: 'scip-query vue-composable-candidates --scope <scope> --full --json'
    when: 'Scan: shared state/lifecycle extraction candidates.'
  - template: 'scip-query vue-large-view-pressure --scope <scope> --full --json'
    when: 'Scan: SFCs carrying several reasons to change.'
  - template: 'scip-query recent-duplicates --scope <scope> --full --json'
    when: 'Scan: recent code re-implementing established components.'
  - template: 'scip-query health --json'
    when: 'Scan: frontend health pressure baseline.'
---

# scip-vue-maintainability

Use this skill to review Vue frontends as maintainable systems of single-file components, templates, scripts, styles, external scripts, components, and composables.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query augment-vue --project <path-to-tsconfig>` | Add compiler-resolved Vue SFC references to the SQLite index using Volar | Vue augmentation counts, project, and diagnostics | `complete` | Bound and augment: add compiler-resolved Vue SFC references first. |
| `scip-query vue-component-duplicates --scope <scope> --full --json` | Find heuristic duplicated Vue component structure candidates from template tags, bindings, slots, and directives | component pairs with structural similarity evidence | `bounded` | Scan: duplicated template structure candidates. |
| `scip-query vue-composable-candidates --scope <scope> --full --json` | Find heuristic Vue composable extraction candidates from shared state, effects, requests, and template bindings | component groups and shared composable-shaped behavior | `bounded` | Scan: shared state/lifecycle extraction candidates. |
| `scip-query vue-large-view-pressure --scope <scope> --full --json` | Find heuristic large Vue view pressure candidates from template, script, style, and external script line counts | view identities with size and responsibility pressure | `bounded` | Scan: SFCs carrying several reasons to change. |
| `scip-query recent-duplicates --scope <scope> --full --json` | Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code | recent and established symbol pairs with similarity evidence | `bounded` | Scan: recent code re-implementing established components. |
| `scip-query health --json` | Composite codebase health report with prioritized action list | health score, findings, priorities, baselines, and coverage notes | `bounded` | Scan: frontend health pressure baseline. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Terms

A Vue component duplicate candidate is a pair or group of rendered structures that repeat the same user-facing arrangement, controls, states, or data-presentation shape enough that a shared component may reduce drift.

A Vue composable candidate is a pair or group of script behaviors that repeat the same state lifecycle, effects, requests, validation, persistence, or derived-data policy enough that a shared composable may preserve behavior better.

Large view pressure means one SFC or linked view file contains several kinds of knowledge that change for different reasons.

## Workflow

### 1. Bound and augment

Pick the narrowest Vue source root, feature area, or changed-file scope that still includes likely reuse partners. When component references, imported composables, script blocks, or linked external scripts matter, run:

```bash
scip-query augment-vue --project <path-to-tsconfig>
```

This step is complete only when the review scope and augmentation decision are recorded.

### 2. Scan

Run uncapped commands:

```bash
scip-query vue-component-duplicates --scope <scope> --full --json
scip-query vue-composable-candidates --scope <scope> --full --json
scip-query vue-large-view-pressure --scope <scope> --full --json
scip-query recent-duplicates --scope <scope> --full --json
scip-query health --json
```

This step is complete only when command scope, counts, and uncapped/full status are recorded.

### 3. Cross-check candidates

- Component duplicate only: inspect for shared presentational component or existing component reuse.
- Composable candidate only: inspect for shared lifecycle, request, validation, persistence, event, or derived-state policy.
- Both: inspect for a feature-level concept needing both component and composable boundaries.
- Large view only: split by reason to change, not by line count.

Use:

```bash
scip-query outline <file>
scip-query deps <file>
scip-query rdeps <file>
scip-query similar-files --scope <scope>
scip-query recent-duplicates --scope <scope> --full --json
```

This step is complete only when each top candidate is reuse, extract, split, skip, or blocked.

### 4. Act and verify

Prefer reuse before extraction. Extract components for repeated template structure, props, slots, states, or design-system composition. Extract composables for repeated state, lifecycle, requests, validation, persistence, derived data, or event policy. Keep essential variation at the call site.

Invoke `scip-verify` and use its authoritative postcheck table, including the applicable Vue, extraction, duplicate, parameter, wrapper, passthrough, and stale-abstraction checks.

The work is complete only when acted-on candidate pairs disappear, weaken materially, or are explicitly accepted as essential variation.

## False Positive Checks

Shared design-system primitives, CSS utilities, icons, labels, or test IDs are not enough. Similar templates with different domain lifecycles may justify a presentational component but not a composable. A large style block is pressure, not proof.

## Report

Report executive read, command evidence, candidate groups, recommended action, post-change proof, and remaining accepted variation.
