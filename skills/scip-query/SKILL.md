---
name: scip-query
description: Use FIRST for codebase work when compiler-resolved identity, references, callers, dependencies, consumers, architecture, change impact, or cleanup relationships can affect the answer. It gives the agent a repository map; it does not own the task, plan, implementation, or acceptance decision.
commands:
  - template: 'scip-query inspect --search <text> [--search <text>...]'
    when: 'Read several related source units across files in one deduplicated packet.'
  - template: 'scip-query search <text>'
    when: 'Find an unknown first anchor from literal routes, events, keys, messages, or other indexed text.'
  - template: 'scip-query evidence <symbol>'
    when: 'Read one definition together with source around its real uses.'
  - template: 'scip-query context <target>'
    when: 'Map a nonlocal target before planning or editing it.'
  - template: 'scip-query diff-impact'
    when: 'Map changed symbols and downstream consumers after a coherent edit.'
  - template: 'scip-query architecture'
    when: "Inspect the repository's declared structural rules when boundaries matter."
  - template: 'scip-query health --full'
    when: 'Inspect React, Vue, duplication, complexity, drift, and cleanup pressure.'
---

# scip-query

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query inspect --search <text> [--search <text>...]` | Batch related searches, symbols, and source locations into one deduplicated source packet | one bounded, deduplicated source packet plus selected symbol relationships and coverage | `bounded` | Read several related source units across files in one deduplicated packet. |
| `scip-query search <text>` | Search literal or regular-expression text in indexed source with nearby code and symbol ownership | matching source windows, file and line identities, owning symbols, and coverage | `bounded` | Find an unknown first anchor from literal routes, events, keys, messages, or other indexed text. |
| `scip-query evidence <symbol>` | Compose related source for one exact symbol in a single evidence view | definition source; deduplicated reference-centered source windows; selected related symbol source and file relationships; explicit ambiguity failure with exact rerun commands | `bounded` | Read one definition together with source around its real uses. |
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

Use scip-query as the primary code-reading surface for indexed source. Source
code records behavior. The SCIP index supplies compiler-resolved identity and
relationships that select the relevant source.

For a nonlocal change:

1. Use `scip-query search <text>` to find an unknown first anchor. Once you
   know several related text, symbol, or file-line anchors, put them in one
   `scip-query inspect` call. It returns deduplicated, syntax-aware source
   units across files. Use `scip-query evidence <symbol>` for one exact
   definition and its use sites. Use `scip-query context <target>` when a
   nonlocal change needs a wider impact and reuse map. For replacement or
   retirement, target the current owner or live entry.
2. If the packet reports only test references or no production consumers, it
   is not a map of the live affected surface. Correct the anchor by mapping the
   current owner or one live entry point. This correction is not duplicate
   querying.
3. Treat every returned source packet as source already read. Do not repeat
   its graph queries, reopen every excerpt, or inventory the repository. Add
   one focused query only when a named uncertainty can change the plan.
4. Write the normal concise plan, edit, and run the repository's native checks.
5. In one final verification batch, run `scip-query diff-impact` when
   downstream consumers matter and `scip-query architecture` when declared
   boundaries are in scope. A nonzero architecture result is an unfinished
   repository policy failure, not an informational warning.
6. Run `scip-query health --full` only for a repository-wide cleanup, drift,
   complexity, React, or Vue review. Do not add it merely because a normal
   feature task deletes obsolete code.

The map replaces redundant exploration. It must not become a second workflow.
Batch independent observations into as few model turns as practical.

Do not build an inventory by running one search, outline, or source read for
every file or symbol. If exploration has become an inventory, stop and put the
named gaps into one `inspect` packet. A focused follow-up is justified only by
an uncertainty that remains after reading that packet.

Compiler-graph results are facts within their stated coverage. Health and
cleanup detectors are candidates: confirm their source before editing. A
bounded result cannot support a claim about every relationship; use `--full`
only when completeness can change a decision.

Prefer human output for model reading. Use `--json --result-only` only for a
programmatic consumer. If output emits `Continue exactly:`, run that command
unchanged until transport is complete. Do not choose an output page size in
advance.

Use a native source read only to edit exact lines or to fill an explicit
coverage gap. Name that gap before the fallback. Do not silently duplicate the
same exploration with text search and full-file reads.

Use `$scip-explore` for an end-to-end explanation. Use `$concrete-plan` for a
non-trivial implementation plan. Reuse an unchanged result after compaction.
