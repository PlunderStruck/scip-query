---
name: scip-setup
description: Set up or repair scip-query in a repository. Use for bootstrapping, onboarding, refreshing indexes, project-local hooks, agent guidance, capability diagnostics, health dossiers, .scipquery.json, or setup cleanup handoff.
---

# scip-setup

Use this skill to make a repository a reliable scip-query workspace: indexed, diagnosed, documented for agents, and honest about unavailable capabilities.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Rules

1. Prefer the single setup command over hand-running its internals.
2. Do not run `scip-query setup-ci` unless the user explicitly asks for CI setup.
3. Treat unavailable capabilities as unproven, not clean.
4. Keep `.scipquery.json` minimal and evidence-backed.

## Workflow

### 1. Confirm the root

```bash
pwd
git rev-parse --show-toplevel
scip-query --version
```

This step is complete only when the repository root and runnable `scip-query` command are known, or the install/link blocker is reported.

### 2. Run setup

```bash
scip-query setup --json
```

Use `scip-query setup --no-hooks --json` when project-local Codex or Claude Code lifecycle hooks should not be written. Use `scip-query setup --git-hook --json` only when the user wants the local pre-commit diff gate.

This step is complete only when setup reports ready, partial, or blocked and names every written, skipped, or blocked artifact.

### 3. Resolve blockers

```bash
scip-query doctor
scip-query status --json
scip-query capabilities --matrix
scip-query config-validate --json
```

`doctor` is the human diagnostic surface. `status --json` is the machine surface for freshness and config. Fix missing indexers, stale indexes, invalid config, or unavailable verification only when the fix is safe; otherwise record the exact external action.

This step is complete only when each blocker is fixed, unavailable with reason, or waiting on a named external action.

### 4. Calibrate config only when needed

Run `scip-query init` only when `.scipquery.json` is absent and the project needs config. Add settings only for observed repo facts: explicit languages, indexer projects, entry roots, declared couplings, locality boundaries, or accepted suppressions.

For TypeScript monorepos, prefer `indexer.typescript.projectMode: "workspace"` when multiple project shards are real. Add `indexerConcurrency` only when measured cold-index timing or memory pressure justifies it.

This step is complete only when config validates and every setting has a reason.

### 5. Hand off cleanup

After setup, invoke `scip-cleanup-audit` when the user wants a report or `scip-cleanup-improve` when the user wants autonomous cleanup.

Report:

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
Next:
- cleanup audit/improve, CI setup, or external blocker
```
