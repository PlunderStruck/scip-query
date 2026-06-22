# Output Schema Quality Finalization

Date: 2026-06-21

## Goal

Close AVL-007 by consolidating the output/schema verdicts for all analyzer families. Done means every analyzer family has either an implemented output contract, a documented support role, or a missing-field list that explains why stronger action or scoring is blocked.

An output contract is the structured evidence an analyzer returns so a maintainer or agent can understand the claim, its confidence, and the next reasonable action. Its essential role is to prevent raw detector mechanics from being mistaken for repair instructions.

## Current State

- `node dist/cli.js health --json` currently reports score 100 with no breakdown or pressure for this working tree.
- `node dist/cli.js diff-gate --json` exits with two known warnings that now carry action-tier metadata: signal-tier `echo` and support-tier `doc-reference` with `citationKind: configuration-example`.
- The prior output-quality slices added or validated `counts`, `shownCounts`, `groupKey`, `actionTier`, `citationKind`, `evidenceClass`, `extractionKind`, `stalenessKind`, `pressureKinds`, `contextKind`, `recommendationKind`, `policyBasis`, `riskKind`, `couplingKind`, `chainKind`, `evidenceReasons`, `boundaryEvidence`, and recommendations.

## Reuse Audit

This is a documentation closure slice. It reuses the existing result documents and current command output captures under `/tmp/scip-query-validation/2026-06-21-direct-deletion-family-closure`.

## Design

### 1. Consolidate Implemented Output Contracts

- [x] **Docs**: dated validation results under `docs/validation/`.
- **Source**: targeted review of `*-result.md` files plus `node dist/cli.js health --json` and `node dist/cli.js diff-gate --json`.
- **What**: List each analyzer family and the fields now available to review the claim.
- **Why**: AVL-007 requires family-level output verdicts, not only individual implementation notes.

### 2. Record Missing Fields And Blocked Stronger Claims

- [x] **Docs**: result files and analyzer inventory.
- **Source**: direct/contextual/score closure results.
- **What**: Record missing output for passthrough boundary evidence, locality consumer coverage, Vue behavior corpus coverage, doc intent/cited-claim precision, and root-cause grouping.
- **Why**: These gaps explain why some analyzers remain signal/support instead of direct repair.

### 3. Close AVL-007

- [x] **Files**: `docs/analyzer-validation-ledger.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`
- **Source**: `rg -n "AVL-007|output and schema|Implementation Priority|Ledger Judgments" ...`
- **What**: Mark output/schema quality complete and point to the final result.
- **Why**: This should close the validation ledger unless new analyzer families are added later.

## Verification

- Run Markdown formatting on changed docs.
- Run the standard repository verification gate after doc updates.

## Result

Completed in `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`.
