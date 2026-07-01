---
name: tla-model-system
description: Model TypeScript systems with TLA+ and scip-query evidence. Use to create or verify TLA+ specs, mapping files, configs, regression models, counterexample loops, or code/model conformance for an existing system.
---

# tla-model-system

Use this skill when a TypeScript system needs a TLA+ model tied to code evidence. A modeled slice is the bounded part of the real system represented by the model: state, transitions, inputs, outputs, and failure modes.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Loop

1. Explore the target with `scip-query plan-context <target>`, `system`, `trace`, `call-graph`, and `dataflow` until state and transitions are concrete.
2. Draft or update the TLA+ module and config.
3. Draft or update the mapping JSON. Every model variable and action names TypeScript referents.
4. Run `scip-query tla verify <spec> --map <map> --config <cfg>`.
5. Classify every finding as code bug, model bug, mapping bug, insufficient trace/alias evidence, or accepted non-modeled behavior.
6. Patch code, model, or mapping.
7. Rerun until verification passes or only explicitly accepted uncertainty remains.

The loop is complete only when the model, code mapping, and checker result agree on the selected slice.

## Fast Regression Models

A regression model is a small TLA+ module or checker config derived from a counterexample, production bug, or suspected transition. A counterexample trace is the concrete sequence of states and actions that reaches a bad state.

When the full model is slow or a specific failure appears:

1. Preserve the full model as source of truth.
2. Create a companion regression spec/config named for the failure.
3. Seed it from the exact counterexample trace.
4. Prefer bounded constants and narrowed action sets over weakening the main model.
5. Run the regression first after each patch.
6. Run the full model after the regression passes.
7. Keep the regression if it protects future behavior.

This branch is complete only when the regression answers the specific failure quickly and the full model still passes before completion is claimed.

## Mapping Contract

Use:

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

`code` entries must resolve through `scip-query trace`. Use `path/to/file.ts/symbol` or an exact symbol name.

## Accuracy Rules

- Treat `scip-query tla verify` as the mechanical checker.
- If evidence is `unknown`, add aliases, mapped referents, or runtime traces before calling the system verified.
- If code changed but the model did not, inspect whether the mapped transition changed meaning.
- If the model checker fails, fix the TLA+ model before relying on conformance.
- Use `--checker none` only when intentionally checking mapping without SANY, TLC, or Apalache.
