---
name: scip-concrete-plan
description: Make an implementation plan or checklist before a non-trivial code change, refactor, migration, API edit, or bug fix. Uses scip-query to establish the end-to-end flow, affected consumers, and reuse options, then orders validated slices. Escalates for security, money, data migration, concurrency, and irreversible changes.
commands:
  - template: 'scip-query status --capabilities'
    when: 'Discover: confirm the index is fresh before citing graph facts.'
  - template: 'scip-query plan-context <target>'
    when: 'Discover: the one call that anchors the plan — flow, consumers, impact, reuse, history.'
  - template: 'scip-query refs <symbol>'
    when: 'Scope: enumerate consumers when plan-context bounds a section you need in full.'
  - template: 'scip-query affected <symbol>'
    when: 'Scope: transitive blast radius when the change is not consumer-local.'
  - template: 'scip-query code <symbol>'
    when: 'Flow: read source behind a behavior claim you are about to write down.'
---

# Concrete Plan

Write an implementation plan another agent can execute without guessing and a reviewer can check
without re-deriving. Two modes: **ordinary** by default, **high-assurance** when the change earns
it. Pick the mode first — running the certificate on routine work is how planning becomes a tax
people route around.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md) when you need lookup tips,
command families, postchecks, or subagent rules.

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query status --capabilities` | Show index status for this project | freshness, generation, language shards, watcher, and optional capabilities | `complete` | Discover: confirm the index is fresh before citing graph facts. |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | definitions and references; callers and callees; dataflow producers and consumers; backward and forward slices; affected symbols; change-surface risk; dependencies and reverse dependencies; module files and exports; external surface use; complexity; churn; co-change partners; active suppressions | `bounded` | Discover: the one call that anchors the plan — flow, consumers, impact, reuse, history. |
| `scip-query refs <symbol>` | Find all files referencing a symbol | referencing file paths; reference line numbers grouped by file | `bounded` | Scope: enumerate consumers when plan-context bounds a section you need in full. |
| `scip-query affected <symbol>` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Scope: transitive blast radius when the change is not consumer-local. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | definition identity, source, and line range | `complete` | Flow: read source behind a behavior claim you are about to write down. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Pick the mode

Load [`HIGH_ASSURANCE.md`](HIGH_ASSURANCE.md) — numbered premises, state-authority inventories,
counterexample attacks, enforcement windows, a derived verdict — when the change touches any of:

- a security boundary or authorization decision;
- money, billing, or anything with an external financial effect;
- a destructive or irreversible operation;
- a persistent-data migration;
- shared-state concurrency;
- a broad public API change;
- a rollout that cannot be rolled back;
- or the user explicitly asks for the rigorous version.

Otherwise use ordinary mode below. When genuinely unsure, ask rather than defaulting up: the
certificate is expensive, and the cost lands on every future change through the same skill.

## Ordinary mode

Start here:

```bash
scip-query status --capabilities     # reindex only if stale, missing, or unknown
scip-query plan-context <target>     # flow, consumers, impact, reuse signals, history
```

`plan-context` already returns definitions, references, callers, callees, dataflow, forward and
backward slices, affected symbols, change-surface risk, dependencies, module exports, external
surface use, complexity, churn, co-change partners, and suppressions. Your job is to interpret
that composite — not to rebuild a proof system on top of it. Reach for a second command only when
a section you need came back bounded, or the target was not indexed.

Put the plan in `docs/plans/YYYY-MM-DD-<short-name>.md` with these sections:

**Goal** — what the user is trying to accomplish, and what done looks like for them.

**Current flow** — the affected path from entry point to observable effect, in prose, with the
evidence behind each claim. If you cannot describe the current behavior end to end, you are not
ready to change it.

**Affected consumers** — who calls, imports, or reads what you are about to change, and what
breaks if the contract shifts. Say whether the list is complete or bounded; a capped list you
present as complete is worse than one you flag.

**Reuse decision** — for every new helper, wrapper, type, parameter, flag, component, hook, or
module: the thing it could have extended instead, and why extension loses. New parallel code with
no reuse decision is the single most common defect this skill exists to prevent.

**Slices** — ordered implementation steps. Each names its files and symbols, the behavior change,
and the validation that proves it: a test, a command, or a specific manual check. A slice with no
validation is a wish.

**Risks and unknowns** — what could go wrong, what you could not establish, and any rollout
constraint. Unknowns stay explicit; do not round them to assumptions.

## Done when

- the entry-to-effect path is described and evidenced;
- every affected consumer is assigned to a slice or explicitly out of scope;
- every new unit has a reuse decision;
- every slice has validation;
- unknowns are written down rather than resolved by guessing.

Then implement the plan in the smallest coherent slice, and run `scip-verify` when the change
lands.
