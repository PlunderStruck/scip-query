---
name: scip-system-compression
description: Compress systems with scip-query evidence. Use to zoom out, simplify architecture, eliminate layers, consolidate commands, scripts, or helpers, find the deeper role behind unlike-looking code, build a compression atlas before a large cleanup, or execute an ordered simplification without rework.
metadata:
  commands:
    - template: 'scip-query system <scope>'
      when: 'Map a module or directory: files, exported symbols, dependencies in and out.'
    - template: 'scip-query surface <scope>'
      when: 'See which symbols consumers actually use from the scope.'
    - template: 'scip-query outline <file>'
      when: 'Inventory one file before assigning its units to roles.'
    - template: 'scip-query trace <symbol>'
      when: 'Prove a key symbol: definition plus every reference.'
    - template: 'scip-query call-graph <symbol>'
      when: 'Prove a key symbol: callers and callees along its execution shape.'
    - template: 'scip-query affected <symbol>'
      when: 'Measure blast radius before choosing a compression model.'
    - template: 'scip-query change-surface <file>'
      when: 'Measure exports, consumers, and risk for a file a cluster will touch.'
    - template: 'scip-query similar --cross-file-only'
      when: 'Signal: functions with overlapping callee sets across files.'
    - template: 'scip-query similar-files'
      when: 'Signal: files with overlapping dependency profiles.'
    - template: 'scip-query similar-chains'
      when: 'Signal: parallel end-to-end flows that diverge at a few points.'
    - template: 'scip-query extract-candidates'
      when: 'Signal: large functions with isolated callee clusters.'
    - template: 'scip-query wrapper-candidates'
      when: 'Signal: single-consumer indirection that a compression may absorb.'
    - template: 'scip-query passthrough-candidates'
      when: 'Signal: pure forwarding functions.'
    - template: 'scip-query stale-abstractions'
      when: 'Signal: types and classes with zero or one consumer.'
    - template: 'scip-query drift --architecture'
      when: 'Signal: files deviating from sibling conventions and declared boundary violations.'
    - template: 'scip-query diff-impact'
      when: 'Audit after each implemented cluster: changed symbols and downstream consumers.'
    - template: 'scip-query architecture'
      when: 'Audit after each implemented cluster: declared boundaries still hold.'
---

