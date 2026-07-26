# React and Vue maintainability

Reviews React and Vue frontends as maintainable systems: React as
components, hooks, JSX structure, and behavior lifecycles; Vue as single-file
components, templates, scripts, styles, external scripts, components, and
composables. Both follow the same four-step workflow below; framework-
specific commands and definitions are called out per step.

## Definitions

- **Component duplicate candidate** (React or Vue) — a pair or group of
  rendered structures that repeat the same user-facing arrangement,
  controls, states, props, or data-presentation shape enough that a shared
  component may reduce drift.
- **React hook candidate** — a pair or group of component behaviors that
  repeat the same state lifecycle, effects, requests, validation,
  persistence, callback policy, or derived-data rule enough that a shared
  hook may preserve behavior better.
- **Vue composable candidate** — a pair or group of script behaviors that
  repeat the same state lifecycle, effects, requests, validation,
  persistence, or derived-data policy enough that a shared composable may
  preserve behavior better.
- **Large component/view pressure** — one component, SFC, or linked view
  file contains several kinds of knowledge that change for different
  reasons. A large file is review pressure, not proof of duplication, by
  itself.

## Step 1 — Bound and scan

Pick the narrowest source root, feature area, or changed-file scope that
still includes likely reuse partners.

**Vue only:** if component references, imported composables, script blocks,
or linked external scripts matter, run `scip-query augment-vue --project
<path-to-tsconfig>` first — it adds compiler-resolved Vue SFC references to
the SQLite index using Volar (complete coverage) and must run before
scanning.

Then run, all uncapped with `--full --json`:

**React:**
```
scip-query react-component-duplicates --scope <scope> --full --json
scip-query react-hook-candidates --scope <scope> --full --json
scip-query react-large-component-pressure --scope <scope> --full --json
scip-query recent-duplicates --scope <scope> --full --json
scip-query health --scope <scope> --json
```

**Vue:**
```
scip-query vue-component-duplicates --scope <scope> --full --json
scip-query vue-composable-candidates --scope <scope> --full --json
scip-query vue-large-view-pressure --scope <scope> --full --json
scip-query recent-duplicates --scope <scope> --full --json
scip-query health --json
```

Every `*-duplicates`/`*-candidates`/`*-pressure` command has bounded
coverage — `--full` is required for the uncapped scan.
`react-component-duplicates`/`vue-component-duplicates` derive structural
similarity from tags, props, events, and bindings (React) or tags, bindings,
slots, and directives (Vue). `recent-duplicates` finds directional pairs:
recent code that re-implements established callable, React, or Vue code.
`health` gives a composite codebase health report (score, findings,
priorities, baselines, coverage notes) scoped to the frontend area.

**Complete when:** command scope, counts, and uncapped/full status are
recorded.

## Step 2 — Cross-check candidates

- **Component-duplicate-only finding** — inspect for a shared presentational
  component or existing component reuse.
- **Hook/composable-candidate-only finding** — inspect for shared behavior,
  lifecycle, request, validation, persistence, event, or derived-state
  policy.
- **Both overlap** — inspect for a feature-level concept that needs both a
  component and a hook/composable boundary.
- **Large-component/view-only finding** — split by reason to change, not by
  line count.

Use `scip-query outline <file>`, `deps <file>`, `rdeps <file>`,
`similar-files --scope <scope>`, and (React) `similar
<closest-existing-component-or-hook>` / (Vue) `recent-duplicates --scope
<scope> --full --json` to validate candidates.

**Complete when:** each top candidate is classified as reuse, extract,
split, skip, or blocked.

## Step 3 — Act on findings

Prefer reuse over extraction.

- **React:** extract a component for repeated UI structure, states, props,
  slots/children, or design-system composition; extract a hook for repeated
  state, effects, requests, subscriptions, memoized derivations, callbacks,
  or persistence.
- **Vue:** extract a component for repeated template structure, props,
  slots, states, or design-system composition; extract a composable for
  repeated state, lifecycle, requests, validation, persistence, derived
  data, or event policy.

Keep domain-specific/essential variation at the call site rather than
abstracting it away.

Anti-patterns to avoid as a side effect of acting on a finding: do not
create boolean-soup APIs or wrapper components with no policy. Shared
design-system primitives, icons, labels, route names, test IDs, or CSS
utilities alone are not sufficient evidence to justify a duplicate/hook/
composable claim. Similar JSX/templates with different domain lifecycles may
justify a presentational component but does not justify a shared hook or
composable.

**Complete when:** the chosen action reduces future drift without creating
boolean-soup APIs or wrapper components with no policy.

## Step 4 — Verify

Invoke `scip-verify` and use its authoritative postcheck table, including
the applicable React/Vue, extraction, duplicate, parameter, wrapper,
passthrough, and stale-abstraction checks.

**Complete when:** acted-on candidate pairs disappear, weaken materially, or
are explicitly accepted as essential variation.

## Report

Executive read, command evidence, candidate groups, recommended action,
post-change proof, and remaining accepted variation.
