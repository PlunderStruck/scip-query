---
name: scip-query
description: Router for codebase work in scip-query-indexed projects. Use whenever exploring, planning, implementing, refactoring, extracting helpers, verifying changes, hunting duplication or bloat, fixing stale docs, or cleaning up after an AI coding session — or when unsure which scip-* skill applies. Picks the right specialist skill and the commands that must run for each phase of work.
---

# scip-query Router

This project is indexed by `scip-query` — compiler-resolved code intelligence.
Your job here is only to route: identify the phase of work, invoke the right
specialist skill, and enforce the non-negotiable checks. Do not improvise a
workflow when a specialist skill exists for it.

Before trusting graph facts, check freshness with `scip-query status --capabilities`
or `scip-query status --json`. If the index is `fresh`, continue without
reindexing. If it is `stale`, `missing`, or `unknown`, run `scip-query reindex`
before using code-intelligence results. Project hooks auto-refresh stale indexes
by default unless `.scipquery.json` sets `watch.autoRefresh: false`.

## The default loop for any implementation request

When the user asks you to build, change, or fix something non-trivial:

1. **Plan first** — invoke `concrete-plan` (every claim in the plan must come
   from a scip-query command, anchored by `scip-query plan-context <target>`).
2. **Implement** the plan.
3. **Verify** — invoke `scip-verify`, then run the post-checks that match what
   you changed (table below).
4. **Gate before done** — check freshness; reindex only when the index is not
   `fresh`, then run `scip-query diff-gate --json`; fix findings or state
   explicitly why each is accepted.

## Route by phase of work

| You are about to...                                                                                                | Invoke                        | Anchor commands                                                                                             |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Understand how something works, trace a system end-to-end                                                          | `scip-explore`                | `scip-query system <module>`, `scip-query trace <symbol>`                                                   |
| Debug a bug, regression, failing behavior, or wrong data flow                                                      | `scip-debug`                  | `scip-query trace <symbol>`, `scip-query dataflow <symbol>`, `scip-query change-surface <file>`             |
| Triage a bug report or issue into evidence and a fix plan                                                          | `scip-triage-issue`           | `scip-query files <term>`, `scip-query trace <symbol>`, `scip-query affected <symbol>`                      |
| Create a visual explanation, flow map, dependency map, or HTML diagram                                             | `scip-diagram`                | `scip-query call-graph <symbol>`, `scip-query dataflow <symbol>`, `scip-query affected <symbol>`            |
| Plan a feature, fix, or refactor                                                                                   | `concrete-plan`               | `scip-query plan-context <target>`                                                                          |
| Assess a public API, route, CLI, config, schema, or boundary change                                                | `scip-api-impact`             | `scip-query surface <module>`, `scip-query affected <symbol>`, `scip-query co-change <file>`                |
| Pick high-signal commands for an unfamiliar language                                                               | `scip-language-playbook`      | —                                                                                                           |
| Benchmark indexing, command runtime, or detector performance                                                       | `scip-query`                  | `scip-query bench --json`, `scip-query bench --cold-index --include-heavy`                                  |
| Adopt or bootstrap scip-query in a repository                                                                      | `scip-adoption`               | `scip-query setup --json`, `scip-query check-deps`, `scip-query capability-matrix --json`                   |
| Verify work you just finished (any implementation, refactor, or extraction)                                        | `scip-verify`                 | `scip-query status --capabilities`, `scip-query diff-gate --json`                                           |
| Confirm post-setup health signals before cleanup                                                                   | `scip-health-audit`           | `scip-query health --json --full`, `scip-query diff-gate --json`                                            |
| Raise the health score as high as reasonably possible with autonomous verified cleanup                             | `scip-health-improve`         | `scip-query health --json --full`, `scip-query cleanup-plan --verify --json`, `scip-query diff-gate --json` |
| Audit dead code, duplication, unnecessary abstractions, or structural bloat and produce a prioritized cleanup plan | `scip-debloat`                | `scip-query health`                                                                                         |
| Clean up recent AI-assisted coding rot, copied echoes, incomplete migrations, speculative params, or doc drift     | `scip-ai-cleanup`             | `scip-query recent-duplicates`, `scip-query incomplete-migration`                                           |
| Reconcile docs/standards that drifted from the code                                                                | `scip-doc-reconcile`          | `scip-query doc-drift <doc>`                                                                                |
| Review or redesign source folder structure and ownership boundaries                                                | `scip-directory-architecture` | `scip-query locality-candidates --json --full`, `scip-query similar-files --full`                           |
| Review architecture, hidden policies, weak boundaries beyond folder structure                                      | `scip-maintainability`        | `scip-query bottlenecks`, `scip-query coupling`                                                             |
| Review React frontend reuse, components, hooks, or TSX/JSX maintainability                                         | `scip-react-maintainability`  | `scip-query react-component-duplicates --full`, `scip-query react-hook-candidates --full`                   |
| Review Vue frontend reuse, SFCs, templates, or composables                                                         | `scip-vue-maintainability`    | `scip-query vue-component-duplicates --full`, `scip-query vue-composable-candidates --full`                 |

