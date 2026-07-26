---
name: scip-improve
description: Use when edits should actually be made: fix confirmed cleanup findings batch by batch, consolidate a drifted twin into one canonical helper, implement a named maintainability mechanism, extract a React hook or Vue composable, move files to fix locality, or bring AGENTS.md/standards/docs back in sync with code. Requires findings already confirmed — audit first if they are not. For reducing one symbol's cognitive complexity, use `complexity-cleanup`; for deciding where a boundary belongs at design time, use `decomposition`.
---

## Purpose

This skill edits the working tree. It does not discover findings — it acts on findings someone already confirmed: a cleanup-plan batch, a twin-drift group, a maintainability register entry, a React/Vue duplicate or extraction candidate, a directory move ledger, or a doc-drift worklist. If nothing has been confirmed yet, run the matching audit skill first (`scip-cleanup-audit`, `scip-twin-drift`, `scip-maintainability`, `scip-react-maintainability`, `scip-vue-maintainability`, `scip-directory-architecture`) and come back with its output.

## Ground rules, every scenario

- Work in small, independently verifiable batches or slices — one verified deletion batch, one migration slice, one twin group, one register entry. Never apply everything unattended.
- State the plan before editing: what's confirmed, the evidence, the intended change, how you'll verify it.
- Re-derive evidence from current `scip-query` output, not from memory or the stale text you're replacing.
- After every applied change, run the routed postchecks in the `scip-verify` skill, in addition to whatever narrow rerun this scenario names.
- Load command mechanics from `_shared` first; this file only names the commands each scenario needs and what to do with their output.

## Triage

| Situation | Do this | Reference |
|---|---|---|
| Fix confirmed cleanup findings, raise health, "keep cleaning" | `health` → `cleanup-plan --verify` → `cleanup-apply --verified --batch <n>` in a loop | `references/cleanup-batches.md` |
| AGENTS.md/CLAUDE.md/standards/command docs are stale or cite moved code | `doc-drift` → `outline`/`trace`/`code` per doc → rerun `doc-drift` | `references/doc-reconcile.md` |
| Same-name/near-name functions diverged, one-sided fix, drifted threshold | `twin-drift --json --full` → classify → consolidate → rerun `twin-drift` | `references/twin-drift.md` |
| Implement a confirmed maintainability register entry (hidden policy, thin wrapper, dead re-export) | `extract-candidates` / `passthrough-candidates` / `wrapper-candidates` / `stale-abstractions` / `redundant-reexports` to confirm, then implement the disposition | `references/maintainability-mechanism.md` |
| Extract a React hook/component or Vue composable/component | cross-check confirmed candidates, classify reuse/extract/split, extract | `references/frontend-extraction.md` |
| Move files to fix locality, declare/close an architecture boundary | `locality-candidates --json --full` → migration slice → boundary config → postchecks | `references/directory-moves.md` |

## Owned commands

`cleanup-apply`, `cleanup-plan`, `twin-drift`, `doc-drift`, `locality-candidates`, `extract-candidates`, `passthrough-candidates`, `wrapper-candidates`, `redundant-reexports`, `stale-abstractions` — each has a worked scenario in the references above; none should be run without reading the reference's evidence caveat first (several of these detectors are exploration-only with near-zero precision on codebases with intentional layering).
