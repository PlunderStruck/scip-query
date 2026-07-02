---
name: scip-debug
description: Debug bugs and regressions with scip-query evidence. Use for failing behavior, wrong data flow, confusing runtime paths, broken tests, root-cause analysis, reproduction, tracing, or minimal fixes.
commands:
  - template: "scip-query files <feature-or-error-term>"
    when: "Find the entry point from a feature name or error term."
  - template: "scip-query trace <candidate-symbol>"
    when: "Find the entry point: definition plus every reference."
  - template: "scip-query call-graph <entry-symbol>"
    when: "Follow execution: callers and callees along the failing path."
  - template: "scip-query dataflow <symbol-or-variable>"
    when: "Follow data: producers, consumers, and usage sites."
  - template: "scip-query similar <suspect-symbol> --json --full"
    when: "Compare nearby implementations for missing guards or handling."
  - template: "scip-query change-surface <suspect-file> --json --full"
    when: "Bound the fix: exports, consumers, and blast-radius risk."
---

# scip-debug

Use this skill to move from a reported failure to a minimal verified fix. A bug is a mismatch between expected behavior and observed behavior in a concrete execution path. A root cause is the earliest code fact in that path that explains the mismatch.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Commands for this skill

| Command | Purpose | When |
| --- | --- | --- |
| `scip-query files <feature-or-error-term>` | Find files matching a pattern | Find the entry point from a feature name or error term. |
| `scip-query trace <candidate-symbol>` | Trace a symbol: definition + all references | Find the entry point: definition plus every reference. |
| `scip-query call-graph <entry-symbol>` | Show incoming callers and outgoing callees for a symbol | Follow execution: callers and callees along the failing path. |
| `scip-query dataflow <symbol-or-variable>` | Reference-level dataflow: definition sites, usage sites, producers, consumers | Follow data: producers, consumers, and usage sites. |
| `scip-query similar <suspect-symbol> --json --full` | Find heuristic function similarity candidates from callee fingerprints | Compare nearby implementations for missing guards or handling. |
| `scip-query change-surface <suspect-file> --json --full` | Pre-change briefing: exports, consumers, and blast-radius risk | Bound the fix: exports, consumers, and blast-radius risk. |

Use this shortlist first. Open [`../_shared/SKILL.md`](../_shared/SKILL.md) only when it is insufficient.
<!-- END GENERATED SKILL COMMANDS -->

## Rules

1. Reproduce or restate the failure before editing.
2. Use scip-query to find entry points, call paths, data flow, and blast radius.
3. Prefer one narrow fix over broad cleanup.
4. Verify with the narrowest repo test or smoke command, then invoke `scip-verify`.

## Workflow

### 1. Pin the failure

Record observed behavior, expected behavior, reproducing command/route/UI action/test/job/file, error text or wrong output, and regression window if known.

If no reproduction is provided, build the smallest runnable reproduction from existing tests, scripts, CLI, or app entry points.

This step is complete only when the mismatch is concrete enough to test or the missing external fact is named.

### 2. Find the entry point

```bash
scip-query files <feature-or-error-term>
scip-query outline <candidate-file>
scip-query trace <candidate-symbol>
scip-query code <candidate-symbol>
```

Use `kind-counts` or `by-kind` when the codebase is unfamiliar.

This step is complete only when the failing path has a plausible entry point with source evidence.

### 3. Follow execution and data

```bash
scip-query call-graph <entry-symbol>
scip-query code <callee-symbol>
scip-query refs <state-or-api-symbol>
scip-query fan-in <suspect-symbol>
scip-query fan-out <suspect-file>
scip-query dataflow <symbol-or-variable>
scip-query slice <symbol-or-variable>
scip-query slice <symbol-or-variable> --forward
```

Stop expanding when the first code fact that can cause the symptom is found.

This step is complete only when the path explains the symptom or the missing evidence is explicit.

### 4. Compare nearby implementations

```bash
scip-query similar <suspect-symbol> --json --full
scip-query similar <suspect-symbol> <similar-symbol> --plan
scip-query similar-files <suspect-file> --json --full
```

Use comparisons to find missing guards, conversions, lifecycle steps, or error handling. Preserve essential differences.

This step is complete only when comparisons either support the fix or are rejected with a reason.

### 5. Bound and fix

```bash
scip-query change-surface <suspect-file> --json --full
scip-query affected <suspect-symbol> --json
```

Make the smallest code change that fixes the root cause.

This step is complete only when the changed symbol/file is justified by blast-radius evidence.

### 6. Verify

Run the reproduction, narrow test or smoke command, and invoke `scip-verify`.

## Report

```markdown
Bug:
Entry point:
Root cause:
Fix:
Verification:
Remaining risk:
```

Do not present a guess as a root cause. If no root cause is proven, report the missing evidence.
