# TypeScript Extraction and Graph-Risk Certification

Date: 2026-07-10
Status: Complete

## Goal

Certify the factual accuracy and recommendation utility of the TypeScript
`extract-candidates`, `locality-candidates`, `coupling`, `bottlenecks`,
`deep-chains`, `complexity-hotspots`, `hotspots`, `fan-in`, and `fan-out`
commands against uncapped production-repository candidate frames. Harden any
repeatable detector defect, preserve framework and architectural boundaries,
and record an explicit certified, qualified, experimental, or
insufficient-evidence verdict for every command.

The disclosed measurement and the suggested action are separate claims. A
graph-risk measurement is a repository relationship or count derived from the
compiler index. What distinguishes it from an actionable finding is that it
describes dependency structure without, by itself, proving that the structure
should change.

## Current State

- `extractCandidates()` scores large production callables from LOC and callee
  clusters, then classifies the result as an extraction signal or workflow
  orchestration context. Source: `scip-query plan-context
src/queries/cleanup/extract-candidates.ts` (`extractCandidates`, lines 61-90;
  classification, lines 95-188).
- `localityCandidates()` derives consumer ownership, directory ancestry,
  boundary evidence, a recommended tier, and a destination assessment. Source:
  `scip-query plan-context src/queries/cleanup/locality-candidates.ts`
  (`localityCandidates`, lines 166-189; candidate construction, lines 235-307;
  destination logic, lines 442-695).
- `topFanIn()` and `topFanOut()` report distinct incoming consumer files and
  outgoing external symbols, respectively. Source: `scip-query plan-context
src/queries/graph/fan.ts` (lines 110-198).
- `topCoupling()` reports file pairs connected by symbols defined in one file
  and referenced by the other. Source: `scip-query plan-context
src/queries/graph/coupling.ts` (lines 70-124).
- `bottlenecks()` combines distinct incoming consumer files with distinct
  cross-file callees and emits the product as a centrality score. Source:
  `scip-query plan-context src/queries/graph/bottlenecks.ts` (lines 33-88).
- `deepChains()` condenses file dependency cycles and selects representative
  longest paths through the resulting acyclic graph. Source: `scip-query
plan-context src/queries/graph/deep-chains.ts` (lines 28-197).
- `hotspots()` ranks cross-file reference counts, while
  `complexityHotspots()` combines source span, caller, callee, and branch
  evidence. Source: `scip-query plan-context src/queries/graph/hotspots.ts`
  (lines 21-98) and `scip-query plan-context
src/queries/quality/complexity-hotspots.ts` (lines 40-181).
- The reusable calibration runner already provides detached worktrees,
  TypeScript reindexing, uncapped candidate collection, deterministic sampling,
  Wilson confidence intervals, and separate relationship/utility verdicts.
  The script is not part of the compiler index, so this claim is grounded by
  direct inspection of `scripts/accuracy-calibration.mjs` and
  `scripts/accuracy-calibration-core.mjs`.

## Reuse Audit

- Reuse `runTypeScriptDetectorMode()` for worktree isolation, indexing,
  repository inventory, timing, and packet persistence.
- Reuse `normalizeSimilarityCandidate()` because these commands also require
  independent measurement and utility verdicts.
- Reuse `deterministicStratifiedSample()` so fixed review samples cover
  detector subtypes without pretending to be exhaustive review.
- Reuse `similarityPacketSummary()` and the relationship packet renderer; only
  the packet family and title need extension.
- Invoke exported production analyzers from `dist/queries/index.js`; do not
  duplicate detector logic in the calibration harness.
- Add no production abstraction unless an observed noise archetype cannot be
  fixed safely in an existing analyzer.

## Testability Design

| Behavior                 | Test seam                                                  | Dependencies                           | Pure core                                | Side-effect shell                  | Contract                                          |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------- | ---------------------------------------- | ---------------------------------- | ------------------------------------------------- |
| Parse the detector batch | `parseGraphRiskCalibrationOptions()`                       | CLI argument array                     | option validation and defaults           | none                               | accepted detectors, roots, sample size, seed      |
| Build review rows        | `collectGraphRiskCandidates()` through the calibration CLI | production `ScipDatabase`, source tree | row normalization and subtype assignment | detached worktree/index lifecycle  | full count plus deterministic sample and metadata |
| Summarize evidence       | existing summary helpers                                   | verdict JSON                           | precision, Wilson interval, utility rate | report writes                      | relationship and utility remain separate          |
| Harden a detector        | existing exported analyzer                                 | indexed fixtures                       | count/classification/filter decision     | semantic/source evidence providers | emitted factual fields match repository evidence  |

## Design Phases

### 1. Extend the calibration manifest and packet routing

- [x] **Files**: `scripts/accuracy-calibration-core.mjs`,
      `scripts/accuracy-calibration.mjs`, and calibration-core tests.
- **Source**: direct script inspection plus `scip-query plan-context` commands
  listed in Current State for the production analyzers.
