# Calibrate detectors

Use this when adopting scip-query in a new or foreign codebase, after major
detector changes, when a health score or gate output seems too noisy or too
clean, or before letting `diff-gate` block anyone's work.

## The stance

A detector tuned on one codebase's conventions can be precise there and
noisy elsewhere. Calibration finds out which, on this repo, and converts
every noise archetype into either a repo-side knob or an upstream detector
bug. A health score that hasn't been calibrated is a number, not a fact:
never present detector output from an uncalibrated repo as findings —
present it as candidate findings pending classification. A calibrated score
has to earn trust the same way a checker earns it in `scip-integrity-audit`:
by being witnessed telling the truth on samples verified by hand.

Run all five stages below. Each has a checkable completion criterion — don't
move on until it's met.

## Stage 1 — Index and inventory

```bash
scip-query reindex
scip-query status --capabilities
```

Record which languages got which evidence tier (SCIP-indexed vs
source-fallback vs regex): a detector's expected precision differs per tier,
and a repo that is 80% fallback-tier must be judged against fallback
expectations, not SCIP-tier expectations. Note the monorepo shape
(workspaces, cross-package imports) — historically the single largest
false-positive source is `dead`/`new-dead` findings on cross-package
consumers.

Complete only when languages, evidence tiers, and workspace shape are
written down.

## Stage 2 — Battery sweep

Run the full detector battery and don't react to any of the numbers yet —
big counts here are sampling frames, not findings:

```bash
scip-query health --json
scip-query dead --json
scip-query similar <symbol>
scip-query twin-drift -s <scope> --json
```

Complete only when every detector's finding count is recorded.

## Stage 3 — Retro-gate replay

Replay the gate against the last 15-20 real commits, using a worktree per
commit — never the user's live tree:

```bash
scip-query diff-gate --base <commit> --json
```

This is the stage that exposes finding WALLS: one hub file or one convention
mismatch generating dozens of near-identical findings per commit. A finding
wall is always either a missing repo knob or a detector bug — it is never
simply "the repo is just bad."

Complete only when per-commit finding counts and every wall are recorded.

## Stage 4 — Sample and classify

This is the actual calibration. For each detector with findings: sample
about 10 of them (all of them if fewer), read the code at each cited site,
and classify actionable vs noise.

- Classify from the code, never from the finding text. A finding that
  sounds plausible and a finding that is true are different things, and the
  difference is only visible at the cited file and line.
- For every noise finding, name the archetype (e.g. "type-only import
  invisible to indexer", "delegation chain flagged as twin", "generic
  shared helpers saturating similarity"). Archetypes are the deliverable —
  a noise rate without archetypes cannot be fixed.

Give each detector a verdict: **keep** (precision acceptable), **retune**
(name the threshold and the value), or **demote to advisory** for this repo.

Complete only when every detector has sampled precision, named archetypes,
and a verdict.

## Stage 5 — Tune the knobs, file the bugs

Apply repo-side fixes for what belongs to the repo, and file upstream for
what belongs to the detector:

- `.scipquery.json` suppressions — one per accepted finding, each with a
  reason. A reasonless suppression is hiding, not tuning.
- `docs.snapshotPaths` — mark dated/archival docs that must never generate
  doc-reference findings.
- Coverage contracts — declare enumerations the gate should police.
- `commandAnalysisBudget` — cap analysis honestly on very large indexes.

Validate any config change:

```bash
scip-query config-validate
```

Detector bugs — noise archetypes no config knob can express — go to the
tool's followup ledger with the archetype, a concrete example, and the
sampled rate. Never tune a threshold to hide an archetype; that trades
visible noise for invisible blindness. File it and live with the noise
until it's fixed.

Confirm the repair:

```bash
scip-query diff-gate --json
```

run before and after, to check it worked.

Complete only when the stage-3 gate replay re-runs materially quieter and
every remaining finding class is actionable, suppressed-with-reason, or
filed upstream.

## Failure modes

Each of these has been observed in a real calibration:

- **Sampling too few.** One good finding does not make a detector precise;
  one bad finding does not make it noise. Ten samples per detector is the
  floor.
- **Classifying from the finding text.** The finding always sounds right —
  it was generated to. Only the code knows.
- **Tuning to green.** Raising a threshold until the noise disappears also
  disappears the real findings. If the archetype is a detector bug, file it
  and live with the noise rather than tuning it away.
- **Trusting a clean run.** Zero findings on a detector can mean precision,
  or it can mean the detector cannot see this repo's conventions at all
  (wrong import style, unindexed language). Verify at least one known-true
  positive per major detector — plant one if none exists.
- **Calibrating the wrong tree.** Use clones or worktrees for anything that
  mutates during calibration. The target repo is read-only unless its owner
  said otherwise.

## After calibration

The finding-outcome ledger keeps calibrating automatically. Once the repo
uses `diff-gate`, per-detector precision is recomputed from real outcomes as
`detectorPrecision` in `health --json`. The committed event ledger under
`.scipquery/events/*.json` makes those outcomes durable and queryable:

```bash
scip-query effectiveness --since 30d --json
```

reports, per check, caught / comparison-verified-fixed / suppressed / open /
unverified counts, precision, and median days-to-fix, sourced from those
individual records.

If `HEAD` advances during or after calibration, use a clean worktree so
scip-query can replay the stored comparison base instead of mistaking an
empty diff for a fix. Re-run this protocol only after major detector
upgrades, or when the ledger's precision numbers drift from what was
measured previously.

Write the calibration report to
`docs/validation/YYYY-MM-DD-external-calibration-<repo>.md`, shaped like the
exemplars this protocol was distilled from: battery table, retro-gate walls,
per-detector verdicts, noise archetypes, caps and deviations.
