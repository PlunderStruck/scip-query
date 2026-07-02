---
name: scip-cleanup-audit
description: Audit and rank scip-query cleanup signals without editing code. Use for health reports, de-bloat reports, recent AI residue audits, score-framed cleanup queues, confirming raw findings, or preparing a cleanup plan.
commands:
  - template: "scip-query health --json"
    when: "Establish evidence: composite score and prioritized action list."
  - template: "scip-query cleanup-plan --verify --json"
    when: "Sweep signals: compiler-verified deletion plan, batched."
  - template: "scip-query duplicate-bodies --json --full"
    when: "Sweep signals: exact duplicate small-body candidates."
  - template: "scip-query recent-duplicates --json --full"
    when: "Sweep signals: recent code that re-implements established code."
  - template: "scip-query incomplete-migration --json --full"
    when: "Sweep signals: partially-completed extractions."
  - template: "scip-query doc-drift --json --full"
    when: "Sweep signals: stale docs referencing changed code."
---

# scip-cleanup-audit

Use this skill to turn raw scip-query signals into a confirmed cleanup queue. Do not edit application code in this skill.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query health --json` | Composite codebase health report with prioritized action list | Establish evidence: composite score and prioritized action list. |
| `scip-query cleanup-plan --verify --json` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | Sweep signals: compiler-verified deletion plan, batched. |
| `scip-query duplicate-bodies --json --full` | Find exact duplicate small-body candidates across files | Sweep signals: exact duplicate small-body candidates. |
| `scip-query recent-duplicates --json --full` | Directional duplicate candidates: recent code that re-implements established callable, React, or Vue code | Sweep signals: recent code that re-implements established code. |
| `scip-query incomplete-migration --json --full` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain | Sweep signals: partially-completed extractions. |
| `scip-query doc-drift --json --full` | Stale-doc candidates: code the doc references or co-changed with kept changing after the doc stopped | Sweep signals: stale docs referencing changed code. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Modes

- Whole-repo audit: rank all cleanup signals.
- Recent AI residue: focus on echoes, twins, incomplete migrations, speculative params, stale agent-facing docs, and hidden couplings.
- Score-framed audit: explain health score deductions and the safest first batch.

## Workflow

### 1. Establish evidence

```bash
scip-query doctor
scip-query status --capabilities
scip-query health --json
scip-query capabilities --json
scip-query config-validate --json
```

This step is complete only when unavailable capabilities are recorded as unavailable.

### 2. Sweep signals

Run every relevant class, or record why it is unavailable:

```bash
scip-query cleanup-plan --verify --json
scip-query duplicate-bodies --json --full
scip-query recent-duplicates --json --full
scip-query incomplete-migration --json --full
scip-query unused-params --json --full
scip-query passthrough-candidates --json --full
scip-query dead --json --full
scip-query isolated --json --full
scip-query cycles
scip-query co-change --json --full
scip-query doc-drift --json --full
```

For frontend repos, add the React or Vue duplicate, hook/composable, and large-component/view commands.

Optional deep-dive (near-zero precision on codebases with intentional layering/ambient types — run only when the sweep above is exhausted, and treat every hit as a lead to confirm, not a finding):

```bash
scip-query stale-abstractions --json --full
scip-query wrapper-candidates --json --full
```

### 3. Confirm candidates

For each high-priority candidate, inspect source and graph evidence:

```bash
scip-query code <symbol-or-file>
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query fan-out <symbol-or-file>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
scip-query similar <symbolA> <symbolB> --plan
scip-query co-change <file> --json --full
```

Classify every candidate as `confirmed fix target`, `intentional design`, `false positive`, or `blocked`.

### 4. Report

```markdown
Health score: N/100

Confirmed items:
- [priority] finding - evidence - first safe action

Unconfirmed signals:
- signal - evidence still needed

Unavailable or blocked checks:
- check - reason

Recommended first cleanup batch:
- batch - why safe now
```

The audit is complete only when each collected signal is classified and the next action is visible.
