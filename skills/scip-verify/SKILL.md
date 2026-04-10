---
name: scip-verify
description: Post-implementation verification using scip-query. Confirms changes are wired correctly — no broken references, no new cycles, no orphaned code, no test gaps, no health regressions. Run after making changes and before committing.
allowed-tools: [Bash, Write, Edit, Glob, Agent, TaskCreate, TaskUpdate, TaskGet, TaskList]
keywords: [verify, check, validate, wire, confirm, post-implementation, review, regression, health, test]
---

# Post-Implementation Verification with scip-query

You are verifying that a code change was implemented correctly. Every check must use `scip-query` to confirm the change didn't break references, introduce cycles, orphan code, or miss test coverage. This is the "measure twice" step — run it after making changes, before committing.

---

## When to Use This Skill

- "Verify my changes"
- "Check if everything is wired correctly"
- "Did I break anything?"
- "Is it safe to commit?"
- "Run a post-implementation check"
- After completing a `/concrete-plan` implementation
- Before any commit of non-trivial changes

---

## Hard Rules

1. **Reindex first.** Always run `scip-query reindex` before verification. You're checking the current code, not the old index.

2. **Every check must produce evidence.** Don't say "looks good." Say "scip-query cycles returned 0 cycles, scip-query diff-impact shows 3 changed symbols affecting 12 files, all 3 have test coverage."

3. **Fail loudly.** If any check fails, stop and report the exact failure with the scip-query command output. Do not proceed to "looks mostly fine."

4. **Compare against baseline.** If a health score or finding count was recorded before the change, compare against it. A regression is a finding.

---

## The 8 Verification Checks

Run every one of these. Each catches a different class of implementation error.

### Check 1: Diff Impact Assessment

```bash
scip-query reindex
scip-query diff-impact
```

**What you're checking:** Which symbols changed, how many consumer files are affected, and whether test coverage exists for changed symbols.

**Pass criteria:**
- Every changed symbol is intentional (no accidental modifications)
- The number of affected consumer files matches expectations
- Changed symbols have test references (or test gaps are acknowledged)

**Fail if:** Unexpected symbols appear in the diff, or the affected file count is much larger than expected (blast radius exceeded plan).

### Check 2: No New Cycles

```bash
scip-query cycles
```

**What you're checking:** The change didn't introduce a circular dependency.

**Pass criteria:** Zero cycles, OR the same cycles that existed before the change.

**Fail if:** New cycle(s) appear. Report the full cycle path.

### Check 3: No New Dead Code

```bash
scip-query dead --min-loc 5
```

**What you're checking:** The change didn't orphan existing code. If you renamed a function, did you update all callers? If you moved a module, did you update all imports?

**Pass criteria:** No new dead symbols compared to before the change. Existing dead code doesn't count.

**Fail if:** A symbol that was alive before the change is now dead. This means something was disconnected.

### Check 4: No New Isolated Symbols

```bash
scip-query isolated --min-loc 3
```

**What you're checking:** The change didn't completely disconnect a symbol from the graph.

**Pass criteria:** No new isolated symbols.

**Fail if:** New isolated symbol(s) appear — something got orphaned.

### Check 5: References Intact

For each symbol that was modified (from diff-impact), verify it's still referenced by the expected consumers:

```bash
scip-query refs <changed-symbol>
scip-query fan-in <changed-symbol>
```

**What you're checking:** Consumers of modified symbols still reference them. If you changed a function signature, callers should still compile and reference it.

**Pass criteria:** Fan-in count for each changed symbol is the same or higher than before.

**Fail if:** A changed symbol's fan-in dropped — a consumer was disconnected.

### Check 6: Test Coverage for Changes

```bash
scip-query test-coverage <changed-symbol>
```

For each changed symbol, verify test files reference it.

**Pass criteria:** Every changed symbol is referenced by at least one test file.

**Fail if:** Changed symbols with zero test references. Report which ones need tests.

