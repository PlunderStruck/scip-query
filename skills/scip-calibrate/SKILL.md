---
name: scip-calibrate
description: Calibrate scip-query's detectors against a repo before trusting them. Use when adopting scip-query in a new or foreign codebase, after major detector changes, when a health score or gate output seems too noisy or too clean, or before letting diff-gate block anyone's work.
commands:
  - scip-query health --json
  - scip-query diff-gate --base <commit> --json
  - scip-query twin-drift -s <scope> --json
  - scip-query dead --json
  - scip-query similar <symbol>
  - scip-query config-validate
  - scip-query effectiveness --since 30d --json
---

# scip-calibrate

Use this skill to measure whether scip-query's detectors tell the truth about a
specific repository before believing anything they say about it. A detector
tuned on one codebase's conventions can be precise there and noisy elsewhere;
calibration is how you find out which you have — and it converts every noise
archetype you find into either a repo-side knob or an upstream detector bug.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## The Stance

A health score you have not calibrated is a number, not a fact. Never present
detector output from an uncalibrated repo as findings — present it as
candidate findings pending classification. The score must EARN trust the same
way a checker earns it in `scip-integrity-audit`: by being witnessed telling
the truth on samples you verified yourself.

## Protocol

Run all five stages. Each has a checkable exit.

### 1. Index and inventory

`scip-query reindex`, then `scip-query status --capabilities`. Record which
languages got which evidence tier (SCIP-indexed vs source-fallback vs regex) —
a detector's expected precision differs per tier, and a repo that is 80%
fallback-tier must be judged against fallback expectations. Note monorepo
shape (workspaces, cross-package imports): historically the single largest
false-positive source (dead/new-dead on cross-package consumers).
Complete when: languages, tiers, and workspace shape are written down.

### 2. Battery sweep

Run the full detector battery and `health --json`. Do not react to anything
yet — big numbers are not findings, they are sampling frames.
Complete when: every detector's finding count is recorded.

### 3. Retro-gate replay

Replay `diff-gate` against the last 15–20 real commits (worktree per commit,
never the user's live tree). This is the stage that exposes finding WALLS —
one hub file or one convention mismatch generating dozens of near-identical
findings per commit. A wall is always either a missing repo knob or a detector
bug; it is never "the repo is just bad."
Complete when: per-commit finding counts and every wall are recorded.

### 4. Sample and classify — the actual calibration

For each detector with findings: sample about 10 (all of them if fewer),
READ THE CODE at each site, and classify actionable vs noise. Two rules make
this real calibration instead of theater:

- Classify from the code, never from the finding text. A finding that sounds
  plausible and a finding that is true are different things; the difference is
  only visible at the cited file and line.
- For every noise finding, name the ARCHETYPE (e.g. "type-only import
  invisible to indexer", "delegation chain flagged as twin", "generic shared
  helpers saturating similarity"). Archetypes are the deliverable: a noise
  rate without archetypes cannot be fixed.

Then give each detector a verdict: **keep** (precision acceptable), **retune**
(name the threshold and the value), or **demote to advisory** for this repo.
Complete when: every detector has sampled precision, named archetypes, and a
verdict.

### 5. Tune the knobs, file the bugs

Apply repo-side fixes for what belongs to the repo, and file upstream for what
belongs to the detector:

- `.scipquery.json` suppressions — one per accepted finding, WITH a reason;
  a reasonless suppression is hiding, not tuning.
- `docs.snapshotPaths` — dated/archival docs that must never generate
  doc-reference findings.
- Coverage contracts — enumerations the gate should police.
- `commandAnalysisBudget` — cap analysis honestly on very large indexes.
- Detector bugs (noise archetypes no knob can express) go to the tool's
  followup ledger with the archetype, a concrete example, and the sampled
  rate. Never tune a threshold to hide an archetype — that trades visible
  noise for invisible blindness.

Complete when: the gate replay from stage 3 re-runs materially quieter, and
every remaining finding class is either actionable, suppressed-with-reason, or
filed upstream.

## Failure Modes (each observed in a real calibration)

- **Sampling too few.** One good finding does not make a detector precise;
  one bad finding does not make it noise. Ten per detector is the floor.
- **Classifying from the finding text.** The finding always sounds right —
  it was generated to. Only the code knows.
- **Tuning to green.** Raising a threshold until the noise disappears also
  disappears the real findings. If the archetype is a detector bug, file it
  and live with the noise until it is fixed.
- **Trusting a clean run.** Zero findings on a detector can mean precision or
  can mean the detector cannot see this repo's conventions at all (wrong
  import style, unindexed language). Verify at least one known-true positive
  per major detector — plant one if none exists.
- **Calibrating the wrong tree.** Clones or worktrees for anything that
  mutates; the target repo is read-only unless its owner said otherwise.

## After Calibration

The finding-outcome ledger keeps calibrating for you: once the repo uses
diff-gate, per-detector precision is recomputed from real outcomes
(`detectorPrecision` in `health --json`), and the committed event ledger
makes those outcomes durable and queryable — `scip-query effectiveness
--since 30d --json` reports per-check caught/same-HEAD-fixed/suppressed/open/
unverified counts, precision, and median days-to-fix from
`.scipquery/ledger/events.jsonl`. Run diff-gate before and after the repair,
before committing, so a changed HEAD cannot be mistaken for a verified fix.
Re-run this protocol only after major detector upgrades or when the
ledger's precision numbers drift from what you measured. Write the calibration report to
`docs/validation/YYYY-MM-DD-external-calibration-<repo>.md` in the shape of
the exemplars this skill was distilled from — battery table, retro-gate
walls, per-detector verdicts, noise archetypes, caps and deviations.
