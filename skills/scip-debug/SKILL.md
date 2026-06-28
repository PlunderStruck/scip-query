---
name: scip-debug
description: Root-cause bugs and regressions with scip-query evidence. Use when the user reports a bug, failing behavior, regression, confusing runtime path, broken data flow, or asks to debug, diagnose, reproduce, trace, or explain why code behaves incorrectly before fixing it.
---

# SCIP Debug

Use this skill to move from a reported failure to a minimal verified fix. A bug is a mismatch between expected behavior and observed behavior in a concrete execution path. A root cause is the earliest code fact in that path that explains the mismatch and makes the later symptoms possible.

## Rules

1. Reproduce or restate the failure before changing code.
2. Use scip-query to identify entry points, call paths, data flow, and blast radius. Do not debug from filename guesses alone.
3. Prefer one narrow fix over broad cleanup. If cleanup is also needed, record it after the bug fix unless it is required for correctness.
4. Verify the fix with the repo's test or smoke command, then run `scip-verify`.

## Workflow

### 1. Pin the failure

Record:

- observed behavior;
- expected behavior;
- command, route, UI action, test, job, or file that exposes it;
- error text or wrong output;
- suspected time window if it is a regression.

If the user provides no reproduction, make the smallest runnable reproduction you can from the repo's existing tests, scripts, CLI, or app entry points.

### 2. Find the entry point

```bash
scip-query status --capabilities
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query files <feature-or-error-term>
scip-query outline <candidate-file>
scip-query trace <candidate-symbol>
scip-query code <candidate-symbol>
```

Use `scip-query by-kind function --scope <scope>` or `scip-query kind-counts --scope <scope>` when the codebase is unfamiliar and you need an inventory before selecting an entry point.

### 3. Follow execution

```bash
scip-query call-graph <entry-symbol>
scip-query code <callee-symbol>
scip-query refs <state-or-api-symbol>
scip-query fan-in <suspect-symbol>
scip-query fan-out <suspect-file>
```

Build the smallest path that explains the observed behavior. Stop expanding once the path reaches the first code fact that can cause the symptom.

### 4. Follow data and state

```bash
scip-query dataflow <symbol-or-variable>
scip-query slice <symbol-or-variable>
scip-query slice <symbol-or-variable> --forward
```

Use dataflow when the bug looks like wrong state, wrong input normalization, missing validation, stale cache, dropped field, wrong async order, or an unexpected output value.

### 5. Compare nearby implementations

```bash
scip-query similar <suspect-symbol> --json --full
scip-query convergence <suspect-symbol> <similar-symbol>
scip-query similar-files <suspect-file> --json --full
```

A similar implementation can reveal the missing branch, guard, conversion, lifecycle step, or error handling path. Preserve essential differences; do not copy behavior blindly.

### 6. Bound the fix

```bash
scip-query change-surface <suspect-file> --json --full
scip-query affected <suspect-symbol> --json
scip-query diff-impact --json
```

Name the smallest symbol or file that should change. If the blast radius is larger than the bug's scope, explain why before editing.

### 7. Fix and verify

Apply the minimal code change, then run:

```bash
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query diff-gate --json
```

Also run the narrowest repo test, app smoke test, or command that reproduces the failure. Invoke `scip-verify` before calling the bug fixed.

## Report Format

```markdown
Bug: <observed mismatch>

Entry point:
- <file/symbol> from <command>

Root cause:
- <code fact> from <command>

Fix:
- <minimal change>

Verification:
- <repo test or smoke command>
- `scip-query diff-gate --json`

Remaining risk:
- <blast radius, unavailable capability, or follow-up cleanup>
```

If no root cause is proven, say what evidence is missing and what command or reproduction would unblock it. Do not present a guess as a fix.
