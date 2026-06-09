# Design: `diff-gate` — slop prevention at the moment of creation

Status: BUILT (same day). Live notes: first self-run caught a real co-change advisory
(command-descriptors without command-handlers) and three honest baseline regressions from
the day's own additions; doc-reference noise led to the archival-doc filter (docs/plans,
ADRs, reports, changelogs) which also de-noised doc-drift itself.

## The idea

Everything built today is either *context before editing* (plan-context) or *cleanup after
the fact* (detectors, cleanup-plan, ratchet). The missing piece is the moment in between:
**the diff**. Every detector we have can be scoped to "what did this change just
introduce?" — turning lagging indicators into a leading gate that runs on every agent
commit / PR in seconds, with zero LLM calls.

```bash
scip-query diff-gate [--base <ref>]    # exit 1 with named findings, or pass
```

## The checks (all reuse existing machinery)

1. **Echo check** — does any function ADDED in this diff have high similarity to an
   established function? (similar fingerprints × file ages; the diff's new symbols only.)
   "You just re-implemented `loadAccessibleMedicalRecord` — extend it instead."
2. **Co-change partner check** — the diff touches file A; A's strong co-change partners
   (≥N together, ≥M confidence) are NOT in the diff. "schema.prisma changed but
   scripts/stable-scope-inventory.mjs didn't — these change together 12/14 times."
   This is auto-generated contract enforcement: the test we hand-wrote for scip-query's
   own manifest, derived from history for free, for every repo.
3. **Doc-reference check** — the diff changes files that drifting docs cite; those docs
   aren't updated in the diff. "agent-os/standards/api/families/horses.md cites
   workflows/horses.ts which you just changed."
4. **Speculative-generality check** — new/changed functions with trailing unused params.
5. **New-dead check** — symbols added by the diff that nothing references (agent wired
   half a feature). Distinct from the ratchet: scoped to the diff, instant.
6. **Baseline ratchet** — fold in `health --baseline` semantics so one command gates CI.

Output: one report, each finding tagged with evidence tier and the exact remediation,
exit code for CI. An agent can self-correct from the output without human triage.

## Why this is the right next thing

- It completes the arc: detect → verify → prevent. Cleanup is O(repo); the gate is
  O(diff) — fast enough for every commit.
- It is the productized version of today's best findings: the co-change partner check
  alone would have prevented the standards drift, the inventory-doc drift, and the
  locale-file desync we found across three repos.
- Nothing here needs new evidence — only diff-scoping the three sources we have.

## Implementation sketch

- `diffChangedFiles(base)` exists in diff-impact's plan machinery; new symbols = diff
  ranges ∩ definitions (reuse diff-impact's changed-symbol extraction).
- Each check is a thin scoped wrapper over an existing query; the command aggregates.
- Config block in `.scipquery.json` (`diffGate: { checks, thresholds }`) so teams can
  tune confidence floors per check.
- Skill: add a "gate" step to scip-ai-cleanup prevention section + CI snippet in README.
