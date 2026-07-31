---
name: scip-plan
description: Use before, during, AND after non-trivial work: plan a change, migration, or refactor; assess what breaks when changing a public export, module boundary, schema, route, CLI command, config field, generated artifact, signature, or documented behaviour; conduct a multi-phase program and review a delegated agent's work mid-flight; plan a performance campaign; scaffold a TLA+ model before implementing, and trace-check it against the real system afterward. Distinct from the `review` skill, which reviews a finished branch or PR against coding standards and the originating spec — this one oversees a program you are conducting.
commands:
  - template: "scip-query plan-context <target>"
    when: "Anchor the current flow, consumers, reuse options, and change risks."
  - template: "scip-query refs <symbol>"
    when: "Complete or narrow the direct consumer set for a planned symbol change."
  - template: "scip-query affected <symbol>"
    when: "Measure transitive impact when the change is not consumer-local."
  - template: "scip-query completion status <change-id> --json"
    when: "Inspect the controller-derived completion state and every blocking predicate."
---

# scip-plan

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | definitions and references; callers and callees; dataflow producers and consumers; backward and forward slices; affected symbols; change-surface risk; dependencies and reverse dependencies; module files and exports; external surface use; complexity; churn; co-change partners; active suppressions | `bounded` | Anchor the current flow, consumers, reuse options, and change risks. |
| `scip-query refs <symbol>` | Find all files referencing a symbol | referencing file paths; reference line numbers grouped by file | `bounded` | Complete or narrow the direct consumer set for a planned symbol change. |
| `scip-query affected <symbol>` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Measure transitive impact when the change is not consumer-local. |
| `scip-query completion status <change-id> --json` | Create successor rules or read, validate, and summarize protected completion state | immutable evaluations, idempotent completion transitions, blocked and unknown predicates, compatibility, and integrity | `complete` | Inspect the controller-derived completion state and every blocking predicate. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Purpose

