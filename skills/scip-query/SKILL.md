---
name: scip-query
description: Router for codebase work in scip-query-indexed projects. Use whenever exploring, planning, implementing, refactoring, extracting helpers, verifying changes, hunting duplication or bloat, fixing stale docs, or cleaning up after an AI coding session — or when unsure which scip-* skill applies. Picks the right specialist skill and the commands that must run for each phase of work.
allowed-tools: [Bash, Skill]
keywords: [scip, codebase, explore, plan, implement, refactor, extract, verify, check-work, cleanup, duplication, bloat, drift, route, which-skill]
---

# scip-query Router

This project is indexed by `scip-query` — compiler-resolved code intelligence.
Your job here is only to route: identify the phase of work, invoke the right
specialist skill, and enforce the non-negotiable checks. Do not improvise a
workflow when a specialist skill exists for it.

If the index might be stale (code changed since the last reindex), run
`scip-query reindex` before anything else.

## Route by phase of work

| You are about to... | Invoke | Anchor commands |
|---|---|---|
| Understand how something works, trace a system end-to-end | `scip-explore` | `scip-query system <module>`, `scip-query trace <symbol>` |
| Plan a feature, fix, or refactor | `concrete-plan` | `scip-query plan-context <target>` |
| Pick high-signal commands for an unfamiliar language | `scip-language-playbook` | — |
| Verify work you just finished (any implementation, refactor, or extraction) | `scip-verify` | `scip-query reindex && scip-query diff-gate` |
| Find dead code, duplication, or structural bloat | `scip-debloat` | `scip-query health` |
| Clean up after AI-assisted coding sessions | `scip-ai-cleanup` | `scip-query recent-duplicates`, `scip-query incomplete-migration` |
| Reconcile docs/standards that drifted from the code | `scip-doc-reconcile` | `scip-query doc-drift <doc>` |
| Review architecture, boundaries, hidden policies | `scip-maintainability` | `scip-query bottlenecks`, `scip-query coupling` |

Invoke skills by name (Skill tool or slash command). If skill invocation is
unavailable in this harness, read `~/.agents/skills/<name>/SKILL.md` and
follow it directly.

## Non-negotiable checks

These run regardless of which route you took:

1. **After any extraction or abstraction** — you moved logic into a helper,
   hook, or shared module — run `scip-query incomplete-migration`. It lists
   call sites that still contain the extracted logic inline. Migrate them or
   state why they differ.
2. **Before declaring any change done** — run `scip-query diff-gate`. Exit 1
   means findings: re-implementations of existing code, incomplete
   migrations, missing co-change partners, uncited doc updates, unused
   parameters, or newly dead symbols. Fix them or knowingly accept them;
   never ignore them silently.
3. **Before creating any new helper or module** — run
   `scip-query similar <closest-existing-symbol>` and
   `scip-query recent-duplicates`. Reuse beats re-implementation.

## One-time project setup

If this project has no agent guidance yet, offer to run
`scip-query setup-agent` — it seeds the AGENTS.md block (every agent reads
it) and, with `--git-hook`, installs a pre-commit diff gate that fires no
matter which agent or human wrote the change.
