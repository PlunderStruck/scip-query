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

| Case                                           | Baseline | Current | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | -------: | ------: | -----------: | ------------------------------------------------------------------ |
| `scip-query wrapper-candidates --json --full`  |   2.165s |  2.147s |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query __health-phase wrapper-candidates` |   2.079s |  2.081s |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query health --json`                     |   2.991s |  2.890s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

Current-only warm medians after the patch:

| Case                                           | Median | Warm repeats           |
| ---------------------------------------------- | -----: | ---------------------- |
| `scip-query wrapper-candidates --json --full`  | 2.150s | 2.169s, 2.124s, 2.150s |
| `scip-query __health-phase wrapper-candidates` | 2.096s | 2.064s, 2.096s, 2.107s |
| `scip-query health --json`                     | 2.879s | 2.871s, 2.879s, 2.932s |

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

| Case                                          | Baseline median | Current median | Warm repeats           | stdout bytes | SHA-256                                                            |
| --------------------------------------------- | --------------: | -------------: | ---------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query wrapper-candidates --json --full` |          2.236s |         1.608s | 1.608s, 1.598s, 1.616s |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full` |          2.202s |         1.527s | 1.542s, 1.527s, 1.520s |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query health --json`                    |          2.903s |         2.512s | 2.597s, 2.500s, 2.512s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`             |          2.959s |         2.530s | 2.512s, 2.586s, 2.530s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query diff-gate --json`                 |          2.711s |         2.763s | 3.676s, 2.763s, 2.718s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

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
- Accepted: let health and baseline skip advisory-only drift pattern deviations.
  Public `drift` still emits those rows, but both health and the baseline ratchet
  already discard them, so computing 903 Vega pattern-deviation rows in those
  paths is avoidable work.
- Rejected: bulk-load the definition catalog for `getScopedDefinitions()`.
  A Vega stage profile for `isolated` showed `productionCallableDefinitions`
  at 0.971s before the probe and 1.614s after the batched SQL candidate; the
  source change was reverted.
- Rejected for now: small cleanup phase grouping. The best small groups were
  `dead,isolated` at 1.968s and `isolated,wrapper-candidates` at 1.960s, but
  they serialize enough work to lose the current parallel health schedule.
- Accepted below: group only cheap/non-critical health tasks that would otherwise
  spill into a second scheduler wave on high-parallelism hosts. The target is
  task-count shape, not sharing broad cleanup detector state.
- Accepted: compute the `overview` health phase in the parent process while the
  parent already has the database open for phase applicability. The overview
  phase is cheap, but spawning a separate CLI process for it still pays process
  startup and database-open cost.
- Rejected: priority-sort health subprocess tasks by broad-scan cost. On
  Vega_2.0 it only moved `health --json` from 2.487s to 2.457s while moving
  `health --json --full` from 2.445s to 2.464s. Explicit concurrency probes on
  that shape were worse at 11, 12, and 14 workers, so the scheduler experiment
  was reverted.
- Candidate accepted below: make drift's source-reference fallback
  candidate-first. SCIP reference edges and existing semantic/source import
  gates can prove most dependency edges are not unused-import findings before
  the expensive source reference scan runs.

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
- Accepted: add `includePatternDeviations` to `drift()` and pass `false` from
  health and health-baseline. This preserves the public `drift` default while
  skipping rows that the health report and baseline identities never expose.
- Accepted: run the `overview` health phase in `runIsolatedHealthReport()`
  before scheduling subprocess phases. This keeps phase aggregation and skipped
  phase semantics unchanged while removing one child process from every health
  command.
- Accepted: in `drift()`, build SCIP symbol-reference edges first, apply the
  conservative semantic/source/type-only/side-effect/Vue skip gates, and only
  then source-scan files that still have possible unused-import findings. This
  preserves public drift output while avoiding a whole-project source-reference
  scan when cheaper evidence has already ruled out most edges.
- Accepted: persist source-corrected per-file definition catalogs as
  `file-definitions` evidence, guarded by source content hash and
  `projectEvidenceFingerprint()`. Corrupt payloads, missing fingerprints, or
  mismatched project fingerprints fall back to the authoritative SCIP row merge
  and source range correction path.
- Accepted: raise the adaptive default health phase concurrency ceiling from 10
  to 12. Vega has enough parallelism to run two more independent health phase
  subprocesses without changing output, and measured concurrency above 12 was
  flat/noisy rather than clearly faster.
- Accepted: pack `similar` with `extract-candidates` and Vue health phases with
  `suppressions`. On Vega this moves the runnable health task count from 14 to
  12, so every task starts in the first default-concurrency wave. It preserves
  phase payloads and aggregation order because each grouped subprocess still
  returns the same per-phase JSON records.

## Post Health Drift Pattern-Deviation Skip

Focused rerun with the local built CLI after health and baseline stopped
computing advisory drift rows that they immediately hide. Vega public
`drift --json` still emits 725,970 bytes with SHA-256
`a7754846099d3424020aa3a26764fec84698dc3f5cfdb1c861c30228d1366462`.

| Case                                           | Baseline median | Current median | Warm repeats                           | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | --------------: | -------------: | -------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query __health-phase drift`              |          1.767s |         1.745s | 1.769s, 1.770s, 1.745s, 1.726s, 1.733s |           98 | `7409f1c8ad7c5ae6a6ac5ae17778707e1b03f9e990a521de4376357f4a48bacd` |
| `scip-query health --json`                     |          2.733s |         2.530s | 2.552s, 2.533s, 2.530s, 2.521s, 2.518s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`              |          2.512s |         2.550s | 2.522s, 3.056s, 2.550s, 2.559s, 2.536s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query __health-phase isolated`           |          1.640s |         1.694s | 1.717s, 1.693s, 1.694s                 |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query __health-phase wrapper-candidates` |          1.582s |         1.646s | 1.694s, 1.646s, 1.633s                 |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query __health-phase stale-abstractions` |          1.549s |         1.598s | 1.581s, 1.598s, 1.599s                 |        2,755 | `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322` |

