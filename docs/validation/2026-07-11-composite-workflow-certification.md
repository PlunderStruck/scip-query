# Composite workflow certification

Date: 2026-07-11

Verdict: **diff, cleanup, health, effectiveness, and impact workflows preserve
their inputs with explicit qualifications; the aggregate health score remains
experimental and private-shadow-only.**

## What this certificate means

A composite workflow is a command that combines detector, source, index, Git,
configuration, suppression, checker, or ledger results into one decision or
report. Its defining risk is evidence amplification: a qualified signal can be
made to look like a fact merely because several results were aggregated. This
audit therefore checks the transition from input evidence to output severity,
status, action language, and persistent outcome—not just whether the command
exits successfully.

`qualified` means the aggregation and stated narrower contract passed planted
positive, negative, unavailable, and suppression probes, while at least one
input family or language remains below public certification. `certified` is
used only for the exact configured coverage-contract comparison. `experimental`
means the result is useful for within-repository investigation but cannot
support an objective cross-repository claim.

## Reproducible probe suite

The focused run executed 24 test files and 166 tests. All passed. It covered:

- cleanup range deletion, overlapping/truncated ranges, patch/apply parity,
  checker diagnostic identity, per-language checker detection, selected-batch
  application, and verification-policy failure;
- every diff-gate family: echo, incomplete migration, co-change partner, twin
  partner, coverage contract, doc reference, unused params, new dead, and
  health baseline;
- structured suppression, skip lists, capped versus uncapped execution,
  advisory versus blocking severity, clustered doc cascades, snapshot policy,
  and fail-closed behavior when Git evidence is unavailable;
- health phase aggregation, uncapped/full parity, baseline round trips,
  deferred/unavailable self-audit, cached-report identity, outcome-ledger
  refresh, and candidate scoring;
- caught, resolved-at-same-HEAD, cross-HEAD disappearance, reopened, moved,
  suppressed, open, and ledger-write-failure effectiveness transitions;
- exact affected-set closures, cycles/diamonds, add/edit/delete widening,
  unavailable shadow oracles, changed-hunk attribution, workspace import
  consumers, and initializer residue.

The command was also replayed on the current repository after a clean commit:

| Command                                                             | Observation                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `incomplete-migration --json`                                       | available, zero changed files, zero helpers, zero findings                                                                          |
| `cleanup-plan --json`                                               | zero current batches and zero blocked rows; positive apply/failure behavior comes from isolated fixtures                            |
| `health --full --json`                                              | score 80 with 4 cycles and 322 heuristic findings; capability and experimental-score disclosure present                             |
| `self-audit --samples 50 --json`                                    | reference precision/recall 1.0; callee precision withheld as `null`, recall 0.75, 46 partial-oracle skips                           |
| `effectiveness --json`                                              | 40 ledger events; caught/fixed/reopened/unverified distinctions retained by check                                                   |
| `affected discloseHealthCapabilities --json`                        | exact one-step consumer: `handleHealth`                                                                                             |
| `change-surface src/runtime/health-capability-disclosure.ts --json` | two external consumer relationships, matching source/index ownership                                                                |
| `diff-impact --json`                                                | clean-diff zero with an explicit “No changed files found” note                                                                      |
| `plan-context discloseHealthCapabilities --json --full`             | trace, caller, callee, dataflow, slices, affected set, surface, dependencies, history, and source agree on the same resolved symbol |

## Workflow verdicts

