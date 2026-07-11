# TypeScript Bottleneck Certification

Date: 2026-07-11

Verdict: **certified graph fact; recommendation utility remains contextual**.

## Claim under review

A bottleneck is a production callable that joins incoming and outgoing parts of
the indexed call graph. The command claims that `fanIn` is the number of
distinct files containing references to the callable, `fanOut` is the number
of distinct cross-file symbols called by it, and `score` is their product. It
does not claim that centrality alone proves a refactor would improve the code.

## Pinned evidence

The deterministic seed `typescript-bottlenecks-evidence-v2` sampled the
uncapped candidate frame at these commits:

| Repository | Commit | Frame | Reviewed |
| --- | --- | ---: | ---: |
| Vega_2.0 | `865df443039cc5074b6db29cf08d126dfe0287c2` | 251 | 15 |
| openwork | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` | 67 | 15 |
| Stable_Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` | 3 | 3 |
| traceroot | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` | 6 | 6 |

All repositories reported indexing, semantic analysis, and source facts as
available. The full frame was 327 rows; all findings in the two smaller
repositories were reviewed instead of manufacturing a larger sample.

The raw packet is
`reports/accuracy/2026-07-11T16-40-10-807Z-typescript-graph-risk-calibration.json`
(a reproducible ignored work product). The committed verdict input is
[`2026-07-11-typescript-bottlenecks-certification-verdicts.json`](./2026-07-11-typescript-bottlenecks-certification-verdicts.json).

## Independent checks

The result shape was hardened to disclose the complete deterministic
`callerFiles` and `externalCallees` sets from which its counts are derived.
That makes the public measurement reproducible instead of asking reviewers to
trust opaque totals.

For all 39 rows:

- `fanIn === callerFiles.length`;
- `fanOut === externalCallees.length`;
- `score === fanIn * fanOut`;
- every one of the 272 distinct source files existed at its pinned commit;
- the target name occurred in all 140 disclosed caller files; and
- the disclosed callee name occurred in all 259 callee source files.

The observed graph-fact precision is 39/39. Its two-sided 95% Wilson lower
bound is 91.0%, above the 90% certification floor, and findings span four
repositories. Existing focused fixtures provide a known-positive case and
preserve distinct-file, distinct-symbol, cross-file, and scoring behavior.

## Defect and replay outcome

The earlier output exposed only counts. Public `refs` and `callgraph` commands
apply their own evidence filters and limits, so they were not an exact oracle
for those hidden sets. This was an auditability defect: the number could be
used but could not be independently reconstructed from the result.

`BottleneckResult` now includes the sorted caller-file and external-callee
sets, derives both counts from them, and retains the existing score and risk
classification. This is an additive public result change. The replay produced
zero length, score, missing-file, caller-name, or callee-name mismatches.

No factual false-positive archetype appeared in the reviewed sample. The
remaining risk is recommendation utility: generated code, tests, framework
boundaries, and deliberately central coordinators may be valid central nodes.
The command therefore remains a review signal, not an automatic cleanup rule.
