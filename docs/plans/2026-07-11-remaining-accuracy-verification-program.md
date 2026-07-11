# Remaining Accuracy Verification Program

Date: 2026-07-11
Status: Active

## Goal

Close every open command row in
[`docs/accuracy-audit-checklist.md`](../accuracy-audit-checklist.md) with a
reproducible verdict. A verdict is a reviewed accuracy classification tied to
the command's real output, distinguished from a feature-completeness claim by
recording what the command proves, what it merely suggests, and where its
evidence is unavailable.

The program may end with `certified`, `qualified`, `insufficient`, or
`unsupported` rows. It may not end with an unexplained unchecked row, an empty
result interpreted as clean, or an accuracy claim derived only from fixtures.

## Source of Truth

- Scope and open rows: `docs/accuracy-audit-checklist.md`.
- Certification thresholds and publication policy:
  `docs/accuracy-hardening-goal.md`.
- Review protocol and TP/FP/FN rules:
  `docs/analyzer-validation-protocol.md`.
- Calibration packet implementation: `scripts/accuracy-calibration.mjs` and
  `scripts/accuracy-calibration-core.mjs`.
- Current code topology: `scip-query status --capabilities` and a fresh
  `scip-query plan-context <target> --json` before each implementation slice.

## Pre-Registered Baseline

Observed on 2026-07-11:

- `scip-query status --capabilities`: fresh TypeScript/Rust index with both
  semantic providers available.
- `rg -n '^\s*- \[ \]' docs/accuracy-audit-checklist.md`: 70 unchecked boxes.
- Nine of those boxes are the reusable evidence-gate definition, not nine
  independently completable commands.
- The remaining command work comprises one TypeScript generator, composite and
  impact workflows, navigation/graph answers, and indexing/operations commands,
  plus the language breadth required by the accuracy roadmap.
- `twin-ab` already has eight focused fixture tests, including compilation of
  a generated scaffold and null-SCIP-kind regression coverage. Source:
  `npm test -- --run tests/queries/cleanup/twin-ab.test.ts` and
  `scip-query plan-context twinAb --json`. Its missing evidence is generated
  scaffold correctness against pinned real indexes.

Target:

- Zero unexplained command rows.
- Every audited row names a truth rule, oracle, applicability state, corpus or
  fixture boundary, observed result, and verdict.
- Every production correction has a failing-before/passing-after regression.
- Every slice ends with a fresh index and quiet diff gate.

## Program Batches

### 1. Reconcile and close the remaining TypeScript evidence gaps

- [x] Run `twin-ab` against real exported callable pairs in at least three
      pinned TypeScript repositories, compile each emitted scaffold, and test
      refusal paths against non-callable, non-exported, ambiguous, and
      signature-incompatible inputs.
- [ ] Expand real-repository or historical evidence for TypeScript rows marked
      `insufficient`: `unused-params`, `cycles`, `isolated`,
      `not-implemented`, `decorative-checkers`, `test-quality`,
      `recent-duplicates`, and `passthrough-candidates`.
- [ ] Seek additional populations for qualified rows whose only failed gate is
      confidence or subtype breadth, including `bottlenecks` and
      `wrapper-candidates`; preserve qualified status when the population does
      not exist.
- [ ] Source-review resolved and missed Vue reference sites in a third
      dependency-ready repository and record `augment-vue` completeness.

Acceptance: each named row is certified, qualified, insufficient, or
unsupported with a dated machine-readable verdict and narrative evidence.

### 2. Renew Rust detector certification

- [ ] Pin at least three representative Rust repositories or historical
      revisions and record capability/build state separately from findings.
- [ ] Audit factual, similarity, architecture, graph-risk, composite, and
      navigation families that actually support Rust.
- [ ] Record trait, implementation, derive, macro, generated-code, public API,
      test, binary, ABI, and feature/target applicability.
- [ ] Replace every proven false-positive archetype with the smallest shared
      correction and replay an untouched holdout.

Acceptance: every Rust row has visible applicability/exclusion counts and a
verdict; no broad framework/library exclusion silently improves output.

### 3. Establish Python capability and certification boundaries

