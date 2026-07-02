---
name: scip-cleanup-improve
description: Improve scip-query health autonomously with verified cleanup. Use when the user asks to fix cleanup findings, raise health, keep cleaning, continue after setup, or work until no safe confirmed cleanup remains.
commands:
  - template: "scip-query health --json"
    when: "Before editing: report current score and remaining signals."
  - template: "scip-query cleanup-plan --verify --json"
    when: "Loop: confirm the next compiler-verified deletion batch."
  - template: "scip-query cleanup-apply --verified --batch <n>"
    when: "Loop: apply one verified deletion batch."
  - template: "scip-query duplicate-bodies --json --full"
    when: "Priority: exact duplicate small-body echoes to consolidate."
  - template: "scip-query incomplete-migration --json --full"
    when: "Priority: un-migrated call sites left behind by a new helper."
---

# scip-cleanup-improve

Use this skill for bounded autonomous cleanup. The target is not score chasing; the target is fixing confirmed issues that make the codebase harder to understand, verify, or change.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query health --json` | Composite codebase health report with prioritized action list | Before editing: report current score and remaining signals. |
| `scip-query cleanup-plan --verify --json` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | Loop: confirm the next compiler-verified deletion batch. |
| `scip-query cleanup-apply --verified --batch <n>` | Apply a compiler-verified cleanup-plan batch to the working tree | Loop: apply one verified deletion batch. |
| `scip-query duplicate-bodies --json --full` | Find exact duplicate small-body candidates across files | Priority: exact duplicate small-body echoes to consolidate. |
| `scip-query incomplete-migration --json --full` | Partially-completed extraction candidates: new helpers in the diff wired into some sites while similar un-migrated sites remain | Priority: un-migrated call sites left behind by a new helper. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Start with `scip-cleanup-audit` evidence or run the audit sweep yourself.
2. Report current health and the first confirmed batch before editing.
3. Prioritize high-confidence, low-blast-radius, clearly verifiable fixes.
4. Apply one small batch at a time.
5. Write or update the health baseline after a cleanup pass, then compare at the start of the next pass.

## Priority

1. Compiler-verified deletion batches.
2. Incomplete migrations and recent duplicate echoes.
3. Unused params, unused imports, dead symbols, and isolated symbols.
4. Broken or stale docs, config validation issues, and missing co-change partners.
5. Thin wrappers, passthroughs, stale abstractions, and speculative generality.
6. Frontend component/hook/composable duplication and large-view pressure.
7. Directory architecture and maintainability repairs only when evidence is strong and the blast radius is bounded.

## Loop

Before editing:

```markdown
Health score: N/100
First confirmed batch:
- finding - evidence - planned fix - verification
Remaining signals:
- signal - status
```

Then repeat:

1. Apply one verified deletion batch or one small targeted refactor.
2. Run the narrow project check for touched behavior.
3. Run `scip-query health --json`.
4. Invoke `scip-verify`.
5. Update health dossiers when present.
6. Pick the next highest-priority confirmed item.

Use `scip-query cleanup-apply --verified --batch <n>` for verified deletion batches. Use `--all` only with explicit user approval.

## Stop

Stop when only intentional, false-positive, blocked, or unconfirmed items remain; when the next improvement needs a product/API/ownership decision; when a missing toolchain prevents trustworthy verification; or when further work would be broad redesign rather than bounded cleanup.

## Closeout

Report starting and final health scores, batches applied, important files changed, verification commands, remaining accepted or blocked items, and highest-value follow-up.
