---
name: scip-query
description: Use FIRST for any codebase task that should rest on SCIP evidence, to pick the right scip-* skill before acting. Routing order when several could apply: explore before plan; diagnose before plan for a recurring bug family; audit before improve; setup before verify on first adoption.
---

# Purpose

scip-query is a router: it reads a codebase task and picks which one specialist `scip-*` skill and command family to invoke. It does not do the task itself. A "SCIP-backed" task is any claim that should rest on the SCIP index — the compiler-derived map of files, symbols, references, calls, dependencies, and consumers — rather than on guessed text search. Shared freshness, lookup, postcheck, and subagent mechanics live in `../_shared/SKILL.md`; each specialist skill carries its own shortlist first, so open `_shared` only when that shortlist is insufficient.

## Default loop (single, non-trivial change, no further routing needed)

1. Confirm the index is fresh: `scip-query status --capabilities`. It returns freshness, generation, language shards, watcher status, and optional capabilities.
2. Anchor a plan and hand off to `scip-concrete-plan`, anchored by `scip-query plan-context <target>` (definitions/references, callers/callees, dataflow producers/consumers, backward/forward slices, affected symbols, change-surface risk, dependencies/reverse-dependencies, module files/exports, external surface use, complexity, churn, co-change partners, active suppressions). `scip-concrete-plan` picks its own mode — ordinary planning by default, high-assurance only for security, money, destructive/irreversible operations, data migration, shared-state concurrency, or broad public API change. Do not demand the high-assurance certificate for routine work.
3. Implement the plan in the smallest coherent slice.
4. Invoke `scip-verify`. The loop is not done until it passes or each remaining finding has a specific stated reason.
5. Close with `scip-query diff-gate --json`, which gates the diff for architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates. It returns blocking findings (check id, message, remediation), advisory findings, root-cause groups, and changed file/symbol counts, and exits 1 on blocking findings. The loop is complete only when this passes or the blocking findings are explained.

Routing is complete only when one owning skill is selected, or the task is small enough for the default loop above to cover on its own.

## Routing table

