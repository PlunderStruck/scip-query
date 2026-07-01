---
name: scip-query
description: Route codebase work in scip-query-indexed projects. Use when exploring, planning, implementing, refactoring, debugging, verifying, cleaning up, reconciling docs, improving health, or when unsure which scip-* skill should own the workflow.
---

# scip-query Router

Use this skill only to route. A scip-query workflow is a codebase task whose claims should be grounded in the SCIP index: the compiler-derived map of files, symbols, references, calls, dependencies, and consumers.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md) when you need freshness, lookup, postcheck, or subagent rules.

## Default Loop

For non-trivial code changes:

1. Invoke `concrete-plan`; the plan starts from `scip-query plan-context <target>` and designs for testability.
2. Implement the plan in the smallest coherent slice.
3. Invoke `scip-verify`.

The loop is complete only when `scip-verify` passes or each remaining finding has a specific reason.

## Routes

| Work | Skill | Anchor |
| --- | --- | --- |
| Understand a system before answering or editing | `scip-explore` | `system`, `trace`, `call-graph`, `dataflow` |
| Root-cause a bug or regression | `scip-debug` | `trace`, `dataflow`, `change-surface` |
| Turn a report into a fix packet | `scip-triage-issue` | `files`, `trace`, `affected` |
| Create a code flow, dependency, or blast-radius diagram | `scip-diagram` | `call-graph`, `dataflow`, `affected` |
| Plan a feature, fix, or refactor | `concrete-plan` | `plan-context` |
| Assess public API, route, config, schema, CLI, or export changes | `scip-api-impact` | `surface`, `affected`, `co-change` |
| Pick language-specific high-signal commands | `scip-language-playbook` | language row |
| Benchmark and optimize a command, workflow, or hot path | `scip-hyper-optimization` | `bench`, `plan-context`, profiles |
| Adopt or repair scip-query setup in a repo | `scip-setup` | `setup`, `doctor`, `capabilities` |
| Verify any finished change | `scip-verify` | `status`, `diff-impact`, final gate |
| Audit, rank, or confirm cleanup findings | `scip-cleanup-audit` | `health`, `cleanup-plan`, cleanup detectors |
| Autonomously fix confirmed cleanup findings | `scip-cleanup-improve` | `health`, `cleanup-plan`, verified batches |
| Reconcile living docs with code | `scip-doc-reconcile` | `doc-drift` |
| Review or migrate folder ownership | `scip-directory-architecture` | `locality-candidates`, `similar-files` |
| Review deeper maintainability and system compression | `scip-maintainability` | `bottlenecks`, `similar-chains`, `change-surface` |
| Review React reuse and component/hook pressure | `scip-react-maintainability` | React duplicate and pressure commands |
| Review Vue reuse and SFC/composable pressure | `scip-vue-maintainability` | Vue duplicate and pressure commands |
| Model a TypeScript system with TLA+ | `tla-model-system` | `plan-context`, `tla verify` |

Routing is complete only when one owning skill is selected or the task is small enough for the default loop alone.

## Tie-Breaks

- Use `scip-cleanup-audit` for reports, ranking, confirmation, or recent AI-residue triage without edits.
- Use `scip-cleanup-improve` when the user asks to fix, improve, continue cleaning, or raise health autonomously.
- Use `scip-maintainability`, `scip-directory-architecture`, or `scip-hyper-optimization` only when the target is architecture, file ownership, or measured speed/cost rather than cleanup.

## Setup

If a repository has not been bootstrapped, invoke `scip-setup`. Use `scip-query setup-agent` only to refresh agent guidance, `scip-query setup-hooks --json` only to repair project-local hooks, and `scip-query setup-ci` only when the user explicitly asks for CI setup.
