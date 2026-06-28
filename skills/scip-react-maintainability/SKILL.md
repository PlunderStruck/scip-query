---
name: scip-react-maintainability
description: React frontend maintainability review using scip-query's React component duplicate, hook candidate, large component pressure, recent-duplicate, incomplete-migration, and diff-gate commands. Use when reviewing React, TSX, JSX, or Next.js codebases; investigating duplicated components or hooks; checking frontend health pressure; or verifying agents reused React code correctly after a refactor.
---

# SCIP React Maintainability Review

This skill reviews React frontends by treating components, hooks, JSX structure, and behavior lifecycles as first-class maintainability units. It uses `scip-query` evidence to decide where UI structure, state/effect/request behavior, and large components are carrying duplicated concepts or too many reasons to change.

A React component duplicate candidate is a pair or group of rendered interface structures that repeat the same user-facing arrangement, controls, states, props, or data-presentation shape enough that a shared component may reduce future divergence.

A React hook candidate is a pair or group of component behaviors that repeat the same state lifecycle, effects, requests, validation, persistence, callback policy, or derived-data rule enough that a shared hook may make the behavior easier to preserve.

Large component pressure is a maintainability signal that one React component or file contains several kinds of knowledge that change for different reasons, such as layout structure, state management, data loading, permission policy, and styling.

React health is a repo-grounded frontend pressure map. It is useful for ranking review attention, but it is not proof that code is bad and not the goal of a refactor.

## Quick Start

Refresh the code intelligence before trusting graph facts:

```bash
scip-query status
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
```

Run the React review commands uncapped when doing a serious frontend pass. Do not combine `--full` with `--limit`.

```bash
scip-query react-component-duplicates --scope <react-source-scope> --full --json
scip-query react-hook-candidates --scope <react-source-scope> --full --json
scip-query react-large-component-pressure --scope <react-source-scope> --full --json
scip-query recent-duplicates --scope <react-source-scope> --full --json
scip-query health --scope <react-source-scope> --json
```

## Workflow

1. Bound the review to a React source root, feature area, or changed files. Prefer the narrowest scope that still includes likely reuse partners.
2. Run the three React commands: component duplicates, hook candidates, and large component pressure.
3. Use `recent-duplicates` to catch newly added frontend echoes of established code.
4. Cross-check the result sets before recommending an extraction:
   - Component duplicate only: inspect for a shared presentational component or an existing component callers should reuse.
   - Hook candidate only: inspect for a shared behavior, lifecycle, request pattern, validation rule, persistence rule, or derived-state policy.
   - Both component and hook candidate: inspect for a feature-level concept that may need both a component boundary and a hook boundary.
   - Large component only: split by reason to change, not by line count alone.
5. Open the source files for the top candidates. Similarity is evidence to inspect, not a verdict.
6. Check existing exports, imports, and call sites before proposing anything new:

```bash
scip-query outline <file>
scip-query deps <file>
scip-query rdeps <file>
scip-query similar-files --scope <react-source-scope>
scip-query similar <closest-existing-component-or-hook>
```

## Acting on Findings

Prefer reuse before extraction. If an existing component or hook already names the concept, migrate callers to it instead of creating another one.

When extracting:

- Extract a component when the repeated knowledge is rendered UI structure, props, slots/children, empty/loading/error states, or design-system composition.
- Extract a hook when the repeated knowledge is state, effects, requests, subscriptions, memoized derivations, callbacks, or persistence policy.
- Split a large component by reason to change: data loading, permission/policy, layout shell, table/list rendering, form state, and action handling are different reasons.
- Keep domain-specific variation at the call site when the variation is essential. Do not hide different product rules behind a boolean soup API.

## Post-Change Verification

After implementing a component reuse, hook extraction, or large-component split, prove both sides of the work: the new abstraction exists and the old inline copies were migrated.

Run the checks that match what changed:

```bash
scip-query diff-impact --json
scip-query react-component-duplicates --scope <react-source-scope> --full --json
scip-query react-hook-candidates --scope <react-source-scope> --full --json
scip-query react-large-component-pressure --scope <react-source-scope> --full --json
scip-query recent-duplicates --scope <react-source-scope> --full --json
scip-query incomplete-migration
scip-query unused-params
scip-query wrapper-candidates --scope <react-source-scope> --full --json
scip-query passthrough-candidates --scope <react-source-scope> --full --json
scip-query stale-abstractions --scope <react-source-scope> --include-low-confidence --full --json
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-gate --json
```

Use the results this way:

- `incomplete-migration`: if a new hook/helper was created and wired somewhere, migrate every unchanged site that still contains the same logic or document why it is not the same behavior.
- `recent-duplicates`: if the new component/hook is still an echo of established code, delete the echo or reuse the established concept.
- React duplicate commands: the specific candidate pair you acted on should disappear, weaken materially, or be explicitly accepted as essential variation.
- `unused-params`: remove speculative props/options introduced "for later."
- wrapper/pass-through/stale checks: remove local wrapper components, hook aliases, or type abstractions that do not enforce a real policy.
- `diff-gate`: treat every finding as unfinished work unless there is a written reason to accept it.

## False Positive Checks

- Shared design-system primitives, icons, labels, route names, or test IDs are not enough to justify an extraction.
- Similar JSX with different domain lifecycles may justify a presentational component but not a hook.
- Shared hook usage may mean the right concept is already extracted; look for drift around the shared call, not another extraction.
- A large file creates review pressure, but it is not proof that behavior is duplicated.
- A local wrapper is justified only when it names a real product concept, enforces a policy, or prevents drift across callers.

## Reporting Shape

Report findings as a frontend maintainability register:

- Executive read: whether the React code is consolidating or drifting.
- Command evidence: exact commands, scope, counts, and whether results were uncapped.
- Candidate groups: files/components, repeated UI structure, repeated behavior, and large-component pressure.
- Recommended action: reuse existing API, extract component, extract hook, split view, delete wrapper, or no action.
- Post-change proof: commands rerun, candidate pairs resolved or accepted, migration completeness checked, and `diff-gate` result.
