---
name: scip-twin-drift
description: Find and resolve twin drift with scip-query. Use for same-name or near-name functions across files with diverged bodies, drifted policy thresholds, one-sided fixes, or consolidating a duplicated concept into one canonical helper.
metadata:
  commands:
    - template: 'scip-query twin-drift -s <scope> --json'
      when: 'Enumerate same-name or near-name callable groups whose bodies partially overlap.'
    - template: 'scip-query duplicate-bodies -s <scope>'
      when: 'Separate exact clones, which belong to this detector, from drifted twins.'
    - template: 'scip-query code <selector>'
      when: 'Read every member of a divergent group to classify the divergence.'
    - template: 'scip-query refs <symbol>'
      when: 'Pick the canonical twin by consumer count.'
    - template: 'scip-query diff-impact'
      when: 'After consolidating, map the changed symbols and every downstream consumer.'
---

# scip-twin-drift

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query twin-drift -s <scope> --json` | Enumerate same-name or near-name callable groups whose bodies partially overlap. |
| `scip-query duplicate-bodies -s <scope>` | Separate exact clones, which belong to this detector, from drifted twins. |
| `scip-query code <selector>` | Read every member of a divergent group to classify the divergence. |
| `scip-query refs <symbol>` | Pick the canonical twin by consumer count. |
| `scip-query diff-impact` | After consolidating, map the changed symbols and every downstream consumer. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

Use this skill when the same concept exists in more than one place under the same or a near-name (case-insensitive, or edit-distance at most 2 for names of 8 or more characters) and the bodies have silently diverged. A twin drift group is a same-leaf-name family of callables spanning at least two files whose normalized-token bodies are neither identical (that is the job of `duplicate-bodies`) nor unrelated (a homonym like `render` or `parse`) but partially overlapping. That overlap is the signature of a concept that was copied once and then edited independently in only some of its copies.

## Rules

1. `IDENTICAL` groups defer to `duplicate-bodies`; do not re-report them here.
2. Homonyms (similarity below `--min-similarity`, default 0.3) are noise unless `--include-homonyms` was requested; do not chase them.
3. Every `DIVERGENT` group in scope gets a classification before this skill reports done.
4. Prefer consolidation to one exported helper over leaving parallel copies. When consolidation is unsafe or premature, record the intent gap explicitly in a comment or a suppression with a reason rather than silently accepting drift.
5. If your own diff introduces a new twin, you just reproduced the defect class this skill exists to catch. Fix or explicitly accept it before finishing.

## Workflow

### 1. Run the detector

```bash
scip-query twin-drift -s <scope> --json
scip-query duplicate-bodies -s <scope>
```

Scope with `-s <path>` when the review is bounded to a module. Record group count, member count, and the maximum divergence per group.

This step is complete only when every group in scope is enumerated with its relationship (`divergent` versus suppressed homonym).

### 2. Classify each DIVERGENT group

For each group, read every member with `scip-query code <symbol-or-file:range>` and use the group's first divergent tokens as a starting point for where the bodies diverge. Classify the group as one of:

- **Intentional variation**: the copies differ because the domains genuinely differ, for example a React-specific versus Vue-specific structural comparator that must branch on framework-specific overlap checks. Essential variation stays; record why.
- **Drifted policy**: the copies encode what should be one policy (a threshold, a normalization rule, an edge-case guard) that only some copies received when it last changed. This is a bug: pick the correct value and propagate it, or extract the policy into one named function or constant.
- **One-sided fix**: one copy was bugfixed or hardened and its twins were not. This is also a bug: apply the same fix to every member, or consolidate.

This step is complete only when every DIVERGENT group in scope has one of these three labels with a one-line reason.

### 3. Pick the canonical twin and act

For groups getting consolidated, pick the canonical member by consumer count:

```bash
scip-query refs <symbol-in-file-A>
scip-query refs <symbol-in-file-B>
```

Prefer the member with the most consumers, or the one in the more general or shared location when counts tie. Extract or move the canonical body to one exported helper; update the other members to call it, or delete them if they were pure duplication with different names for the caller's convenience. Preserve any classified-essential variation as a parameter or a thin caller-side branch, not as a second copy of the whole body.

For groups marked intentional variation, do not force consolidation. Record the reason in a comment near one of the members so the next `twin-drift` run and the next reader both see it was considered.

This step is complete only when every DIVERGENT group is either consolidated (with the old copies gone or forwarding) or has a recorded reason it stays separate.

### 4. Verify

Rerun the detector to confirm consolidated groups no longer appear as DIVERGENT, run the repository's own tests and typecheck for the touched files, then:

```bash
scip-query diff-impact
```

Read every downstream consumer it lists. A consumer that depended on the deleted twin's behavior, not the canonical one's, is a regression this skill must catch before finishing.

This step is complete only when `twin-drift` shows no unclassified `DIVERGENT` groups in scope and every consumer named by `diff-impact` has been checked.

## Report

```markdown
Scope:
Groups found: N (M divergent, K suppressed homonyms)

Divergent groups:

- <leaf name> (<files>): classification: intentional variation | drifted policy | one-sided fix
  - action: consolidated into <canonical file:symbol> | reason kept separate

Verification:

- `scip-query twin-drift -s <scope> --json`: <result>
- `scip-query diff-impact`: <consumers checked>
```
