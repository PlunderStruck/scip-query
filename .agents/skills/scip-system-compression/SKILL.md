---
name: scip-system-compression
description: Use when Codex needs to understand a codebase, module, CLI, subsystem, or feature at a high level with SCIP query evidence, inventory all conceptual compression opportunities up front, order them by dependency, and propose or execute a simpler architecture. Trigger on requests to "zoom out", "think in principle", "simplify the architecture", "eliminate layers", "consolidate scripts/commands/helpers", "find the deeper pattern", "make this system more elegant", "think ahead", "compress the system", or reason about duplicated roles even when the code is not textually similar.
---

# SCIP System Compression

## Purpose

Use this skill to move between concrete SCIP-backed code facts and higher-level architectural ideas. The goal is not to find similar code; the goal is to find many code units that are doing the same kind of work in principle, build a whole-scope map of the compression opportunities before editing, then propose or execute fewer mechanisms that preserve the same behavior.

This is not a score-improvement workflow. Do not optimize for health scores, strict scores, issue counts, detector counts, or any other numeric proxy. Use diagnostic commands only to find evidence. Judge success by whether the code now has fewer, clearer mechanisms that still preserve the required behavior.

## Core Terms

System compression names an architecture investigation over real code units such as files, symbols, command handlers, query modules, helper layers, renderers, and tests; it identifies when several concrete mechanisms are separate expressions of one deeper role and replaces them, conceptually or in code, with fewer mechanisms that still explain and produce the same observed behavior.

An abstraction ladder is an ordered set of descriptions of the same codebase facts, starting with files and symbols, rising through workflows and roles, and ending in principles that explain why those workflows exist. It lets the agent change the amount of detail without losing contact with the original code.

A role is the job a code unit performs in a workflow, such as translating user input, choosing a policy, building a graph, running an analysis, formatting output, or preserving a public API. The role is identified by the effect the unit has on data, control flow, or users, not by the names or syntax it happens to use.

A principle is a general codebase fact that explains many role-level observations at once. For example, "CLI commands parse options, call a pure query, and render rows" is a principle if it predicts the structure of several commands and explains why their concrete handlers look related.

A mechanism is the actual code structure that makes behavior happen: functions, classes, tables, registries, scripts, config files, tests, command builders, dispatch maps, SQL fragments, and module boundaries.

Evidence is an observed fact from compiler-backed SCIP data, semantic augmentation, source inspection, tests, or runtime output. Treat an architectural claim as unproven until it names the concrete evidence that led to it.

An execution shape is the recurring control-flow form behind several concrete units, such as "open database, run pure query, render rows" or "read project config, inspect environment, print readiness." Use shapes to group unlike-looking code by what must happen in what order.

A compression audit is a check after designing or implementing a simplification: it asks whether the change removed a concept, policy, branch family, or hand-maintained surface, or merely moved the same complexity into a new large file.

A compression atlas is a temporary work map over the selected repository, module, or feature; it records real files, symbols, roles, opportunities, dispositions, ordering constraints, and validation commands so the agent acts from a whole-system view instead of repeatedly rediscovering local chances to simplify.

A compression opportunity is an observed chance to replace, merge, delete, inline, generate, or enforce one or more mechanisms because concrete code evidence shows they are separate expressions of the same role, policy, lifecycle, or public surface.

An opportunity ledger is the accounting table for those opportunities; it assigns each opportunity exactly one disposition such as keep, skip, defer, supersede, merge, delete, inline, extract, generate, or enforce, which prevents already-understood work from reappearing as a "new" idea after nearby code changes.

A dependency order is the sequence of proposed changes arranged by what each change makes possible or safer. It puts enabling compressions, such as shared policy definitions or descriptor tables, before the cleanup steps that depend on them.

A deferred register is the written list of opportunities deliberately left out of the current implementation; each entry names the opportunity, the verified blocking fact, why it is not part of the current ordered clusters, and what concrete condition would make it eligible again.

A rework loop is repeated editing of the same file, symbol family, or role because the earlier pass handled one visible symptom without accounting for the wider opportunity set and dependency order.

## Workflow

### 1. Bound the Inquiry

Identify the user's target: whole repository, module, command family, feature, or suspected mess. If the scope is vague, start broad and state the assumed scope before running commands.

Prefer a question shaped like:

```text
What is this part of the system trying to do, what roles recur across it, and what smaller mechanism could produce the same behavior?
```

Do not start by proposing a refactor. Start by discovering the current system.

If the target is broad, assume the user wants an atlas-first compression pass. Do not edit code until the compression atlas has enough coverage to account for all obvious subsystem-level opportunities in the chosen scope.

