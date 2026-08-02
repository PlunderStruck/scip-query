---
name: scip-query
description: Router for compiler-resolved codebase work only when the right scip specialist is unclear. Do not load it alongside an already selected scip-plan, scip-verify, or other specialist.
---

# SCIP Query Router

Choose the one workflow whose completion condition matches the current phase.
Load that skill only. This router does not perform the work itself.

Evidence commands obtain a fresh usable index internally. Ask the useful
question directly; do not make `status`, watcher polling, sleeps, or `reindex`
part of an ordinary agent workflow. `scip-setup` owns actual installation or
index repair when an evidence command returns a setup failure.

Prefer human output for model reading. Use `--json --result-only` only for a
programmatic consumer. Do not preselect `--compact` or an output page size.
Follow an emitted `Continue exactly:` command unchanged until transport is
complete. Transport completion means all rendered text was retrieved; it does
not turn bounded analysis into complete coverage.

Reuse an exact read-only result while repository state, command input, index
generation, and required coverage remain unchanged. Context compaction is not
new repository evidence.

## Routes

| Starting point | Skill | Done when |
| --- | --- | --- |
| Understand or trace existing behavior | `scip-explore` | Entry, effect, dependencies, consumers, and uncertainty are evidenced. |
| Plan a feature, fix, refactor, migration, API change, or phased program | `scip-plan` | Flow, consumers, reuse, completeness, slices, and validation are explicit. |
| Explain a failure or regression | `scip-diagnose` | Cause is evidenced, rivals are rejected, and the fix surface is known. |
| Find problems without editing | `scip-audit` | Scoped findings are classified and ranked with evidence. |
| Fix confirmed cleanup, drift, duplication, or maintainability findings | `scip-improve` | One coherent finding slice is changed and checked. |
| Install, adopt, repair, or remove scip-query | `scip-setup` | The workspace works or the exact external blocker is known. |
| Challenge a coherent finished diff | `scip-verify` | Each requirement has evidence, impact is reconciled, and one final gate owner decides. |

## Disambiguation

Understanding without a symptom routes to `scip-explore`; a failure routes to
`scip-diagnose`. Finding problems without edits routes to `scip-audit`; fixing
confirmed findings routes to `scip-improve`. Missing installation or broken
index machinery routes to `scip-setup`, not to an ordinary evidence workflow.

When a request crosses phases, keep one owner at a time. Plan before a
non-trivial edit. Load `scip-verify` only after a coherent implementation
exists; final-stage rules cannot improve pre-edit understanding.

## Default change loop

1. Route to `scip-plan`. It runs one compact `plan-context` anchor and decides
   whether the work is direct, relational, or sustained.
2. Direct work edits the known local target. Bounded relational work uses one
   concise readable plan. Sustained work applies one durable plan contract.
3. Implement the smallest coherent outcome. Useful commands update work
   history automatically; do not add manual ledger writes.
4. Route once to `scip-verify` for the coherent finished outcome. Reuse checks
   that already ran and add only evidence that can expose an uncovered failure.
5. Give the final diff gate one owner. A protected blocking Stop hook owns it
   when active; otherwise `scip-verify` runs it once. Rerun only after a finding
   causes a relevant state change. Follow the exact Stop-controller next action.

Load `../_shared/SKILL.md` only when the routed skill's shortlist cannot answer
a named question.

<!-- BEGIN GENERATED ROUTER COMMAND PREVIEW -->
## Command Preview

Top commands per routed skill, generated from each skill's own `commands:` frontmatter.

| Skill | Top commands |
| --- | --- |
| `scip-audit` | `scip-query health`, `scip-query decorative-checkers --full`, `scip-query doc-drift --full` |
| `scip-diagnose` | `scip-query files <feature-or-error-term>`, `scip-query trace <candidate-symbol>`, `scip-query call-graph <entry-symbol>` |
| `scip-explore` | `scip-query system <module-or-scope>`, `scip-query trace <entry-symbol>`, `scip-query affected <symbol>` |
| `scip-improve` | `scip-query cleanup-plan --verify`, `scip-query cleanup-apply --verified --batch <n> --dry-run`, `scip-query diff-gate` |
| `scip-plan` | `scip-query plan-context <target>`, `scip-query refs <symbol> --full`, `scip-query affected <symbol> --full` |
| `scip-setup` | `scip-query setup --json`, `scip-query doctor`, `scip-query status --capabilities` |
| `scip-verify` | `scip-query diff-impact`, `scip-query diff-gate`, `scip-query mission-trial report <program> --protected-root <path>` |
<!-- END GENERATED ROUTER COMMAND PREVIEW -->
