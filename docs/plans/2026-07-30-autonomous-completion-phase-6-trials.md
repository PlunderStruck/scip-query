# Phase 6 — outcome trials and product alignment

Date: 2026-07-30
Status: planned; depends on Phase 5
Parent: [Autonomous completion execution plan](./2026-07-30-autonomous-completion-execution.md)

## Goal

```gherkin
Feature: Product claims follow measured autonomous outcomes

  Scenario: The integrated workflow is evaluated
    Given matched long-form repository tasks and protected ground truth
    When otherwise equivalent agents run with and without the workflow
    Then quality, efficiency, false blocking, and rework are measured under pre-registered thresholds

  Scenario: A claimed capability is not established
    Given trial evidence is absent, mixed, or below threshold
    When documentation and health status are generated
    Then the capability is labeled experimental or bounded rather than complete
```

## Concepts fixed by this phase

A mission trial is a protected comparison of autonomous repository work from
goal receipt to verified completion. Its referents are matched tasks,
otherwise equivalent agent configurations, independent ground truth, and
recorded outcomes. It is wider than a detector benchmark; the distinguishing
property is end-to-end causal relevance to the product mission.

Full completion rate is the proportion of trials whose final repository
satisfies the goal, preserves invariants, reconciles the independently known
affected surface, and leaves no unaccepted architecture or residue defect. It
is wider than test pass rate; the differentiating fact is independent
whole-change judgment.

False blocking is a controller refusal when the candidate actually satisfies
the protected goal and policy. It is wider than any warning; the
distinguishing fact is that it prevents or materially delays a valid autonomous
completion.

## Current code path and reuse

- outcome events and the finding-outcome ledger already measure detector
  resolution and precision signals.
- `effectiveness` and health reporting already aggregate operational evidence.
- benchmark and validation documentation patterns already exist.
- command envelopes now carry invocation/evidence metadata suitable for tool
  call and coverage accounting.

Keep detector calibration separate from mission trials while linking both
through versioned run IDs and protected observations.

## Slices

### 6.1 Trial manifest and protected evaluator

Exact change:

- add a versioned trial manifest naming task fixture, authorized goal,
  protected evaluator location/hash, agent/runtime configuration, treatment,
  budgets, and thresholds;
- keep ground truth outside the candidate-editable worktree or bind it to a
  fixed predecessor identity;
- record all result artifacts immutably; and
- reject trials whose treatment/control conditions drift.

Expected validation:

- a candidate cannot edit the evaluator that scores it;
- control and treatment differ only in the declared workflow;
- reruns retain separate identities; and
- incomplete or contaminated trials are excluded with reasons.

### 6.2 Metric derivation

Exact change:

- derive completion, missed affected artifacts, residue, reintroduced behavior,
  architecture violations, false blocking, elapsed time, model tokens, tool
  calls, failed attempts, and rework;
- report paired differences and raw samples;
- distinguish detector miss, controller miss, and agent failure; and
- retain unknown rather than imputing success or failure.

Expected validation:

- metric functions are deterministic over immutable trial records;
- protected hand-calculated fixtures match;
- missing telemetry never becomes zero; and
- quality and efficiency dimensions remain separate.

### 6.3 Pre-registered decision rule

Exact change:

- require a higher full-completion probability without unacceptable false
  blocking or architecture regression;
- require improvement in either elapsed time or model tokens without
  unacceptable regression in the other;
- define minimum trial count and uncertainty reporting before data collection;
  and
- classify results as `established | promising | neutral | regressed |
  insufficient`.

Expected validation:

- the classifier cannot be tuned from the measured results without producing a
  new versioned trial program;
- mixed results remain mixed; and
- one fast but incomplete run cannot establish success.

### 6.4 Product identity and calibration

Exact change:

- feed trial classifications into effectiveness/health reporting without
  letting health rewrite trial facts;
- align README, command reference, setup text, skills, schemas, and product
  language with established capability bounds;
- publish detector calibration separately from mission effectiveness; and
- retain the evidence needed to reproduce every public quantitative claim.

Expected validation:

- every capability statement links to a trial class and version;
- unsupported agent/provider paths are labeled;
- health distinguishes unavailable evidence from failing performance; and
- docs/API contract checks prevent drift.

## Pre-registered thresholds

Before running treatment trials, fix:

- fixture set and independent affected-surface ground truth;
- minimum paired-trial count;
- unacceptable full-completion, false-blocking, architecture, time, and token
  regressions;
- treatment/control agent and tool budgets;
- retry policy and timeout handling; and
- exclusion criteria.

Threshold values are written only after pilot runs used solely to validate the
apparatus. Pilot outcomes cannot count toward the decision dataset.

## Risks and deferrals

- Model runs are stochastic and expensive. Report raw paired outcomes and
  uncertainty; do not manufacture precision from a small sample.
- Self-hosting scip-query changes require an evaluator outside the candidate
  diff. Repository-internal tests remain useful but are not independent mission
  evidence.
- A neutral trial result does not prove the architecture is wrong. It prevents
  a strong product claim and identifies which cost or failure mode to revise.

## Program exit probe

Run a long feature overhaul containing an intentionally plausible obsolete
implementation and a strict architecture constraint. The treatment must
preserve its goal across interruption, avoid rewiring the obsolete behavior,
reconcile every protected consequence, and reach completion without routine
human input or metadata ceremony.
