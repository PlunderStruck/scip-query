# Doc reconciliation (absorbs scip-doc-reconcile)

Use for stale standards, broken file references, docs that cite moved code, agent guidance, or normative contradictions between documentation and implementation. Only reconcile living docs — documentation agents or maintainers use to make present-day changes: AGENTS.md, CLAUDE.md, standards, command docs, workflow docs. Do not reconcile archival records (dated plans, ADRs, reports); list them in `.scipquery.json` under `docs.snapshotPaths` so `doc-drift` excludes them with a labeled exclusion instead of resurfacing them every sweep.

The core distinction driving every edit:

- **Descriptive claims** say what the code currently does or where it lives. Update them when code moves.
- **Normative claims** say what code must or should do. If code violates one, fix the code or escalate the contradiction — never weaken the standard silently to match drifted code.

## Step 1 — Build the worklist

Run `scip-query doc-drift --json --full` for the ranked worklist (document paths, coupled code subjects, history evidence), plus `scip-query doc-drift <doc-or-tree>` for anything scoped. Prioritize broken references first, then highest staleness, then the docs agents read most. Done only when each target doc is selected for a current-use reason.

## Step 2 — Reconcile one doc

For each doc: `scip-query doc-drift <doc>`, `scip-query outline <subject-file>` for its current shape, `scip-query system <module>` for the surrounding module, `scip-query trace <symbol>` for every symbol the doc mentions, `scip-query code <symbol>` to re-derive any snippet from current source (never from memory or the stale text). Use git history only to understand why a subject changed, never as a substitute for current code evidence.

- Fix broken references by finding the current code or deleting the obsolete claim.
- Rewrite stale descriptive claims from the evidence just gathered.
- Record normative contradictions instead of changing standards to bless drifted code.

Done only when every edited claim is supported by evidence gathered in this session.

## Step 3 — Verify

Rerun `scip-query doc-drift <doc>`. If the documentation change is part of a codebase diff, invoke `scip-verify`. Don't claim reconciliation is done until `doc-drift` has been rerun. Done only when staleness drops to zero or the remaining contradiction is explicitly reported.

## Step 4 — Report

Staleness before and after, broken references fixed, claims updated, normative contradictions surfaced, and docs recommended for deletion.
