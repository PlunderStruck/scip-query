---
name: scip-query
description: Explore code, plan changes around existing owners and patterns, and review actual changes for complexity, duplication and dependency problems. Use exact source and explicit relationship evidence; preserve behavior and disclose unsupported claims.
metadata:
  commands:
    - template: 'scip-query health'
      when: 'Find concrete TS/JS issues in current source, including on first use without an index.'
    - template: 'scip-query context <symbol>'
      when: 'Gather existing implementations, reuse candidates and consumers before planning a change.'
    - template: 'scip-query review --base HEAD'
      when: 'Review every changed or new function and current-source findings before handing off a change.'
    - template: 'scip-query diff-impact'
      when: 'Map changed symbols and downstream consumers after confirming index freshness.'
---

# scip-query

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query health` | Find concrete TS/JS issues in current source, including on first use without an index. |
| `scip-query context <symbol>` | Gather existing implementations, reuse candidates and consumers before planning a change. |
| `scip-query review --base HEAD` | Review every changed or new function and current-source findings before handing off a change. |
| `scip-query diff-impact` | Map changed symbols and downstream consumers after confirming index freshness. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

scip-query is a code analysis tool that links source locations to measured structure and observed relationships. A finding identifies concrete code and evidence of a possible problem. A candidate requires investigation; it does not authorize a refactor. An owner is the implementation responsible for enforcing a rule or controlling a resource, established from its behavior and consumers.

## Work loop

1. **Orient.** On first adoption or an explicit cleanup task, run `scip-query health`. It reads current TS/JS source without requiring an index or baseline. Read its grouped subjects, source exclusions, import-resolution counts and missing architecture-policy rows. Directory membership is location evidence; mixed-responsibility findings require confirming the actual contracts. Use `health --indexed` for existing language, framework, drift and cleanup specialists when those questions matter. Do not run every detector as a ritual.
2. **Explore.** State the material facts needed for the task. Locate exact text with `scip-query search`, symbols in a known file with `outline`, or an external root with `entrypoints`. Read existing implementations, sibling outcomes, and consumers before choosing an owner. `context <symbol>` gathers reuse and impact candidates; confirm their contracts in source.
3. **Plan.** For a nontrivial change, write a concise plan in the repository's normal documentation location. Cite exact owners and consumers, existing patterns to reuse, behavior and state effects to preserve, dependencies to change, obsolete code to remove, and checks that could detect a regression. Record uncertain ownership explicitly. Continue implementation when the user has authorized it; writing a plan does not create another approval gate.
4. **Implement.** Follow the plan and revise it when evidence changes the design. Keep authorization, error handling, side effects, operation identity, ordering, cleanup, and concurrency guarantees intact. Consolidate implementations only after comparing their actual contracts.
5. **Review.** Run `scip-query review --base <commit>` after edits, normally against `HEAD`. It compares the chosen commit to current files, including untracked files and new functions in old files. Read all changed-function records and candidate sites. Review duplication against existing code, complexity changes, cycles and declared dependencies. Include configuration-only relationship changes. Distinguish production value cycles from type/test dependencies and grouping-only boundary cycles. Use fresh `diff-impact` or explicit evidence when symbol consumers or runtime effects matter. Inspect unsupported portions directly using a reported recovery or native tools for that named gap.
6. **Verify and finish.** Simplify justified problems, run relevant behavioral tests and required repository checks, then rerun review. Explain retained candidates and material coverage gaps. A lower complexity number, passing compiler, empty report, or generated test scaffold does not establish behavioral correctness. Do not commit unless authorized.

## Evidence and freshness

For relationships use repeated `--symbol`, `--at`, or `--search` roots with `scip-query evidence --edge <family> --direction <incoming|outgoing|both> --depth <n> --max-edges <n>`. Choose only relationships needed for the claim: execution for callers/callees; dataflow for value origins/uses; runtime for producer/consumer handoffs; state for resource reads/writes; temporal for ordering; contract for constraints; identity for entity identity; ownership for containment; dependencies for static reliance. Containment alone does not establish responsibility for a business rule.

Use `scip-query inspect --view behavior` for several named behavior gaps, and `code <symbol-or-file:range>` for exact source. Range reads stay local; `code --local-calls` explicitly includes statically attributed same-file callees. Batch independent questions. Do not reread evidence already received. Load `$scip-explore` for a complex end-to-end explanation requiring a private evidence ledger.

Source health/review always read current bytes. Compiler-backed relationships require a current index. Inspect reported freshness after edits. If watching is configured, reuse the watcher for this worktree; `watch --status` shows its state. Respect disabled watching and failed startup. Use the normal bounded refresh or the printed recovery; do not repeatedly start a disabled watcher or silently substitute an expensive rebuild. A missing newly created root is unresolved evidence, not proof that no callers exist.

Exact evidence is directly observed; derived evidence is deterministically calculated; candidate evidence needs confirmation. Accounted coverage accounts for the requested supported projection, not the whole task. Missing, bounded or unsupported output cannot establish absence. Do not treat references, imports or value relationships as executable calls.

CRAP combines cyclomatic complexity (a count of independent decision paths under the printed rules) and measured test coverage. Supply `review --coverage .scipquery/coverage.json` only after recording a real Istanbul test run with the shipped `scripts/record-review-coverage.mjs`. Missing, stale or unmappable coverage is unavailable, never zero. Cognitive complexity measures structural nesting and flow interruptions under the versioned rules; the current source metric does not measure recursion. Read `docs/REVIEW.md` for exact rules and coverage recording.

Prefer human output. For a program, write exhaustive JSON with `--json --json-output <path>`; for model-facing JSON use `--json --agent-output`. Never rerun a successful human command solely to change encoding. Every emitted `Continue exactly:` command is required transport: run it unchanged until no continuation remains. Printed recovery commands are optional expansions only when the omitted fact matters. Stop exploring when the material claims are established.
