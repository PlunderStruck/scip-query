---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It exposes exact referents, explicit typed-graph projections, and source evidence; it does not infer task relevance.
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

# scip-query

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

scip-query is a repository exploration surface: an indexed code reader that joins exact current text to compiler-owned identities and typed relationships. Native text and file tools expose matches and slices; scip-query additionally exposes how code units call, carry data, cross runtime boundaries, observe or change state, occur in order, satisfy contracts, share identity, contain one another, and depend on one another. It performs the control you select; it does not infer task relevance or decide what the user meant.

Use scip-query as the primary exploration surface for tracked repository text. Treat its commands as controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct repository question. There is no mandatory sequence, required anchor phase, or query-count limit. Thoroughness means understanding the relevant system end to end, not exhausting the repository.

Use one discriminating exact `search`, `outline`, or `entrypoints` locator, then reuse every returned symbol or `file:line` as an `evidence` root. Do not repeat generic synonym searches after usable candidates exist. Locator ordering does not establish relevance. When several implementations match the same vocabulary, do not select one by path, naming, apparent recency, or result order. Compare their entry surfaces, incoming execution, ownership, callers, or runtime connections; if the repository does not establish one as authoritative, explain the alternatives and their scopes.

An evidence projection accepts repeated `--symbol`, `--at`, or `--search` roots and repeated `--edge <family>` flags; always choose `--direction incoming|outgoing|both`, `--depth <n>`, and `--max-edges <n>` explicitly. Use `--subtype <subtype>` to narrow a family, `--connecting` when the selected roots themselves must be connected, and `--inventory-only` when counts alone can choose the next bounded projection.

Read each command's request, observed facts, evidence calibration, coverage, and recovery together. Exact observations are facts only within their reported coverage. Derived observations are deterministic computations. Candidate observations require confirmation. Missing or bounded output is not evidence of absence. Follow a relevant printed recovery or unchanged `Continue exactly:` command when its omitted information matters.

`inspect --view behavior` returns connected behavior for named units; `code` returns exact source. Treat source rendered by either command as already read. Batch independent roots and source gaps when practical. Use native tools only for edits, checks, binary content, or a specific unsupported gap reported by scip-query. After edits, use `diff-impact` when downstream consumers matter, `architecture` for declared boundaries, and `health` for configured quality or cleanup detectors.
