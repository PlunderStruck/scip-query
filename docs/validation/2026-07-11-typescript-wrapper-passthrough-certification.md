# TypeScript Wrapper and Passthrough Certification

Date: 2026-07-11
Status: Both relationships certified; removal utility remains contextual

## Result

`wrapper-candidates` and `passthrough-candidates` now satisfy the certified
relationship threshold. A wrapper relationship identifies a short production
callable with one production caller after explicit test, entry, and barrel
exclusions. A passthrough relationship identifies a callable whose body does
nothing except forward its parameters to one callee. Neither relationship by
itself proves that removing the layer improves the design.

| Detector                 | Uncapped frame | Reviewed | Repositories | Valid | 95% lower bound | Verdict                |
| ------------------------ | -------------: | -------: | -----------: | ----: | --------------: | ---------------------- |
| `wrapper-candidates`     |            222 |       60 |            3 | 60/60 |           94.0% | certified relationship |
| `passthrough-candidates` |            144 |       41 |            3 | 41/41 |           91.4% | certified relationship |

The uncapped frames came from Vega_2.0, openwork, Stable_Management, and
traceroot. Traceroot contributed no wrapper rows and one passthrough row;
supported zeros were retained rather than treated as failures.

## Corpus

- Vega_2.0 `5065da485e0b134c0239b5ea864d8ed117b857c8`
- openwork `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e`
- Stable_Management `bd221c3fa61034b4e52734f15ce6ef0b285ec78e`
- traceroot `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9`

Raw packet:
`reports/accuracy/2026-07-11T16-06-53-094Z-typescript-architecture-calibration.json`.
Deterministic 20-per-repository resample:
`reports/accuracy/2026-07-11T16-10-03-113Z-typescript-typescript-architecture-resampled.json`.
Reviewed packet:
`reports/accuracy/2026-07-11T16-19-31-329Z-typescript-typescript-architecture-reviewed.json`.
These generated artifacts remain ignored; the committed verdict input is
[`2026-07-11-typescript-wrapper-passthrough-expansion-verdicts.json`](./2026-07-11-typescript-wrapper-passthrough-expansion-verdicts.json).

## Independent Checks

The 60 wrapper rows received 180 independent command-level checks against
fresh detached indexes:

1. `refs --full` established exactly one production caller after the documented
   exclusions.
2. The reported enclosing caller resolved to that same file.
3. The disclosed caller fan-in remained a positive graph measurement using the
   detector's function-level or source-fallback file-level basis.

The first oracle draft counted test files and reported 27 mismatches. Source
inspection showed that the detector deliberately excludes test, entry, and
barrel callers. The calibration truth rule was corrected to name that
production-call contract. The aligned unbounded oracle then produced zero
mismatches.

All 41 passthrough rows were reviewed from both cited source endpoints. Every
candidate body literally forwarded its parameters through one call or return.
The sample included methods, API facades, framework route handlers, capability
boundaries, normalizers, and private helpers.

## Utility Boundary

All recommendation verdicts remain uncertain. Many exact wrappers and
passthroughs preserve public names, framework handler conventions, lifecycle
boundaries, normalization vocabulary, or test seams. Certification permits the
relationship to be published as evidence; it does not permit automatic
inlining or deletion language.
