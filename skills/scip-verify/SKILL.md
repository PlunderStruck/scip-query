---
name: scip-verify
description: Verify finished code, docs, config, refactor, cleanup, setup, React, Vue, or API changes with scip-query. Use before committing or when the user asks whether a change is wired, safe, regression-free, or ready.
---

# scip-verify

Use this skill to verify the actual diff. Verification is the evidence pass that proves the workspace can answer, the index is current, the changed symbols and files match intent, routed postchecks ran, and diff-gate findings are resolved.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Rules

1. Verify environment and index freshness before trusting graph facts.
2. Treat `scip-query diff-gate --json` as the primary blocker for diff-specific risk.
3. Run every postcheck that matches the actual edit, not only the check you expected to need.
4. If `.scipquery.json` or suppressions changed, run `scip-query config-validate`.
5. Prefer fixing findings. Suppress only intentional design, compatibility shims, framework entry points, or accepted false positives with a specific reason.

## Flow

### 1. Prove the workspace

```bash
scip-query doctor
scip-query status --capabilities
```

This step is complete only when missing indexers, invalid config, stale indexes, or unavailable relevant capabilities are fixed or reported as blockers.

### 2. Assess the diff

```bash
scip-query diff-impact --json
```

Compare changed files, changed symbols, and downstream consumers with the intended work. Unexpected blast radius is a finding even if later gates pass.

This step is complete only when the diff shape is understood.

### 3. Run routed postchecks

Use the postcheck table in the shared reference. Run all rows that apply to the change type.

This step is complete only when each applicable postcheck has a result and every actionable finding is fixed, accepted with evidence, or blocked by a named constraint.

### 4. Run the gate

```bash
scip-query diff-gate --json
```

If it reports findings, fix them or record the acceptance reason. If a suppression is needed:

```bash
scip-query suppress <id> --reason "<specific reason>"
scip-query config-validate
```

This step is complete only when `diff-gate` passes or every finding has a durable explanation.

### 5. Check health, docs, and config when relevant

Run:

```bash
scip-query health --baseline
```

when a committed baseline exists. If docs, AGENTS.md, CLAUDE.md, command docs, generated docs, or skill instructions changed, run:

```bash
scip-query doc-drift --json --full
```

If the repository provides a self-audit command and the change touches generated command surfaces, analyzers, or evidence-labeling behavior, also run:

```bash
scip-query self-audit
```

This step is complete only when changed documentation and config surfaces are checked or explicitly out of scope.

## Report

End with:

```markdown
Verification: PASS/FAIL

Environment:
- doctor:
- status:

Diff:
- changed files/symbols:
- unexpected blast radius:

Postchecks:
- <command>: <result>

Gate:
- `scip-query diff-gate --json`: <result>

Health/docs/config:
- <commands and results>

Remaining risk:
- <accepted findings, unavailable capabilities, or checks not run>
```

Do not claim ready-to-ship unless freshness is `fresh` after the final edit and diff-gate is passed or fully explained.
