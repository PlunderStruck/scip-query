---
name: scip-verify
description: Post-implementation verification using scip-query's modern gate model. Use after making code, docs, config, refactor, cleanup, or setup changes; before committing; when the user asks whether a change is wired correctly, safe, verified, regression-free, or ready to ship.
---

# Post-Implementation Verification with scip-query

Verify the actual diff, not your intention. A verification pass proves that the current workspace has a runnable scip-query environment, a current index, expected blast radius, no diff-gate findings, and no relevant health or config regression.

## Hard Rules

1. Run environment checks before trusting graph facts.
2. Check index freshness before final verification. Reindex only when freshness is `stale`, `missing`, or `unknown`, unless a just-finished command already refreshed the index and no files changed afterward.
3. Treat `scip-query diff-gate --json` as the primary blocker for diff-specific risk. Manual checks are drill-down evidence, not a replacement.
4. Run the postchecks that match the actual change type.
5. Prefer fixing findings. Use `scip-query suppress <id> --reason "<specific reason>"` only for intentional design, compatibility shims, framework entry points, or accepted false positives with durable evidence.
6. If `.scipquery.json` or suppressions changed, run `scip-query config-validate`.

## Default Verification Flow

### 1. Prove the workspace can answer

```bash
scip-query doctor
scip-query status --capabilities
```

If either command reports missing indexers, stale indexes, invalid config, or unavailable capabilities relevant to the change, resolve that first or report it as a blocker. Unavailable is not clean; it means that signal class was not proven.

### 2. Refresh and assess the diff

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-impact --json
```

Use `diff-impact` to check whether the changed files, changed symbols, and downstream consumers match the work you intended to do. Unexpected symbols or a much wider blast radius are findings even if `diff-gate` later passes.

### 3. Run routed postchecks

Run every row that applies to the work just performed.

| Change type | Required checks |
|---|---|
| Extracted a helper or created an abstraction | `scip-query incomplete-migration --json --full` |
| Added a new helper, module, component, or adapter | `scip-query similar <symbol> --json --full` and `scip-query recent-duplicates --json --full` |
| Added parameters, options, or config flags | `scip-query unused-params --json --full` |
| Added a forwarding or wrapper layer | `scip-query wrapper-candidates --json --full` and `scip-query passthrough-candidates --json --full` |
| Added an interface, base class, adapter contract, or type alias | `scip-query stale-abstractions --json --full` |
| Changed schema, config, generated artifacts, or public contracts | `scip-query co-change <file> --json --full` |
| Changed code described by docs or changed docs that cite code | `scip-query doc-drift --json --full` |
| Deleted code | `scip-query cleanup-plan --verify --json` |
| Changed React components or hooks | `scip-query react-component-duplicates --json --full`, `scip-query react-hook-candidates --json --full`, and `scip-query react-large-component-pressure --json --full` |
| Changed Vue SFCs or composables | `scip-query vue-component-duplicates --json --full`, `scip-query vue-composable-candidates --json --full`, and `scip-query vue-large-view-pressure --json --full` |

Use focused probes when a finding needs explanation:

```bash
scip-query code <symbol-or-file>
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query fan-out <symbol>
scip-query affected <symbol> --json
scip-query change-surface <file> --json --full
```

### 4. Run the gate

```bash
scip-query diff-gate --json
```

On any finding, fix it or explicitly accept it with evidence. Do not ignore a nonzero gate. If a suppression is the right outcome, record the reason and validate config:

```bash
scip-query suppress <id> --reason "<specific reason>"
scip-query config-validate
```

### 5. Check baseline health when present

Run this when the repository has a committed scip-query baseline:

```bash
scip-query health --baseline
```

If no baseline exists and the user asked for broad health verification, run:

```bash
scip-query health --json --full
```

Health score changes are diagnostic, not the objective. A score drop matters when it corresponds to a real new signal; a score increase does not excuse unverified behavior.

### 6. Validate config and docs when touched

If `.scipquery.json`, AGENTS.md, CLAUDE.md, command docs, or skill instructions changed, run the relevant check:

```bash
scip-query config-validate
scip-query doc-drift --json --full
```

For generated command docs, also run the repo's descriptor or docs test if one exists.

If you are maintaining scip-query analyzers or command descriptors inside the scip-query repository itself, add:

```bash
scip-query self-audit
```

This is a maintainer check for analyzer consistency, not a general app-developer verification step.

## Manual Drill-Down Checks

Use these when `diff-impact`, routed postchecks, or `diff-gate` point to a structural risk:

```bash
scip-query cycles
scip-query dead --json --full
scip-query isolated --json --full
scip-query coupling
scip-query bottlenecks
```

These commands are not a substitute for `diff-gate`; they explain or bound the finding.

## Verification Report

End with a compact report:

```markdown
Verification: PASS/FAIL

Environment:
- doctor: PASS/FAIL
- status capabilities: PASS/FAIL or unavailable checks

Diff:
- changed files/symbols from `scip-query diff-impact --json`
- unexpected blast radius, if any

Postchecks:
- <command>: PASS/FAIL and finding count

Gate:
- `scip-query diff-gate --json`: PASS/FAIL

Health/config:
- baseline or health result
- config validation result when applicable

Remaining risk:
- accepted suppressions, blocked capabilities, or checks not run
```

Do not claim "safe to commit" unless freshness is `fresh` after the final file edit and `scip-query diff-gate --json` passed.
