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

## Accepted Source-Reexports Cache Measurements

CPU profiling of warm `wrapper-candidates --json --full` showed 158
`tree-sitter` parses under JavaScript re-export parsing. `source-imports` and
`source-facts` were already persisted in Vega's evidence database, but
`getReExports()` only had an in-process cache, so every fresh health subprocess
reparsed the same barrel files.

The accepted pass persists `source-reexports` rows by file content hash plus
the same import-resolution fingerprint used by `source-imports`. The first
patched wrapper run populated the new cache in 2.916s and preserved the
78,437-byte output hash. A follow-up parse hook on warm `wrapper-candidates`
reported zero `tree-sitter` parse calls.

| Case | Baseline median | Current median | Warm repeats | stdout bytes | SHA-256 |
| --- | ---: | ---: | --- | ---: | --- |
| `scip-query wrapper-candidates --json --full` | 2.236s | 1.608s | 1.608s, 1.598s, 1.616s | 78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full` | 2.202s | 1.527s | 1.542s, 1.527s, 1.520s | 83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query health --json` | 2.903s | 2.512s | 2.597s, 2.500s, 2.512s | 15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full` | 2.959s | 2.530s | 2.512s, 2.586s, 2.530s | 15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query diff-gate --json` | 2.711s | 2.763s | 3.676s, 2.763s, 2.718s | 3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

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
- `isReExportOnlyConsumer()` calls `getReExports()` while filtering barrel-only
  consumers for wrapper and stale-abstraction evidence. Source:
  `scip-query code getReExports -C 8`;
  `scip-query code isReExportOnlyConsumer -C 8`.

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
- Accepted: persist JavaScript/TypeScript re-export parse results. The output
  contract is unchanged because the payload is keyed by source content and
  import-resolution fingerprint; corrupt or stale rows fall back to the parser.

## Decisions

- Accepted: add a wrapper-specific consumer map helper that runs source
  fallback only for candidate symbols that can still become wrapper findings.
  Hashes are unchanged for `health --json`,
  `__health-phase wrapper-candidates`, and
  `wrapper-candidates --json --full`. Runtime impact is modest on Vega_2.0
  because only 290 of 3,310 scanned wrapper symbols are pruned from source
  fallback; this is still a safe reduction in unnecessary source scanning.
- Accepted: add `source-reexports` file evidence and route `getReExports()`
  through it. This removes repeated warm tree-sitter re-export parsing across
  fresh CLI processes and materially improves wrapper, stale, and composite
  health timings with byte-identical Vega outputs.