Plan and conduct work: a single non-trivial change, public-surface impact, a multi-phase program carried end to end with verification at each handoff (including reviewing a delegated agent's work in flight), a benchmark-driven optimization campaign, and TLA+ modelling both before implementation and as post-implementation trace-conformance.

Shared mechanics (lookup tips, command families, postchecks, subagent-briefing text, general command catalogue) live in `../_shared/SKILL.md` — load it only when this skill's own shortlist is insufficient.

## Pick the mode first

| Situation | Do this |
|---|---|
| One non-trivial change, refactor, migration, or bug fix | Ordinary-mode scenario below |
| The change touches a security boundary, money, a destructive/irreversible op, a persistent-data migration, shared-state concurrency, a broad public API, or an unrollback-able rollout — or the user asks for the rigorous version | `references/high-assurance.md` |
| You're about to edit a public export, route, schema, CLI command, config field, generated artifact, or documented behavior, and need to know what breaks | `references/api-impact.md` |
| You're running a multi-phase program: writing an executable plan, delegating steps, reviewing a subagent's work mid-flight, or carrying a change end to end | `references/conductor.md` |
| You need something faster and must prove the speedup with measurements | `references/hyper-optimization.md` |
| You need a TLA+ model of a risky protocol, before or after implementation | `references/tla-model.md` |

Picking the mode matters: running the high-assurance certificate on routine work is how planning becomes a tax people route around. When genuinely unsure whether a change needs a heavier mode, ask rather than defaulting up.

## Scenario: plan a single non-trivial change (ordinary mode, the default)

Apply `_shared`'s freshness gate once before citing the first graph fact; let an active watcher handle refreshes and use manual reindex only as the documented fallback. Then run `scip-query plan-context <target>` — the single anchoring call for planning. Its composite return already includes definitions, references, callers, callees, dataflow producers/consumers, forward and backward slices, affected symbols, change-surface risk, dependencies and reverse dependencies, module exports, external surface use, complexity, churn, co-change partners, and active suppressions, so the job is to interpret this composite rather than rebuild a proof system on top of it.

Reach for a second command only when a section `plan-context` returned came back bounded (not complete) or the target wasn't indexed: `scip-query refs <symbol>` to enumerate consumers in full, `scip-query affected <symbol>` for the transitive blast radius when the change isn't consumer-local, `scip-query code <symbol>` to read the source behind a behavior claim before writing it into the plan.

Write the plan to `docs/plans/YYYY-MM-DD-<short-name>.md` with these sections:

- **Goal** — what the user is trying to accomplish, and what done looks like for them.
- **Current Flow** — the affected path from entry point to observable effect, in prose, with evidence behind each claim; if current behavior can't be described end to end, the change isn't ready to make.
- **Affected Consumers** — who calls/imports/reads the changed code and what breaks if the contract shifts; state explicitly whether the list is complete or bounded — a capped list presented as complete is worse than one flagged as bounded.
- **Reuse Decision** — for every new helper/wrapper/type/parameter/flag/component/hook/module, name what it could have extended instead and why extension loses. New parallel code with no reuse decision is the single most common defect this skill exists to prevent.
- **Slices** — ordered implementation steps, each naming its files/symbols, the behavior change, and the validation (a test, command, or specific manual check) that proves it. A slice with no validation is a wish.
- **Risks and Unknowns** — what could go wrong, what couldn't be established, and any rollout constraint; keep unknowns explicit rather than rounding them to assumptions.

The plan is done only when: the entry-to-effect path is described and evidenced, every affected consumer is assigned to a slice or explicitly out of scope, every new unit has a reuse decision, every slice has validation, and unknowns are written down rather than resolved by guessing. Then implement in the smallest coherent slice and run `scip-verify` when the change lands.

When a repository has adopted canonical autonomous work state, use
`scip-query goal status` and `scip-query change status` to recover the
authorized goal and intended change rather than asking the user or transcript
to restate them. If exactly one active change exists, continue it. If no goal
or change exists and the user's request both authorizes repository work and
states a sufficiently clear desired outcome, derive and materialize the
initial records yourself; do not ask the user to translate their request into
protocol fields. A real ambiguity about authority or what observable outcome
would count as success remains unknown rather than being invented.

Keep the goal shorter than the implementation plan. Map it to Gherkin as:

```gherkin
Feature: <one sentence naming the repository capability or end state>

  Scenario: <one observable acceptance case>
    Given <relevant starting facts>
    When <an externally meaningful event occurs>
    Then <observable repository or user-facing effects hold>
```

Add only invariants that must remain true across every valid implementation,
and add only enough scenarios to distinguish success from a technically
narrow edit. Do not put file names, symbols, algorithms, ordered coding steps,
or the proposed implementation into the goal unless they are themselves part
of the authorized external contract. If writing the goal takes more prose than
the plan slice it governs, move the detail into the intended change or plan.

Supported project-local hooks derive the same bounded restoration projection
automatically on session start, changed prompt state, and after compaction;
when it emits exact status commands because its registered context budget was
reached, run those commands instead of asking for a narrative handoff.
`scip-query goal create --input <path>` and
`scip-query change create --input <path>` are repository mutations: use them
once to materialize the derived authorized request, and rely on their
retry-stable identities instead of editing committed record bytes directly.
Use `scip-query attempt status <change-id>` and
`scip-query decision status <change-id>` to recover tried strategies,
unresolved effects, and settled next actions before proposing another slice.
Use `scip-query obligation status <change-id>` to recover every completion
condition that remains live or conflicted. Admit an obligation when useful
work discovers a condition that completion must establish; transition it only
with fixed current observation evidence. Carry-forward embeds the successor
in the same immutable transition, so unfinished work survives branch merges
without a coordination-only write.
Use `scip-query completion status <change-id> --json` to inspect the protected
completion judgment. An evaluation with an unknown required predicate remains
blocked, and only a controller-derived complete evaluation has a completion
transition. Do not infer completion from a passing command or an agent's prose.
Attempt and decision records are durable workflow primitives, but supported
hooks and commands create them as a side effect of useful work and Stop
evaluation. Do not issue manual `attempt create` or `decision create`
operations for ordinary exploration, edits, verification, retries, or
reconciliation. Use those maintenance commands only for an unsupported agent
adapter or explicit ledger repair. Never authorize repetition of an unresolved
non-idempotent attempt.

## Owned command quick-reference

`bench`, `work-audit` → performance campaigns, see `references/hyper-optimization.md`.
`tla`, `tla scaffold`, `tla verify`, `tla instrument`, `tla trace-check`, `tla fetch-tools` → model scaffolding and conformance, see `references/tla-model.md`.

Everything else used above (`plan-context`, `refs`, `affected`, `code`, `surface`, `co-change`, `doc-drift`, `diff-gate`, `health`, `call-graph`, `complexity`, `change-surface`, ...) is general catalogue — see `../_shared/SKILL.md` for the full vocabulary.
