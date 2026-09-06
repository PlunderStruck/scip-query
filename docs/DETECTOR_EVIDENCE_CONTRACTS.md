# Detector evidence contracts

Generated from `DETECTOR_EVIDENCE_CONTRACTS`.

## dead

The symbol has no visible repository reference after entry, framework, and rooted-symbol exclusions.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `identity/references` (exact), `execution/call` (exact).
- Structural evidence: entry-surface exclusions; framework/source fallback references; rooted-symbol exclusions.
- Does not establish: Absence of visible references does not prove absence of reflection, generated dispatch, or external use.
- Recover with: `scip-query evidence --symbol <symbol> --edge execution --edge runtime --edge identity --direction both --depth 2 --max-edges 100`

## passthrough-candidates

A small callable visibly forwards to one callee, with public-facade and boundary signals disclosed.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `execution/call` (exact), `contract/uses-contract-symbol` (exact).
- Structural evidence: statement-complete forwarding shape; public facade evidence; runtime-boundary signals.
- Does not establish: Literal forwarding does not prove the callable has no contract, naming, policy, or compatibility role.
- Recover with: `scip-query inspect --symbol <symbol> --view behavior`

## decorative-checkers

A checker-shaped callable lacks a visible failure terminal directly or through one resolved delegate.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `execution/returns` (exact), `execution/throws` (exact).
- Structural evidence: checker naming shape; direct terminal behavior; one-hop delegate body.
- Does not establish: No visible terminal does not prove the checker cannot fail through an opaque call, exception, or process exit.
- Recover with: `scip-query inspect --symbol <symbol> --view behavior`

## duplicate and similarity detectors

Two source units share the detector-specific structural or token pattern.

- Calibration: `candidate`; provider coverage: `partial`.
- Relations: none; structural detector.
- Structural evidence: normalized source/token/JSX/template similarity.
- Does not establish: Structural similarity does not establish shared domain identity or justify consolidation.
- Recover with: `scip-query inspect --symbol <symbol-a> --symbol <symbol-b> --view behavior`

