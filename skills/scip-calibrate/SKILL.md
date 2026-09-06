---
name: scip-calibrate
description: Calibrate scip-query's detectors against a repository before trusting them. Use when adopting scip-query in a new or foreign codebase, after major detector changes, or when a health report or detector output seems too noisy or too clean.
metadata:
  commands:
    - template: 'scip-query capabilities --matrix'
      when: 'Inventory: which languages got which evidence tier before judging any detector.'
    - template: 'scip-query health --json'
      when: 'Battery sweep: every detector finding count as a sampling frame, not a verdict.'
    - template: 'scip-query dead --json'
      when: 'Sample: the detector historically most exposed to monorepo and cross-package false positives.'
    - template: 'scip-query twin-drift -s <scope> --json'
      when: 'Sample: same-name divergence groups to classify from the code.'
    - template: 'scip-query similar <symbol>'
      when: 'Sample: callee-overlap pairs to classify from the code.'
    - template: 'scip-query code <selector>'
      when: 'Classify: read the cited site; the finding text is never the evidence.'
    - template: 'scip-query suppress <id> --reason <text>'
      when: 'Tune: record one accepted finding with a concrete reason.'
    - template: 'scip-query config-validate'
      when: 'Tune: validate .scipquery.json and suppressions after every knob change.'
---

# scip-calibrate

<!-- BEGIN GENERATED SKILL COMMANDS -->
## Command and question manual

| Command syntax | Question it answers |
| --- | --- |
| `scip-query capabilities --matrix` | Inventory: which languages got which evidence tier before judging any detector. |
| `scip-query health --json` | Battery sweep: every detector finding count as a sampling frame, not a verdict. |
| `scip-query dead --json` | Sample: the detector historically most exposed to monorepo and cross-package false positives. |
| `scip-query twin-drift -s <scope> --json` | Sample: same-name divergence groups to classify from the code. |
| `scip-query similar <symbol>` | Sample: callee-overlap pairs to classify from the code. |
| `scip-query code <selector>` | Classify: read the cited site; the finding text is never the evidence. |
| `scip-query suppress <id> --reason <text>` | Tune: record one accepted finding with a concrete reason. |
| `scip-query config-validate` | Tune: validate .scipquery.json and suppressions after every knob change. |

These commands are controls, not a checklist. Use every capability needed by the task, but make each query answer a distinct question. There is no required sequence or query limit. Run a command's `--help` when you need a flag not shown in its template.
<!-- END GENERATED SKILL COMMANDS -->

Use this skill to measure whether scip-query's detectors tell the truth about a specific repository before believing anything they say about it. A detector tuned on one codebase's conventions can be precise there and noisy elsewhere. Calibration is how you find out which you have, and it converts every noise archetype you find into either a repo-side knob or an upstream detector bug.

## The Stance

Treat detector output as candidate findings until source review establishes the claimed defect. Validate each detector on representative examples and counterexamples; aggregate quality grades are not part of the health report.

## Protocol

Run all four stages. Each has a checkable exit.

### 1. Index and inventory

Run `scip-query status` and, if the index is stale or missing, `scip-query reindex`. Then `scip-query capabilities --matrix`. Record which languages got which evidence tier (SCIP-indexed versus source-fallback versus regex). A detector's expected precision differs per tier, and a repo that is mostly fallback-tier must be judged against fallback expectations. Note monorepo shape (workspaces, cross-package imports): historically the single largest false-positive source, with `dead` flagging cross-package consumers.

Complete when: languages, tiers, and workspace shape are written down.

### 2. Battery sweep

Run `scip-query health --json` and the standalone detectors it does not include (`twin-drift`, `decorative-checkers`, `not-implemented`, `test-quality`). Do not react to anything yet. Big numbers are not findings; they are sampling frames.

Watch for finding WALLS: one hub file or one convention mismatch generating dozens of near-identical findings. A wall is always either a missing repo knob or a detector bug. It is never "the repo is just bad."

Complete when: every detector's finding count and every wall are recorded.

### 3. Sample and classify (the actual calibration)

For each detector with findings: sample about 10 (all of them if fewer), READ THE CODE at each site with `scip-query code`, and classify actionable versus noise. Two rules make this real calibration instead of theater:

- Classify from the code, never from the finding text. A finding that sounds plausible and a finding that is true are different things; the difference is only visible at the cited file and line.
- For every noise finding, name the ARCHETYPE (for example "type-only import invisible to indexer", "delegation chain flagged as twin", "generic shared helpers saturating similarity"). Archetypes are the deliverable: a noise rate without archetypes cannot be fixed.

Then give each detector a verdict: **keep** (precision acceptable), **retune** (name the threshold and the value), or **demote to advisory** for this repo.

Complete when: every detector has sampled precision, named archetypes, and a verdict.

### 4. Tune the knobs, file the bugs

Apply repo-side fixes for what belongs to the repo, and file upstream for what belongs to the detector:

- `scip-query suppress <id> --reason <text>`: one per accepted finding, WITH a concrete reason. A reasonless suppression is hiding, not tuning.
- `docs.snapshotPaths` in `.scipquery.json`: dated or archival docs that must never generate doc-drift findings.
- Coverage contracts: enumerations the detectors should police.
- `commandAnalysisBudget`: cap analysis honestly on very large indexes.
- Detector bugs (noise archetypes no knob can express) go upstream with the archetype, a concrete example, and the sampled rate. Never tune a threshold to hide an archetype; that trades visible noise for invisible blindness.

Run `scip-query config-validate` after every knob change.

Complete when: the battery from stage 2 re-runs materially quieter, and every remaining finding class is either actionable, suppressed with a reason, or filed upstream.

## Failure Modes (each observed in a real calibration)

- **Sampling too few.** One good finding does not make a detector precise; one bad finding does not make it noise. Ten per detector is the floor.
- **Classifying from the finding text.** The finding always sounds right; it was generated to. Only the code knows.
- **Tuning to green.** Raising a threshold until the noise disappears also disappears the real findings. If the archetype is a detector bug, file it and live with the noise until it is fixed.
- **Trusting a clean run.** Zero findings on a detector can mean precision or can mean the detector cannot see this repo's conventions at all (wrong import style, unindexed language). Verify at least one known-true positive per major detector; plant one if none exists.
- **Calibrating the wrong tree.** Use clones or worktrees for anything that mutates; the target repo is read-only unless its owner said otherwise.

## After Calibration

Write the calibration report to `docs/validation/YYYY-MM-DD-external-calibration-<repo>.md`: battery table, walls, per-detector verdicts, noise archetypes, caps and deviations. Re-run this protocol only after major detector upgrades or when detector behavior visibly drifts from what you measured.