## Tie-break close calls

Use these boundaries before loading a specialist skill:

- `scip-health-audit` confirms, ranks, and reports health signals before code
  changes. It is the right first step when the user asks "what needs fixing?"
  or when setup produced a health dossier.
- `scip-health-improve` is the autonomous campaign. Use it when the user asks
  to raise/maximize the health score, keep working with minimal interaction, or
  get the repo as clean as reasonably possible.
- `scip-debloat` is a bloat audit and cleanup plan. Use it when the user wants
  dead code, duplication, unnecessary abstractions, wrappers, or structural
  waste found and prioritized, but has not asked for a score-maxing campaign.
- `scip-ai-cleanup` is for AI-session residue: recent re-implementations of
  established code, incomplete helper migrations, speculative parameters,
  stale docs caused by generated changes, and echo code introduced in the
  current or recent work.
- `scip-maintainability` is for deeper design pressure: hidden policies,
  scattered concepts, weak boundaries, accidental variation, and system
  compression. Use it when the problem is not just "delete waste" but "make the
  codebase easier to reason about."
- `scip-directory-architecture` is only for folder ownership and migration
  questions. Use it when the user asks where code should live, whether
  boundaries are mature, or how to reorganize source directories.

Invoke skills by name (Skill tool or slash command). If skill invocation is
unavailable in this harness, read `~/.agents/skills/<name>/SKILL.md` and
follow it directly.

## Match the post-check to the change

After implementing, run the checks for what the change actually did — every
row, every time it applies:

| You just...                                           | Run                                                                                                                          |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Extracted a helper / created an abstraction           | `scip-query incomplete-migration` — lists call sites that still hold the logic inline; migrate them or state why they differ |
| Wrote a brand-new helper or module                    | `scip-query similar <it>` and `scip-query recent-duplicates` — reuse beats re-implementation; delete the echo                |
| Added parameters, options, or config flags            | `scip-query unused-params` — speculative "for later" params must go                                                          |
| Added a forwarding or wrapper layer                   | `scip-query wrapper-candidates` and `scip-query passthrough-candidates` — indirection must earn its keep                     |
| Added an interface, base class, or type alias         | `scip-query stale-abstractions` — one real consumer is not an abstraction                                                    |
| Changed a schema, contract, config, or generated file | `scip-query co-change <file>` — update the historical partners or confirm the coupling broke                                 |
| Changed code that docs describe                       | `scip-query doc-drift` — update the docs that now lie                                                                        |
| Deleted code                                          | `scip-query cleanup-plan --verify` — take the whole cascade with compiler proof                                              |

Confusable detectors (full guide: docs/DETECTOR_GUIDE.md): `unused-params` is
parameter-level; `passthrough-candidates` = one **callee** (only forwards);
`wrapper-candidates` = one **caller** (no reuse); `stale-abstractions` is
type-level. `recent-duplicates` = similarity + git age (which copy is the
echo); `incomplete-migration` = the inverse (the new helper is canonical, the
old inline copies must go).

**Before declaring any change done** — run `scip-query diff-gate --json`. Exit 1
means findings, each with a remediation. Fix them or knowingly accept them
with a stated reason; never ignore them silently.

## One-time project setup

If this project has not been bootstrapped yet, run `scip-query setup`. It
installs bundled skills, checks indexer readiness, refreshes the index, runs
capability and health checks, writes the health dossier, and seeds agent
guidance. Use `scip-query setup-agent` only when you specifically need to
refresh AGENTS.md/CLAUDE.md guidance without the full setup pass.
Use `scip-query setup-hooks --json` to repair the current repository's
project-local Codex/Claude Code lifecycle hooks.
After setup, use `scip-health-audit` to confirm and rank raw health signals, or
`scip-health-improve` when the user wants the agent to raise the score as high
as reasonably possible with minimal interaction.

Do not use `scip-query setup-ci` as part of first-run setup. The CI workflow is
intentionally separate until its validation story is mature.
