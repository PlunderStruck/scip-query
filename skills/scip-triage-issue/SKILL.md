---
name: scip-triage-issue
description: Triage bug reports and issues with scip-query evidence. Use when the user shares a GitHub issue, bug report, failing test, support report, TODO, vague defect, or asks to investigate, classify, root-cause, write an issue, or produce a test-first fix plan before implementation.
---

# SCIP Issue Triage

Use this skill to turn a report into a grounded fix plan. An issue is a described mismatch between expected and observed behavior that needs a tracked decision or code change. Triage is the evidence pass that determines whether the issue is reproducible, where it enters the codebase, what root cause is most likely, and what test should fail before the fix.

## Rules

1. Do not file or implement from the title alone. Extract concrete observed behavior, expected behavior, scope, and reproduction first.
2. Use scip-query for code evidence: entry points, references, call flow, data flow, blast radius, and similar implementations.
3. Prefer a failing test plan before a code plan. If no test harness exists, name the smoke command or manual check that will prove the fix.
4. If the user asks only for triage, stop at the triage packet. If they asked to fix it too, implement after the packet is clear.

## Workflow

### 1. Normalize the report

Record:

- title or short summary;
- observed behavior;
- expected behavior;
- reproduction steps or missing reproduction data;
- affected surface: CLI command, API route, UI view, job, library export, docs, or config;
- severity and user impact;
- known logs, stack traces, screenshots, failing tests, or issue links.

If key facts are missing but the repo can answer them, investigate. Ask the user only when the missing fact is product intent, credentials, private data, or an external system state you cannot inspect.

### 2. Map likely code ownership

```bash
scip-query status --capabilities
scip-query status --capabilities
# If freshness is stale, missing, or unknown:
# scip-query reindex
scip-query files <issue-term>
scip-query outline <candidate-file>
scip-query system <module-or-scope>
scip-query surface <module-or-scope>
```

Use `scip-query kind-counts --scope <scope>` and `scip-query by-kind function --scope <scope>` when the issue names a broad subsystem and you need an inventory.

### 3. Trace the failing path

```bash
scip-query trace <entry-or-error-symbol>
scip-query code <entry-or-error-symbol>
scip-query call-graph <entry-symbol>
scip-query dataflow <state-or-input-symbol>
scip-query slice <state-or-input-symbol>
```

If a stack trace names a file and line, use `scip-query code '<file>:<start>-<end>'` to read the exact region before following symbols.

### 4. Look for known-good comparisons

```bash
scip-query similar <suspect-symbol> --json --full
scip-query convergence <suspect-symbol> <comparison-symbol>
scip-query similar-files <suspect-file> --json --full
scip-query co-change <suspect-file> --json --full
```

Use comparisons to identify a missing guard, validation step, conversion, docs partner, generated artifact, or test fixture.

### 5. Bound impact and test shape

```bash
scip-query change-surface <suspect-file> --json --full
scip-query affected <suspect-symbol> --json
scip-query diff-impact --json
```

Choose the narrowest failing test that proves the bug. If the issue crosses a public API or generated contract, include `scip-query co-change <file> --json --full` in the plan.

## Triage Packet

Write the packet before filing or fixing:

```markdown
## Issue
<one-sentence mismatch>

## Reproduction
<steps, command, failing test, or missing data>

## Evidence
- <scip-query command>: <fact>

## Suspected Root Cause
<earliest code fact that explains the symptom>

## Impact
- users/surfaces affected
- blast radius from `scip-query affected` or `change-surface`

## Fix Plan
1. Add or update failing test/smoke check.
2. Make the smallest code change.
3. Run targeted test.
4. Run `scip-query status --capabilities`; if freshness is `stale`, `missing`, or `unknown`, run `scip-query reindex`.
5. Run `scip-query diff-gate --json`.
6. Invoke `scip-verify`.

## Open Questions
- <product intent or external state only>
```

If creating a GitHub issue, use the packet as the issue body and include exact file/symbol references. If no root cause is proven, label the result as `needs reproduction` or `needs product decision`, not as ready to implement.
