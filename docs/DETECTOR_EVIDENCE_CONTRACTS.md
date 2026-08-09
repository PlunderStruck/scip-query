# Detector evidence contracts

Generated from `DETECTOR_EVIDENCE_CONTRACTS`.

## dead

The symbol has no visible repository reference after entry, framework, and rooted-symbol exclusions.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `identity/references` (exact), `execution/call` (exact).
- Structural evidence: entry-surface exclusions; framework/source fallback references; rooted-symbol exclusions.
- Does not establish: Absence of visible references does not prove absence of reflection, generated dispatch, or external use.
- Recover with: `scip-query evidence --symbol <symbol> --edge execution --edge runtime --edge identity --direction both --depth 2 --max-edges 100`

## isolated

The callable has no visible non-self caller or callee after entry, framework, and rooted-symbol exclusions.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `execution/call` (exact), `identity/references` (exact).
- Structural evidence: entry-surface exclusions; framework contract exclusions; source fallback callers.
- Does not establish: Visible graph isolation does not establish runtime unreachability through reflection or generated dispatch.
- Recover with: `scip-query evidence --symbol <symbol> --edge execution --edge runtime --edge identity --direction both --depth 2 --max-edges 100`

## wrapper-candidates

A small callable has one visible consumer and wrapper-shaped delegation, after boundary evidence is disclosed.

- Calibration: `candidate`; provider coverage: `partial`.
- Relations: `execution/call` (exact), `ownership/contains` (exact).
- Structural evidence: callable body shape; public and runtime-boundary signals; consumer fan-in.
- Does not establish: Wrapper shape does not prove that an API, ownership, observability, or compatibility boundary is unnecessary.
- Recover with: `scip-query inspect --symbol <symbol> --view behavior`

## passthrough-candidates

A small callable visibly forwards to one callee, with public-facade and boundary signals disclosed.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `execution/call` (exact), `contract/uses-contract-symbol` (exact).
- Structural evidence: statement-complete forwarding shape; public facade evidence; runtime-boundary signals.
- Does not establish: Literal forwarding does not prove the callable has no contract, naming, policy, or compatibility role.
- Recover with: `scip-query inspect --symbol <symbol> --view behavior`

## stale-abstractions

A type-like abstraction has zero or one visible real consumer after re-export and ownership distinctions.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `identity/references` (exact), `ownership/contains` (exact).
- Structural evidence: definition kind; barrel-only consumer distinction; defining-file usage.
- Does not establish: Low visible consumer count does not prove a public contract or runtime-registered type is obsolete.
- Recover with: `scip-query evidence --symbol <symbol> --edge identity --edge ownership --edge contract --direction both --depth 2 --max-edges 100`

## complexity-hotspots

A callable concentrates local branch/control pressure and graph fan-in or fan-out.

- Calibration: `mixed`; provider coverage: `partial`.
- Relations: `execution/predicate-consequence` (exact), `execution/call` (exact).
- Structural evidence: AST branch count or disclosed regex fallback; call fan-in; callee count.
- Does not establish: Structural complexity does not establish runtime frequency, latency, defect density, or a required refactor.
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

