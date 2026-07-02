---
name: scip-query
description: Route codebase work in scip-query-indexed projects. Use when exploring, planning, implementing, refactoring, debugging, verifying, cleaning up, reconciling docs, improving health, or when unsure which scip-* skill should own the workflow.
commands:
  - template: "scip-query status --capabilities"
    when: "Before routing: confirm the index is fresh."
  - template: "scip-query plan-context <target>"
    when: "Default loop: anchor a plan for the routed skill."
  - template: "scip-query diff-gate --json"
    when: "Default loop: the loop is complete only when this passes or is explained."
---

# scip-query Router

Use this skill only to route. A scip-query workflow is a codebase task whose claims should be grounded in the SCIP index: the compiler-derived map of files, symbols, references, calls, dependencies, and consumers.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md) when you need freshness, lookup, postcheck, or subagent rules.

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query status --capabilities` | Show index status for this project | Before routing: confirm the index is fresh. |
| `scip-query plan-context <target>` | Pre-edit planning context for a symbol, file, or module | Default loop: anchor a plan for the routed skill. |
| `scip-query diff-gate --json` | Gate the current diff: echo candidates, incomplete migrations, missing co-change partners, unedited twin partners (advisory), uncited doc updates, unused params, new dead symbols; exit 1 on blocking findings | Default loop: the loop is complete only when this passes or is explained. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

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
| Find or resolve same-name twins that have diverged | `scip-twin-drift` | `twin-drift`, `duplicate-bodies`, `refs` |
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
- Use `scip-twin-drift` for same-name/near-name consolidation questions (a specific concept copied and drifted); use `scip-cleanup-audit`/`scip-cleanup-improve` for general bloat, echoes, and duplication sweeps that are not centered on one drifted twin family.

## Setup

If a repository has not been bootstrapped, invoke `scip-setup`. Use `scip-query setup-agent` only to refresh agent guidance, `scip-query setup-hooks --json` only to repair project-local hooks, and `scip-query setup-ci` only when the user explicitly asks for CI setup.

<!-- BEGIN GENERATED ROUTER COMMAND PREVIEW -->
## Command Preview

Top commands per routed skill, generated from each skill's own `commands:` frontmatter.

| Skill | Top commands |
| --- | --- |
| `concrete-plan` | `scip-query status --capabilities`, `scip-query plan-context <target>`, `scip-query refs <symbol>` |
| `scip-api-impact` | `scip-query surface <module-or-package>`, `scip-query refs <symbol>`, `scip-query affected <symbol> --json` |
| `scip-cleanup-audit` | `scip-query health --json`, `scip-query cleanup-plan --verify --json`, `scip-query duplicate-bodies --json --full` |
| `scip-cleanup-improve` | `scip-query health --json`, `scip-query cleanup-plan --verify --json`, `scip-query cleanup-apply --verified --batch <n>` |
| `scip-debug` | `scip-query files <feature-or-error-term>`, `scip-query trace <candidate-symbol>`, `scip-query call-graph <entry-symbol>` |
| `scip-diagram` | `scip-query system <module>`, `scip-query trace <symbol>`, `scip-query call-graph <symbol>` |
| `scip-directory-architecture` | `scip-query system <scope>`, `scip-query locality-candidates --json --full`, `scip-query similar-files --full --json` |
| `scip-doc-reconcile` | `scip-query doc-drift --json --full`, `scip-query doc-drift <doc>`, `scip-query outline <subject-file>` |
| `scip-explore` | `scip-query stats`, `scip-query system <module-or-scope>`, `scip-query trace <entry-symbol>` |
| `scip-hyper-optimization` | `scip-query bench --json`, `scip-query bench --json --cold-index --include-heavy --timeout-ms 600000`, `scip-query plan-context <entry-symbol-or-file>` |
| `scip-language-playbook` | `scip-query stats`, `scip-query files <feature-or-module-name>`, `scip-query outline <file>` |
| `scip-maintainability` | `scip-query stats`, `scip-query system <scope>`, `scip-query surface <scope>` |
| `scip-react-maintainability` | `scip-query react-component-duplicates --scope <scope> --full --json`, `scip-query react-hook-candidates --scope <scope> --full --json`, `scip-query react-large-component-pressure --scope <scope> --full --json` |
| `scip-setup` | `scip-query setup --json`, `scip-query doctor`, `scip-query status --json` |
| `scip-triage-issue` | `scip-query files <issue-term>`, `scip-query trace <entry-or-error-symbol>`, `scip-query code <entry-or-error-symbol>` |
| `scip-twin-drift` | `scip-query twin-drift --json --full`, `scip-query duplicate-bodies --json --full`, `scip-query code <symbol>` |
| `scip-verify` | `scip-query doctor`, `scip-query status --capabilities`, `scip-query diff-impact --json` |
| `scip-vue-maintainability` | `scip-query augment-vue --project <path-to-tsconfig>`, `scip-query vue-component-duplicates --scope <scope> --full --json`, `scip-query vue-composable-candidates --scope <scope> --full --json` |
| `tla-model-system` | `scip-query tla scaffold <file>`, `scip-query tla verify <spec>`, `scip-query tla instrument <spec>` |
<!-- END GENERATED ROUTER COMMAND PREVIEW -->
