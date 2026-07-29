# Twin drift: same concept, silently diverged copies

Use when the same concept exists in more than one place under the same or a
near name and the bodies have silently diverged — same-name or near-name
functions across files with diverged bodies, drifted policy thresholds,
one-sided fixes, or consolidating a duplicated concept into one canonical
helper.

Command shortlist: `twin-drift --json --full` (detector), `duplicate-bodies
--json --full` (cross-check), `code <symbol>`, `refs <symbol>`, `diff-gate
--json`.

## Definitions

A **twin drift group** is a same-leaf-name family of callables spanning at
least two files whose normalized-token bodies are neither identical (that's
`duplicate-bodies`' job) nor unrelated (a homonym like `render` or `parse`)
but partially overlapping — signaling a concept copied once and then edited
independently in only some of its copies.

**Near-name** means case-insensitive match, or edit-distance ≤ 2 for names of
8 or more characters.

## Detect

Run `scip-query twin-drift --full` to surface every DIVERGENT and
near-name group in scope; scope it to a module with `-s/--scope <path>` when
the review should be bounded. Record group count, member count, and
`maxDivergence` per group.

Cross-check results against `scip-query duplicate-bodies --full` —
IDENTICAL groups belong to `duplicate-bodies`, not here; do not re-report
them. Homonyms — groups with similarity below `--min-similarity` (default
0.3) — are noise and should not be chased unless `--include-homonyms` was
explicitly requested.

**Complete when:** every group in scope is enumerated with its relationship
(divergent vs. suppressed homonym).

## Classify each DIVERGENT group

Use `scip-query code <symbol>` to read every member's body; use the group's
`firstDivergentTokens` field as a starting point for locating where the
bodies diverge. Assign exactly one label:

- **Intentional variation** — the copies differ because the domains
  genuinely differ (example: a React-specific vs. Vue-specific structural
  comparator branching on framework-specific overlap checks). Essential
  variation stays, and the reason must be recorded.
- **Drifted policy** — the copies encode what should be one policy (a
  threshold, a normalization rule, an edge-case guard) that only some copies
  received when it last changed. This is a bug: pick the correct value and
  propagate it, or extract the policy into one named function/constant.
- **One-sided fix** — one copy was bugfixed or hardened and its twin(s)
  were not. This is a bug: apply the same fix to every member, or
  consolidate them.

**Complete when:** every DIVERGENT group in scope has one of the three
labels with a one-line reason.

## Act

Prefer consolidating a twin-drift group into one exported helper over
leaving parallel copies; when consolidation is unsafe or premature, record
the intent gap explicitly (comment or waiver) rather than silently accepting
the drift.

For groups being consolidated, pick the canonical member by comparing
consumer counts via `scip-query refs <symbol-in-file-A>` and `scip-query
refs <symbol-in-file-B>` — prefer the member with the most consumers, or the
one in the more general/shared location when consumer counts tie.

To consolidate: extract or move the canonical body to one exported helper
and update the other members to call it, or delete them outright if they
were pure duplication with different names for caller convenience. Preserve
any classified-essential variation as a parameter or a thin caller-side
branch, not as a second copy of the whole body.

For groups marked intentional variation, do not force consolidation —
instead record the reason in a comment near one of the members so the next
`twin-drift` run and the next reader both see it was considered.

**Complete when:** every DIVERGENT group is either consolidated (old copies
gone or forwarding) or has a recorded reason it stays separate.

## Verify

After acting, rerun `scip-query twin-drift` to confirm consolidated groups
no longer appear as DIVERGENT, and run the routed postchecks from
`scip-verify`.

The twin-partner check inside `scip-query diff-gate` is advisory and never
blocks the gate by itself, but a finding there on your own diff means you've
reproduced the exact defect class this workflow exists to catch — fix it or
explicitly accept it before finishing.

**Complete when:** `twin-drift` shows no unclassified DIVERGENT groups in
scope and any `diff-gate` findings are resolved or explained.

## Report

List: scope; groups found (total/divergent/suppressed homonyms); each
divergent group with classification and action taken; and the verification
results of `twin-drift --json --full` and `diff-gate --json`.
