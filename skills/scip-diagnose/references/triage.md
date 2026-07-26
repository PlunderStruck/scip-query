# Triage: raw report → grounded fix packet

Use this mode to turn a report into a grounded fix packet. Triage is the evidence pass that determines whether the issue is reproducible, where it enters the codebase, what root cause is likely, and what test should fail before the fix.

Load shared mechanics from [`../../_shared/SKILL.md`](../../_shared/SKILL.md) only when this shortlist is insufficient.

## Commands used in this mode

| Command | When |
| --- | --- |
| `scip-query files <issue-term>` | Map ownership: locate files for the reported term (complete coverage: matching file paths). |
| `scip-query outline <candidate-file>` | Map ownership: enumerate symbols in a candidate owner file. |
| `scip-query system <module-or-scope>` / `scip-query surface <module-or-scope>` | Map ownership: the module's real shape and public surface for broad subsystems. |
| `scip-query kind-counts` / `scip-query by-kind` | Map ownership: orient in broad or unfamiliar subsystems. |
| `scip-query trace <entry-or-error-symbol>` | Trace the failing path: definition plus every reference (bounded coverage: definition sites with source/signature, referencing files with line numbers). |
| `scip-query code <entry-or-error-symbol>` | Trace the failing path: read the exact source (complete coverage: definition identity, source, line range). For stack traces, read the exact range with `scip-query code 'file:start-end'`. |
| `scip-query call-graph <entry-symbol>` | Trace the failing path: callers and callees (bounded coverage). |
| `scip-query dataflow <state-or-input-symbol>` / `scip-query slice <state-or-input-symbol>` | Trace the failing path: data flow and slices from the suspect input or state. |
| `scip-query similar <suspect-symbol> --json --full` | Compare and bound: nearby implementations for missing handling (bounded coverage: symbol pairs, similarity scores, shared evidence). |
| `scip-query similar <suspect-symbol> <comparison-symbol> --plan` | Compare and bound: two specific implementations directly. |
| `scip-query similar-files <suspect-file> --json --full` | Compare and bound: nearby files for missing handling. |
| `scip-query co-change <suspect-file> --json --full` | Compare and bound: files that historically changed with the suspect file. |
| `scip-query change-surface <suspect-file> --json --full` | Compare and bound: exports, consumers, and blast-radius risk. |
| `scip-query affected <suspect-symbol> --json` | Compare and bound: transitive impact bound for the fix plan (bounded coverage). |

## Rules

1. Do not file or implement a fix from the issue title alone.
2. Use scip-query for code evidence: entry points, references, call flow, data flow, blast radius, and similar implementations.
3. Prefer a failing test plan before a code plan.
4. If the user asks only for triage, stop at the packet. If they also asked to fix it, implement only after the packet is clear.

## Workflow

### 1. Normalize the report

Record summary, observed behavior, expected behavior, reproduction, affected surface, severity, user impact, and logs/screenshots/tests/links.

Ask the user only for product intent, credentials, private data, or external system state that the repo cannot answer.

This step is complete only when missing facts are either recovered or named.

### 2. Map ownership

```bash
scip-query files <issue-term>
scip-query outline <candidate-file>
scip-query system <module-or-scope>
scip-query surface <module-or-scope>
```

Use `kind-counts` and `by-kind` for broad subsystems.

This step is complete only when likely owner files and surfaces are named.

### 3. Trace the failing path

```bash
scip-query trace <entry-or-error-symbol>
scip-query code <entry-or-error-symbol>
scip-query call-graph <entry-symbol>
scip-query dataflow <state-or-input-symbol>
scip-query slice <state-or-input-symbol>
```

For stack traces, read the exact range with `scip-query code 'file:start-end'`.

This step is complete only when a suspected root cause is tied to source evidence or labeled unproven.

### 4. Compare and bound

```bash
scip-query similar <suspect-symbol> --json --full
scip-query similar <suspect-symbol> <comparison-symbol> --plan
scip-query similar-files <suspect-file> --json --full
scip-query co-change <suspect-file> --json --full
scip-query change-surface <suspect-file> --json --full
scip-query affected <suspect-symbol> --json
```

This step is complete only when the packet has a narrow test shape and an impact bound.

## Packet

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
- blast radius

## Fix Plan

1. Add or update failing test/smoke check.
2. Make the smallest code change.
3. Run targeted test.
4. Invoke `scip-verify`.

## Open Questions

- <product intent or external state only>
```

If no root cause is proven, label the issue `needs reproduction` or `needs product decision` rather than asserting one.