### Check 7: Change Surface Risk Check

For each modified file:

```bash
scip-query change-surface <modified-file>
```

**What you're checking:** High-risk symbols in modified files (high consumer count + no tests).

**Pass criteria:** No HIGH RISK symbols, or all high-risk symbols were intentionally modified.

**Fail if:** A HIGH RISK symbol was modified without test coverage.

### Check 8: Health Score

```bash
scip-query health
```

**What you're checking:** The overall codebase health didn't regress.

**Pass criteria:** Health score is the same or higher than before the change. If it dropped, every finding that increased must be explained.

**Fail if:** Health score dropped by more than 5 points without explanation.

---

## Verification Workflow

### Phase 1: Reindex and Assess Impact

```bash
scip-query reindex
scip-query diff-impact
```

Record: changed files, changed symbols, affected consumers, test coverage %.

### Phase 2: Structural Checks (parallel)

Run checks 2-4 simultaneously — they're independent:

```bash
scip-query cycles
scip-query dead --min-loc 5
scip-query isolated --min-loc 3
```

### Phase 3: Per-Symbol Checks

For each changed symbol from diff-impact:

```bash
scip-query refs <symbol>
scip-query fan-in <symbol>
scip-query test-coverage <symbol>
```

### Phase 4: Per-File Checks

For each modified file:

```bash
scip-query change-surface <file>
```

### Phase 5: Health Comparison

```bash
scip-query health
```

Compare against the pre-change score.

---

## Output Format

The verification report is structured as:

```markdown
# Verification Report

**Date:** YYYY-MM-DD
**Change:** [description]
**Pre-change health:** N/100
**Post-change health:** N/100

## Diff Impact
- Changed files: N
- Changed symbols: N
- Affected consumer files: N
- Test coverage: N%

## Check Results

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Diff impact | PASS/FAIL | [summary] |
| 2 | No new cycles | PASS/FAIL | [count] |
| 3 | No new dead code | PASS/FAIL | [count] |
| 4 | No new isolated | PASS/FAIL | [count] |
| 5 | References intact | PASS/FAIL | [fan-in changes] |
| 6 | Test coverage | PASS/FAIL | [uncovered symbols] |
| 7 | Risk assessment | PASS/FAIL | [high-risk symbols] |
| 8 | Health score | PASS/FAIL | [score delta] |

## Failures
[Detailed explanation of any failures with scip-query output]

## Verdict
PASS — safe to commit
FAIL — [list what needs fixing before commit]
```

---

## Using with /concrete-plan

The ideal workflow:

1. **Before:** Run `/concrete-plan` to design the change with full scip-query evidence
2. **During:** Implement the plan
3. **After:** Run `/scip-verify` to confirm the implementation matches the plan

The verification report should reference the original plan's blast radius predictions and confirm they were accurate.

---

## Subagent Briefing Template

When parallelizing verification checks:

```
## Task: Run verification check [N]

You are verifying a code change using scip-query. First run `scip-query reindex`.

Run the following command:
[specific scip-query command]

Report:
1. The exact command output
2. Whether it PASSES or FAILS the criteria: [specific criteria]
3. If FAIL: exactly what went wrong and which symbols/files are affected

Do NOT use grep, rg, or Read. Use only scip-query commands.
```

---

## scip-query Quick Reference

| Check | Command |
|---|---|
| Reindex | `scip-query reindex` |
| Diff impact | `scip-query diff-impact` |
| Cycles | `scip-query cycles` |
| Dead code | `scip-query dead --min-loc 5` |
| Isolated | `scip-query isolated --min-loc 3` |
| References | `scip-query refs <symbol>` |
| Fan-in | `scip-query fan-in <symbol>` |
| Test coverage | `scip-query test-coverage <symbol>` |
| Change surface | `scip-query change-surface <file>` |
| Health | `scip-query health` |
| Full blast radius | `scip-query affected <symbol>` |
| Read source | `scip-query code <symbol>` |