| When the task is to… | Route to | First moves |
|---|---|---|
| Understand how a system works, or trace a feature/data flow before editing | `scip-explore` | `stats`; `system <module-or-scope>`; `trace <entry-symbol>` (also `call-graph`, `dataflow` as needed) |
| Root-cause one failing behavior, crash, or regression | `scip-debug` | `files <feature-or-error-term>`; `trace <candidate-symbol>`; `call-graph <entry-symbol>` (also `change-surface`) |
| Diagnose the design flaw behind a *family* of recurring, similar bugs | `scip-root-cause` | `trace <mechanism-symbol>`; `co-change <fix-site-file>`; `system <system-scope>` (also `similar`, `refs`) |
| Turn a bug report/issue/failing test into a fix packet | `scip-triage-issue` | `files <issue-term>`; `trace <entry-or-error-symbol>`; `code <entry-or-error-symbol>` (also `affected`) |
| Produce a code-flow, architecture, dependency, or blast-radius diagram | `scip-diagram` | `system <module>`; `trace <symbol>`; `call-graph <symbol>` (also `dataflow`, `affected`) |
| Plan a feature, fix, or refactor (single change) | `scip-concrete-plan` | `status --capabilities`; `plan-context <target>`; `refs <symbol>` |
| Run a multi-phase program: plan, delegate, verify handoffs, close | `scip-conductor` | `plan-context <target>`; `diff-gate --json`; `health --json` |
| Assess what breaks from a public API, route, config, schema, CLI, or export change | `scip-api-impact` | `surface <module-or-package>`; `refs <symbol>`; `affected <symbol> --json` (also `co-change`) |
| Pick high-signal commands for an unfamiliar language ecosystem | `scip-language-playbook` | `stats`; `files <feature-or-module-name>`; `outline <file>` |
| Benchmark or optimize a command, workflow, or hot path | `scip-hyper-optimization` | `bench --json`; `bench --json --cold-index --include-heavy --timeout-ms 600000`; `work-audit <profile> --json` |
| Bootstrap or repair scip-query in a repo (first adoption) | `scip-setup` | `setup --json`; `doctor`; `status --json` |
| Verify a finished change is wired, safe, regression-free, ready | `scip-verify` | `doctor`; `status --capabilities`; `diff-impact --json` |
| Audit, rank, or confirm cleanup findings without editing | `scip-cleanup-audit` | `health --json`; `cleanup-plan --verify --json`; `duplicate-bodies --json --full` |
| Autonomously fix confirmed cleanup findings / raise health | `scip-cleanup-improve` | `health --json`; `cleanup-plan --verify --json`; `cleanup-apply --verified --batch <n>` |
| Find or resolve same-name/near-name twins that have diverged | `scip-twin-drift` | `twin-drift --json --full`; `duplicate-bodies --json --full`; `code <symbol>` |
| Investigate faked/half-implemented features, checkers that never fail, dead paths behind fallbacks, or lying metrics | `scip-integrity-audit` | open the skill directly — no fixed command preview |
| Judge whether an "available"/"verified"/"safe"/"PASS" claim is derived, hedged, or merely asserted | `scip-claim-audit` | `files <pattern>`; `refs <symbol>`; `code <symbol>` (also `trace`) |
| Prove whether a parser/AST branch is actually reachable | `scip-probe-reachability` | `outline <file> --signatures`; `code <symbol>`; `trace <symbol>` |
| Reconcile living docs with code (stale standards, broken references) | `scip-doc-reconcile` | `doc-drift --json --full`; `doc-drift <doc>`; `outline <subject-file>` |
| Review or migrate folder ownership / directory structure | `scip-directory-architecture` | `system <scope>`; `locality-candidates --json --full`; `similar-files --full --json` |
| Review deep maintainability, system compression, architecture smells | `scip-maintainability` | `stats`; `system <scope>`; `surface <scope>` (also `bottlenecks`, `similar-chains`, `change-surface`) |
| Review React reuse / component / hook pressure | `scip-react-maintainability` | `react-component-duplicates --scope <scope> --full --json`; `react-hook-candidates --scope <scope> --full --json`; `react-large-component-pressure --scope <scope> --full --json` |
| Review Vue reuse / SFC / composable pressure | `scip-vue-maintainability` | `augment-vue --project <path-to-tsconfig>`; `vue-component-duplicates --scope <scope> --full --json`; `vue-composable-candidates --scope <scope> --full --json` |
| Model a TypeScript system with TLA+ | `scip-tla-model-system` | `plan-context <target>`; `tla scaffold <file>`; `tla verify <spec>`; `tla instrument <spec>` |

## Disambiguation rules

These resolve the cases where two rows above could both plausibly apply:

- "Is this implementation real / does it actually work?" → `scip-integrity-audit`. "Is this well-organized?" → `scip-maintainability`.
- Same-name/near-name twins centered on **one** drifted concept → `scip-twin-drift`. General bloat, echoes, or duplication sweeps not centered on one twin family → `scip-cleanup-audit` / `scip-cleanup-improve`.
- A single change → `scip-concrete-plan`. A program of changes with delegation across steps → `scip-conductor`.
- A single failing behavior → `scip-debug`. A family of similar bugs whose fixes keep recurring, or "what is really wrong with this system" backed by actual bug history → `scip-root-cause`. Structure smells with no bug evidence → `scip-maintainability` instead.
- `scip-cleanup-audit` is for reports, ranking, confirmation, or recent-AI-residue triage without making edits. `scip-cleanup-improve` is for when the user asks to fix, improve, continue cleaning, or raise health autonomously.
- `scip-maintainability`, `scip-directory-architecture`, and `scip-hyper-optimization` apply only when the target is architecture, file ownership, or measured speed/cost — not general cleanup.

## Setup-only commands

If the repo has not been bootstrapped for scip-query, invoke `scip-setup` before anything else in this list. Within it:

- `scip-query setup-agent` — only to refresh agent guidance.
- `scip-query setup-hooks --json` — only to repair project-local hooks.
- `scip-query setup-ci` — only when the user explicitly asks for CI setup.
