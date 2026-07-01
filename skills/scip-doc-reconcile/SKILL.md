---
name: scip-doc-reconcile
description: Reconcile living docs with current code using scip-query doc-drift. Use for stale standards, broken file references, docs that cite moved code, agent guidance, or normative contradictions between documentation and implementation.
---

# scip-doc-reconcile

Use this skill to make living documentation true again. A living doc is documentation agents or maintainers use to make present-day changes, such as AGENTS.md, CLAUDE.md, standards, command docs, or workflow docs.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Rule

Separate statement types:

- Descriptive claims say what the code currently does or where it lives. Update them when code moves.
- Normative claims say what code must or should do. If code violates them, fix the code or escalate the contradiction; do not weaken the standard silently.

This distinction is the core of doc reconciliation.

## Workflow

### 1. Build the worklist

```bash
scip-query doc-drift --json --full
scip-query doc-drift <doc-or-tree>
```

Prioritize broken references, highest staleness, then docs agents read most. Do not reconcile archival records such as dated plans, ADRs, or reports.

This step is complete only when each target doc is selected for a current-use reason.

### 2. Reconcile one doc

For each doc:

```bash
scip-query doc-drift <doc>
scip-query outline <subject-file>
scip-query system <module>
scip-query trace <symbol-the-doc-mentions>
scip-query code <symbol>
```

Use Git history only to understand why a subject changed, not as a substitute for current code evidence.

Fix broken references by finding the current code or deleting the obsolete claim. Rewrite stale descriptive claims from current source evidence. Re-derive snippets from `scip-query code`. Record normative contradictions instead of changing standards to bless drifted code.

This step is complete only when every edited claim is supported by evidence from this session.

### 3. Verify

```bash
scip-query doc-drift <doc>
```

Invoke `scip-verify` when the documentation change is part of a codebase diff. The doc is complete only when staleness drops to zero or the remaining contradiction is explicitly reported.

### 4. Report

Report staleness before and after, broken references fixed, claims updated, normative contradictions, and docs recommended for deletion.

Do not claim reconciliation is done until `doc-drift` has been rerun.
