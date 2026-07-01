---
name: scip-explore
description: Explore codebases with scip-query evidence. Use to explain how a system, feature, module, call path, dependency graph, data flow, architecture, or change risk works before answering or editing.
---

# scip-explore

Use this skill to produce verified understanding. Exploration is the evidence pass that traces code from entry points to effects using the SCIP index rather than memory or folder guesses.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Rules

1. Use a current index before trusting graph facts.
2. Every behavior, path, consumer, and risk claim cites a scip-query command.
3. Read source with `scip-query code`; do not describe what a function probably does.
4. Follow the graph before trusting folder structure.
5. Start wide, then narrow.

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
- Relationship between units: `coupling`, `convergence`, `similar-chains`.

## Report

Report overview, entry points, call flow, data flow, dependencies, consumers, risk areas, and the command citations that prove each claim. Exploration is complete only when the user can see what was proven and what remains unverified.
