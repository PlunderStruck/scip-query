---
name: scip-setup
description: Use to adopt, onboard, repair, or diagnose scip-query ITSELF in a repo — first index, config, capability and dependency checks, installing or uninstalling agent skills, agent guidance blocks, project hooks, CI wiring. Wins over scip-verify for first-time adoption; calibration comes afterward.
---

# scip-setup

## Purpose

Make a repository a reliable scip-query workspace: indexed, diagnosed,
documented for agents, and honest about unavailable capabilities. Covers
first-time adoption, repair after drift, capability/dependency diagnosis, and
the lifecycle commands that install, refresh, or remove scip-query's footprint
(skills, agent guidance, hooks, CI).

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md). Use
this skill's own command shortlist first; open the shared file only when it is
insufficient.

## Triage: which scenario applies

| Situation | Go to |
| --- | --- |
| First time running scip-query in this repo, or repairing a broken setup | [Bootstrap workflow](references/bootstrap-workflow.md) — `setup` |
| `setup` reported a blocker, or index/capabilities look wrong | [Bootstrap workflow §3](references/bootstrap-workflow.md#3-resolve-blockers) — `doctor`, `status`, `capabilities`, `config-validate` |
| Confirming TypeScript/Vue or Rust semantic readiness specifically | [Language verification](references/language-verification.md) |
| Need to (re)install skills, agent guidance, hooks, or CI without a full bootstrap | [Lifecycle commands](references/lifecycle-commands.md) |
| Removing scip-query's footprint from a repo | [Lifecycle commands § uninstall](references/lifecycle-commands.md#uninstall) |
| New repo has standing findings that are intentional (naming conventions, snapshot docs, coupled files) | [Per-repo triage](references/per-repo-triage.md) |
| Setup is done and clean; user wants a cleanup report or autonomous cleanup | Hand off to `scip-cleanup-audit` (report) or `scip-cleanup-improve` (autonomous) |

## The core scenario

When a repository is new to scip-query, or its setup is suspect, run:

```bash
scip-query setup --json
```

`setup` is the bootstrap orchestrator: it installs/repairs language indexers,
installs Tree-sitter grammars, installs bundled agent skills and hooks,
enables demand-started incremental indexing, builds SQLite shards, starts the
project service, checks semantic readiness, and reports repository/checkout/
environment/runtime state separately. Prefer this single command over
hand-running its internals. Full step-by-step handling — including what to do
when it reports `partial` or `blocked` — is in
[Bootstrap workflow](references/bootstrap-workflow.md).

Do not manually install AST grammar packages before trying `setup`. If npm's
script-approval gate blocks a native package, report the pending packages and
ask the user to approve them — a package must not approve its own install
scripts.

## Rules (apply across every scenario)

1. Prefer the single `setup` command over hand-running its internals.
2. Do not run `scip-query setup-ci` unless the user explicitly asks for CI
   setup.
3. Treat unavailable capabilities as unproven, not clean. A missing semantic
   provider is "unsupported," never "clean semantic analysis."
4. Keep `.scipquery.json` minimal and evidence-backed — add a setting only for
   an observed repo fact, with a reason.
5. Let `setup` install detected AST parser packages and supported indexers; do
   not make users reproduce package-manager commands unless `setup` reports a
   blocker.
6. A demand-started service or Rust helper in `stopped` state can still be
   correctly configured. Availability comes from capabilities; lifecycle state
   only says whether current work keeps the helper awake.

## Report template

```markdown
Setup: ready/partial/blocked
Capabilities:
- available:
- unavailable:
Health:
- score:
- dossier:
Written or changed:
- files:
Runtime:
- automatic indexing:
- TypeScript project/index sessions:
- Rust semantic transport/lifecycle:
Next:
- cleanup audit/improve, CI setup, or external blocker
```

Fill this in as the closing report for any bootstrap or repair pass — it is
the fixed template regardless of which reference scenario you used.
