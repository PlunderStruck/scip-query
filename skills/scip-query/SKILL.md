---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, runtime boundaries, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It exposes exact referents, explicit typed-graph projections, and source evidence; it does not infer task relevance. Pair it with scip-explore when the task is to understand a repository system end to end.
metadata:
  commands:
    - template: 'scip-query watch --daemon'
      when: 'When the user explicitly asks to use scip-query, make sure the background watcher for the exact target worktree is running before the first exploration command.'
    - template: 'scip-query watch --status'
      when: 'Check whether the watcher for the current worktree is running, refreshing, idle, or failed.'
    - template: 'scip-query watch --stop'
      when: 'Stop the watcher owned by the current worktree when the user asks to turn it off.'
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
| `scip-query watch --daemon` | When the user explicitly asks to use scip-query, make sure the background watcher for the exact target worktree is running before the first exploration command. |
| `scip-query watch --status` | Check whether the watcher for the current worktree is running, refreshing, idle, or failed. |
| `scip-query watch --stop` | Stop the watcher owned by the current worktree when the user asks to turn it off. |
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

## Watcher lifecycle

The scip-query watcher is a project-scoped background refresh service: one process owned by one worktree that observes that worktree's configured compiler inputs and keeps its index current after relevant changes. It is not a global service, and starting it in one worktree must not start watchers for sibling worktrees.

When the user explicitly names scip-query, invokes `$scip-query`, or asks the agent to use it, run `scip-query watch --daemon` from the exact target project root before the first exploration command. Treat both a newly started watcher and an already-running watcher as success; reuse the existing process instead of starting another. This automatic start applies only to an explicit request to use scip-query. Merely opening a repository or shell must not start it.

Use the normal command without `CHOKIDAR_USEPOLLING` or another forced polling override. If startup fails, report the exact failure; do not silently start a watcher in another worktree, force polling, or substitute an unbounded full rebuild.

Run `scip-query watch --status` from the same project root to inspect the watcher. Run `scip-query watch --stop` from that root when the user asks to stop it. The stop command targets only that worktree's watcher; do not stop watchers owned by other worktrees unless the user names them.

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

For end-to-end system understanding, load `$scip-explore` alongside this skill. `scip-explore` owns the material-fact model, evidence integration, answer audit, and stopping judgment; this skill remains the calibrated sensing and source-reading surface.

Use scip-query as the primary exploration surface for tracked repository text. Treat its commands as controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct repository question. There is no mandatory sequence, required anchor phase, or query-count limit. Thoroughness means understanding the relevant system end to end, not exhausting the repository.

Use one discriminating exact `search`, `outline`, or `entrypoints` locator, then reuse every returned symbol or `file:line` as an `evidence` root. Do not repeat generic synonym searches after usable candidates exist. Locator ordering does not establish relevance. When several implementations match the same vocabulary, do not select one by path, naming, apparent recency, or result order. Compare their entry surfaces, incoming execution, ownership, callers, or runtime connections; if the repository does not establish one as authoritative, explain the alternatives and their scopes.

An evidence projection accepts repeated `--symbol`, `--at`, or `--search` roots and repeated `--edge <family>` flags; always choose `--direction incoming|outgoing|both`, `--depth <n>`, and `--max-edges <n>` explicitly. Use `--subtype <subtype>` to narrow a family, `--connecting` when the selected roots themselves must be connected, and `--inventory-only` when counts alone can choose the next bounded projection.

Read each command's request, observed facts, evidence calibration, coverage, and recovery together. Exact observations are facts only within their reported coverage. Derived observations are deterministic computations. Candidate observations require confirmation. Missing or bounded output is not evidence of absence.

An emitted `Continue exactly:` command is a cursor: a next-page read from one immutable rendered result. It is required transport, not optional evidence expansion. Run the emitted command unchanged and repeat until no continuation remains before interpreting that command's complete result. Do not rerun the original query or alter cursor flags. Continuation reads saved output without repository preparation, reindexing, or watcher startup. Printed recovery and expansion commands are different: run those only when their omitted evidence matters.

Prefer human output for agent reading. If a model-facing consumer genuinely needs JSON, add `--json --agent-output`; add `--result-only` only when the common envelope is unnecessary, and drain every emitted cursor before interpreting the result. Never send raw `--json` output through a model-facing terminal or tool. When a program needs the exhaustive machine payload, use `--json --json-output <path>` and inspect that file programmatically instead of injecting its complete contents into model context.

`inspect --view behavior` returns connected behavior for named units; `code` returns exact source. Treat source rendered by either command as already read. Batch independent roots and source gaps when practical. Use native tools only for edits, checks, binary content, or a specific unsupported gap reported by scip-query. After edits, use `diff-impact` when downstream consumers matter, `architecture` for declared boundaries, and `health` for configured quality or cleanup detectors.
