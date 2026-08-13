---
name: scip-plan
description: Write a concise, code-grounded implementation plan for a non-trivial feature, fix, refactor, migration, or retirement. Use scip-query as the primary repository exploration surface and cite exact owners, relationships, behavior, and consumers.
metadata:
  commands:
    - template: 'scip-query search <text>'
      when: 'Locate exact repository text, a runtime key, or a compiler symbol; use `scip-query search -- <text>` when the literal starts with a dash.'
    - template: 'scip-query outline <file>'
      when: 'Locate compiler-owned constructs in a known file.'
    - template: 'scip-query entrypoints <text>'
      when: 'Locate an external callable root when its entry surface is known.'
    - template: 'scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>'
      when: 'Project explicitly selected typed relationships from one exact root.'
    - template: 'scip-query inspect --at <file:line> --view behavior'
      when: 'Read connected behavior for a named implementation gap.'
    - template: 'scip-query code <selector>'
      when: 'Read exact source only when syntax itself can change the decision.'
    - template: 'scip-query diff-impact'
      when: 'Map changed symbols and downstream consumers after an edit.'
    - template: 'scip-query architecture'
      when: 'Validate declared structural boundaries.'
    - template: 'scip-query health --full'
      when: 'Run configured cleanup and quality detectors.'
---

# SCIP Plan

Write a plan that another coding agent can execute without rediscovering the relevant system.

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query search <text>` | Locate exact repository text, a runtime key, or a compiler symbol; use \`scip-query search -- <text>\` when the literal starts with a dash. |
| `scip-query outline <file>` | Locate compiler-owned constructs in a known file. |
| `scip-query entrypoints <text>` | Locate an external callable root when its entry surface is known. |
| `scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>` | Project explicitly selected typed relationships from one exact root. |
| `scip-query inspect --at <file:line> --view behavior` | Read connected behavior for a named implementation gap. |
| `scip-query code <selector>` | Read exact source only when syntax itself can change the decision. |
| `scip-query diff-impact` | Map changed symbols and downstream consumers after an edit. |
| `scip-query architecture` | Validate declared structural boundaries. |
| `scip-query health --full` | Run configured cleanup and quality detectors. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

<!-- BEGIN GENERATED EXPLORATION MANUAL -->
### Choose a relationship deliberately

| Question | Evidence family | Direction |
|---|---|---|
| Who can call or reach this? | `execution` | `incoming` |
| What can this call or reach? | `execution` | `outgoing` |
| Where can this value come from? | `dataflow` | `incoming` |
| Where can this value go? | `dataflow` | `outgoing` |
| Which producer and consumer rendezvous? | `runtime` | `both` |
| What resource is observed or changed? | `state` | `both` |
| What occurs before or after this? | `temporal` | `both` |
| What interface constrains this? | `contract` | `both` |
| Are these observations the same entity? | `identity` | `both` |
| What contains or owns this? | `ownership` | `both` |
| What does this statically rely on? | `dependencies` | `outgoing` |

Use exact evidence as an observed fact only within its coverage. Derived evidence is deterministically computed; candidate evidence is a lead; mixed evidence must retain its constituent strengths; unknown evidence cannot support a stronger claim. Missing output is not evidence of absence.

The controls above are complete for ordinary exploration. Run `scip-query capabilities --matrix` only when a named claim depends on uncertain provider support; do not run it for routine orientation.
<!-- END GENERATED EXPLORATION MANUAL -->

scip-query is a repository exploration surface: an indexed code reader that joins exact current text to compiler-owned identities and typed relationships. Use it as the primary exploration surface for tracked repository text. Treat its commands as controls, not a checklist. Use every capability needed by the change, but make each query answer a distinct repository question. There is no mandatory sequence, required anchor phase, or query-count limit.

Before planning, understand the relevant initiating surfaces, behavior owners, decisions, data transformations, effects, consumers, existing reuse opportunities, and structural constraints. Use one discriminating locator and reuse its results as graph roots; do not repeat generic synonym searches after usable candidates exist. When several implementations match, compare their entry surfaces, incoming execution, ownership, callers, or runtime connections before selecting one. Locator results are graph roots, not relevance rankings. Read coverage and recovery before making complete-set or absence claims. Use native tools only for edits, checks, binary content, or a specific unsupported gap reported by scip-query.

Do not write a plan for one obvious local edit. Write one when correctness depends on several owners or files, downstream consumers, a migration or retirement, reuse of existing behavior, architecture rules, or several coherent implementation slices. Put it in `docs/plans/YYYY-MM-DD-<name>.md` only when it must survive a context reset.

## Plan shape

State the observable outcome in one or two sentences. Explain the current behavior with exact symbol and file/line references. Then use this table:

| Step | Code reference | Change | Preserve or retire | Verify |
| --- | --- | --- | --- | --- |
| Coherent implementation slice | Exact symbol and file/line | Concrete edit and why it belongs here | Existing behavior to keep or residue to remove | Check that fails when the outcome is absent |

Order the rows so each leaves the repository in a valid state. Include the relevant entry point, behavior owner, downstream consumers, reuse candidates, architecture constraints, migration or cleanup, and validation. Label design choices as choices. Include an open-uncertainty section only when an unresolved repository fact can change the implementation, and name the exact scip-query command that would answer it.

The plan is ready when another agent can implement it without a broad repository rediscovery pass.
