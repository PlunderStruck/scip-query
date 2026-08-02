---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, references, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It gives the agent a repository map; it does not own the task, plan, implementation, or acceptance decision.
commands:
  - template: "scip-query context <target>"
    when: "Map a nonlocal target before planning or editing it."
  - template: "scip-query diff-impact"
    when: "Map changed symbols and downstream consumers after a coherent edit."
  - template: "scip-query architecture"
    when: "Inspect the repository's declared structural rules when boundaries matter."
  - template: "scip-query health --full"
    when: "Inspect React, Vue, duplication, complexity, drift, and cleanup pressure."
---

# scip-query

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query context <target>` | Compiler-backed context for a symbol, file, or module | definitions and references; callers and callees; dataflow producers and consumers; backward and forward slices; affected symbols; change-surface risk; dependencies and reverse dependencies; module files and exports; external surface use; complexity; churn; co-change partners; active suppressions; reuse candidates with evidence class and action tier; possible shared owners found from a bounded scan of affected consumers | `bounded` | Map a nonlocal target before planning or editing it. |
| `scip-query diff-impact` | Map changed symbols and downstream consumers from the current git diff | changed symbols, downstream consumer identities, and impact paths | `bounded` | Map changed symbols and downstream consumers after a coherent edit. |
| `scip-query architecture` | Evaluate project-owned architectural boundaries and dependency rules | boundary coverage and dependency-rule violations | `complete` | Inspect the repository's declared structural rules when boundaries matter. |
| `scip-query health --full` | Composite repository health report with React, Vue, and general cleanup findings | health score, findings, priorities, baselines, and coverage notes | `bounded` | Inspect React, Vue, duplication, complexity, drift, and cleanup pressure. |

Use this shortlist first. Run a command's `--help` only when a named uncertainty needs another option.
<!-- END GENERATED SKILL COMMANDS -->

scip-query is a compiler-backed repository map: a code-reading tool whose
essential service is resolving which named program elements are actually the
same element and how those elements connect. Its referents are definitions,
references, calls, imports, exports, dependencies, changed symbols, and
detector findings in the indexed repository.

The coding agent still owns the goal, ordinary plan, edits, tests, and final
judgment. scip-query supplies evidence that normal text search cannot reliably
supply. It does not create goals, acceptance tests, work records, or completion
permission.

## Working rule

Use native search and file reads for literal text and source. Use scip-query
only when a compiler-resolved relationship can change the plan or reveal
cleanup work.

For a nonlocal change:

1. In the first exploration batch, combine ordinary literal search with one
   `scip-query context <target>` call on the behavior that is wired today. For
   a replacement, retirement, or migration, target the current owner or a
   current production entry point, not the proposed replacement.
2. If the packet reports only test references or no production consumers, it
   is not a map of the live affected surface. Correct the anchor by mapping the
   current owner or one live entry point. This correction is not duplicate
   querying.
3. Treat the source packet as source already read. Do not repeat its graph
   queries, reopen every excerpt, inventory the whole repository, or load
   another scip skill. Add one focused query only when a named uncertainty can
   change the plan.
4. Write the normal concise plan, edit, and run the repository's native checks.
5. In one final verification batch, run `scip-query diff-impact` when
   downstream consumers matter and `scip-query architecture` when declared
   boundaries are in scope. A nonzero architecture result is an unfinished
   repository policy failure, not an informational warning.
6. Run `scip-query health --full` only for a repository-wide cleanup, drift,
   complexity, React, or Vue review. Do not add it merely because a normal
   feature task deletes obsolete code.

The map replaces redundant exploration; it must not become a second workflow.
Batch independent reads and checks into as few model turns as practical.

Compiler-graph results are facts within their stated coverage. Health and
cleanup detectors are candidates: confirm their source before editing. A
bounded result cannot support a claim about every relationship; use `--full`
only when completeness can change a decision.

Prefer human output for model reading. Use `--json --result-only` only for a
programmatic consumer. If output emits `Continue exactly:`, run that command
unchanged until transport is complete. Do not choose an output page size in
advance.

Reuse an unchanged read-only result. Context compaction does not create new
repository evidence.
