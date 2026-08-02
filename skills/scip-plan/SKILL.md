---
name: scip-plan
description: Use before non-trivial work to recover the current flow, affected consumers, reuse choices, completeness conditions, and smallest useful implementation slices. A finished diff routes to scip-verify.
commands:
  - template: 'scip-query plan-context <target>'
    when: 'Get the compact pre-edit decision packet for the main changed symbol, file, or module.'
  - template: 'scip-query refs <symbol> --full'
    when: 'Complete the direct consumer set only when bounded references could change the plan.'
  - template: 'scip-query affected <symbol> --full'
    when: 'Complete transitive impact only when bounded downstream coverage could change the plan.'
  - template: 'scip-query plan apply <path>'
    when: 'Compile one relational or sustained Markdown contract into durable work records.'
  - template: 'scip-query completion status <change-id>'
    when: 'Recover controller-owned completion state for resumed protected work.'
---

# scip-plan

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | definitions and references; callers and callees; dataflow producers and consumers; backward and forward slices; affected symbols; change-surface risk; dependencies and reverse dependencies; module files and exports; external surface use; complexity; churn; co-change partners; active suppressions; reuse candidates with evidence class and action tier; possible shared owners found from a bounded scan of affected consumers | `bounded` | Get the compact pre-edit decision packet for the main changed symbol, file, or module. |
| `scip-query refs <symbol> --full` | Find all files referencing a symbol | referencing file paths; reference line numbers grouped by file | `bounded` | Complete the direct consumer set only when bounded references could change the plan. |
| `scip-query affected <symbol> --full` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Complete transitive impact only when bounded downstream coverage could change the plan. |
| `scip-query plan apply <path>` | Apply or inspect one structured Markdown change contract and its derived obligations | immutable plan identity, workflow class, repository consequences, source observation, derived obligations, compatibility, and revision integrity | `complete` | Compile one relational or sustained Markdown contract into durable work records. |
| `scip-query completion status <change-id>` | Create successor rules or read, validate, and summarize protected completion state | immutable evaluations, idempotent completion transitions, blocked and unknown predicates, compatibility, and integrity | `complete` | Recover controller-owned completion state for resumed protected work. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Purpose

Plan only what can change the implementation or its completion verdict. The
tool's evidence commands obtain a fresh usable index internally. Run the useful
query directly; do not manage `status`, watcher waits, or `reindex` as planning
steps. If the command cannot establish freshness, its error is the blocker.

Use the ordinary path below unless one risk needs a specialist reference:

| Risk | Read |
| --- | --- |
| Security, money, irreversible work, persistent data, concurrency, or broad public API | `references/high-assurance.md` |
| Public export, route, schema, CLI, config, generated output, or documented behavior | `references/api-impact.md` |
| Several independently verifiable phases or delegated work | `references/conductor.md` |
| Measured performance work | `references/hyper-optimization.md` |
| Risky state protocol needing a TLA+ model | `references/tla-model.md` |

## Ordinary path

1. Classify the work from evidence:
   - **Direct:** one known local target and effect, with no consumer, public
     surface, retirement, architecture, migration, security, durability, or
     multi-slice consequence. Read and edit directly; create no plan record.
   - **Relational:** a consumer, export, alias, responsibility transfer,
     retirement, compatibility rule, or architecture edge can change the
     result. Apply one concise plan contract before editing.
   - **Sustained:** several independently verifiable slices must survive a
     context or agent reset. Keep the readable plan under `docs/plans/`.
2. Run one `scip-query plan-context <target>` anchor. Treat its default output
   as a decision packet: current flow, affected consumers, reuse candidates,
   constraints, next source files, and stated coverage. Read those named files.
3. Run another SCIP command only for a named uncertainty that can change the
   plan. Use the exact `--full` or `--detail` route printed by the packet when
   complete coverage is material. Do not rerun the same observation against
   unchanged repository state, even after context compaction.
4. Write the plan from the goal backward:
   - **Goal:** one short capability or end state, one observable Gherkin
     scenario, and only true cross-implementation invariants.
   - **Current flow:** entry to observable effect, grounded in source.
   - **Affected consumers:** what changes for each, and whether coverage is
     complete or bounded.
   - **Reuse decision:** resolve every direct option from the packet. Reuse an
     existing owner that owns the same responsibility. Reject it only with
     concrete semantic evidence in the readable plan.
   - **Completeness:** behavior to preserve, identities or responsibilities to
     retire, justified survivors, architecture rules, and direct evidence.
   - **Slices:** the smallest ordered outcomes that can each be verified.
   - **Unknowns:** facts still capable of changing the route or verdict.
5. For relational or sustained work, put exactly one `scip-query-plan` JSON
   fence in the Markdown and run `scip-query plan apply <path>` once. Use
   `scip-query plan example` for the concise valid form. It expands into the
   strict durable v1 records before validation; it does not weaken them.
6. Implement the smallest coherent slice. Load `scip-verify` only after that
   slice exists.

The plan is ready when the entry-to-effect path is known, every material
consumer is assigned or explicitly excluded, every new unit has a reuse
decision, obsolete behavior has a retirement condition, each slice has
discriminating evidence, and real unknowns remain visible.

## Goal rule

Keep the goal shorter than the implementation plan:

```gherkin
Feature: <one sentence naming the capability or repository end state>

  Scenario: <one observable acceptance case>
    Given <relevant starting facts>
    When <an externally meaningful event occurs>
    Then <observable effects hold>
```

Do not put files, symbols, algorithms, or coding steps in the goal unless the
user made them part of the external contract. Add scenarios only when they
separate complete success from a technically correct narrow edit.

## Durable work state

Supported hooks restore the active goal, change, attempts, decisions,
obligations, and controller action. Use that state instead of asking the user
to repeat it. Ordinary commands create workflow history as a side effect of
useful work. Do not issue manual `attempt create` or `decision create`
operations for ordinary exploration, edits, verification, retries, or
reconciliation. A missing authority or truly ambiguous observable outcome
stays unknown.

The compact contract fields, survivor and reuse rules, continuation rules, and
full stored shape are in
[`references/plan-contract.md`](references/plan-contract.md). Load that file
only when the starter is insufficient or validation reports one of those
specific concepts.
