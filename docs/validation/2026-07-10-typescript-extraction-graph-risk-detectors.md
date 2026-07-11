# TypeScript Extraction and Graph-Risk Detector Certification

Date: 2026-07-10
Status: Complete

## Scope

This campaign audited `extract-candidates`, `locality-candidates`, `coupling`,
`bottlenecks`, `deep-chains`, `complexity-hotspots`, `hotspots`, `fan-in`, and
`fan-out` against Vega 2.0, openwork, Stable Management, and traceroot.

A graph-risk measurement is a compiler-indexed count, path, or ownership
relationship. Its defining characteristic is that it describes how code is
connected without proving that the connection should be changed. The audit
therefore classified measurement truth separately from recommendation utility.

## Method

- Each repository was read from a detached worktree at a recorded commit and
  reindexed for TypeScript into a disposable cache.
- Production analyzers ran without a result cap. The resulting 69,942-row
  candidate frame was counted in full.
- Review samples were deterministic and stratified by detector subtype or
  low/medium/high magnitude. They were not presented as exhaustive review.
- The final 417 sampled rows were checked against exact symbol identities,
  source endpoints, ownership and component structure, count arithmetic, and
  score formulas. All detector-specific invariants reconciled.
- Known-positive fixtures cover each command. Wilson 95% intervals are reported
  on measurement precision, not recommendation actionability or exhaustive
  recall.

## Repository Frames

| Repository        | Commit                                     | Extract |  Locality |   Coupling | Bottlenecks | Deep chains | Complexity |   Hotspots |     Fan-in |   Fan-out |
| ----------------- | ------------------------------------------ | ------: | --------: | ---------: | ----------: | ----------: | ---------: | ---------: | ---------: | --------: |
| Vega 2.0          | `833c0d00370015f18ac14d9307910d46f9651845` |     241 |     1,536 |      7,676 |         244 |         887 |      6,036 |     14,188 |      7,061 |     1,764 |
| openwork          | `1bc2b18ef426c4751a6d8c16fbbf8023f5da9f6e` |     163 |       757 |      2,462 |          67 |         415 |      2,864 |      3,716 |      1,477 |       721 |
| Stable Management | `bd221c3fa61034b4e52734f15ce6ef0b285ec78e` |     115 |     1,038 |      2,510 |           3 |         779 |      2,096 |      5,356 |      2,191 |       748 |
| traceroot         | `c41ac2bb3801fc2ce882ea3bacba9b0c4c5afeb9` |       7 |       244 |        381 |           6 |         175 |        472 |      1,022 |        312 |       212 |
| **Total**         | —                                          | **526** | **3,575** | **13,029** |     **320** |   **2,256** | **11,468** | **24,282** | **11,041** | **3,445** |

## Hardening Results

### Exact fan-in identity

The initial packet found 24 rows in openwork, Stable Management, and traceroot
whose shortened display names referred to multiple exact SCIP symbols. The
counts belonged to real definitions, but the public row did not identify which
definition it counted.

`fanIn()` and `topFanIn()` now return the exact SCIP `symbol` and `definedIn`
path. Human-readable top-mode output appends the definition path when a
shortened name collides. The final packet independently reconciled all 11,041
production rows with a detailed indexed query; the full identity multisets
matched in all four repositories.

### Condensed deep-chain depth

`deep-chains` previously weighted a dependency cycle by its member count and
printed alphabetically ordered cycle members as sequential chain steps. A
cycle is one strongly connected dependency component, so that behavior could
inflate depth and imply unproven direct edges.

Depth now counts condensed components once. Each result exposes canonical
representatives in `chain`, complete membership in `components`, and the total
represented `fileCount`. Human output renders a multi-file component as a
cycle. A final openwork sample contained a nine-file cycle: it is now reported
as one component in a five-component path representing 13 files, instead of a
13-step dependency depth.

### Magnitude-stratified review

Graph detectors now stratify calibration samples by low, medium, and high
magnitude where applicable. This prevents a large low-count population from
hiding the high-centrality, high-depth, or high-complexity rows for which
recommendation utility matters most.

## Certification Verdicts

| Detector              | Reviewed | Valid | Precision | Wilson lower | Verdict   |
| --------------------- | -------: | ----: | --------: | -----------: | --------- |
| `extract-candidates`  |       43 |    43 |      100% |        91.8% | certified |
| `locality-candidates` |       48 |    48 |      100% |        92.6% | certified |
| `coupling`            |       48 |    48 |      100% |        92.6% | certified |
| `bottlenecks`         |       33 |    33 |      100% |        89.6% | qualified |
| `deep-chains`         |       48 |    48 |      100% |        92.6% | certified |
| `complexity-hotspots` |       48 |    48 |      100% |        92.6% | certified |
| `hotspots`            |       48 |    48 |      100% |        92.6% | certified |
| `fan-in`              |       48 |    48 |      100% |        92.6% | certified |
| `fan-out`             |       48 |    48 |      100% |        92.6% | certified |

`bottlenecks` remains qualified rather than certified because only nine total
candidates existed across Stable Management and traceroot. Its 33/33 valid
sample has a conservative lower confidence bound just below 90%; the verdict
is not upgraded merely because the point estimate is perfect.

## Recommendation Utility

- Extraction, locality, coupling, bottleneck, and deep-chain rows are
  investigative signals. Their sampled structural facts were valid, but none
  independently justified a code change without a concept name, ownership
  decision, boundary intent, and behavioral evidence.
- Complexity hotspots, hotspots, fan-in, and fan-out emit measurements and
  rankings rather than direct repairs. Recommendation actionability is not
  applicable to those rows.
- These distinctions are part of the public credibility contract: certified
  measurement does not mean “automatically fix every row.”

## Performance Observation

The exhaustive Vega bottleneck frame dominated the final calibration at about
220 seconds because it gathers semantic incoming and outgoing relationships
for every production callable. This is an accuracy certification result, not a
new runtime target; the command remains correct but is a candidate for a later
work-elimination pass.

## Evidence Files

- Execution plan:
  [`2026-07-10-typescript-extraction-graph-risk-certification.md`](../plans/2026-07-10-typescript-extraction-graph-risk-certification.md)
- Committed verdict overlay:
  [`2026-07-10-typescript-extraction-graph-risk-certification-verdicts.json`](./2026-07-10-typescript-extraction-graph-risk-certification-verdicts.json)
- Generated final packet:
  `reports/accuracy/2026-07-11T05-22-33-831Z-typescript-graph-risk-calibration.json`
- Generated reviewed report:
  `reports/accuracy/2026-07-11T05-31-18-000Z-typescript-typescript-graph-risk-reviewed.json`

Generated packets remain ignored because they contain large reproducible source
excerpts. The dated certificate and verdict overlay are the committed record.