# SCIP System Compression

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query system <scope>` | Map a module or directory: files, exported symbols, dependencies in and out. |
| `scip-query surface <scope>` | See which symbols consumers actually use from the scope. |
| `scip-query outline <file>` | Inventory one file before assigning its units to roles. |
| `scip-query trace <symbol>` | Prove a key symbol: definition plus every reference. |
| `scip-query call-graph <symbol>` | Prove a key symbol: callers and callees along its execution shape. |
| `scip-query affected <symbol>` | Measure blast radius before choosing a compression model. |
| `scip-query change-surface <file>` | Measure exports, consumers, and risk for a file a cluster will touch. |
| `scip-query similar --cross-file-only` | Signal: functions with overlapping callee sets across files. |
| `scip-query similar-files` | Signal: files with overlapping dependency profiles. |
| `scip-query similar-chains` | Signal: parallel end-to-end flows that diverge at a few points. |
| `scip-query extract-candidates` | Signal: large functions with isolated callee clusters. |
| `scip-query wrapper-candidates` | Signal: single-consumer indirection that a compression may absorb. |
| `scip-query passthrough-candidates` | Signal: pure forwarding functions. |
| `scip-query stale-abstractions` | Signal: types and classes with zero or one consumer. |
| `scip-query drift --architecture` | Signal: files deviating from sibling conventions and declared boundary violations. |
| `scip-query diff-impact` | Audit after each implemented cluster: changed symbols and downstream consumers. |
| `scip-query architecture` | Audit after each implemented cluster: declared boundaries still hold. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

## Purpose

Use this skill to move between concrete scip-query code facts and higher-level architectural ideas. The goal is not to find similar code. The goal is to find many code units that are doing the same kind of work in principle, build a whole-scope map of the compression opportunities before editing, then propose or execute fewer mechanisms that preserve the same behavior.

This is not a score-improvement workflow. Do not optimize for health scores, issue counts, or detector counts. Use diagnostic commands only to find evidence. Judge success by whether the code now has fewer, clearer mechanisms that still preserve the required behavior.

`$principal-maintainability-review` ranks smells in one scope. This skill owns the atlas: the whole-system inventory, ordering, and execution of a compression that spans several slices.

## Core Terms

System compression names an architecture investigation over real code units such as files, symbols, command handlers, query modules, helper layers, renderers, and tests. It identifies when several concrete mechanisms are separate expressions of one deeper role and replaces them, conceptually or in code, with fewer mechanisms that still explain and produce the same observed behavior.

An abstraction ladder is an ordered set of descriptions of the same codebase facts, starting with files and symbols, rising through workflows and roles, and ending in principles that explain why those workflows exist. It lets the agent change the amount of detail without losing contact with the original code.

A role is the job a code unit performs in a workflow, such as translating user input, choosing a policy, building a graph, running an analysis, formatting output, or preserving a public API. The role is identified by the effect the unit has on data, control flow, or users, not by the names or syntax it happens to use.

A principle is a general codebase fact that explains many role-level observations at once. "CLI commands parse options, call a pure query, and render rows" is a principle if it predicts the structure of several commands and explains why their concrete handlers look related.

A mechanism is the actual code structure that makes behavior happen: functions, classes, tables, registries, scripts, config files, tests, command builders, dispatch maps, SQL fragments, and module boundaries.

An execution shape is the recurring control-flow form behind several concrete units, such as "open database, run pure query, render rows." Use shapes to group unlike-looking code by what must happen in what order.

A compression atlas is a written work map over the selected scope. It records real files, symbols, roles, opportunities, dispositions, ordering constraints, and validation commands so the agent acts from a whole-system view instead of repeatedly rediscovering local chances to simplify. Load [`references/compression-atlas.md`](references/compression-atlas.md) for the template.

An opportunity ledger is the atlas table that assigns each discovered opportunity exactly one disposition, which prevents already-understood work from reappearing as a "new" idea after nearby code changes.

A deferred register is the written list of opportunities deliberately left out of the current implementation. Each entry names the opportunity, the verified blocking fact, and the concrete condition that would make it eligible again.

A rework loop is repeated editing of the same file, symbol family, or role because an earlier pass handled one visible symptom without accounting for the wider opportunity set and dependency order. The atlas exists to prevent it.

## Workflow

### 1. Bound the inquiry

Identify the target: whole repository, module, command family, feature, or suspected mess. If the scope is vague, start broad and state the assumed scope before running commands.

Prefer a question shaped like:

```text
What is this part of the system trying to do, what roles recur across it, and what smaller mechanism could produce the same behavior?
```

Do not start by proposing a refactor. Start by discovering the current system. Do not edit code until the atlas accounts for all obvious subsystem-level opportunities in the chosen scope.

### 2. Build a concrete evidence base

```bash
scip-query system <scope>
scip-query surface <scope>
scip-query outline <file>
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query affected <symbol>
scip-query change-surface <file>
```

Compression signals, used as starting points rather than boundaries:

```bash
scip-query similar --cross-file-only
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query drift --architecture
```

If two units have the same role but different code, keep investigating. Use the first pass to decide which subsystems deserve deeper ladders, not to choose the first refactor.

### 3. Climb the abstraction ladder

For each important subsystem, write a short ladder:

```text
Concrete: files, symbols, commands, tests, data stores
Workflow: user or caller path through those units
Roles: what each unit contributes to the workflow
Principle: the general rule that explains several roles together
Pressure: why the current mechanisms feel too numerous, indirect, or inconsistent
```

Every role-level or principle-level sentence must be traceable back to files, symbols, call graphs, references, docs, tests, or observed command output.

When the target is a command surface, API surface, worker set, or script family, add an execution-shape inventory:

```text
Shape: name the lifecycle in one sentence
Units: commands, files, or functions that follow it
Required order: setup -> policy -> core operation -> rendering or effects
Variant points: inputs, query function, budget, renderer, error behavior
Non-members: similar-looking units that must stay separate, and why
```

If most units fit a few shapes, the next abstraction should usually encode those shapes rather than only moving code into themed files. Every ladder's pressure becomes a ledger item; a pressure that never becomes a ledger item is only a note.

### 4. Find same-in-principle repetition

Look for repeated roles across unlike code:

- handlers that all parse options, open a resource, call one query, render sections, and close
- help text, README text, command metadata, and tests that all describe the same surface
- query modules that each build equivalent structures before applying different filters
- language- or kind-specific branches that share one dispatch shape
- several checks that carry separate definitions of the same predicate, such as liveness or reachability
- scripts that perform separate concrete steps of one lifecycle
- wrappers, pass-throughs, and adapters that preserve an old surface after the real concept moved

Ask: "What are these all instances of?" Then: "What single mechanism would make those instances natural?" Cluster opportunities by root cause, not by surface trait. Prefer clusters such as "one reachability policy" or "metadata renders command docs" over "files in src/queries" or "similar function names." Load [`references/compression-patterns.md`](references/compression-patterns.md) for a pattern catalog and its anti-patterns.

### 5. Build the atlas

Write the atlas before implementation. Save it under `docs/plans/YYYY-MM-DD-<scope>-compression-atlas.md` unless the user forbids file creation, in which case include it in the response. It must contain: scope map, role inventory, opportunity ledger, deferred register, compression clusters, dependency order, touch map, and validation plan.

Dispositions, exactly one per opportunity:

- `merge`: combine mechanisms that perform the same role
- `delete`: remove a mechanism proven unused or replaced
- `inline`: remove a wrapper, adapter, or single-use abstraction
- `extract`: isolate a real shared role that multiple consumers need
- `generate`: derive a surface from metadata instead of maintaining it by hand
- `enforce`: centralize a policy or invariant so callers cannot drift
- `supersede`: absorb a local issue into a larger compression cluster
- `defer`: keep the opportunity visible but out of the current migration, only because of a verified blocker
- `skip`: reject the opportunity because the compression is false, too costly, or net-negative

Use `defer` only for a verified blocker: outside the stated scope, evidence unavailable, depends on an unimplemented earlier cluster, conflicts with unrelated live edits, needs unavailable runtime or generated artifacts, or the user limited this run. Every deferred entry needs its blocking fact and revisit condition. Do not defer merely because a change is large; if it is the right compression, order it and do it.

Reject a plan that starts editing before it can answer: What full set of opportunities is this edit part of? Which later opportunities become easier after it? Which earlier opportunities would make it unnecessary? What file-touch conflicts or public surfaces constrain the order?

### 6. Generate competing models

For any substantial proposal, produce at least two models; for high-leverage refactors, three: conservative (delete or inline local bloat), shape-level (one small mechanism for a repeated role or lifecycle), and radical (replace a scattered surface with metadata, generation, or enforced policy).

Evaluate each by: behavior preserved, concept count, blast radius (`affected`, `change-surface`), deletion potential, failure mode if the abstraction is false, migration path, and whether it deletes, generates, or enforces complexity rather than relocating it.

Prefer the model that removes a concept or policy duplication. Do not prefer a model merely because it extracts a helper. Reject a model that creates a new thousand-line center unless that center is a temporary migration step and the next compression step is explicit.

### 7. Sense-check, then implement in dependency order

Turn the selected model into executor-ready clusters, each with thesis, evidence, old mechanisms, new mechanism, ordered steps naming files and symbols, and validation. Before editing, check: every step names existing files or symbols; overlapping clusters have an explicit order; the plan deletes, generates, or enforces instead of adding a larger abstraction; no step edits a file a later enabling cluster would rewrite; public surfaces that must stay stable are named.

Read the source for every key symbol in the proposal with `scip-query code`. Implement cluster by cluster. Finish and validate the current cluster before replanning; change course only when a verified fact falsifies the plan. When the right compression is large, do not shrink it into cosmetic local edits.

After each implemented cluster, run the repository's own tests plus:

```bash
scip-query diff-impact
scip-query architecture
scip-query system <new-center-or-module>
scip-query wrapper-candidates
scip-query passthrough-candidates
```

Then answer: what old mechanisms disappeared, what new mechanisms appeared, and which new file or symbol is now the next pressure point?

## Report

```text
Current System Model: one paragraph from concrete evidence.
Compression Thesis: the deeper principle and the smaller mechanism, in one sentence.
Evidence: commands, files, and symbols that support the thesis.
Proposed Shape: what owns the policy, workflow, or data afterward.
What Disappears: specific scripts, branches, duplicated policies, hand-maintained text, or helper layers.
Opportunity Ledger: every discovered opportunity with its disposition.
Deferred Register: every deferral, its verified blocker, and its revisit condition.
Dependency Order: cluster order and why earlier clusters enable later ones.
Compression Audit: whether the proposal deletes, generates or enforces, or merely relocates complexity; the largest remaining pressure point.
Risks: facts that could falsify the compression or make it too expensive.
```

## Guardrails

Do not confuse textual duplication with conceptual duplication. Textual duplication is repeated code; conceptual duplication is repeated responsibility. Either can exist without the other.

Do not package-deal unrelated concerns: a false grouping that treats different things as one because they share a surface trait while ignoring the facts that distinguish them.

Do not invent a "clean architecture" vocabulary unless it identifies actual referents in this codebase. Prefer the project's existing names when they already isolate the right concepts.

Do not let detectors decide the answer. They are instruments, not judgment. Use them to find clues; use source reading and graph facts to validate.

Do not let the implementation loop become the discovery mechanism. Discovery produces the atlas; implementation follows it.
