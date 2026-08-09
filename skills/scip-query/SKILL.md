---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It exposes exact referents, explicit typed-graph projections, and source evidence; it does not infer task relevance.
commands:
  - template: 'scip-query search <text>'
    when: 'Locate exact repository text, a runtime key, or a compiler symbol.'
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
## Commands for this skill

| Command | When |
| --- | --- |
| `scip-query search <text>` | Locate exact repository text, a runtime key, or a compiler symbol. |
| `scip-query outline <file>` | Locate compiler-owned constructs in a known file. |
| `scip-query entrypoints <text>` | Locate an external callable root when its entry surface is known. |
| `scip-query evidence --symbol <symbol> --edge <family> --direction <direction> --depth <n> --max-edges <n>` | Project explicitly selected typed relationships from one exact root. |
| `scip-query inspect --at <file:line> --view behavior` | Read connected behavior for a named implementation gap. |
| `scip-query code <selector>` | Read exact source only when syntax itself can change the decision. |
| `scip-query diff-impact` | Map changed symbols and downstream consumers after an edit. |
| `scip-query architecture` | Validate declared structural boundaries. |
| `scip-query health --full` | Run configured cleanup and quality detectors. |

Use this shortlist first. Run a command's `--help` only when a named uncertainty needs another option.
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

Run `scip-query capabilities` for the complete control contracts, provider ceilings, contrasts, and project support matrix.
<!-- END GENERATED EXPLORATION MANUAL -->

scip-query is a repository exploration surface: an indexed code reader that joins exact current text to compiler-owned constructs, typed relationships, compressed behavior, exact source, and recoverable omissions. It performs the graph or read operation the agent selects; it does not infer task relevance, choose a subsystem, or decide that the user's question is complete.

Privately name the material facts the answer requires. Locate exact referents with `search`, `outline`, or `entrypoints`; choose the relationship and direction that can establish each fact; batch compatible roots into `evidence`; then use one batched `inspect` or exact `code` read only for named implementation gaps. There is no anchor-discovery phase or mandatory map.

Read request, observed facts, calibration, coverage, and recovery together. A completed bounded projection is not a completed user task. Continue while a material fact remains unresolved and an exact in-scope recovery path exists; query count is never a correctness cutoff. Treat rendered source as already read, batch independent gaps, and run an unchanged `Continue exactly:` command until transport completes.

Use scip-query rather than a parallel grep/read workflow for tracked text. Native tools are for edits, checks, binary content, or an explicitly reported unsupported gap. After edits, use `diff-impact` when consumers matter, `architecture` for declared boundaries, and `health` for quality or cleanup analysis.
