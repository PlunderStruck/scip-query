---
name: tla-model-system
description: Model an existing TypeScript system with TLA+, verify the TLA+ model, verify the scip-query mapping against code evidence, build fast targeted regression models/configs from failures, and iterate on code/model/map until the modeled slice is coherent.
---

# TLA+ System Modeling

Use this skill when the user asks to model a system in TLA+, verify a TLA+
model against TypeScript code, or run an iterative formal-modeling loop.

A modeled slice is the bounded part of the real system represented by the
model: concrete state, transitions, inputs, outputs, and failure modes. Do not
claim the model represents the whole program unless the mapping proves that
scope.

## Loop

1. Explore the target system with `scip-query plan-context <target>`, then use
   `scip-query system`, `scip-query trace`, `scip-query call-graph`, and
   `scip-query dataflow` until state and transitions are concrete.
2. Draft or update the TLA+ module and config.
3. Draft or update the mapping JSON. Every model variable and action must name
   TypeScript referents; no name-only guessing.
4. Run `scip-query tla verify <spec> --map <map> --config <cfg>`.
5. Classify every finding as one of:
   - code bug;
   - model bug;
   - mapping bug;
   - insufficient trace or alias evidence;
   - accepted non-modeled behavior.
6. Patch the code, model, or mapping.
7. Rerun `scip-query tla verify` until it passes or only explicitly accepted
   uncertainty remains.

## Fast Regression Models

A regression model is a deliberately small TLA+ module or checker config derived
from a real counterexample, production bug, or suspected transition. It is still
a TLA+ model, but its purpose is to recheck one known failure path quickly while
the full model remains the broad behavioral proof.

A counterexample trace is the concrete sequence of states and actions produced
by TLC, Apalache, a runtime trace, or a failing test that shows how the modeled
system reaches a bad state.

When a full model takes more than a few minutes or produces a specific failure:

1. Preserve the full model and config as the source of truth.
2. Create a companion regression spec/config beside it, named for the failure
   or invariant, such as `Queue.retry-regression.tla` or
   `Queue.retry-regression.cfg`.
3. Seed the regression model from the exact counterexample trace: keep the
   smallest variables, constants, initial state, actions, bounds, and invariants
   needed to reproduce the failure.
4. Prefer bounded constants and narrowed action sets over editing the main model
   until it no longer represents the real system.
5. Run the regression model first after each code/model/map patch. It should
   answer "did this specific failure get fixed?" in seconds or a small number of
   minutes.
6. Run the full model after the regression passes. Do not claim the system is
   fixed from the regression alone.
7. Keep the regression model if it protects against future recurrence. Delete it
   only when the full model or a better regression fully subsumes the scenario.

Use `scip-query tla verify <regression-spec> --map <map> --config
<regression-cfg>` for the fast loop, then rerun the same command against the
full spec/config before declaring completion.

## Mapping Contract

Use a mapping file shaped like:

```json
{
  "module": "specs/Queue.tla",
  "config": "specs/Queue.cfg",
  "scope": ["src/queue"],
  "variables": {
    "queue": {
      "code": ["src/queue/store.ts/queue"],
      "aliases": ["queue"]
    }
  },
  "actions": {
    "Enqueue": {
      "code": ["src/queue/commands.ts/enqueue"],
      "writes": ["queue"],
      "reads": []
    }
  },
  "invariants": ["TypeOK"]
}
```

`code` entries must resolve through `scip-query` symbol lookup. Use
`path/to/file.ts/symbol` or an exact symbol name that `scip-query trace` can
resolve.

## Accuracy Rules

- Treat `scip-query tla verify` as the mechanical checker. Do not override it
  with intuition.
- If a finding uses `unknown` evidence, add an alias, a mapped referent, or a
  runtime trace before calling the system verified.
- If code changed but the model did not, inspect whether the mapped transition
  changed meaning. Update the model when it did.
- If the model checker fails, fix the TLA+ model before relying on code
  conformance results.
- Use `--checker none` only when intentionally checking the mapping without
  running SANY, TLC, or Apalache.
