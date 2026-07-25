---
name: scip-doc-reconcile
description: Reconcile living docs with current code using scip-query doc-drift. Use for stale standards, broken file references, docs that cite moved code, agent guidance, or normative contradictions between documentation and implementation.
commands:
  - template: 'scip-query doc-drift --json --full'
    when: 'Build the worklist: every stale-doc candidate, ranked.'
  - template: 'scip-query doc-drift <doc>'
    when: 'Reconcile one doc: staleness detail for a single target.'
  - template: 'scip-query outline <subject-file>'
    when: 'Reconcile one doc: current shape of the code the doc describes.'
  - template: 'scip-query trace <symbol>'
    when: 'Reconcile one doc: verify a symbol the doc mentions still exists as described.'
  - template: 'scip-query code <symbol>'
    when: 'Reconcile one doc: re-derive a snippet from current source.'
---

# scip-doc-reconcile

Use this skill to make living documentation true again. A living doc is documentation agents or maintainers use to make present-day changes, such as AGENTS.md, CLAUDE.md, standards, command docs, or workflow docs.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query doc-drift --json --full` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | document paths, coupled code subjects, and history evidence | `bounded` | Build the worklist: every stale-doc candidate, ranked. |
| `scip-query doc-drift <doc>` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | document paths, coupled code subjects, and history evidence | `bounded` | Reconcile one doc: staleness detail for a single target. |
| `scip-query outline <subject-file>` | Tree view of symbols in a file, with line ranges | symbol names, nesting, and line ranges | `complete` | Reconcile one doc: current shape of the code the doc describes. |
| `scip-query trace <symbol>` | Trace a symbol: definition + all references | definition sites with source and signature; referencing files with line numbers | `bounded` | Reconcile one doc: verify a symbol the doc mentions still exists as described. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | definition identity, source, and line range | `complete` | Reconcile one doc: re-derive a snippet from current source. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

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

Prioritize broken references, highest staleness, then docs agents read most. Do not reconcile archival records such as dated plans, ADRs, or reports — list them in `.scipquery.json` `docs.snapshotPaths` so `doc-drift` excludes them with a labeled exclusion instead of resurfacing them every sweep.

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