### 2. Build a Concrete Evidence Base

Use `rg --files` and `rg` for filesystem and text orientation. Use SCIP query for code intelligence. Reindex first when the index is missing, stale, or the user asks for current graph facts.

Useful first-pass commands:

```bash
scip-query stats
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

For broad scopes, also sample the repository by directory and entry point so unlike-looking conceptual repetition is visible before a plan forms:

```bash
scip-query system .
scip-query surface .
scip-query files .
scip-query stats
```

Use the first pass to decide which subsystems deserve deeper ladders, not to choose the first refactor.

### 3. Build the Compression Atlas

For substantial work, write down a compression atlas before implementation. The atlas is a visible planning artifact, not only private reasoning. If filesystem edits are allowed, save it before code changes under `docs/plans/` or `reports/compression/` with a date and scope in the filename, such as `docs/plans/YYYY-MM-DD-<scope>-compression-atlas.md`. If those directories do not exist, create the most locally appropriate one. If the user explicitly asks not to create files, include the atlas in the response instead. Load `references/compression-atlas.md` when you need the full template.

The atlas must include:

```text
Scope Map: directories, entry points, public surfaces, tests, generated artifacts
Role Inventory: recurring roles and execution shapes, tied to files and symbols
Opportunity Ledger: every discovered opportunity with evidence and one disposition
Deferred Register: every deferred opportunity with a blocking fact and revisit condition
Compression Clusters: opportunities grouped by shared root cause or enabling mechanism
Dependency Order: what must happen first, what can batch together, what should wait
Touch Map: files/symbols each cluster will edit, including overlap and conflict risks
Validation Plan: commands or tests for each cluster and for the final audit
```

The ledger is mandatory when the user asks to "think ahead", "do everything at once", "avoid rework", or compress a whole subsystem. Do not leave an opportunity unaccounted because it is small; small opportunities can be marked skip or batch. The saved atlas path must be reported before or alongside any implementation summary.

Default to action, not deferral. Large or cross-cutting changes are in scope when they are the right compression; make them executor-ready, order them safely, and implement them when the current task asks for code changes. Do not defer merely because a change is major, touches many files, requires a new central mechanism, or needs careful sequencing.

Use these dispositions:

- `merge`: combine mechanisms that perform the same role
- `delete`: remove a mechanism proven unused or replaced
- `inline`: remove a wrapper, adapter, or single-use abstraction
- `extract`: isolate a real shared role that multiple consumers need
- `generate`: derive a surface from metadata instead of maintaining it by hand
- `enforce`: centralize a policy or invariant so callers cannot drift
- `supersede`: absorb a local issue into a larger compression cluster
- `defer`: keep the opportunity visible but out of the current migration only because of a verified blocker
- `skip`: reject the opportunity because the compression is false, too costly, or net-negative

Use `defer` only when at least one of these is true:

- the opportunity is outside the user's stated scope
- required evidence is unavailable and guessing would risk behavior
- it depends on an earlier cluster that has not been implemented yet
- it would conflict with unrelated user changes in the current worktree
- it requires external input, generated artifacts, or runtime access that is currently unavailable
- it is valid but the user explicitly limited this run to a smaller slice

Every deferred opportunity must appear in the deferred register with: opportunity ID, evidence, blocking fact, dependency or owner, revisit condition, and whether it should be handled in the next compression pass.

Reject a plan that starts editing before it can answer:

- What full set of opportunities is this edit part of?
- Which later opportunities become easier after this edit?
- Which earlier opportunities would make this edit unnecessary?
- What file-touch conflicts or public surfaces constrain the order?
- Which discovered opportunities are deliberately skipped or deferred, and what written evidence justifies each deferral?

### 4. Climb the Abstraction Ladder

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

Add each ladder's compression pressure to the atlas ledger. A pressure that never becomes a ledger item is only a note, not a plan.

### 5. Find Same-In-Principle Repetition

Look for repeated roles across unlike code:

- command handlers that all parse options, open the database, call one query, render sections, and close resources
- help text, README text, command metadata, and tests that all describe the same command surface
- query modules that each build equivalent graph structures before applying different filters
- language-specific branches that share one dispatch shape
- maintenance, dead-code, redundant-export, and liveness checks that carry separate definitions of reachability
- scripts that perform separate concrete steps of one lifecycle
- wrappers, pass-throughs, and adapters that preserve an old surface after the real concept moved

Ask: "What are these all instances of?" Then ask: "What single mechanism would make those instances natural?"

Cluster opportunities by root cause, not by surface trait. Prefer clusters such as "one reachability policy", "one command execution shape", or "metadata renders command docs" over clusters such as "files in src/queries" or "similar function names."

### 6. Generate Competing Compression Models

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

Before choosing a model, update the atlas:

- mark which opportunities the model handles, supersedes, defers, or rejects
- record the new mechanism that will own each role, policy, lifecycle, or surface
- record deletion potential and expected net concept reduction
- order clusters by enabling power, file-touch overlap, public API safety, and validation cost

### 7. Enrich and Sense-Check Before Editing

Turn the selected model into executor-ready clusters. Each cluster must have:

```text
Thesis: the deeper role or policy being compressed
Evidence: files, symbols, traces, tests, or docs that prove the role exists
Old Mechanisms: concrete mechanisms that will disappear or shrink
New Mechanism: the smaller mechanism that will own the behavior
Steps: ordered file/symbol actions, not vague "clean up" instructions
Validation: focused tests, scip-query checks, or runtime commands
```

Then run a pre-edit sense-check:

- Content check: every step names existing files or symbols and matches source evidence
- Structure check: overlapping clusters have an explicit order or are merged
- Value check: the plan deletes, generates, or enforces complexity instead of adding a larger abstraction
- Rework check: no step edits a file that a prior enabling cluster would later rewrite again
- Public-surface check: command names, API exports, file formats, help text, docs, and tests that must stay stable are named
- Ambition check: any major compression is either planned in dependency order or appears in the deferred register with a real blocker

Skip or split clusters that fail the value check. Defer only for verified blockers listed in the deferred register. Prefer deletion, inlining, and policy centralization over adding broad frameworks. A new abstraction is justified only when it removes more conceptual machinery than it adds.

### 8. Descend Back to Concrete Proof

Before recommending or implementing a compression, prove it against the code:

```bash
scip-query trace <key-symbol>
scip-query call-graph <key-symbol>
scip-query affected <key-symbol>
scip-query change-surface <touched-file>
```

Read the source for every key symbol named in the proposal. Check tests around the public behavior. If docs, help output, generated files, or command-line text are involved, inspect those artifacts directly.

If implementing, execute in dependency order by cluster. Avoid rescanning or replanning after every small edit unless a falsifying fact appears; instead, finish the current cluster, validate it, update the atlas ledger, then continue.

When the right compression is large, do not shrink it into cosmetic local edits. Break it into ordered clusters, write the atlas, protect public behavior with validation, then make the major change.

After each implemented cluster, run the audit with concrete evidence:

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

### 9. Report in Compression Form

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

Opportunity Ledger
Each discovered opportunity with disposition: handled, superseded, deferred, skipped, or out of scope.

Deferred Register
Every deferred opportunity, the verified blocker, and the concrete revisit condition.

Dependency Order
The cluster order and the reason earlier clusters enable later ones.

Compression Audit
State whether the proposal deletes complexity, generates/enforces it, or merely relocates it. Name the largest new pressure point if one remains.

Migration Plan
Atlas-backed ordered clusters, each with concrete steps and validation.

Risks
The facts that could falsify the compression or make it too expensive.
```