The accepted change is intentionally small: it removes no public findings and
keeps both health hashes unchanged. The next health pass should target the
shared definition/source-facts setup cost or a different orchestration model,
but the measured bulk catalog and small phase-grouping variants above should
stay rejected unless new evidence changes the tradeoff.

## Post Parent Overview Scheduling

Focused rerun with the local built CLI after `runIsolatedHealthReport()`
computed `overview` in the parent process while it already had the database open
for phase applicability. The change removes one health subprocess and preserves
the byte-identical JSON contracts.

| Case                              | Baseline median | Current median | Warm repeats                                           | stdout bytes | SHA-256                                                            |
| --------------------------------- | --------------: | -------------: | ------------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`        |          2.608s |         2.442s | 2.674s, 2.442s, 2.518s, 2.391s, 2.408s, 2.432s, 2.543s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full` |          2.550s |         2.432s | 2.438s, 2.420s, 2.413s, 2.553s, 2.432s                 |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

The standard health path improved by 166ms versus the same-session pre-patch
median and kept the exact same 15,342-byte payload hash. Full health also moved
below the previous focused 2.55s median while preserving its 15,360-byte hash.

## Post Candidate-First Drift Source Scan

Focused rerun with the local built CLI after `drift()` stopped building
source-scanned symbol-reference edges for every indexed file up front. The new
flow builds SCIP reference edges first, filters dependency edges through the
same conservative skip gates that already existed, and source-scans only files
that can still become unused-import findings.

| Case                                     |        Baseline median | Current median | Warm repeats                                           | stdout bytes | SHA-256                                                            |
| ---------------------------------------- | ---------------------: | -------------: | ------------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query __health-phase drift --full` |                 1.709s |         0.723s | 1.154s, 0.730s, 0.729s, 0.706s, 0.723s, 0.714s, 0.712s |           98 | `7409f1c8ad7c5ae6a6ac5ae17778707e1b03f9e990a521de4376357f4a48bacd` |
| `scip-query drift --json`                | 1.7s phase-family band |         0.723s | 0.726s, 0.728s, 0.723s, 0.715s, 0.719s                 |      725,970 | `a7754846099d3424020aa3a26764fec84698dc3f5cfdb1c861c30228d1366462` |
| `scip-query health --json`               |                 2.487s |         2.384s | 2.375s, 2.384s, 2.428s, 2.377s, 2.368s, 2.423s, 2.392s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`        |                 2.445s |         2.455s | 2.455s, 2.378s, 2.576s, 2.466s, 2.403s                 |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

