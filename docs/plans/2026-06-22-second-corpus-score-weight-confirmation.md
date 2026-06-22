# Second-Corpus Score-Weight Confirmation Plan

Date: 2026-06-22

## Goal

Confirm whether the current health score weights still match reviewed analyzer evidence outside `scip-query`. A score weight is the numeric pressure an analyzer contributes to the composite health score; it should change only when another real repository shows that an analyzer is consistently too strong, too weak, or missing action-tier discounts.

## Evidence Anchors

- `node dist/cli.js plan-context computeHealthScore --json` resolves `computeHealthScore()` in `src/queries/health/health-report.ts:557`, where direct deductions and pressure deductions are applied.
- The same plan-context run shows `buildHealthReport()` as the direct consumer, so this slice should validate health JSON and not edit scoring code unless the corpus evidence contradicts the current rules.
- `Vega_2.0` is clean at `6288855333faf33ba395fa804eb9b03c0a04989e` and has `.scipquery.json` configured for TypeScript and Python.
- `SynthRunnerRust` is at `658a52d355e8733d6ce759e77b84735a47ef3048` with pre-existing local edits, so it can only be used as contextual capability evidence unless those edits are intentionally part of the sample.
- `Stable_Management` is heavily dirty, so it is not a clean score-weight confirmation corpus for this pass.

## Checklist

- [x] Run the current CLI against clean `Vega_2.0`: `reindex`, `health --full --json`, `similar --full --json`, `wrapper-candidates --json`, `passthrough-candidates --json`, `react-component-duplicates --full --json`, `react-hook-candidates --full --json`, and `react-large-component-pressure --full --json`.
- [x] Save raw outputs under `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0`.
- [x] Summarize score breakdown rows, pressure rows, action-tier counts, and score-count discounts.
- [x] Decide whether current weights should change or remain conservative.
- [x] Implement hidden-coupling score weighting because clean Vega showed broad-sweep contract migrations scoring like focused current coupling.
- [x] Record the result in `docs/validation/2026-06-22-second-corpus-score-weight-confirmation-result.md`.
- [x] Update the ledger, protocol, and calibration memo with the judgment.
- [x] Run repository formatting and verification gates after doc updates.

## Expected Judgment Shape

Keep the current weights if direct rows are narrow, signal rows dominate broad candidate families, and score-count discounts prevent boundary/support evidence from acting like direct debt. Propose a scoring change only if a clean corpus shows repeated direct evidence that is underweighted or repeated contextual/support evidence that still deducts too strongly.
