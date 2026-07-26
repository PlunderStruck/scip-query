---
name: scip-audit
description: Use to find and confirm problems WITHOUT editing: is this implementation real (decorative checkers, not-implemented, lying metrics), is a status word derived or merely asserted, are cleanup findings worth acting on, has a same-name twin silently drifted, have the living docs (AGENTS.md, standards, command docs) drifted from the code, and are there hidden policies, scattered concepts, accidental variation or weak boundaries — including React/Vue component and directory-locality pressure. Proactive: needs no reported symptom. Hand confirmed findings to scip-improve. Distinct from `complexity-cleanup` and `principal-maintainability-review`: those reason about a specific symbol's complexity or a reviewer's judgement; this one runs detectors across the repo and ranks confirmed findings by evidence.
---

# scip-audit

Read-only evidence audits. Every audit here classifies something —
real-vs-decorative, derived-vs-asserted, confirmed-vs-noise, drifted-vs-stable
— and ends in a ranked, evidenced verdict. None of them edit code or docs.
When a finding needs a fix, hand it to `scip-improve`; do not apply it here.

Load shared mechanics (evidence freshness, lookup, the full command
catalogue) from `../_shared/SKILL.md` — each reference file below carries its
own shortlist first and only defers to `_shared` when that shortlist runs
out. Before trusting any graph fact, confirm the index is fresh with
`scip-query status --capabilities` (reindex if `stale`/`missing`/`unknown`).

## Triage

| Situation | Open | Core commands |
|---|---|---|
| A checker/verifier/metric/feature might be decorative, half-built, or a fallback might be masking a dead primary path | [`references/integrity.md`](references/integrity.md) | `decorative-checkers`, `not-implemented`, `twin-ab`, `test-quality`, `refs`, `code`, `call-graph` |
| A status word ("available", "verified", "safe", "PASS", "complete") needs classifying as derived, hedged, or asserted | [`references/claims.md`](references/claims.md) | `files`, `refs`, `code`, `trace`, `capabilities` |
| Turning a health report, de-bloat report, AI-residue sweep, or raw detector output into a confirmed cleanup queue | [`references/cleanup.md`](references/cleanup.md) | `health`, `cleanup-plan`, `duplicate-bodies`, `recent-duplicates`, `incomplete-migration`, `doc-drift`, `unused-params`, `passthrough-candidates`, `dead`, `isolated`, `cycles`, `co-change` |
| Same-name or near-name functions across files whose bodies have silently diverged | [`references/twin-drift.md`](references/twin-drift.md) | `twin-drift`, `duplicate-bodies`, `code`, `refs`, `diff-gate` |
| Hidden policy, scattered concepts, accidental variation, weak boundaries — general structural/maintainability pressure | [`references/maintainability.md`](references/maintainability.md) | `stats`, `system`, `surface`, `change-surface`, `affected`, `drift`, `health`, `similar*`, `extract-candidates`, `wrapper-candidates`, `stale-abstractions`, `cycles` |
| React or Vue component/hook/composable duplication, or large-component/view pressure | [`references/frontend.md`](references/frontend.md) | `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `vue-component-duplicates`, `vue-composable-candidates`, `vue-large-view-pressure`, `augment-vue`, `recent-duplicates`, `similar`, `health` |
| Folder structure, ownership boundaries, locality config, a messy or AI-generated layout, safe move slices | [`references/directory.md`](references/directory.md) | `system`, `locality-candidates`, `similar-files`, `cycles`, `architecture`, `drift`, `co-change`, `config-validate`, `diff-gate`, `health` |

Rows are not exclusive. A "does this actually work" investigation that turns
up structural mess routes that mess to `references/maintainability.md`
instead of forcing it into the integrity verdict — real-but-messy is a
different failure mode than fake-but-green. A twin-drift finding that
surfaces on your own diff (via `diff-gate`) is a live instance of that defect
class, not just a gate finding — open `references/twin-drift.md`.

## Cross-cutting rules

- **Classify, don't just list.** Every audit in this skill assigns each item
  in scope to exactly one label from its taxonomy (real/decorative,
  derived/hedged/asserted, confirmed/intentional/false-positive/blocked,
  intentional-variation/drifted-policy/one-sided-fix, mature/emerging/
  accidental). A count that doesn't sum to the scope size is an unfinished
  audit.
- **Ground every claim in evidence**, not opinion or a variable's name — a
  variable called `verified` that nothing ever checked is still asserted.
  Name concrete files/symbols before naming a smell.
- **Preserve essential variation.** Difference that reflects real behavior,
  domain facts, runtime constraints, or external contracts is not a defect;
  consolidating it away is a false abstraction. Any merge/consolidate
  recommendation must carry the single trait that makes the cited sites one
  concept — if that trait can't be stated, they aren't one concept.
- **A clean run is itself a claim.** A suspect scope that produces zero
  findings needs a stated reason the suspicion was wrong, not silence.
- **This skill never edits.** Findings, evidence, and a fix direction are the
  deliverable; route action to `scip-improve`.
