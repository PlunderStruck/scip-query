---
name: scip-explore
description: Use to understand a system before editing it: what calls what, how data flows, what depends on it, what a change would reach, and what historically changed together. Includes choosing high-signal commands for an unfamiliar language and rendering the result as a flow, dependency, or blast-radius diagram. For understanding a failure mode class rather than this codebase, use `engineering-lenses`.
commands:
  - template: "scip-query system <module-or-scope>"
    when: "Orient to a module's files, symbols, dependencies, and consumers."
  - template: "scip-query trace <entry-symbol>"
    when: "Connect an entry symbol to its definition and references."
  - template: "scip-query affected <symbol> --json"
    when: "Measure the transitive downstream blast radius of a change."
---

## Purpose

Build verified understanding of how a system works end to end — entry points, call flow, data flow, dependencies, consumers, and risk — before answering or editing. Exploration means tracing code from entry points to effects against the SCIP index, not against memory or folder guesses. Load shared mechanics from `../_shared/SKILL.md`; use this skill's own shortlist first and open `_shared` only when it is insufficient.

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query system <module-or-scope>` | Full module map: files, symbols, deps in/out | module file paths; exported symbols with line ranges; internal dependencies; reverse dependencies | `complete` | Orient to a module's files, symbols, dependencies, and consumers. |
| `scip-query trace <entry-symbol>` | Trace a symbol: definition + all references | definition sites with source and signature; referencing files with line numbers | `bounded` | Connect an entry symbol to its definition and references. |
| `scip-query affected <symbol> --json` | Transitive closure of symbols that could break if this symbol changes | affected symbol identities, files, and traversal depths | `bounded` | Measure the transitive downstream blast radius of a change. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Evidence rules (apply to every step below)

- Use a current index before trusting graph facts: check `scip-query status --capabilities` freshness (`_shared` has the exact command); reindex if it reports `stale`, `missing`, or `unknown`.
- Relationship, consumer, and completeness claims must cite a `scip-query` command. Literal local-source claims may cite a native file read instead.
- Resolve ambiguous symbols before describing behavior — `scip-query code` is the usual tool, but it isn't mandatory when you already have an exact native range.
- Follow the graph before trusting folder structure. Start wide, then narrow.
- Descriptions need citations; conclusions need discriminators. A conclusion — why something happens, what a unit is for, which intent explains a shape — must state one rival explanation and the trace evidence that ruled it out.

Each `scip-query` command below carries a coverage rating: **complete** (exhaustive) or **bounded** (capped — a follow-up command may be needed to fill in the picture).

## The core workflow

Run these five steps in order. Skip a step only when its evidence is already in hand from an earlier step.

**1. Orient.** Run `stats` (repo-wide size/shape, complete), `kind-counts`, `system <module-or-scope>` (file paths, exported symbols with line ranges, internal/reverse deps, complete), `outline <entry-file>`, and `by-kind function --scope <scope>`.
Done when: module files, key symbols, dependencies, and reverse dependencies are mapped.

**2. Trace entry points.** Run `trace <entry-symbol>` (definition + every reference, bounded), `call-graph <entry-symbol>` (incoming callers, outgoing callees, bounded), `code <entry-symbol>`, `dataflow <entry-symbol>` — repeat for important callees until the path reaches a side effect, a returned value, or a terminal output.
Done when: the traced path connects entry point to observable effect.

**3. Map dependencies and consumers.** Run `deps <file>`, `rdeps <file>`, `fan-out <file>`, `surface <module>`, `affected <symbol> --json` (transitive closure of symbols that could break if this symbol changes: identities, files, traversal depths, bounded).
Done when: direct dependencies, public surface, and downstream blast radius are named.

**4. Follow data and state.** Run `dataflow <symbol-or-variable>` (definition sites, usage sites, producers, consumers, bounded), `slice <symbol-or-variable>`, `slice <symbol-or-variable> --forward`.
Done when: producers, transformations, storage, and consumers are identified — or explicitly marked unavailable.

**5. Assess risk.** Run `complexity <symbol>`, `complexity-hotspots`, `bottlenecks`, `change-surface <file>` (pre-change briefing: exports, consumers, blast-radius risk), `cycles`, `deep-chains --min-depth 5` (longest condensed dependency-component chains — flags fragile long call paths).
Done when: the explanation names the risky symbols, or states that no relevant risks appeared.

## Route by question type

| Question | Commands |
|---|---|
| Function behavior | `code`, `hierarchy`, `call-graph`, `dataflow`, `complexity` |
| User-action flow | `files` or `outline` to find the handler, then `code` and `call-graph` down the path |
| Safe to change? | `change-surface`, `affected`, `similar` |
| Module architecture | `system`, `surface`, `deep-chains`, `bottlenecks`, `cycles`, `hotspots` (`hotspots` lists the most-referenced symbols — choke points where any change ripples widely) |
| Relationship between two units | `coupling`, `similar --plan`, `similar-chains` |

## Other owned commands

These four don't have a dedicated workflow step above but come up constantly once you're inside a module — use them as needed, not in sequence:

- **`imported-by <symbol>`** — which files import this symbol. Run before changing or removing a shared export, to know exactly which files to check. If the list is empty, confirm with `dead` before deleting rather than trusting the empty result alone.
- **`unused-imports <file>`** — imports not referenced in that same file. Run on a file you're about to touch, or one a de-bloat pass flagged; remove only entries you've confirmed are safe.
- **`similar-signatures`** — functions with near-identical type signatures. Run when hunting duplicate-shaped functions to consolidate. This is a *good-with-review* signal — check each match with `code` before merging, don't act on the list alone.
- **`co-change [file]`** — files that change together in git history with no dependency edge between them: hidden coupling. Run when `change-surface` or `affected` reports a small blast radius but you suspect the graph is missing something. This is also *good-with-review* — a paired file is a prompt to check manually, not proof the current change must touch it too. (`diff-gate`'s `co-change-partner` check is the automated version of this same signal.)

## Report the exploration

Cover: overview, entry points, call flow, data flow, dependencies, consumers, risk areas, and the command citation that proves each claim. For every conclusion-bearing claim, name the rival explanation you considered and the evidence that ruled it out. Exploration is complete only when the reader can see what was proven, what remains unverified, and which conclusions rest on a discriminator rather than a single story.

## Deeper references

| Need | Reference |
|---|---|
| Entering an unfamiliar language (TypeScript, Python, Java, Scala, Kotlin, Rust, Go, C, C++, Ruby, C#, Visual Basic, Dart, PHP, Clojure/ClojureScript, Vue) and picking the highest-signal commands, including de-bloat sets | `references/language-playbook.md` |
| Turning exploration evidence into an HTML flow, dependency, data-flow, or blast-radius diagram | `references/diagrams.md` |

## Constraint

scip-explore's OpenAI-agent interface binds to display name "SCIP Explore" with default prompt "Use $scip-explore to understand this system end to end with SCIP-backed code evidence."
