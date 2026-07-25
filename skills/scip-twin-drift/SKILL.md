---
name: scip-twin-drift
description: Find and resolve twin drift with scip-query. Use for same-name or near-name functions across files with diverged bodies, drifted policy thresholds, one-sided fixes, or consolidating a duplicated concept into one canonical helper.
commands:
  - template: 'scip-query twin-drift --json --full'
    when: 'Run the detector: every DIVERGENT and near-name group in scope.'
  - template: 'scip-query duplicate-bodies --json --full'
    when: "Cross-check: IDENTICAL groups are duplicate-bodies' job, not this skill's."
  - template: 'scip-query code <symbol>'
    when: "Classify a divergent group: read every member's body."
  - template: 'scip-query refs <symbol>'
    when: 'Pick the canonical twin: consumer count per member.'
  - template: 'scip-query diff-gate --json'
    when: 'Verify: the twin-partner check must not flag a one-sided fix.'
---

# scip-twin-drift

Use this skill when the same concept exists in more than one place under the same or a near-name (case-insensitive, or edit-distance ≤ 2 for names ≥ 8 characters) and the bodies have silently diverged. A twin drift group is a same-leaf-name family of callables spanning at least two files whose normalized-token bodies are neither identical (that is `duplicate-bodies`' job) nor unrelated (a homonym like `render` or `parse`) but partially overlapping — the signature of a concept that was copied once and then edited independently in only some of its copies.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query twin-drift --json --full` | Twin drift candidates: same-name (or near-name) functions across files with diverged bodies | twin symbol pairs, history, and divergence evidence | `bounded` | Run the detector: every DIVERGENT and near-name group in scope. |
| `scip-query duplicate-bodies --json --full` | Find exact duplicate small-body candidates across files | callable groups with exact normalized-body identity | `bounded` | Cross-check: IDENTICAL groups are duplicate-bodies' job, not this skill's. |
| `scip-query code <symbol>` | Read the source code for a symbol (bounded to its definition range) | definition identity, source, and line range | `complete` | Classify a divergent group: read every member's body. |
| `scip-query refs <symbol>` | Find all files referencing a symbol | referencing file paths; reference line numbers grouped by file | `bounded` | Pick the canonical twin: consumer count per member. |
| `scip-query diff-gate --json` | Gate the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | blocking findings with check id, message, and remediation; advisory findings; root-cause groups; changed file and symbol counts; process exit status (1 when blocking findings exist) | `bounded` | Verify: the twin-partner check must not flag a one-sided fix. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. `IDENTICAL` groups defer to `duplicate-bodies`; do not re-report them here.
2. Homonyms (similarity below `--min-similarity`, default 0.3) are noise unless `--include-homonyms` was requested; do not chase them.
3. Every `DIVERGENT` group in scope gets a classification before this skill reports done.
4. Prefer consolidation to one exported helper over leaving parallel copies; when consolidation is unsafe or premature, record the intent gap explicitly (comment or waiver) rather than silently accepting drift.
5. A twin-partner `diff-gate` finding on a change you are making is the live version of this same defect class — treat it as a signal to run this skill, not just to suppress.

## Workflow

### 1. Run the detector

```bash
scip-query twin-drift --json --full
```

Scope with `-s/--scope <path>` when the review is bounded to a module. Record group count, member count, and `maxDivergence` per group.

This step is complete only when every group in scope is enumerated with its relationship (`divergent` vs suppressed homonym).

### 2. Classify each DIVERGENT group

For each group, read every member with `scip-query code <symbol-or-file:range>` and use the group's `firstDivergentTokens` as a starting point for where the bodies diverge. Classify the group as one of:

- **Intentional variation**: the copies differ because the domains genuinely differ (for example a React-specific vs Vue-specific structural comparator that must branch on framework-specific overlap checks). Essential variation stays; record why.
- **Drifted policy**: the copies encode what should be one policy (a threshold, a normalization rule, an edge-case guard) that only some copies received when it last changed. This is a bug: pick the correct value and propagate it, or extract the policy into one named function/constant.
- **One-sided fix**: one copy was bugfixed or hardened and its twin(s) were not. This is also a bug: apply the same fix to every member, or consolidate.

This step is complete only when every DIVERGENT group in scope has one of these three labels with a one-line reason.

### 3. Pick the canonical twin and act

For groups getting consolidated, pick the canonical member by consumer count:

```bash
scip-query refs <symbol-in-file-A>
scip-query refs <symbol-in-file-B>
```

Prefer the member with the most consumers, or the one in the more general/shared location when counts tie. Extract or move the canonical body to one exported helper; update the other member(s) to call it, or delete them if they were pure duplication with different names for the caller's convenience. Preserve any classified-essential variation as a parameter or a thin caller-side branch, not as a second copy of the whole body.

For groups marked intentional variation, do not force consolidation; record the reason in a comment near one of the members so the next `twin-drift` run and the next reader both see it was considered.

This step is complete only when every DIVERGENT group is either consolidated (with the old copies gone or forwarding) or has a recorded reason it stays separate.

### 4. Verify

Rerun the detector to confirm consolidated groups no longer appear as DIVERGENT, then run the routed postchecks from `scip-verify` and:

```bash
scip-query diff-gate --json
```

The `twin-partner` check is advisory (it never blocks the gate by itself) but a finding here on your own diff means you just reproduced the exact defect class this skill exists to catch — fix or explicitly accept it before finishing.

This step is complete only when `twin-drift` shows no unclassified `DIVERGENT` groups in scope and `diff-gate` findings are resolved or explained.

## Report

```markdown
Scope:
Groups found: N (M divergent, K suppressed homonyms)

Divergent groups:

- <leaf name> (<files>) — classification: intentional variation / drifted policy / one-sided fix
  - action: consolidated into <canonical file:symbol> / reason kept separate

Verification:

- `scip-query twin-drift --json --full`: <result>
- `scip-query diff-gate --json`: <result>
```
