---
name: scip-improve
description: Use when edits should actually be made: fix confirmed cleanup findings batch by batch, consolidate a drifted twin into one canonical helper, implement a named maintainability mechanism, extract a React hook or Vue composable, move files to fix locality, or bring AGENTS.md/standards/docs back in sync with code. Requires findings already confirmed — audit first if they are not. For reducing one symbol's cognitive complexity, use `complexity-cleanup`; for deciding where a boundary belongs at design time, use `decomposition`.
commands:
  - template: "scip-query cleanup-plan --verify"
    when: "Build compiler-checked deletion batches from confirmed dead-code findings."
  - template: "scip-query cleanup-apply --verified --batch <n> --dry-run"
    when: "Apply one already verified cleanup batch."
  - template: "scip-query diff-gate"
    when: "Gate each implemented improvement slice before declaring it complete."
---

## Purpose

This skill edits the working tree. It does not discover findings — it acts on
findings someone already confirmed: a cleanup-plan batch, a twin-drift group,
a maintainability register entry, a React/Vue duplicate or extraction
candidate, a directory move ledger, or a doc-drift worklist. If nothing has
been confirmed yet, run the matching scenario in `scip-audit` and come back
with its evidence and disposition.

## Ground rules, every scenario

- Work in small, independently verifiable batches or slices — one verified
  deletion batch, one migration slice, one twin group, one register entry.
  Continue through those slices autonomously; do not collapse all findings
  into one unverified mutation.
- Preserve the plan in the canonical intended change or plan document when it
  changes a future decision. Do not narrate a duplicate checklist merely to
  satisfy the control system.
- Re-derive evidence from current `scip-query` output, not from memory or the stale text you're replacing.
- After every applied change, run the routed postchecks in the `scip-verify` skill, in addition to whatever narrow rerun this scenario names.
- Let useful commands and Stop evaluation capture attempts, evidence, and
  next-action decisions automatically. Follow the exact restored next action;
  use manual ledger commands only when the adapter explicitly reports that
  automatic integration is unavailable.
- Use this skill's shortlist first. Load command mechanics from `_shared` only
  when the shortlist is insufficient.

## Triage

| Situation | Do this | Reference |
|---|---|---|
| Fix confirmed cleanup findings, raise health, "keep cleaning" | `health` → `cleanup-plan --verify` → preview then apply one `cleanup-apply --verified --batch <n>` in a loop | `references/cleanup-batches.md` |
| AGENTS.md/CLAUDE.md/standards/command docs are stale or cite moved code | `doc-drift` → `outline`/`trace`/`code` per doc → rerun `doc-drift` | `references/doc-reconcile.md` |
| Same-name/near-name functions diverged, one-sided fix, drifted threshold | `twin-drift --full` → classify → consolidate → rerun `twin-drift` | `references/twin-drift.md` |
| Implement a confirmed maintainability register entry (hidden policy, thin wrapper, dead re-export) | `extract-candidates` / `passthrough-candidates` / `wrapper-candidates` / `stale-abstractions` / `redundant-reexports` to confirm, then implement the disposition | `references/maintainability-mechanism.md` |
| Extract a React hook/component or Vue composable/component | cross-check confirmed candidates, classify reuse/extract/split, extract | `references/frontend-extraction.md` |
| Move files to fix locality, declare/close an architecture boundary | `locality-candidates --full` → migration slice → boundary config → postchecks | `references/directory-moves.md` |

## Owned commands

`cleanup-apply`, `cleanup-plan`, `twin-drift`, `doc-drift`, `locality-candidates`, `extract-candidates`, `passthrough-candidates`, `wrapper-candidates`, `redundant-reexports`, `stale-abstractions` — each has a worked scenario in the references above; none should be run without reading the reference's evidence caveat first (several of these detectors are exploration-only with near-zero precision on codebases with intentional layering).


<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | Returns | Coverage | When |
| --- | --- | --- | --- | --- |
| `scip-query cleanup-plan --verify` | Ordered, batched deletion plan: graph-fact dead code plus the cascade candidates it unlocks | ordered cleanup batches, evidence, and optional verification outcomes | `bounded` | Build compiler-checked deletion batches from confirmed dead-code findings. |
| `scip-query cleanup-apply --verified --batch <n> --dry-run` | Apply a compiler-verified cleanup-plan batch to the working tree | applied files, deletions, verification, and refusal reasons | `bounded` | Apply one already verified cleanup batch. |
| `scip-query diff-gate` | Runtime-bounded, single-flight gate for the current diff: architecture regressions plus echo, migration, coordination, doc-drift, unused-param, and new-dead candidates; exit 1 on blocking findings | blocking findings with check id, message, and remediation; advisory findings; root-cause groups; changed file and symbol counts; process exit status (1 when blocking findings exist) | `bounded` | Gate each implemented improvement slice before declaring it complete. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->
