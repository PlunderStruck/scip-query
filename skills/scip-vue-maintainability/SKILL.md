---
name: scip-vue-maintainability
description: Review Vue maintainability with scip-query. Use for Vue, Nuxt, SFCs, duplicated templates, composable candidates, large views, frontend health pressure, or verifying Vue reuse after refactors.
---

# scip-vue-maintainability

Use this skill to review Vue frontends as maintainable systems of single-file components, templates, scripts, styles, external scripts, components, and composables.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

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

Run routed postchecks from the shared reference, including Vue commands, `incomplete-migration`, `recent-duplicates`, `unused-params`, and wrapper/passthrough/stale checks, then invoke `scip-verify`.

The work is complete only when acted-on candidate pairs disappear, weaken materially, or are explicitly accepted as essential variation.

## False Positive Checks

Shared design-system primitives, CSS utilities, icons, labels, or test IDs are not enough. Similar templates with different domain lifecycles may justify a presentational component but not a composable. A large style block is pressure, not proof.

## Report

Report executive read, command evidence, candidate groups, recommended action, post-change proof, and remaining accepted variation.
