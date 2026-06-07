---
name: scip-system-compression
description: Use when Codex needs to understand a codebase, module, CLI, subsystem, or feature at a high level with SCIP query evidence and then propose a simpler, more coherent architecture. Trigger on requests to "zoom out", "think in principle", "simplify the architecture", "eliminate layers", "consolidate scripts/commands/helpers", "find the deeper pattern", "make this system more elegant", or reason about duplicated roles even when the code is not textually similar.
---

# SCIP System Compression

## Purpose

Use this skill to move between concrete SCIP-backed code facts and higher-level architectural ideas. The goal is not to find similar code; the goal is to find many code units that are doing the same kind of work in principle, then propose a smaller mechanism that preserves the same behavior.

## Core Terms

System compression names an architecture investigation over real code units such as files, symbols, command handlers, query modules, helper layers, renderers, and tests; it identifies when several concrete mechanisms are separate expressions of one deeper role and replaces them, conceptually or in code, with fewer mechanisms that still explain and produce the same observed behavior.

An abstraction ladder is an ordered set of descriptions of the same codebase facts, starting with files and symbols, rising through workflows and roles, and ending in principles that explain why those workflows exist. It lets the agent change the amount of detail without losing contact with the original code.

A role is the job a code unit performs in a workflow, such as translating user input, choosing a policy, building a graph, running an analysis, formatting output, or preserving a public API. The role is identified by the effect the unit has on data, control flow, or users, not by the names or syntax it happens to use.

A principle is a general codebase fact that explains many role-level observations at once. For example, "CLI commands parse options, call a pure query, and render rows" is a principle if it predicts the structure of several commands and explains why their concrete handlers look related.

A mechanism is the actual code structure that makes behavior happen: functions, classes, tables, registries, scripts, config files, tests, command builders, dispatch maps, SQL fragments, and module boundaries.

Evidence is an observed fact from compiler-backed SCIP data, semantic augmentation, source inspection, tests, or runtime output. Treat an architectural claim as unproven until it names the concrete evidence that led to it.

An execution shape is the recurring control-flow form behind several concrete units, such as "open database, run pure query, render rows" or "read project config, inspect environment, print readiness." Use shapes to group unlike-looking code by what must happen in what order.

A compression audit is a check after designing or implementing a simplification: it asks whether the change removed a concept, policy, branch family, or hand-maintained surface, or merely moved the same complexity into a new large file.

## Workflow

### 1. Bound the Inquiry

Identify the user's target: whole repository, module, command family, feature, or suspected mess. If the scope is vague, start broad and state the assumed scope before running commands.

Prefer a question shaped like:

```text
What is this part of the system trying to do, what roles recur across it, and what smaller mechanism could produce the same behavior?
```

Do not start by proposing a refactor. Start by discovering the current system.

### 2. Build a Concrete Evidence Base

Use `rg --files` and `rg` for filesystem and text orientation. Use SCIP query for code intelligence. Reindex first when the index is missing, stale, or the user asks for current graph facts.

Useful first-pass commands:

```bash
scip-query stats
scip-query health
scip-query system <module-or-directory>
scip-query surface <module-or-directory>
scip-query deps <file>
scip-query rdeps <file>
```

Useful focused commands:

```bash
scip-query symbols <file>
scip-query outline <file>
scip-query trace <symbol>
scip-query call-graph <symbol>
scip-query affected <symbol>
scip-query change-surface <file>
```

Useful compression signals:

```bash
scip-query similar
scip-query similar-files
scip-query similar-chains
scip-query extract-candidates
scip-query wrapper-candidates
scip-query passthrough-candidates
scip-query stale-abstractions
scip-query drift
```

Treat similarity commands as starting points, not boundaries. If two units have the same role but different code, keep investigating.

### 3. Climb the Abstraction Ladder

For each important subsystem, write a short ladder:

```text
Concrete: files, symbols, commands, tests, data stores
Workflow: user or caller path through those units
Roles: what each unit contributes to the workflow
Principle: the general rule that explains several roles together
Pressure: why the current mechanisms feel too numerous, indirect, or inconsistent
```

Keep the ladder tied to evidence. Every role-level or principle-level sentence should be traceable back to files, symbols, call graphs, references, docs, tests, or observed command output.

When the target is a command surface, API surface, worker set, or script family, add an execution-shape inventory:

```text
Shape: name the lifecycle in one sentence
Units: commands/files/functions that follow it
Required order: setup -> policy -> core operation -> rendering/effects
Variant points: inputs, query function, budget, renderer, error behavior
Non-members: similar-looking units that must stay separate and why
```

