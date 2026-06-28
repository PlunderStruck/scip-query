# health --json Optimization Ledger

## Output Contract

- Target command: `scip-query health --json`
- Internal target phase: `scip-query __health-phase wrapper-candidates`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve health score, axes, finding counts, action
  summary, JSON shape, and the bounded default large-index semantics where
  default health uses the candidate scan limit and disables semantic enrichment.

## Baseline Measurements

| Case                                             | Warm timings             | stdout bytes | SHA-256                                                            |
| ------------------------------------------------ | ------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`                       | 3.338s, 3.461s           |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query __health-phase dead`                 | 2.049s, 2.017s           |           55 | `decdc3187d74e82cb158362174e58a4de3f8a490dd798571e16794f90f7a65e5` |
| `scip-query __health-phase isolated`             | 1.651s, 1.634s           |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query __health-phase wrapper-candidates`   | 2.148s, 2.124s           |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query __health-phase stale-abstractions`   | 2.092s, 2.112s           |        2,755 | `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322` |
| `scip-query __health-phase drift`                | 1.717s, 1.712s           |           98 | `7409f1c8ad7c5ae6a6ac5ae17778707e1b03f9e990a521de4376357f4a48bacd` |
| `scip-query wrapper-candidates --json --full`    | profile run, 2.590s wall |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `SCIP_QUERY_HEALTH_CONCURRENCY=10 health --json` | 2.891s, 3.003s           |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `SCIP_QUERY_HEALTH_CONCURRENCY=8 health --json`  | 3.297s, 3.294s           |       15,342 | same                                                               |
| `SCIP_QUERY_HEALTH_CONCURRENCY=6 health --json`  | 3.792s, 3.809s           |       15,342 | same                                                               |
| `SCIP_QUERY_HEALTH_CONCURRENCY=4 health --json`  | 4.865s, 4.826s           |       15,342 | same                                                               |

## Accepted Wrapper Prefilter Measurements

The accepted wrapper pass keeps the original output domain intact: fallback
caller evidence is skipped for symbols that cheap evidence already rules out,
and enclosing caller fallback is added only when that enclosing symbol was
already in the original wrapper candidate set.

| Case | Baseline | Current | stdout bytes | SHA-256 |
| --- | ---: | ---: | ---: | --- |
| `scip-query wrapper-candidates --json --full` | 2.165s | 2.147s | 78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query __health-phase wrapper-candidates` | 2.079s | 2.081s | 1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query health --json` | 2.991s | 2.890s | 15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

Current-only warm medians after the patch:

| Case | Median | Warm repeats |
| --- | ---: | --- |
| `scip-query wrapper-candidates --json --full` | 2.150s | 2.169s, 2.124s, 2.150s |
| `scip-query __health-phase wrapper-candidates` | 2.096s | 2.064s, 2.096s, 2.107s |
| `scip-query health --json` | 2.879s | 2.871s, 2.879s, 2.932s |

## Current Pipeline

- `health()` calls `withHealthRun()`, runs `runHealthAnalyses()`, and returns
  `buildHealthReport()`. Source: `scip-query plan-context health`;
  `scip-query code health -C 8`.
- The CLI health path uses `runIsolatedHealthReport()`, filters runnable
  phases, groups React and Vue phases, and runs phase tasks through
  `mapWithConcurrency()`. Source: `scip-query code runIsolatedHealthReport -C 8`;
  `scip-query code healthPhaseTasks -C 8`.
- `HEALTH_PHASES` includes overview, cleanup detectors, frontend detectors,
  git evidence, and suppressions. Source:
  `scip-query code 'src/queries/health/health.ts:53-130'`.
- Large-index default health uses `commandAnalysisBudget()`: when `--full` is
  not supplied, it applies a 2,500 candidate scan limit and disables semantic
  enrichment. Source: `scip-query code commandAnalysisBudget -C 8`.
- `wrapperCandidates()` builds production callable candidates, prepares caller
  evidence via `definitionConsumerFileMap()`, evaluates wrappers, and orders
  by caller fan-in and LOC. Source: `scip-query plan-context wrapperCandidates`;
  `scip-query code wrapperCandidates -C 8`.
- `definitionConsumerFileMap()` delegates to `ProjectIndex.callerFileMap()`,
  which composes cross-file caller evidence with optional source fallback.
  Source: `scip-query code definitionConsumerFileMap -C 8`;
  `scip-query code ProjectIndex.callerFileMap -C 8`;
  `scip-query code callerFileEvidenceMap -C 8`.

## Hypotheses

- Rejected: lower the default health concurrency. The output hash stayed the
  same, but concurrency below 10 was slower on Vega_2.0.
- Rejected for now: group all cleanup-heavy health phases in one subprocess.
  `dead,isolated,similar,extract-candidates,wrapper-candidates,passthrough-candidates,stale-abstractions,drift`
  took 5.493s-5.626s, which is slower than the current health command.
- Candidate: reuse the stale-abstractions consumer-map pruning pattern for
  wrappers. Indexed/semantic caller evidence can rule out symbols that already
  have more than one real external caller; source fallback can only add callers,
  so those symbols cannot become wrapper findings. Source:
  `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 8`;
  `scip-query code wrapperCandidateForSymbol -C 8`.
- Rejected variant: adding fallback evidence for arbitrary enclosing caller
  functions. This changed fan-in evidence for callers that were not in the
  original wrapper candidate set, which altered Vega wrapper findings.

## Decisions

- Accepted: add a wrapper-specific consumer map helper that runs source
  fallback only for candidate symbols that can still become wrapper findings.
  Hashes are unchanged for `health --json`,
  `__health-phase wrapper-candidates`, and
  `wrapper-candidates --json --full`. Runtime impact is modest on Vega_2.0
  because only 290 of 3,310 scanned wrapper symbols are pruned from source
  fallback; this is still a safe reduction in unnecessary source scanning.
