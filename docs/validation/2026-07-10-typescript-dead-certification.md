# TypeScript `dead` certification

Date: 2026-07-10

Status: **certified for precision under the repository-dead truth rule**

## Certified claim

A TypeScript `dead` finding is a conservative repository deletion candidate: the indexed compiler graph, source-reference fallback, test suite, declared package surface, framework entry conventions, interface and implemented-protocol contracts, and configured roots contain no evidence that the definition is consumed.

This certificate does not claim that every truly dead definition will be found. It does not certify other languages, other detectors, the aggregate health score, or automatic deletion without the repository's applicable checker.

## Result

| Measure                        |     Baseline | Certified rerun |
| ------------------------------ | -----------: | --------------: |
| Reviewed fixed-seed findings   |           78 |              43 |
| Valid findings                 |           25 |              43 |
| Invalid findings               |           53 |               0 |
| Observed precision             |        32.1% |          100.0% |
| 95% Wilson lower bound         |        22.7% |           91.8% |
| Repositories represented       |            4 |               4 |
| Known-positive recall fixtures |            0 |               3 |
| Classification                 | experimental |       certified |

The final detector emitted 162 total candidates across the four pinned repositories, down from 427 at baseline. The reduction removed unsupported claims rather than hiding reviewed valid findings: all 53 confirmed baseline false positives disappeared; 24 of 25 baseline-valid findings remained, and the one removed row was subsequently shown to have a test consumer.

## Pinned corpus

| Repository        | Commit                                     | Baseline candidates | Final candidates |
| ----------------- | ------------------------------------------ | ------------------: | ---------------: |
| Vega_2.0          | `3da5ec1a6b7e1d74b3ce358896262977d5f7f585` |                 140 |                1 |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` |                 238 |              144 |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` |                   3 |                1 |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` |                  46 |               16 |

## Hardening performed

- Test files remain excluded from the default candidate set, but their references now count as repository usage.
- Next.js page, layout, route, middleware, proxy, and instrumentation files are treated as framework entry boundaries.
- Declared package exports propagate through parsed re-export chains.
- Interface declarations, synthetic constructors, React class lifecycle methods, and methods on classes implementing protocols are excluded from deletion advice.
- Three positive fixtures prove that ordinary unreferenced top-level functions and class methods remain detectable.

## Reproduction

```bash
npm run build
node scripts/accuracy-calibration.mjs health-dead --sample-size 10000
node scripts/accuracy-calibration.mjs resample <full-packet.json> 25
node scripts/accuracy-calibration.mjs summarize <sample-packet.json> docs/validation/2026-07-10-typescript-dead-certification-verdicts.json
```

The generated packets live under ignored `reports/accuracy/`; the reviewed verdict overlay is committed at `docs/validation/2026-07-10-typescript-dead-certification-verdicts.json`.

## Renewal conditions

Re-run this calibration when dead-code candidate semantics, source attribution, framework roots, package-surface derivation, or the TypeScript indexer changes. A future result loses certification if observed precision falls below 95%, the Wilson lower bound falls below 90%, fewer than three repositories are represented, or the positive-recall suite no longer passes.