- [ ] Pin `scip-python`, `traceroot`, and a third distinct Python framework
      repository or revision.
- [ ] Establish indexing, semantic-reference, framework-registration, and
      checker capability independently.
- [ ] Audit only claims supported by the available provider, covering
      decorators and registration patterns encountered in the corpus.
- [ ] Treat unavailable semantic/checker paths as `unsupported` or
      `insufficient`, never as zero findings.

Acceptance: every Python row has a capability-backed verdict and public output
cannot imply unsupported semantic completeness.

### 4. Audit composite, diff, cleanup, health, and impact workflows

- [ ] Audit `incomplete-migration`, `cleanup-plan`, `cleanup-apply`, every
      `diff-gate` check, `health`, `self-audit`, and `effectiveness`.
- [ ] Audit `affected`, `change-surface`, `diff-impact`, and `plan-context`
      against hand-established changed-symbol/consumer fixtures and real diffs.
- [ ] Plant at least one bounded failure for each gate family before trusting a
      green result, then remove the probe by targeted edit.
- [ ] Verify aggregation, suppression, unavailable-state propagation, baseline
      comparison, and outcome-ledger transitions independently from detector
      precision.

Acceptance: composite commands neither amplify uncertified inputs into facts
nor lose capability/suppression/status information.

### 5. Audit navigation and graph answers

- [ ] Compare every navigation row in the checklist against exact SCIP,
      compiler, source, and hand-established graph oracles.
- [ ] Cover aliases, overloads, re-exports, inheritance, traits,
      implementations, generated files, path-qualified ambiguity, and
      cross-language boundaries where applicable.
- [ ] Record exact-answer parity rather than statistical recommendation
      precision for graph-fact commands.

Acceptance: each command has known-positive and known-negative cases, explicit
unsupported shapes, and reproducible exact-answer evidence.

### 6. Audit indexing and operations

- [ ] Exercise the checklist's indexing, watcher, status, profiling,
      capability, setup, configuration, suppression, lifecycle, skill, and TLA
      commands.
- [ ] Cover cold/warm indexes, incremental add/edit/delete/rename, branch/index
      changes, stale/corrupt caches, interrupted publication, concurrent
      requests, daemon sleep/wake, setup idempotence, and clean uninstall.
- [ ] Separate local user preferences from committed project records and verify
      the effectiveness ledger records caught/resolved/suppressed transitions.

Acceptance: every operational row has a deterministic state transition or
observable output contract and a failure-path probe.

### 7. Publication-readiness closure

- [ ] Reconcile every checklist row and certification-matrix cell.
- [ ] State whether certified evidence views are ready for a private cloud
      shadow; keep leaderboard operation a separate product program.
- [ ] Run final full tests, typecheck, lint/format, build, reindex, health
      baseline review, doc drift, and diff gate.
- [ ] Write the conductor self-report with benchmark before/after values,
      observed discriminating probes, deviations, deferrals, and folded-back
      learning.

Acceptance: zero unexplained accuracy gaps and a quiet final gate.

## Working Agreement

- Work directly on `main` and do not use sub-agents.
- Commit each coherent verified slice with explicit paths; never accumulate the
  whole program into one commit.
- Use read-only pinned repositories or isolated temporary worktrees/clones.
- Before editing a production surface, run
  `scip-query plan-context <target> --json` and the matching change-surface or
  trace command.
- Verify the verifier with one bounded failing probe when feasible.
- Run focused tests during iteration and the full test/typecheck/lint/build set
  at slice boundaries.
- Before every commit, run `scip-query reindex && scip-query diff-gate --json`.
- Commit `.scipquery` outcome/suppression records produced by the slice; never
  commit `.codex/hooks.json` or `.claude/settings.local.json`.
- If source evidence contradicts this plan, record the deviation and update the
  plan before continuing; never improvise silently.

## Explicit Deferrals

- Public cloud deployment and leaderboard operation are not authorized by this
  verification program. The program produces the readiness verdict and
  reproducibility contract they require.
- Performance-only work without an observed accuracy or verification impact
  remains in its existing performance roadmap.
- A detector may remain insufficient when the required real population does
  not exist; manufacturing redundant repositories to force certification is
  forbidden.