If most units fit a few shapes, the next abstraction should usually encode those shapes rather than only moving code into themed files.

### 4. Find Same-In-Principle Repetition

Look for repeated roles across unlike code:

- command handlers that all parse options, open the database, call one query, render sections, and close resources
- help text, README text, command metadata, and tests that all describe the same command surface
- query modules that each build equivalent graph structures before applying different filters
- language-specific branches that share one dispatch shape
- health, dead-code, redundant-export, and liveness checks that carry separate definitions of reachability
- scripts that perform separate concrete steps of one lifecycle
- wrappers, pass-throughs, and adapters that preserve an old surface after the real concept moved

Ask: "What are these all instances of?" Then ask: "What single mechanism would make those instances natural?"

### 5. Generate Competing Compression Models

For any substantial proposal, produce at least two possible models before choosing one. For ambiguous or high-leverage refactors, produce three: a conservative model, a shape-level model, and a radical model. Load `references/compression-patterns.md` when you need a pattern catalog.

Evaluate each model by:

- Behavior preserved: user-visible outputs, public API names, file formats, command names, and test expectations that must remain stable
- Concept count: how many distinct ideas future maintainers must understand
- Blast radius: files and symbols touched, measured with `affected`, `change-surface`, `deps`, and `rdeps`
- Deletion potential: scripts, branches, local policies, hand-written docs, or adapters that become unnecessary
- Failure mode: what would go wrong if the abstraction is false
- Migration path: smallest reversible sequence of edits
- Compression audit: what becomes impossible, unnecessary, generated, or enforceable after the change

Prefer the model that removes a concept or policy duplication. Do not prefer a model merely because it extracts a helper.

Reject a model that creates a new thousand-line center unless that center is a temporary migration step and the next compression step is explicit.

### 6. Descend Back to Concrete Proof

Before recommending or implementing a compression, prove it against the code:

```bash
scip-query trace <key-symbol>
scip-query call-graph <key-symbol>
scip-query affected <key-symbol>
scip-query change-surface <touched-file>
```

Read the source for every key symbol named in the proposal. Check tests around the public behavior. If docs, help output, generated files, or command-line text are involved, inspect those artifacts directly.

If you already made a compression, run the audit with concrete evidence:

```bash
scip-query system <new-center-or-module>
scip-query surface <new-center-or-module>
scip-query symbols <largest-new-file>
scip-query similar-signatures --min-loc 5
scip-query wrapper-candidates --max-loc 20
scip-query passthrough-candidates
scip-query drift
```

Then answer: what old mechanisms disappeared, what new mechanisms appeared, and which new file or symbol is now the next pressure point?

Reject or narrow the proposal when:

- the supposedly shared role hides different user-visible semantics
- the abstraction would require a large parameter object with many unrelated flags
- the new layer preserves all old layers instead of removing or clarifying one
- the evidence comes only from names, comments, or vibes
- the plan cannot name the concrete code that would disappear or become simpler

### 7. Report in Compression Form

Use this output shape unless the user requested a different artifact:

```text
Current System Model
One paragraph that explains the subsystem from concrete evidence.

Compression Thesis
One sentence naming the deeper principle and the smaller mechanism.

Evidence
Bullets with commands/files/symbols that support the thesis.

Proposed Shape
The new conceptual structure, including what owns the policy, workflow, or data.

What Disappears
Specific scripts, branches, duplicated policies, hand-maintained text, or helper layers that become unnecessary.

Compression Audit
State whether the proposal deletes complexity, generates/enforces it, or merely relocates it. Name the largest new pressure point if one remains.

Migration Plan
Small ordered steps, each with validation.

Risks
The facts that could falsify the compression or make it too expensive.
```

If the user asked for implementation, still produce the compression thesis internally before editing. Then make the smallest change that proves the new shape, run focused tests, and report the evidence.

## Guardrails

Do not confuse textual duplication with conceptual duplication. Textual duplication is repeated code; conceptual duplication is repeated responsibility. They often overlap, but either can exist without the other.

Do not package-deal unrelated concerns. A package-deal is a false grouping that treats different things as one because they share a surface trait while ignoring the more important facts that distinguish them.

Do not invent a "clean architecture" vocabulary unless it identifies the actual referents in this codebase. Prefer the project's existing names when they already isolate the right concepts.

Do not let `health`, `similar`, or `stale-abstractions` decide the answer. They are instruments, not judgment. Use them to find clues; use source reading and SCIP graph facts to validate.
