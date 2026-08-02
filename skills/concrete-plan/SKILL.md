---
name: concrete-plan
description: Write a concise implementation plan for a non-trivial feature, fix, refactor, migration, or retirement. Use direct scip-query evidence for ownership, flow, consumers, reuse, residue, architecture, and proof. Keep the plan smaller than the implementation problem and omit ceremony that does not change the next action.
---

# Concrete Plan

Write a plan that another coding agent can execute without rediscovery.

A concrete plan is a short sequence of code changes tied to observed source and relationships. Its essential trait is that each material step names the fact that makes the step necessary.

Direct evidence is source or compiler-graph output that names the exact code unit and relationship behind a claim. It differs from a folder guess, a likely story, or a general design preference.

## When to write a plan

Do not write a plan for one obvious local edit.

Write a plan when correctness depends on one or more of these facts:

- several owners or files;
- downstream consumers;
- a replacement, migration, or retirement;
- reuse of existing behavior;
- architecture rules;
- several coherent implementation slices.

Put the plan in `docs/plans/YYYY-MM-DD-<name>.md` only when it must survive a context reset. Otherwise, keep it in the active task.

## Gather only decision evidence

Start with one anchor:

```bash
scip-query context <current-owner-or-entry>
```

Use `scip-query evidence <symbol>` when source around exact uses matters more than a broad map.

Add a focused command only for a named uncertainty that can change the plan. Use `scip-query search <text>` for routes, event names, configuration keys, and other literal wiring.

## Plan shape

Write these parts:

### Outcome

State the observable repository or product result in one or two sentences. Do not name files unless the file is part of the contract.

### Current path

State the current entry, behavior owner, effect, and material consumers. Cite the command and source identity inline.

### Implementation slices

Use this compact table:

| Change              | Direct evidence             | Preserve                      | Retire                                          | Prove                         |
| ------------------- | --------------------------- | ----------------------------- | ----------------------------------------------- | ----------------------------- |
| Exact coherent edit | Command and source identity | Existing behavior or contract | Obsolete symbol, route, branch, export, or file | Check that can expose failure |

Split a row only when the next row can start from a valid repository state.

### Open uncertainty

Include this section only when an unknown can change the implementation. Name the next command that resolves it.

## Required reasoning

- Cite direct evidence for each changed owner and material consumer.
- Compare an existing reuse candidate before adding a new helper, wrapper, hook, component, or module.
- Name behavior that must remain true.
- Name residue that the change must remove.
- Include architecture rules that constrain dependency direction.
- Use a proof that can fail when the outcome is absent.
- Label a design choice as a choice. Do not present it as an observed code fact.

Do not copy the same fact into several sections. Do not add evidence identifiers, goal records, approval steps, or progress bookkeeping.

The plan is ready when the coding agent can start the first edit without another broad exploration pass.
