---
name: scip-plan
description: The pre-edit scip specialist for a planned feature, fix, refactor, or migration. Recover flow, consumers, reuse, and completeness. Do not load scip-audit, scip-query, or scip-verify alongside it.
commands:
  - template: 'scip-query plan-context <target>'
    when: 'Get the compact pre-edit decision packet for the main changed symbol, file, or module.'
  - template: 'scip-query refs <symbol> --full'
    when: 'Complete the direct consumer set only when bounded references could change the plan.'
  - template: 'scip-query affected <symbol> --full'
    when: 'Complete transitive impact only when bounded downstream coverage could change the plan.'
  - template: 'scip-query plan apply <path>'
    when: 'Compile sustained work that must survive phases or context resets into durable records.'
---

# scip-plan

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | definitions and references; callers and callees; dataflow producers and consumers; backward and forward slices; affected symbols; change-surface risk; dependencies and reverse dependencies; module files and exports; external surface use; complexity; churn; co-change partners; active suppressions; reuse candidates with evidence class and action tier; possible shared owners found from a bounded scan of affected consumers | `bounded` | Get the compact pre-edit decision packet for the main changed symbol, file, or module. |
| `scip-query refs <symbol> --full` | Find all files referencing a symbol | referencing file paths; reference line numbers grouped by file | `bounded` | Complete the direct consumer set only when bounded references could change the plan. |
| `scip-query affected <symbol> --full` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Complete transitive impact only when bounded downstream coverage could change the plan. |
| `scip-query plan apply <path>` | Apply or inspect one structured Markdown change contract and its derived obligations | immutable plan identity, workflow class, repository consequences, source observation, derived obligations, compatibility, and revision integrity | `complete` | Compile sustained work that must survive phases or context resets into durable records. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Purpose

Plan only facts that can change the implementation or its completion verdict.
Evidence commands obtain a fresh usable index themselves. Do not add `status`,
watcher polling, or `reindex` to an ordinary planning loop.

## Ordinary path

1. Classify the work from repository evidence:
   - **Direct work** is change work whose complete effect stays inside one
     known local target. Read and edit it directly. Create no plan record.
   - **Bounded relational work** is change work whose correctness depends on
     consumers, exports, retirement, ownership, or architecture, but whose
     evidence and implementation fit in one coherent slice. Write one concise
     readable plan. Do not create durable work records.
   - **Sustained work** is change work whose complete result requires several
     independent slices that must survive a context or agent reset. Keep the
     readable plan under `docs/plans/` and apply one durable contract.
2. Run one `scip-query plan-context <target>` anchor. For a migration or
   retirement, target the current owner or artifact being removed so its
   consumers, forwarding surfaces, and reuse candidates appear together.
   Treat the source packet as the read for every line it shows. Read a named
   file only for omitted context that can change the plan.
3. Inspect the anchor before choosing another SCIP command. Do not launch
   follow-up SCIP commands in parallel with it. Add one only for a named
   uncertainty that can change the plan. Use the exact `--full` or `--detail`
   route printed by the packet when complete coverage is material. Do not
   rerun the same observation against unchanged repository state.
4. Write one plan without repeating the same fact in prose and structured
   data. State a short observable goal, the current owner and flow, each file's
   role and reason, reuse decisions, behavior to preserve, artifacts to retire,
   architecture constraints, and checks. Omit empty headings.
5. Only sustained work adds one `scip-query-plan` fence and runs
   `scip-query plan apply <path>`. Use `scip-query plan example` only then.
6. Implement the smallest coherent slice. Load `scip-verify` only after that
   slice exists.

The plan is ready when the entry-to-effect path, material consumers, reuse
owners, retirement closure, and discriminating checks are explicit. Do not
turn those facts into a second checklist.

## Concise goal

Keep the goal shorter than the file plan:

```gherkin
Feature: <one sentence naming the capability or repository end state>

  Scenario: <one observable acceptance case>
    Given <relevant starting facts>
    When <an externally meaningful event occurs>
    Then <observable effects hold>
```

Do not put files or coding steps in the goal unless they are part of the user's
external contract. For sustained work, load
[`references/plan-contract.md`](references/plan-contract.md) only when the
starter is insufficient or validation names a missing field. Restored durable
state replaces new records. Do not poll `completion status`; the next Stop
reevaluates a named local action.
