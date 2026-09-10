---
name: scip-query
description: Use code relationships, module structure, quality findings and change impact to plan and review changes alongside ordinary source-reading tools.
---

# SCIP Query

scip-query connects code locations through observed relationships and measured quality findings. Use ordinary search and file tools to read source. Use scip-query when the question concerns consumers, execution, value flow, dependencies, reuse or maintenance problems.

An owner is the implementation responsible for a rule or resource, established from behavior and consumers. A finding identifies concrete code with evidence of a possible problem. Candidates require confirmation; names, folders and matching text alone do not establish ownership or interchangeable behavior.

## Choose the work

| Situation                   | Analysis to use                                                                            | Workflow                    |
| --------------------------- | ------------------------------------------------------------------------------------------ | --------------------------- |
| Understand a subsystem      | `system --source`, then selected module dependencies or `evidence`                         | `$scip-explore`             |
| Plan a substantial change   | `context <target>` for reuse candidates; incoming/outgoing execution and relevant handoffs | `$scip-plan`                |
| Evaluate architecture       | Module dependencies, cycles and `architecture` for configured rules                        | `$scip-architecture-review` |
| Clean up code               | `health` for complexity/duplication/dependencies; relevant specialist detectors            | `$scip-architecture-review` |
| Check a feature's integrity | Live consumers and distinguishing behavior; relevant incomplete-implementation detectors   | `$scip-integrity-audit`     |
| Review actual edits         | `review --base HEAD`, `diff-impact`, and architecture if dependencies changed              | This guide                  |
| Install or repair the tool  | `status`, then the diagnosed operation                                                     | `$scip-setup`               |

Load only the needed workflow. Simple local lookups need no workflow ceremony. These are task boundaries, not a command battery. Use the relevant section of the [command guide](references/command-guide.md) when a more specific question needs a specialist command.

## Ask for relationships

Existing `file:line` locations are graph roots. Symbol lookup, `outline`, and `entrypoints` are useful when compiler identity, nesting or external roots are unclear. `code` and `inspect` are optional symbol-aware source tools; ordinary reads are usually sufficient for implementation details.

For example, `scip-query evidence --at src/service.ts:42 --edge execution --direction incoming --depth 1 --max-edges 30` asks for caller evidence. Repeat `--at` or `--symbol` to batch participants. Use outgoing execution for callees, dataflow for value origins/destinations, runtime for handoffs and dependencies for imports. Select state, temporal, contract, identity or containment relationships only when they answer a concrete question. Execution and supported runtime handoffs establish reachability; other relationship families do not become call claims.

Before a substantial change, establish the existing central path, comparable features and reuse opportunities. A relationship query should settle an uncertainty about that path or the consequences of changing it. Read the relevant implementation with ordinary tools to verify decisions, errors, state changes and ordering.

## Keep useful evidence

Exact is directly observed; derived is deterministically computed; candidates need confirmation; unknown cannot support a stronger claim. Respect material stale, unsupported or incomplete results. A saved result is the complete output of its query, not proof that every possible relationship was analyzed. Missing or bounded evidence cannot establish absence.

Prefer concise human output. Read saved results selectively using normal search/read tools. Use `--json --json-output <path>` when programmatic filtering helps. Do not paste large raw JSON or rerun an already answered query. Optional compatibility cursors are useful only when an omitted detail could change the decision; there is no requirement to drain every page or read every saved byte.

Source `health`, `review` and `system --source` use current files. Indexed relationships require a fresh index. Respect disabled watching and configured rebuild policy. Check `capabilities --matrix` only for uncertain support that matters to the question.

## Review changes

After a nontrivial edit, run `scip-query review --base <commit>` and fresh `scip-query diff-impact` against the same base. Normally use HEAD before committing. Review includes new/untracked functions and repository peers; scope the displayed findings to the change when useful. Check `architecture` when module dependencies or policy changed. Use `health --indexed` only for a needed specialist question.

Confirm findings with source and behavioral checks before fixing them. Preserve existing owners, authorization, errors, state identity, ordering, concurrency and cleanup. Do not lower thresholds, widen rules or suppress findings to make a report pass.

CRAP combines complexity with actual test coverage. Use `scripts/record-review-coverage.mjs` with the real test command when this measure matters; missing or stale coverage is unavailable, never zero. See [review rules](../../docs/REVIEW.md).

Report changes, actual checks, justified retained findings and material limits. An empty report or passing mocked test alone does not establish correct behavior.
