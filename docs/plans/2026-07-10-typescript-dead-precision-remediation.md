# TypeScript dead-code precision remediation

Date: 2026-07-10

## Objective

Raise the TypeScript `dead` detector from the measured 25/78 valid baseline by removing the five observed false-positive classes without weakening the meaning of a reported result.

Within this detector, **dead code** means a repository definition for which the available compiler graph, source scan, declared package surface, framework entry conventions, test suite, and language contract provide no evidence of a consumer. It is a conservative deletion candidate, not merely code unused by the production build.

## Evidence

- Baseline: `docs/validation/2026-07-10-typescript-dead-certification-baseline.md`
- Reviewed verdicts: `docs/validation/2026-07-10-typescript-dead-calibration-verdicts.json`
- Calibration packet: ignored local report `reports/accuracy/2026-07-10T22-27-14-877Z-typescript-dead-calibration.json`
- Change surface: `scip-query plan-context src/queries/cleanup/dead.ts --json` reports 12 external consumers and medium risk.

Measured false positives:

| Class                       | Count | Required correction                                                                                               |
| --------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------- |
| Test-only consumer excluded |    26 | Keep test files out of the candidate set by default, but always count their references to production definitions. |
| Framework file entrypoint   |    20 | Treat framework-owned route/page/layout/middleware files as external entry surfaces.                              |
| Declared package surface    |     5 | Propagate public reachability through JavaScript/TypeScript re-export chains.                                     |
| Interface contract member   |     1 | Reject declaration-only callable members as deletion candidates.                                                  |
| Implicit constructor        |     1 | Reject synthetic constructor symbols because construction invokes them without a textual call to the member.      |

## Implementation slices

### 1. Repository-wide consumer semantics

- [x] Decouple test candidate inclusion from test reference inclusion.
- [x] Add a regression proving a production symbol used only by a test is not reported.
- [x] Preserve `--include-tests` as the switch controlling whether definitions inside test files can themselves be candidates.

### 2. External entry surfaces

- [x] Recognize framework-owned Next.js and middleware paths at the file boundary.
- [x] Compute package-surface reachability through parsed re-export statements.
- [x] Add path and transitive package-surface regression tests.

### 3. Language contract exclusions

- [x] Reject declaration-only TypeScript/JavaScript callable members.
- [x] Reject synthetic `<constructor>` definitions.
- [x] Reject React lifecycle and implemented-protocol members discovered by the replacement sample.
- [x] Add focused candidate-gate and end-to-end dead-output tests.

### 4. Measurement and release gate

- [x] Run focused tests, typecheck, and build.
- [x] Re-run the same four pinned repositories with the same seed and sample size.
- [x] Review every new sampled finding and compare the Wilson interval with the baseline.
- [x] Update the certification baseline and accuracy roadmap with the measured result.
- [x] Run command-doc generation, `scip-query reindex`, and `scip-query diff-gate`; accept the descriptor/handler broad-sweep co-change signal because only help text changed.

## Acceptance criteria

1. All 53 previously observed false positives are absent when the same commits are re-analyzed, unless a case is explicitly reclassified with evidence.
2. The original 25 valid findings remain eligible unless a new verified consumer is discovered.
3. `dead` no longer uses “production-unreferenced” as a synonym for “repository-dead.”
4. Certification remains withheld until a reviewed sample reaches at least 95% observed precision, at least 90% Wilson lower bound, three repositories, and a non-zero known-positive recall suite.