| Workflow               | Verdict      | Preserved contract and boundary                                                                                            |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `incomplete-migration` | qualified    | new-helper containment and unmatched-site evidence; Git/base/source unavailability is explicit                             |
| `cleanup-plan`         | qualified    | ordered zero-reference cascade and blocker facts; inherits language liveness limits                                        |
| `cleanup-apply`        | qualified    | patch/apply share one deletion primitive and checker regressions reject the batch; safety is limited by checker capability |
| `diff-gate`            | qualified    | complete check ledger, severity, suppression, skips, attribution, unavailable state, and fail-closed status are preserved  |
| `health`               | experimental | auditable score lines and raw findings, but no cross-language/framework normalization or public-score claim                |
| `self-audit`           | qualified    | compares cheap paths to the best available oracle and withholds precision when oracle coverage is partial                  |
| `effectiveness`        | qualified    | exact committed event transitions; a disappearance is not credited as fixed without same-HEAD evidence                     |
| `affected`             | qualified    | transitive indexed consumer closure; dynamic/unindexed consumers are outside the frame                                     |
| `change-surface`       | qualified    | indexed external-consumer counts per symbol; runtime reachability is not claimed                                           |
| `diff-impact`          | qualified    | hunk-attributed changed definitions and downstream indexed consumers; unattributed lines stay visible                      |
| `plan-context`         | qualified    | parity-preserving aggregation of existing navigation/impact sections; each section retains its own evidence limit          |

### Diff-gate checks

| Check                  | Verdict      | Truth boundary                                                                           |
| ---------------------- | ------------ | ---------------------------------------------------------------------------------------- |
| `echo`                 | qualified    | disclosed same-concept evidence and action tier; generic token matches remain signals    |
| `incomplete-migration` | qualified    | same contract as the standalone analyzer                                                 |
| `co-change-partner`    | qualified    | exact history/changed-path facts; coordination advice is contextual                      |
| `twin-partner`         | qualified    | one-sided edit of a detected twin; twin identity remains qualified                       |
| `coverage-contract`    | certified    | exact configured ground-truth versus mirror key comparison                               |
| `doc-reference`        | qualified    | exact citation/change fact with calibrated citation-kind severity                        |
| `unused-params`        | insufficient | aggregation is correct, but the underlying TS/JS detector lacks population certification |
| `new-dead`             | qualified    | new indexed zero-reference candidate; ambiguous identity is downgraded to unconfirmed    |
| `baseline`             | qualified    | exact set difference with analyzer metadata; inherits each baselined detector's verdict  |

## Defects found and corrected

The real Python/mixed-repository replay exposed two forms of evidence
amplification:

1. `health` returned a numeric score without the project capability matrix, so
   an unavailable Python semantic provider could be mistaken for a clean
   analysis. Health JSON and human output now include live language capability
   rows, syntax-only checker disclosure, an `experimental-composite` status,
   `comparableAcrossLanguages: false`, and a completed-analyses-only scope.
2. Health transformed relationships into commands such as “remove,” “inline,”
   “extract,” or “deletable,” even where detector certificates explicitly said
   actionability was contextual. Action descriptions now state the measured
   relationship and the framework, runtime, ownership, or domain evidence that
   must be reviewed. Candidate LOC is no longer presented as proven
   recoverable LOC.

The traceroot replay still reports score 58.25, but it now attaches the Python
semantic-provider limitation, syntax-only cleanup verification, C++ partial
index/checker limits, and a direct statement that the number cannot support a
public leaderboard. That is a discriminating correction: findings remain
visible while unsupported completeness no longer appears as a clean zero.

## Suppression and outcome persistence

Structured suppressions retain check, file, reason, and expiry identity and
remove only matching findings. Skipped checks remain distinct from successful
zero findings. The outcome ledger records a caught event when the gate emits a
finding, a verified resolution only when the same finding disappears at the
same HEAD after re-execution, suppression as its own outcome, and cross-HEAD
disappearance as unverified. Ledger append failure does not corrupt the gate
decision. These are repository records, not local preferences.

## Publication decision

Diff-gate may be used as a repository workflow when each finding retains its
check, evidence, action tier, and capability boundary. Impact answers may be
used as qualified indexed-graph facts. The health score must remain private
shadow telemetry: it is an experimental within-repository summary and is not
normalized across language, framework, detector applicability, or
certification state.

Machine-readable verdicts:
[`2026-07-11-composite-workflow-certification-verdicts.json`](./2026-07-11-composite-workflow-certification-verdicts.json).
