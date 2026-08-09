# TLA+ surface audit

Date: 2026-08-09

## Decision

Keep the supported `scip-query tla` implementation and its focused tests, but expose formal modeling only through `scip-query --help-all`. TLA+ remains an advanced analysis: it describes explicitly modeled state transitions and checks their invariants; it is not one of the ordinary controls an agent needs to navigate indexed code.

Retire only the shipped `DiffGateOutcome` and `FindingOutcomeLedger` model families. Their mappings name source systems that no longer exist, so they cannot establish facts about the current product. The general evidence-cache model remains owned by the current cache implementation.

## Evidence

- Current runtime source contains no `DiffGateOutcome` or `FindingOutcomeLedger` referent.
- `specs/diff-gate/DiffGateOutcome.scip-tla.json` still mapped `src/queries/impact/diff-gate.ts`.
- `specs/evidence-cache/FindingOutcomeLedger.scip-tla.json` still mapped `src/queries/health/finding-outcome-ledger.ts`.
- The TLA command remains registered under the `Formal Models` descriptor category and is available in complete help.

## Compatibility

No CLI command or supported alias is removed. This cleanup removes repository-owned example models whose claimed implementation referents were retired. Historical plans remain as records of what existed at the time; they are not current runtime contracts.

## Required proof

- Ordinary root help shows primary exploration and maintenance controls only.
- `--help-all` shows specialized, quality, formal-modeling, compatibility, and deprecated controls.
- TLA command help and focused TLA tests pass.
- The package contains no retired diff-gate or finding-outcome-ledger model artifact.