- **Change**: add a `health-graph-risk` batch with the nine commands, uncapped
  production invocations, source endpoints, subtype metadata, deterministic
  samples, and generic relationship-packet routing.
- **Testability**: exercise option parsing, default manifest membership,
  detector rejection, and packet-family routing without indexing a real repo.
- **Validation**: focused Vitest calibration tests and a one-detector smoke run.
- **Why**: one evidence pipeline keeps the sampling and confidence contract
  comparable to the completed detector campaigns.

### 2. Run the uncapped cross-repository calibration

- [x] **Repositories**: Vega 2.0, openwork, Stable Management, and traceroot.
- **Source**: detached-worktree inventories emitted by
  `scripts/accuracy-calibration.mjs health-graph-risk`.
- **Change**: no target-repository writes; record full candidate counts,
  timings, capability tier, subtype counts, and deterministic review rows.
- **Testability**: every reviewed row includes the relevant definitions,
  files, dependency path, counts, and source excerpt needed to recompute the
  disclosed measurement.
- **Validation**: all four repositories index successfully and every detector
  emits an explicit candidate count, including zero.
- **Why**: candidate frames are uncapped even though manual review is sampled.

### 3. Classify truth and recommendation utility

- [x] **Files**: dated verdict JSON and validation Markdown under
      `docs/validation/`.
- **Source**: calibration packet endpoints plus production source inspection.
- **Change**: classify measurement validity separately from whether a move,
  extraction, dependency reduction, or refactor is independently justified.
  Name every repeatable invalid or non-actionable archetype.
- **Testability**: verdict groups must cover every sampled calibration ID once;
  summarization fails on unknown or duplicate IDs.
- **Validation**: reviewed packet reports per-detector precision, confidence
  interval, repository count, subtype coverage, and utility rate.
- **Why**: a correct centrality count is not automatically a refactoring task.

### 4. Harden only evidence-backed defects

- [x] **Files**: the affected existing analyzer and focused regression test.
- **Source**: the exact invalid sample and `scip-query plan-context` for the
  affected analyzer.
- **Change**: correct repeatable false facts or materially misleading labels;
  do not tune thresholds merely to hide inconvenient candidates.
- **Testability**: reproduce the noise archetype in the smallest indexed
  fixture, prove the correction, and preserve a nearby true positive.
- **Validation**: focused tests plus a second uncapped calibration run.
- **Why**: production changes must be caused by observed evidence, not by a
  desire to force a favorable certification result.

### 5. Reconcile the roadmap and verify the repository

- [x] **Files**: `docs/accuracy-audit-checklist.md`,
      `docs/accuracy-hardening-goal.md`, dated validation records, and the shared
      effectiveness ledger if the gate records outcomes.
- **Source**: final reviewed packet and `scip-query diff-impact --json`.
- **Change**: record the final verdict and next framework-specific batch.
- **Validation**: focused tests, full tests, typecheck, lint, formatting, build,
  relevant routed postchecks, `scip-query reindex`, `scip-query doctor`,
  `scip-query status --capabilities`, and `scip-query diff-gate --json`.
- **Why**: documentation must expose both what is trusted and what still needs
  human investigation.

## Stress-Test Findings

- A top-N CLI default is not an exhaustive candidate frame. Calibration calls
  production analyzers with an infinite result limit where supported.
- `fan-in`, `fan-out`, `hotspots`, `coupling`, and `bottlenecks` overlap in
  graph inputs but make different measurements; cross-checking them is useful,
  but one command cannot substitute for another.
- Cycles complicate dependency depth. `deep-chains` must be judged against its
  disclosed cycle-condensation and representative-path contract, not against
  an impossible claim that the output lists every simple path.
- Framework entry points, tests, generated code, barrels, and intentional
  boundary modules can make an accurate relationship non-actionable. Those are
  utility archetypes unless they also falsify an emitted count or label.
- Zero candidates are evidence of insufficient prevalence, not accuracy; known
  positive fixtures remain necessary for recall coverage.

## Ship Order

1. Calibration manifest and tests.
2. Initial uncapped packet.
3. Narrow production hardening with regression tests, if warranted.
4. Final reviewed packet and roadmap reconciliation.
5. Repository-wide verification and one dedicated commit.

No phase is a one-way door. Target repositories remain read-only because all
calibration runs use detached worktrees and disposable indexes.

## Expected File Summary

- Create this plan and dated graph-risk validation/verdict records.
- Edit the calibration scripts and their focused tests.
- Edit only production analyzers proven defective by reviewed samples.
- Update the accuracy checklist, hardening roadmap, and committed ledger.
- Delete no production files.

## Outcome

The final uncapped frame contained 69,942 candidates. Exact fan-in identities
and condensed deep-chain depth were hardened, all 417 final sampled
measurements passed their detector-specific invariants, eight detectors were
certified, and bottlenecks was qualified at 33/33 with an 89.6% confidence
floor. See
[`2026-07-10-typescript-extraction-graph-risk-detectors.md`](../validation/2026-07-10-typescript-extraction-graph-risk-detectors.md).
