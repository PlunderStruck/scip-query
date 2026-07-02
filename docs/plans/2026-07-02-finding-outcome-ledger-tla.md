# Finding-outcome ledger TLA model

Date: 2026-07-02

## Goal

Model the finding-outcome ledger lifecycle for `src/storage/evidence-cache.ts`: outcome transitions produced by the pure health ledger core, persistence through the SQL-backed evidence cache, and the per-check FIFO cap. Done means a CurrentSpec proves `NoResurrectedResolutions` and `CapNeverExceeded`, a VulnerableSpec refutes each invariant, and `scip-query tla verify` passes without unknown findings.

## Current State

`scip-query plan-context src/storage/evidence-cache.ts` shows `src/storage/evidence-cache.ts` is high risk with 47 external consumers and historical co-change with `tests/storage/evidence-cache.test.ts`.

`scip-query code readFindingOutcomeLedger` shows the read path maps SQL rows into `FindingOutcomeRow[]` and returns `[]` after disabling the cache on read failure.

`scip-query code writeFindingOutcomeLedger` shows the write path groups rows by `check`, deletes existing rows for that check, sorts by descending `lastSeen`, slices to `FINDING_OUTCOME_LEDGER_CAP_PER_CHECK`, and inserts each capped row.

`scip-query code FINDING_OUTCOME_LEDGER_CAP_PER_CHECK` shows the production cap is `5_000`.

`scip-query code recordFindingOutcomes` shows the outcome transition core: observed unsuppressed findings become `still-open`, observed suppressed findings become `suppressed`, missing findings for checks that ran become `resolved`, already resolved missing findings remain resolved, and findings for checks that did not run are untouched.

`scip-query call-graph updateFindingOutcomeLedger` shows the end-to-end hook path reads ledger rows, calls `recordFindingOutcomes`, then calls `writeFindingOutcomeLedger`.

The TLA scaffold command was run against `src/storage/evidence-cache.ts`. It found only module-level cache/connection state and actions `ConnectionFor` and `Disable`, so the generated variable set was discarded. The ledger rows are SQL-backed state behind prepared statements, and the outcome transition lives in `src/queries/health/finding-outcome-ledger.ts`.

## Reuse Audit

Reuse existing TLA layout under `specs/evidence-cache` and the existing CurrentSpec/VulnerableSpec pattern from `specs/diff-gate/DiffGateOutcome.tla`.

Add a new model instead of extending `EvidenceCacheCoherence.tla` because cache-key coherence and finding-outcome lifecycle have different state, failure stories, and abstraction bounds.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Outcome transition | `recordFindingOutcomes` | clock as `now` | status transition over previous rows and observed findings | `updateFindingOutcomeLedger` | `(previous, observed, checksRun, now) -> next rows` |
| Per-check FIFO cap | `writeFindingOutcomeLedger` | SQLite evidence DB | sort and slice by `lastSeen` | prepared SQL delete/insert transaction | per-check rows stored <= cap, newest rows kept |
| Model conformance | `scip-query tla verify` | TLA tools, SCIP index | TLA `NextCurrent`/`NextVulnerable` | static referent scanner and TLC | mapping waivers are explicit and scoped |

## Design Phases

### 1. Model lifecycle

- [x] **File**: `specs/evidence-cache/FindingOutcomeLedger.tla`
- **Source**: `scip-query code recordFindingOutcomes`; `scip-query code writeFindingOutcomeLedger`
- **What**: The lifecycle combines pure transition with persistence and cap.
- **Change**: Add CurrentSpec actions for open observation, suppressed observation, missing-finding resolution, and skipped checks. Add VulnerableSpec actions for resolved identity resurrection and uncapped writes.
- **Validation**: TLC proves CurrentSpec and refutes VulnerableSpec variants.
- **Why**: The invariant failure stories need a model that can both pass and fail.

### 2. Map code evidence

- [x] **File**: `specs/evidence-cache/FindingOutcomeLedger.scip-tla.json`
- **Source**: `scip-query trace writeFindingOutcomeLedger`; `scip-query trace readFindingOutcomeLedger`; `scip-query trace recordFindingOutcomes`
- **What**: SQL rows and model-only projections cannot be proven as normal TypeScript assignments.
- **Change**: Map real transition and storage functions, with per-variable and per-action waivers for SQL-backed rows, model history, finite cap abstraction, and scalar trace projections.
- **Validation**: `scip-query tla verify ... --full` has zero unknown findings.
- **Why**: A green checker without honest mapping would not establish code/model correspondence.

### 3. Add checker configs and trace

- [x] **File**: `specs/evidence-cache/FindingOutcomeLedgerCurrent.cfg`
- [x] **File**: `specs/evidence-cache/FindingOutcomeLedgerVulnerableResurrection.cfg`
- [x] **File**: `specs/evidence-cache/FindingOutcomeLedgerVulnerableCap.cfg`
- [x] **File**: `specs/evidence-cache/finding-outcome-ledger-current.trace.json`
- **Source**: `scip-query tla trace-check --next NextCurrent` pattern from `specs/diff-gate/diff-gate-decision.trace.json`
- **What**: Current and vulnerable checks should be runnable independently, and trace-check should cover the shipped current transition shape.
- **Change**: Use a finite model cap of `2` with three symbolic findings so overflow is reachable; the production `5_000` cap is recorded in the model and mapping as the code referent for this abstraction.
- **Validation**: Current verify passes, vulnerable resurrection refutes `NoResurrectedResolutions`, vulnerable cap refutes `CapNeverExceeded`, trace-check accepts the current trace.
- **Why**: The small finite cap is the tractable model of the 5,000-row production bound.

## Stress-Test Findings

Purpose: Preserve detector outcome history without letting resolved identities become active again under the modeled identity contract.

Blast radius: The model files do not change runtime behavior; `src/storage/evidence-cache.ts` and `src/queries/health/finding-outcome-ledger.ts` remain source evidence only.

Failure: SQL-backed rows are invisible to static assignment scanning, so mapping waivers identify that residual class explicitly.

Concurrency: The model treats the read-transition-write hook update as one atomic lifecycle step. SQLite transaction boundaries are modeled at the persistence action level, not as interleavings between individual row inserts.

Data integrity: The cap is checked per check, not globally.

Accepted gap: CurrentSpec assumes a resolved `(check, findingId)` is not observed again as the same identity; that is the documented meaning of resolution, but the TypeScript function relies on caller identity semantics rather than enforcing a terminal-state guard itself.

## Summary

Create model, configs, mapping, and trace under `specs/evidence-cache`; create this plan; do not edit production TypeScript.
