---
name: scip-explore
description: Explain how code works, where a feature is implemented, what calls or consumes it, how data flows, or what a change could affect. Uses scip-query to explore an unfamiliar system before answering or editing.
commands:
  - template: 'scip-query stats'
    when: 'Orient: repo-wide size and shape before naming a scope.'
  - template: 'scip-query system <module-or-scope>'
    when: 'Orient: map files, symbols, deps in/out for the scope.'
  - template: 'scip-query trace <entry-symbol>'
    when: 'Trace entry points: definition plus every reference.'
  - template: 'scip-query call-graph <entry-symbol>'
    when: 'Trace entry points: callers and callees for the path.'
  - template: 'scip-query dataflow <symbol-or-variable>'
    when: 'Follow data and state through producers and consumers.'
  - template: 'scip-query affected <symbol> --json'
    when: 'Map dependencies and consumers: downstream blast radius.'
---

# scip-explore

Use this skill to produce verified understanding. Exploration is the evidence pass that traces code from entry points to effects using the SCIP index rather than memory or folder guesses.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query stats` | Show index statistics | document, symbol, definition, reference, size, and build-time totals | `complete` | Orient: repo-wide size and shape before naming a scope. |
| `scip-query system <module-or-scope>` | Full module map: files, symbols, deps in/out | module file paths; exported symbols with line ranges; internal dependencies; reverse dependencies | `complete` | Orient: map files, symbols, deps in/out for the scope. |
| `scip-query trace <entry-symbol>` | Trace a symbol: definition + all references | definition sites with source and signature; referencing files with line numbers | `bounded` | Trace entry points: definition plus every reference. |
| `scip-query call-graph <entry-symbol>` | Show incoming callers and outgoing callees for a symbol | caller and callee symbol identities with files | `bounded` | Trace entry points: callers and callees for the path. |
| `scip-query dataflow <symbol-or-variable>` | Reference-level dataflow: definition sites, usage sites, producers, consumers | definition sites, usage sites, producer symbols, and consumer symbols | `bounded` | Follow data and state through producers and consumers. |
| `scip-query affected <symbol> --json` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Map dependencies and consumers: downstream blast radius. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Use a current index before trusting graph facts.
2. Relationship, consumer, and completeness claims cite scip-query; literal local-source claims may cite a native file read.
3. Resolve ambiguous symbols before describing behavior. `scip-query code` is useful but not mandatory when an exact native range is already known.
4. Follow the graph before trusting folder structure.
5. Start wide, then narrow.
6. Descriptions need citations; conclusions need discriminators. A conclusion — why something happens, what a unit is for, which intent explains a shape — states one rival explanation and the trace evidence that rules it out.

## Workflow

### 1. Orient

```bash
scip-query stats
scip-query kind-counts
scip-query system <module-or-scope>
scip-query outline <entry-file>
scip-query by-kind function --scope <scope>
```

This step is complete only when the module files, key symbols, dependencies, and reverse dependencies are mapped.

### 2. Trace entry points

```bash
scip-query trace <entry-symbol>
scip-query call-graph <entry-symbol>
scip-query code <entry-symbol>
scip-query dataflow <entry-symbol>
```

Repeat for important callees until the path reaches side effects, returned values, or terminal outputs.

This step is complete only when the explored path connects entry point to observable effect.

### 3. Map dependencies and consumers

```bash
scip-query deps <file>
scip-query rdeps <file>
scip-query fan-out <file>
scip-query surface <module>
scip-query affected <symbol>
```

This step is complete only when direct dependencies, public surface, and downstream blast radius are named.

### 4. Follow data and state

```bash
scip-query dataflow <symbol-or-variable>
scip-query slice <symbol-or-variable>
scip-query slice <symbol-or-variable> --forward
```

This step is complete only when producers, transformations, storage, and consumers are identified or marked unavailable.

### 5. Assess risk

```bash
scip-query complexity <symbol>
scip-query complexity-hotspots
scip-query bottlenecks
scip-query change-surface <file>
scip-query cycles
scip-query deep-chains --min-depth 5
```

This step is complete only when the explanation includes the risky symbols or states that no relevant risks appeared.

## Question Recipes

- Function behavior: `code`, `hierarchy`, `call-graph`, `dataflow`, `complexity`.
- User action flow: `files` or `outline` for the handler, then `code` and `call-graph` down the path.
- Safety to change: `change-surface`, `affected`, `similar`.
- Module architecture: `system`, `surface`, `deep-chains`, `bottlenecks`, `cycles`, `hotspots`.
- Relationship between units: `coupling`, `similar --plan`, `similar-chains`.

## Report

Report overview, entry points, call flow, data flow, dependencies, consumers, risk areas, and the command citations that prove each claim. For each conclusion-bearing claim, name the rival explanation considered and the evidence that ruled it out. Exploration is complete only when the user can see what was proven, what remains unverified, and which conclusions rest on a discriminator rather than a single story.