The standalone drift phase drops by 986ms with the exact same 98-byte health
phase payload. Public `drift --json` keeps the same 725,970-byte result hash and
now runs in the same 0.72s band. Aggregate health is only modestly better
because isolated, wrapper, stale, dead, complexity, and git-evidence phases now
dominate the subprocess schedule.

## Post Scoped Callable-Row Loading

Focused rerun with the local built CLI after `productionCallableDefinitions()`
kept the original all-definition catalog path for function-like health
detectors, added per-file entry/test role caches in the final filter, and used a
direct merged primary/fallback row loader only for `requireCallableSymbol`
callers. The direct loader materializes the same source-corrected
`requireCallableSymbol` candidate set as the old all-definition filter on
Vega_2.0: 6,442 candidates, identical ordered symbol IDs, and no range
mismatches.

| Case                                           | Previous focused median | Current median | Warm repeats           | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | ----------------------: | -------------: | ---------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query __health-phase isolated --full`    |                  1.694s |         1.672s | 2.391s, 1.627s, 1.672s |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query isolated --json --full`            |                  1.857s |         1.744s | 1.750s, 1.744s, 1.734s |          130 | `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702` |
| `scip-query health --json --full`              |                  2.455s |         2.326s | 2.341s, 2.294s, 2.326s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query health --json`                     |                  2.384s |         2.329s | 2.400s, 2.309s, 2.329s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query wrapper-candidates --json --full`  |                  1.608s |         1.689s | 1.744s, 1.689s, 1.684s |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full`  |                  1.527s |         1.672s | 1.672s, 1.610s, 1.677s |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query complexity-hotspots --json --full` |                  1.603s |         1.528s | 1.528s, 1.499s, 1.533s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |

Rejected variants from this pass:

| Probe                                                                          |                                                                        Result | Decision                                                                  |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------: | ------------------------------------------------------------------------- |
| Preselect files with callable-shaped symbols, then load full per-file catalogs | `health --json --full` moved to 2.637s and `isolated --json --full` to 2.034s | Rejected; extra query cost did not repay the smaller file set             |
| Use direct merged row loading for every callable mode                          |          `health --json --full` moved to 2.580s and `health --json` to 2.524s | Rejected for health slowdown despite a `complexity-hotspots` win          |
| Include `bottlenecks --json --full` in the same timed sweep                    |                                          Still running after multiple minutes | Stopped; not used as evidence for this scoped production-callables change |

The accepted scoped version preserves the target health hashes and improves the
current focused health medians while keeping the `requireCallableSymbol` fast
path available for complexity-style scans. The next pass should target the
remaining isolated graph checks or the long-running `bottlenecks --json --full`
path separately.

## Post Persistent Definition Cache

Focused rerun with the local built CLI after `getDefinitionsForFile()` started
serving source-corrected definition catalogs from `file-definitions` evidence
when the source hash and project evidence fingerprint match. Vega started with
0 rows for this evidence kind; the first `isolated --json --full` run populated
1,779 rows in 2.726s.

| Case                                                      | Previous focused/current baseline |  Current warm | Warm repeats                          | stdout bytes | SHA-256                                                            |
| --------------------------------------------------------- | --------------------------------: | ------------: | ------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `productionCallableDefinitions()` stage inside `isolated` |                            0.922s |        0.400s | stage probe                           |          n/a | n/a                                                                |
| `scip-query isolated --json --full`                       |                            1.744s |        1.306s | 1.314s, 1.306s                        |          130 | `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702` |
| `scip-query __health-phase isolated`                      |      1.580s same-session baseline |        1.162s | single phase rerun                    |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query __health-phase wrapper-candidates`            |      1.570s same-session baseline |        1.178s | single phase rerun                    |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query __health-phase stale-abstractions`            |      1.547s same-session baseline |        1.110s | single phase rerun                    |        2,755 | `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322` |
| `scip-query health --json`                                |           2.329s previous focused | 2.131s-2.251s | 2.184s, 2.131s, 2.186s, matrix 2.251s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`                         |           2.326s previous focused | 2.145s-2.358s | 2.221s, matrix 2.145s, 2.358s         |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

Cross-command warm matrix after the cache also moved definition-heavy commands:
`dead --json --full` 1.513s, `recent-duplicates --json --full` 1.480s,
`wrapper-candidates --json --full` 1.206s, `stale-abstractions --json --full`
1.142s, and `similar --json --full` 0.939s. All hash probes listed above kept
their previous byte-identical outputs. `diff-gate --json` had one matrix
outlier at 2.644s, then repeated at 1.651s, 1.548s, and 1.503s with the same
3,089-byte SHA-256
`4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.

