# Twin drift

Use when the same concept exists in more than one place under the same or a near-name and the bodies have silently diverged — same-name or near-name functions across files with diverged bodies, drifted policy thresholds, one-sided fixes, or consolidating a duplicated concept into one canonical helper.

A twin drift group is a same-leaf-name family of callables spanning at least two files whose normalized-token bodies are neither identical (that's `duplicate-bodies`' job) nor unrelated (a homonym like `render` or `parse`), but partially overlapping — a concept copied once and edited independently in only some copies. "Near-name" means case-insensitive match, or edit-distance ≤ 2 for names of 8+ characters.

## Detect

Run `scip-query twin-drift --full` to surface every DIVERGENT and near-name group in scope; scope it with `-s/--scope <path>` when the review should be bounded. Cross-check against `scip-query duplicate-bodies --full` — IDENTICAL groups belong there, not here; don't re-report them. Homonyms (similarity below `--min-similarity`, default 0.3) are noise — skip them unless `--include-homonyms` was explicitly requested. Record group count, member count, and `maxDivergence` per group. Done only when every group in scope is enumerated with its relationship (divergent vs. suppressed homonym).

## Classify

For every DIVERGENT group, read each member's body with `scip-query code <symbol>`, starting from the group's `firstDivergentTokens` field to locate where the bodies diverge. Assign exactly one label with a one-line reason:

- **Intentional variation** — the domains genuinely differ (e.g., a React-specific vs. Vue-specific structural comparator branching on framework-specific checks). Essential variation stays; record the reason.
- **Drifted policy** — one policy (a threshold, a normalization rule, an edge-case guard) only some copies received when it last changed. This is a bug: pick the correct value and propagate it, or extract the policy into one named function/constant.
- **One-sided fix** — one copy was bugfixed or hardened and its twin(s) weren't. This is a bug: apply the same fix to every member, or consolidate.

Done only when every DIVERGENT group has one of the three labels with its reason.

## Consolidate

Pick the canonical member by comparing consumer counts via `scip-query refs <symbol-in-file-A>` and `scip-query refs <symbol-in-file-B>` — prefer the member with more consumers, or the one in the more general/shared location on a tie. Extract or move the canonical body to one exported helper and update the other members to call it, or delete them outright if they were pure duplication under a different name for caller convenience. Preserve classified-essential variation as a parameter or a thin caller-side branch, not a second copy of the whole body. For intentional-variation groups, don't force consolidation — record the reason in a comment near one of the members so the next `twin-drift` run and the next reader both see it was considered.

Done only when every DIVERGENT group is either consolidated (old copies gone or forwarding) or has a recorded reason it stays separate.

## Verify

Rerun `scip-query twin-drift --full` to confirm consolidated groups no longer appear as DIVERGENT, then run the routed postchecks from `scip-verify`. The twin-partner check inside `diff-gate` is advisory and never blocks the gate by itself — but a finding there on your own diff means you've reproduced the exact defect class this skill exists to catch; treat it as a signal to run this workflow, not just to suppress the finding. Fix it or explicitly accept it before finishing.

Done only when `twin-drift` shows no unclassified DIVERGENT groups in scope and any `diff-gate` findings are resolved or explained.

## Report

Scope, groups found (total / divergent / suppressed homonyms), each divergent group with its classification and action taken, and the verification results of `twin-drift --full` and `diff-gate`.
