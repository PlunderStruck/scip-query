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

## The default loop for any implementation request

When the user asks you to build, change, or fix something non-trivial:

1. **Plan first** — invoke `concrete-plan` (every claim in the plan must come
   from a scip-query command, anchored by `scip-query plan-context <target>`).
2. **Implement** the plan.
3. **Run the post-checks that match what you did** (table below) — don't wait
   to be asked.
4. **Gate before done** — `scip-query reindex && scip-query diff-gate`; fix
   findings or state explicitly why each is accepted.

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

## Match the post-check to the change

After implementing, run the checks for what the change actually did — every
row, every time it applies:

| You just... | Run |
|---|---|
| Extracted a helper / created an abstraction | `scip-query incomplete-migration` — lists call sites that still hold the logic inline; migrate them or state why they differ |
| Wrote a brand-new helper or module | `scip-query similar <it>` and `scip-query recent-duplicates` — reuse beats re-implementation; delete the echo |
| Added parameters, options, or config flags | `scip-query unused-params` — speculative "for later" params must go |
| Added a forwarding or wrapper layer | `scip-query wrapper-candidates` and `scip-query passthrough-candidates` — indirection must earn its keep |
| Added an interface, base class, or type alias | `scip-query stale-abstractions` — one real consumer is not an abstraction |
| Changed a schema, contract, config, or generated file | `scip-query co-change <file>` — update the historical partners or confirm the coupling broke |
| Changed code that docs describe | `scip-query doc-drift` — update the docs that now lie |
| Deleted code | `scip-query cleanup-plan --verify` — take the whole cascade with compiler proof |

Confusable detectors (full guide: docs/DETECTOR_GUIDE.md): `unused-params` is
parameter-level; `passthrough-candidates` = one **callee** (only forwards);
`wrapper-candidates` = one **caller** (no reuse); `stale-abstractions` is
type-level. `recent-duplicates` = similarity + git age (which copy is the
echo); `incomplete-migration` = the inverse (the new helper is canonical, the
old inline copies must go).

**Before declaring any change done** — run `scip-query diff-gate`. Exit 1
means findings, each with a remediation. Fix them or knowingly accept them
with a stated reason; never ignore them silently.

## One-time project setup

If this project has no agent guidance yet, offer to run
`scip-query setup-agent` — it seeds the AGENTS.md block (every agent reads
it) and, with `--git-hook`, installs a pre-commit diff gate that fires no
matter which agent or human wrote the change.