## Rejected Shared Phase Cache Probe

Focused rerun with the local built CLI after a temporary `runHealthAnalyses()`
change mirrored `healthPhases()` by passing
`releaseCachesBetweenPhases: false` to every phase runner. The hypothesis was
that composite health was losing time by clearing pure per-DB evidence caches
between phases. Output hashes stayed stable, but the warm timing band did not
improve, so the code change was reverted.

| Command                           | Baseline warm band | Probe warm band                                  | stdout bytes | SHA-256                                                            | Decision                       |
| --------------------------------- | -----------------: | ------------------------------------------------ | -----------: | ------------------------------------------------------------------ | ------------------------------ |
| `scip-query health --json`        |      2.120s-2.161s | 2.187s-2.139s-2.151s-2.165s after 2.510s outlier |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` | Rejected; no measurable win    |
| `scip-query health --json --full` |      2.095s-2.198s | 2.115s-2.155s-2.184s-2.156s-2.128s               |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` | Rejected; neutral within noise |

Current repeat matrix from the same session, after reverting the probe, keeps
the next-target ordering: `diff-gate --json` 1.552s-1.594s after one 2.559s
outlier, `dead --json --full` 1.556s-1.612s,
`complexity-hotspots --json --full` 1.498s-1.543s, and
`recent-duplicates --json --full` 1.495s-1.523s. All hashes matched their
previous values.

## Post Dead Bulk Caller Files

Focused rerun with the local built CLI after `dead()` stopped resolving
per-symbol caller rows for the large-candidate path. The accepted change keeps
the existing small-repo caller facade, but when the command is already using the
bulk semantic caller condition it now reads caller files through the batched
`mentionReferenceChunkRows()` storage primitive and records only the file-level
cross-file liveness evidence that `DeadSummary` can observe.

Direct Vega query timing before the change showed that `dead()` analysis took
1.259s-1.335s while JSON projection and stringify took only 0ms-3ms, so
serialization was not the bottleneck. The exact CLI output stayed stable after
the change.

| Command                         | Previous warm band | Current warm band                                 | stdout bytes | SHA-256                                                            | Decision |
| ------------------------------- | -----------------: | ------------------------------------------------- | -----------: | ------------------------------------------------------------------ | -------- |
| `scip-query dead --json --full` |      1.515s-1.531s | 1.119s-1.139s after 1.819s outlier; matrix 1.132s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` | Accepted |

Neighbor checks kept their hashes: `health --json` stayed at SHA-256
`edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`,
`health --json --full` stayed at
`04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff`, and
`diff-gate --json` stayed at
`4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.

Local `scip-query diff-gate` reported only eight support-tier
`doc-reference` findings where README, benchmark, and historical validation
documents cite `src/queries/cleanup/dead.ts` as a configuration-example path.
The path target remains intentional; `scip-query diff-gate --skip
doc-reference` passed with zero code or behavioral findings.

## Post Health Concurrency Ceiling

Focused rerun with the rebuilt local CLI after raising
`MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY` from 10 to 12. The health phase scheduler
still keeps the CPU-aware default, item-count cap, and explicit
`SCIP_QUERY_HEALTH_CONCURRENCY` override behavior; only high-parallelism hosts
that were previously capped at 10 get the higher default.

The pre-change focused warm band in this same Vega session was
2.252s-2.325s for `health --json` and `health --json --full`. Explicit
concurrency probes preserved the `health --json` output hash at every tested
concurrency from 1 through 20. The clearest conservative win was cap 12:
1.897s and 1.962s with the same 15,342-byte SHA-256 output.

| Case                              | Previous warm band | Current warm repeats   | stdout bytes | SHA-256                                                            |
| --------------------------------- | -----------------: | ---------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`        |      2.252s-2.325s | 2.116s, 1.933s, 1.949s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full` |      2.256s-2.325s | 1.938s, 1.916s, 1.925s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

