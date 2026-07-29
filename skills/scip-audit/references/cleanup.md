# Cleanup: raw signal to confirmed queue

Turn raw scip-query cleanup signals into a confirmed cleanup queue. Use for
health reports, de-bloat reports, recent AI-residue audits, score-framed
cleanup queues, confirming raw findings, or preparing a cleanup plan.

This audit never edits application code — it only audits and classifies
signals; applying fixes is `scip-improve`'s job.

Three common modes, same underlying workflow:

- **Whole-repo audit** — rank all cleanup signals across the codebase.
- **Recent-AI-residue** — focus specifically on echoes, twins, incomplete
  migrations, speculative params, stale agent-facing docs, and hidden
  couplings.
- **Score-framed** — explain the health score's deductions and identify the
  safest first cleanup batch.

## Step 1 — Establish evidence

Before any sweeping begins, run `scip-query doctor`, `scip-query status
--capabilities`, `scip-query health`, `scip-query capabilities`, and
`scip-query config-validate`.

**Complete when:** unavailable capabilities are explicitly recorded as
unavailable, not silently skipped.

## Step 2 — Sweep signals

Run every relevant detector class or explicitly record why it is
unavailable — never silently omit a class.

Core sweep set:

```
scip-query cleanup-plan --verify                 # compiler-verified batched deletion plan
scip-query duplicate-bodies --full               # exact duplicate small-body candidates
scip-query recent-duplicates --full              # recent code re-implementing established code
scip-query incomplete-migration --full           # partially-completed extractions
scip-query unused-params --full
scip-query passthrough-candidates --full
scip-query dead --full
scip-query isolated --full
scip-query cycles
scip-query co-change --full                      # hidden file-level coupling from git history
scip-query doc-drift --full                      # docs whose referenced/co-changed code kept moving
```

`scip-query health` establishes the composite score and prioritized
action list; `scip-query cleanup-plan --verify` combines graph-fact
dead code with the cascade candidates it unlocks. `scip-query doc-drift
--full` finds stale-doc candidates: code a doc references, or
co-changed with, that kept changing after the doc stopped — run it whenever
the audit is about living-doc drift, not just code cleanup.

For frontend repos, add the React/Vue duplicate, hook/composable, and
large-component/view detector commands (see `references/frontend.md`) to the
sweep.

**Optional deep dives**, run only after the main sweep is exhausted:
`scip-query stale-abstractions --full` and `scip-query
wrapper-candidates --full` have near-zero precision on codebases with
intentional layering or ambient types — treat every hit as a lead to
confirm, never a finding on its own.

## Step 3 — Confirm each candidate

Classify every cleanup candidate as exactly one of: **confirmed fix
target**, **intentional design**, **false positive**, or **blocked**.

To confirm a high-priority candidate, inspect source and graph evidence with
`scip-query code`, `scip-query refs`, `scip-query fan-in`, `scip-query
fan-out`, `scip-query affected`, `scip-query change-surface --full`,
`scip-query similar --plan`, and `scip-query co-change --full`.

Because a deletion is this audit's scrutiny-ending verdict, a candidate
classified "confirmed fix target" that deletes code must survive refutation
checks before being finalized:

1. Run `rg` for the symbol name as a plain string to catch dynamic dispatch,
   config keys, serialized references, and CLI/doc text that graph-based
   detectors cannot see.
2. Check for the cross-package barrel re-export gap — the one blind spot
   `dead` self-labels as "unconfirmed."

Record `refutation: survived — <checks run>` on a confirmed-deletion entry
once the blind-spot checks pass, or reclassify the entry if they don't;
either way the note must be recorded.

## Report

Final report must include: health score, classification counts
(confirmed/intentional/false positive/blocked — must cover every collected
signal, none left uncounted), confirmed items with evidence and first safe
action, unconfirmed signals with evidence still needed, unavailable/blocked
checks with reasons, and a recommended first cleanup batch with why it's
safe now.

A run is complete only when each collected signal is classified and the
next action is visible.
