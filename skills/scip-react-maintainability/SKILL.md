---
name: scip-react-maintainability
description: Review React maintainability with scip-query. Use for React, TSX, JSX, Next.js, duplicated components, hook candidates, large components, frontend health pressure, or verifying reuse after refactors.
commands:
  - template: 'scip-query react-component-duplicates --scope <scope> --full --json'
    when: 'Bound and scan: duplicated JSX structure candidates.'
  - template: 'scip-query react-hook-candidates --scope <scope> --full --json'
    when: 'Bound and scan: shared state/effect/request extraction candidates.'
  - template: 'scip-query react-large-component-pressure --scope <scope> --full --json'
    when: 'Bound and scan: components carrying several reasons to change.'
  - template: 'scip-query recent-duplicates --scope <scope> --full --json'
    when: 'Bound and scan: recent code re-implementing established components.'
  - template: 'scip-query similar <closest-existing-component-or-hook>'
    when: 'Cross-check candidates: existing component or hook to reuse instead.'
  - template: 'scip-query health --scope <scope> --json'
    when: 'Bound and scan: frontend health pressure for the scope.'
---

# scip-react-maintainability

Use this skill to review React frontends as maintainable systems of components, hooks, JSX structure, and behavior lifecycles.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query react-component-duplicates --scope <scope> --full --json` | Find heuristic duplicated React component structure candidates from JSX tags, props, events, and bindings | component pairs with structural similarity evidence | `bounded` | Bound and scan: duplicated JSX structure candidates. |
| `scip-query react-hook-candidates --scope <scope> --full --json` | Find heuristic React hook extraction candidates from shared state, effects, requests, and handlers | component groups and shared hook-shaped behavior | `bounded` | Bound and scan: shared state/effect/request extraction candidates. |
| `scip-query react-large-component-pressure --scope <scope> --full --json` | Find heuristic large React component pressure candidates from component lines, JSX structure, and hook behavior | component identities with size and responsibility pressure | `bounded` | Bound and scan: components carrying several reasons to change. |
| `scip-query recent-duplicates --scope <scope> --full --json` | Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code | recent and established symbol pairs with similarity evidence | `bounded` | Bound and scan: recent code re-implementing established components. |
| `scip-query similar <closest-existing-component-or-hook>` | Find heuristic function similarity candidates from callee fingerprints | symbol pairs, similarity scores, and shared evidence | `bounded` | Cross-check candidates: existing component or hook to reuse instead. |
| `scip-query health --scope <scope> --json` | Composite codebase health report with prioritized action list | health score, findings, priorities, baselines, and coverage notes | `bounded` | Bound and scan: frontend health pressure for the scope. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Terms

A React component duplicate candidate is a pair or group of rendered structures that repeat the same user-facing arrangement, controls, states, props, or data-presentation shape enough that a shared component may reduce drift.

A React hook candidate is a pair or group of component behaviors that repeat the same state lifecycle, effects, requests, validation, persistence, callback policy, or derived-data rule enough that a shared hook may preserve behavior better.

Large component pressure means one component or file contains several kinds of knowledge that change for different reasons.

## Workflow

### 1. Bound and scan

Pick the narrowest React source root, feature area, or changed-file scope that still includes likely reuse partners. Run uncapped commands:

```bash
scip-query react-component-duplicates --scope <scope> --full --json
scip-query react-hook-candidates --scope <scope> --full --json
scip-query react-large-component-pressure --scope <scope> --full --json
scip-query recent-duplicates --scope <scope> --full --json
scip-query health --scope <scope> --json
```

This step is complete only when command scope, counts, and uncapped/full status are recorded.

### 2. Cross-check candidates

- Component duplicate only: inspect for shared presentational component or existing component reuse.
- Hook candidate only: inspect for shared behavior, lifecycle, request, validation, persistence, or derived-state policy.
- Both: inspect for a feature-level concept needing both component and hook boundaries.
- Large component only: split by reason to change, not by line count.

Use:

```bash
scip-query outline <file>
scip-query deps <file>
scip-query rdeps <file>
scip-query similar-files --scope <scope>
scip-query similar <closest-existing-component-or-hook>
```

This step is complete only when each top candidate is reuse, extract, split, skip, or blocked.

### 3. Act on findings

Prefer reuse before extraction. Extract components for repeated UI structure, states, props, slots/children, or design-system composition. Extract hooks for repeated state, effects, requests, subscriptions, memoized derivations, callbacks, or persistence. Keep domain-specific variation at call sites when essential.

This step is complete only when the chosen action reduces future drift without creating boolean-soup APIs or wrapper components with no policy.

### 4. Verify

Invoke `scip-verify` and use its authoritative postcheck table, including the applicable React, extraction, duplicate, parameter, wrapper, passthrough, and stale-abstraction checks.

The work is complete only when acted-on candidate pairs disappear, weaken materially, or are explicitly accepted as essential variation.

## False Positive Checks

Shared design-system primitives, icons, labels, route names, or test IDs are not enough. Similar JSX with different domain lifecycles may justify a presentational component but not a hook. A large file is review pressure, not proof of duplication.

## Report

Report executive read, command evidence, candidate groups, recommended action, post-change proof, and remaining accepted variation.
