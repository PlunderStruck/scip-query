# Debug: one failure → minimal verified fix

Use this mode to move from a reported failure to a minimal verified fix. A **bug** is a mismatch between expected behavior and observed behavior in a concrete execution path. A **root cause** is the earliest code fact in that path that explains the mismatch.

Load shared mechanics from [`../../_shared/SKILL.md`](../../_shared/SKILL.md) only when this shortlist is insufficient.

## Commands used in this mode

| Command | When |
| --- | --- |
| `scip-query files <feature-or-error-term>` | Find the entry point from a feature name or error term (complete coverage: matching file paths). |
| `scip-query outline <candidate-file>` | Enumerate symbols in a candidate file while narrowing the entry point. |
| `scip-query trace <candidate-symbol>` | Find the entry point: definition plus every reference (bounded coverage: definition sites with source/signature, referencing files with line numbers). |
| `scip-query code <candidate-symbol>` | Read the exact source at the candidate entry point or callee. |
| `scip-query kind-counts` / `scip-query by-kind` | Orient in an unfamiliar codebase during entry-point discovery. |
| `scip-query call-graph <entry-symbol>` | Follow execution: callers and callees along the failing path (bounded coverage). |
| `scip-query refs <state-or-api-symbol>` | Follow execution: every referencing site of shared state or an API symbol. |
| `scip-query fan-in <suspect-symbol>` / `scip-query fan-out <suspect-file>` | Follow execution: who depends on the suspect symbol/file, and what it depends on. |
| `scip-query dataflow <symbol-or-variable>` | Follow data: producers, consumers, and usage sites (bounded coverage). |
| `scip-query slice <symbol-or-variable>` / `--forward` | Follow data: backward and forward slices from the suspect value. |
| `scip-query similar <suspect-symbol> --full` | Compare nearby implementations for missing guards or handling (bounded coverage: symbol pairs, similarity scores, shared evidence). |
| `scip-query similar <suspect-symbol> <similar-symbol> --plan` | Compare two specific implementations directly. |
| `scip-query similar-files <suspect-file> --full` | Compare nearby files for missing handling. |
| `scip-query change-surface <suspect-file> --full` | Bound the fix: exports, consumers, and blast-radius risk (bounded coverage). |
| `scip-query affected <suspect-symbol>` | Bound the fix: transitive closure of symbols that could break. |

## Rules

1. Reproduce or restate the failure before editing.
2. Use scip-query to find entry points, call paths, data flow, and blast radius.
3. Prefer one narrow fix over broad cleanup.
4. Verify with the narrowest repo test or smoke command, then invoke `scip-verify`.
5. A root-cause claim whose fix crosses a file boundary requires a rival: state the next-most-plausible explanation for the same symptom and run the observation that separates them. A root cause with no rival considered is a guess presented with unearned confidence.

## Workflow

### 1. Pin the failure

Record observed behavior, expected behavior, the reproducing command/route/UI action/test/job/file, error text or wrong output, and the regression window if known.

If no reproduction is provided, build the smallest runnable reproduction from existing tests, scripts, CLI, or app entry points.

This step is complete only when the mismatch is concrete enough to test, or the missing external fact is named.

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

Stop expanding the trace when the first code fact that can cause the symptom is found.

When a candidate cause emerges, state it as a hypothesis alongside one rival — the next-most-plausible explanation for the same symptom. Name the observation that distinguishes them (a log line, a probe, a narrower test) and execute it. Choose the discriminator that is cheapest to run, not the one most likely to confirm the preferred hypothesis.

This step is complete only when the path explains the symptom or the missing evidence is made explicit.

### 4. Compare nearby implementations

```bash
scip-query similar <suspect-symbol> --full
scip-query similar <suspect-symbol> <similar-symbol> --plan
scip-query similar-files <suspect-file> --full
```

Use implementation comparisons to find missing guards, conversions, lifecycle steps, or error handling, while preserving essential differences.

This step is complete only when comparisons either support the fix or are rejected with a stated reason.

### 5. Bound and fix

```bash
scip-query change-surface <suspect-file> --full
scip-query affected <suspect-symbol>
```

Make the smallest code change that fixes the root cause.

This step is complete only when the changed symbol/file is justified by blast-radius evidence.

### 6. Verify

Run the reproduction, a narrow test or smoke command, and invoke `scip-verify`.

## Report

```markdown
Bug:
Entry point:
Root cause:
Rival considered:
Discriminator: <the executed observation that separated them>
Fix:
Verification:
Remaining risk:
```

Do not present a guess as a root cause. A root cause with no rival considered and no executed discriminator is a guess. If no root cause is proven, state the missing evidence instead of asserting a cause.
