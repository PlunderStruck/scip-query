---
name: scip-setup
description: Set up or repair scip-query in a repository. Use for bootstrapping, onboarding, refreshing indexes, project-local hooks, agent guidance, capability diagnostics, health dossiers, .scipquery.json, or setup cleanup handoff.
commands:
  - template: "scip-query setup --json"
    when: "Run setup: install skills, refresh the index, report health."
  - template: "scip-query doctor"
    when: "Resolve blockers: human diagnostic for config, index, and dependencies."
  - template: "scip-query status --json"
    when: "Resolve blockers: machine surface for freshness and config."
  - template: "scip-query capabilities --matrix"
    when: "Resolve blockers: which evidence/verification capabilities are available."
  - template: "scip-query config-validate --json"
    when: "Resolve blockers: validate .scipquery.json."
  - template: "scip-query init"
    when: "Calibrate config: create .scipquery.json only when absent and needed."
---

# scip-setup

Use this skill to make a repository a reliable scip-query workspace: indexed, diagnosed, documented for agents, and honest about unavailable capabilities.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query setup --json` | Bootstrap this project: enable automatic indexing, install agent skills, refresh the index, verify capabilities, and report health | Run setup: install skills, refresh the index, report health. |
| `scip-query doctor` | Diagnose config, index freshness, dependency readiness, and project capabilities | Resolve blockers: human diagnostic for config, index, and dependencies. |
| `scip-query status --json` | Show index status for this project | Resolve blockers: machine surface for freshness and config. |
| `scip-query capabilities --matrix` | Report which evidence and verification capabilities are available in this project | Resolve blockers: which evidence/verification capabilities are available. |
| `scip-query config-validate --json` | Validate .scipquery.json, including structured suppressions and declared coupling groups | Resolve blockers: validate .scipquery.json. |
| `scip-query init` | Create a .scipquery.json config file for this project | Calibrate config: create .scipquery.json only when absent and needed. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Per-Repo Triage (once, after setup)

New repos surface standing findings that are intentional. Encode them once so
every later gate run is precise:

1. Sweep initial findings (`health --json`, `diff-gate --json`) and, for each accepted one, `suppress <id> --reason <why>` — reasons are required and audited.
2. Declare files that legitimately change together in `.scipquery.json` `declaredCouplings`.
3. List dated snapshot docs (benchmarks, validation ledgers, historical plans/reviews) in `docs.snapshotPaths` so doc checks skip them with a labeled exclusion instead of recurring findings.
4. Seed `coverageContracts` for every hand-maintained enumeration (policy maps, capability tables, registry lists) so enumeration rot fails the gate the day it happens.
5. Set a hygiene cadence: run `scip-twin-drift` and `scip-claim-audit` after large refactor campaigns or quarterly — the gate only sees diffs; these lenses see accumulated state.

This step is complete only when a clean working tree produces a finding-free `diff-gate` and every suppression carries a reason a reviewer would accept.

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