This is an orchestration speedup: a health phase is an independently computed
section of the aggregate health report, and the changed ceiling lets two more
ready sections run concurrently on machines with enough CPU capacity. It does
not alter individual phase logic, candidate limits, health scoring, or JSON
projection.

## Post Cheap Phase Grouping

Focused rerun with the rebuilt local CLI after `healthPhaseTasks()` grouped
only measured cheap tasks: `similar,extract-candidates` and
`vue-component-duplicates,vue-composable-candidates,vue-large-view-pressure,suppressions`.
The current health runner had 14 runnable Vega tasks under a default concurrency
cap of 12, so two late tasks had to wait for a worker. These groups keep the
slowest grouped task below the current 1.1s detector cluster while reducing the
task count to 12.

Source evidence: `scip-query plan-context healthPhaseTasks` shows the task
packer is called only by `runIsolatedHealthReport()`, and
`scip-query trace healthPhaseTasks` shows no downstream detector dependency.

Pre-change focused phase refresh:

| Case                                            | Median | Warm repeats         | stdout bytes | SHA-256                                                            |
| ----------------------------------------------- | -----: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`                      | 1.833s | 1.833s-1.818s-1.844s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`               | 1.862s | 2.000s-1.853s-1.862s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query __health-phase isolated`            | 1.133s | 1.133s-1.129s-1.157s |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query __health-phase wrapper-candidates`  | 1.150s | 1.174s-1.150s-1.133s |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query __health-phase stale-abstractions`  | 1.109s | 1.109s-1.150s-1.096s |        2,755 | `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322` |
| `scip-query __health-phase complexity-hotspots` | 1.082s | 1.098s-1.076s-1.082s |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |
| `scip-query __health-phase git-evidence`        | 0.837s | 0.835s-0.837s-0.844s |      413,963 | `7750461f2aeea01ef99261bc29cec088c9b8edeb06028bd24e4e5cb4392a96b4` |

Grouping probes before the accepted edit:

| Probe                                                                                                               | Median | Warm repeats                       | Decision                                                          |
| ------------------------------------------------------------------------------------------------------------------- | -----: | ---------------------------------- | ----------------------------------------------------------------- |
| `scip-query __health-phase similar,extract-candidates`                                                              | 0.707s | 0.723s-0.714s-0.701s-0.707s-0.695s | Accepted; below slow detector cluster                             |
| `scip-query __health-phase vue-component-duplicates,vue-composable-candidates,vue-large-view-pressure,suppressions` | 0.263s | 0.263s-0.262s-0.266s-0.261s-0.269s | Accepted; turns a late tiny task into work already grouped by Vue |
| `scip-query __health-phase cycles,suppressions`                                                                     | 0.510s | 0.526s-0.510s-0.517s-0.508s-0.498s | Rejected; useful, but Vue grouping was cheaper on Vega            |
| `scip-query __health-phase cycles,similar,extract-candidates`                                                       | 0.961s | 0.978s-0.972s-0.957s-0.959s-0.961s | Rejected; less headroom against the 1.1s detector cluster         |
| `scip-query __health-phase dead,similar`                                                                            | 1.126s | 1.145s-1.119s-1.126s-1.114s-1.160s | Rejected; sits on the critical path                               |

Post-change focused rerun:

| Case                                                   | Baseline median | Current median | Warm repeats                                     | stdout bytes | SHA-256                                                            |
| ------------------------------------------------------ | --------------: | -------------: | ------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`                             |          1.833s |         1.766s | 1.965s-1.766s-1.879s-1.844s-1.762s-1.725s-1.756s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`                      |          1.862s |         1.791s | 1.857s-1.836s-1.791s-1.790s-1.744s-1.750s-1.839s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query __health-phase similar,extract-candidates` |          0.707s |         0.758s | 0.758s-0.785s-0.740s                             |           87 | `8d475f2ccb1bd2153060aba3569526c49e0000faf2f5b8b8aceda84f0f7e329e` |
| `scip-query __health-phase vue*,suppressions`          |          0.263s |         0.278s | 0.284s-0.275s-0.278s                             |          461 | `96a35252e19a9f115944f18f165e5a759ee5e3c55f9d7501978db8b51e034c37` |

The accepted change is intentionally small: it reduces process scheduling waves
without changing detector logic, phase result order, candidate budgets, or
health report projection.