If the user asked for implementation, still write down the atlas, thesis, ledger, and dependency order before editing unless the scope is tiny or the user forbids file creation. Then implement the ordered clusters that are safe in the current turn, run focused tests, update the saved atlas audit when useful, and report the evidence.

## Guardrails

Do not confuse textual duplication with conceptual duplication. Textual duplication is repeated code; conceptual duplication is repeated responsibility. They often overlap, but either can exist without the other.

Do not package-deal unrelated concerns. A package-deal is a false grouping that treats different things as one because they share a surface trait while ignoring the more important facts that distinguish them.

Do not invent a "clean architecture" vocabulary unless it identifies the actual referents in this codebase. Prefer the project's existing names when they already isolate the right concepts.

Do not let `health`, `similar`, or `stale-abstractions` decide the answer. They are instruments, not judgment. Use them to find clues; use source reading and SCIP graph facts to validate.

Do not let the implementation loop become the discovery mechanism. Discovery produces the atlas; implementation follows it and changes course only when new verified facts falsify the plan.

Do not measure compression success by health score movement, issue count reduction, or detector output. A compression succeeds when it removes or clarifies real mechanisms while preserving behavior, even if a score does not move.

Do not use deferral as a way to avoid major but correct cleanup. Deferral is a recorded exception for blocked, out-of-scope, or dependency-gated opportunities; otherwise, plan the work and do it.
