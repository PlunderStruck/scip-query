---
name: scip-adoption
description: Adopt scip-query in a repository from first run through verified local readiness. Use when the user wants to install, bootstrap, onboard, set up, refresh, or roll out scip-query in a project, including skills, indexers, local capabilities, health dossier, and post-setup cleanup handoff.
---

# SCIP Adoption

Use this skill when a repository needs to become a reliable scip-query workspace. A scip-query workspace is a source repository with a current SCIP index, runnable language indexers, installed agent skills, project guidance, and health evidence that agents can use before editing.

## Rules

1. Make local setup reliable before recommending cleanup.
2. Do not run `scip-query setup-ci` in the default adoption path. CI is a separate explicit workflow.
3. Treat missing capabilities as unavailable evidence, not as clean results.
4. After setup, tell the user the health score and confirmed issue list before application-code cleanup begins.

## Adoption Workflow

### 1. Establish the project

```bash
pwd
git rev-parse --show-toplevel
scip-query --version
```

If `scip-query` is not available, install or link the package through the repo's package manager, then rerun the checks.

### 2. Install skills and run setup

```bash
scip-query install-skills
scip-query setup-hooks --json
scip-query setup --json
```

Use `scip-query setup --git-hook --json` only when the user wants the local Git pre-commit diff-gate hook. Do not treat that hook as a replacement for final verification.
Use `scip-query setup-hooks --json` when hook config needs to be repaired for the current repository without rerunning the full setup pass.

### 3. Resolve blockers

If setup reports `blocked` or `partial`, inspect dependencies and capabilities:

```bash
scip-query check-deps
scip-query doctor
scip-query capability-matrix --json
scip-query status --capabilities
```

Fix missing indexers, toolchain dependencies, invalid config, or stale indexes. If a toolchain cannot be installed safely, record exact manual commands and keep the adoption state blocked.

### 4. Initialize or validate config

```bash
scip-query init
scip-query config-validate
```

Run `init` only when `.scipquery.json` is absent and the project needs config. Keep config minimal and evidence-backed. Use suppressions only for accepted findings with specific reasons:

```bash
scip-query suppress <id> --reason "<specific reason>"
scip-query config-validate
```

### 5. Prove ongoing local usefulness

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query stats
scip-query files <known-source-term>
scip-query outline <known-source-file>
scip-query health --json --full
scip-query diff-gate --json
```

Use `scip-query watch` only for an active local work session where automatic reindexing is useful. Do not leave it running as a hidden setup side effect.

### 6. Hand off to health audit

Invoke `scip-health-audit` after setup if the user wants cleanup or a perfect-code pass. The first user-facing message after the audit must include:

- health score;
- confirmed items that need attention;
- unconfirmed signals;
- unavailable or blocked checks;
- recommended first cleanup batch.

Then start cleanup only if the current request already asks for cleanup or the user approves the batch.

## Adoption Report

End with:

```markdown
Adoption: ready/partial/blocked

Installed:
- skills, hooks, indexers, config files, guidance files

Capabilities:
- available checks
- unavailable checks and why

Health:
- score
- dossier path
- confirmed cleanup queue or audit handoff

Verification:
- `scip-query status --capabilities`, then `scip-query reindex` only if freshness is `stale`, `missing`, or `unknown`
- `scip-query diff-gate --json`
- targeted smoke commands

Deferred:
- CI setup, external toolchains, product decisions, or blocked checks
```

Do not claim adoption is ready until the index is current, core commands smoke-test, and `scip-query diff-gate --json` passes.
