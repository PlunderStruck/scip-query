---
name: scip-ai-cleanup
description: Clean up AI-generated code rot using scip-query's change-graph and verification tooling. Finds recent re-implementations of established code, drifting standards docs, speculative parameters, hidden coupling, and produces compiler-verified deletion plans. Sets up the CI ratchet so findings never regress.
allowed-tools: [Bash, Write, Edit, Glob, Agent, TaskCreate, TaskUpdate, TaskGet, TaskList]
keywords: [ai-slop, ai-generated, cleanup, duplicates, echo, doc-drift, standards, stale-docs, cleanup-plan, verify, co-change, ratchet, baseline, unused-params]
---

# AI-Generated Code Cleanup with scip-query

AI-assisted development rots a codebase in specific, detectable ways: agents
re-implement helpers they didn't know existed, leave half-wired parallel
implementations behind, add parameters "for later" that never come, and the
standards docs written FOR agents drift away from the code — so the next agent
implements against a dead spec. None of this is visible in a single file;
all of it is visible in the reference graph + the git change graph.

This skill runs the full sweep and ends with a compiler-verified deletion
plan and a CI ratchet.

## When to Use This Skill

- "Clean up the AI slop in this repo"
- "Did the agents duplicate code?"
- "Are our standards docs stale?"
- "What can we safely delete?"
- "Set up a quality gate for agent-written code"

## Hard Rules

1. **Evidence first.** Run `scip-query status` and `scip-query reindex` before
   trusting graph facts. All detectors print whether they're heuristic.
2. **Verify before deleting.** Findings are candidates; only
   `cleanup-plan --verify` output stamped COMPILER-VERIFIED is proof.
   A FAILED verification is signal too — its errors name the references the
   static evidence missed. Never delete on a failed batch.
3. **Echoes consolidate INTO the established side.** When recent code
   duplicates older code, extend the original and delete the echo — not the
   reverse. The established side has the consumers and the bug-fix history.
4. **Fix the doc or delete the doc — never leave it lying.** A stale standards
   doc actively misleads every agent that reads it.

## The Sweep

### Step 1: Recent re-implementations (echoes)

```bash
scip-query recent-duplicates --window 100
```

- `ECHO` — recent code duplicating established code. Read both sides, then
  migrate the echo's callers to the established symbol and delete the echo.
- `TWIN` — both sides landed recently (often one agent session duplicating
  itself). Pick the better-placed one, consolidate before they diverge.
- Widen `--window` on slow-moving repos; narrow it right after a big agent
  session.

### Step 2: Drifting and lying docs

```bash
scip-query doc-drift
scip-query doc-drift AGENTS.md     # detail mode for one doc
```

- `BROKEN REFERENCE` lines are the worst class: the doc cites files that no
  longer exist. Fix those citations first.
- `referenced by doc` subjects changed after the doc's last update — re-read
  the subject files and update the doc's claims (or delete the doc).
- Re-run after updating: staleness should drop to 0 for the docs you touched.

### Step 3: Speculative generality

```bash
scip-query unused-params
```

Trailing parameters no body uses — already scoped to removals that are
type-safe by construction (TS/JS, trailing-only, no parameter properties).
Drop the parameters and any arguments at call sites.

### Step 4: Hidden coupling

```bash
scip-query co-change
```

File pairs that repeatedly change in the same commits with NO dependency
edge: hand-synchronized artifacts (schema ↔ inventory doc ↔ generator
script, backend schema ↔ frontend store, .env.example ↔ env parser).
For each pair, either name the shared concept in code (one source of truth)
or add a contract test that fails when one side changes without the other.

### Step 5: Compiler-verified deletion

```bash
scip-query cleanup-plan --verify
```

- Batches are ordered: batch 0 is graph-fact dead now; batch n is dead once
  batch n-1 lands (the cascade). Apply ONE batch at a time.
- `COMPILER-VERIFIED` means the deletion was applied in a throwaway worktree
  and your own checker (tsc / cargo check / go build / ruff) passed differentially.
- `FAILED` errors name real references — usually barrel export lines or
  imports that must be removed together with the symbol, occasionally a
  detector false positive. Investigate before deleting anything.
- The `blocked` list explains why candidates can't cascade (e.g. a spec file
  still references them).

### Step 6: Ratchet it

```bash
scip-query health --write-baseline   # commit .scipquery-baseline.json
scip-query health --baseline         # exit 1 on any NEW finding — wire into CI
scip-query diff-gate                 # per-diff gate: echoes, missing partners, uncited docs
```

`diff-gate` is the leading indicator: run it on every agent commit / PR
(`--base origin/main` in CI). Each finding carries a remediation the agent
can apply directly.

After each cleanup round, re-run `--write-baseline` to ratchet the count
down. The gate is "don't get worse" — objective and ungameable.

## Before Writing New Code (prevention)

Tell implementing agents to run these BEFORE writing a helper or reading a
standard:

```bash
scip-query plan-context <symbol-or-file>   # structure + HISTORY (churn, co-change partners)
scip-query similar <new-function-name>     # does this already exist?
scip-query doc-drift <standard.md>         # is the standard I'm about to follow stale?
```

The HISTORY section of plan-context lists the files that usually change with
the target — the edit checklist that prevents the drift this skill cleans up.

## Reporting

End with a prioritized summary:

1. Echoes/twins consolidated (LOC removed, callers migrated)
2. Docs fixed vs deleted (staleness before → after)
3. Compiler-verified deletions applied (LOC, batches)
4. Hidden couplings resolved (named mechanism or contract test added)
5. Baseline ratcheted: N findings → M
