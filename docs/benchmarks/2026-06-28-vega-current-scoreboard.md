# Vega 2.0 Current Speed Scoreboard - 2026-06-28

This scoreboard records the latest full warm command matrix for
`/Users/aydansalois/Documents/GitHub/Vega_2.0` after the `similar --full`,
React profile-cache, source identifier prefilter, diff-gate callee-index reuse,
and JS/TS framework-exclusion prefilter passes. Focused reruns after the full
matrix are recorded separately below so partial measurements do not silently
reshuffle the whole ranking.

## Corpus

- Repository files: 14,553
- Source files: 2,290
- Indexed files: 1,779
- Indexed symbols: 103,982
- Index size: 74,207,232 bytes
- Index last built: 2026-06-28T02:38:40.753Z

## Latest Warm Ranking

| Rank | Command                                           | Latest warm duration | Exit | stdout bytes |
| ---: | ------------------------------------------------- | -------------------: | ---: | -----------: |
|    1 | `scip-query recent-duplicates --json --full`      |               4.900s |    0 |        3,618 |
|    2 | `scip-query dead --json --full`                   |               4.070s |    0 |    3,803,655 |
|    3 | `scip-query health --json`                        |               3.913s |    0 |       15,342 |
|    4 | `scip-query doc-drift --json --full`              |               3.697s |    0 |      963,953 |
|    5 | `scip-query diff-gate --json`                     |               3.053s |    1 |        3,089 |
|    6 | `scip-query cleanup-plan --verify --json`         |               2.892s |    0 |          237 |
|    7 | `scip-query wrapper-candidates --json --full`     |               2.339s |    0 |       78,437 |
|    8 | `scip-query stale-abstractions --json --full`     |               2.285s |    0 |       83,654 |
|    9 | `scip-query isolated --json --full`               |               1.908s |    0 |          130 |
|   10 | `scip-query incomplete-migration --json --full`   |               1.727s |    0 |        1,101 |
|   11 | `scip-query complexity-hotspots --json --full`    |               1.691s |    0 |    2,160,117 |
|   12 | `scip-query similar --json --full`                |               1.507s |    0 |       88,859 |
|   13 | `scip-query passthrough-candidates --json --full` |               1.402s |    0 |      146,739 |
|   14 | `scip-query unused-params --json --full`          |               0.958s |    0 |          135 |
|   15 | `scip-query similar-files --json --full`          |               0.526s |    0 |      194,564 |

`diff-gate` exits 1 because Vega_2.0 has findings; the timing is still valid.

## Latest Focused Refresh

Focused rerun after the diff-gate callee-index pass while starting the next
dead/health source-fallback trace:

| Command                                      | Hash probe | Warm repeats  | stdout bytes | SHA-256                                                            |
| -------------------------------------------- | ---------: | ------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`              |     4.325s | 4.070s, 4.580s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead --full`      |     2.926s | 3.176s, 2.895s |          189 | `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| `scip-query health --json`                   |     4.178s | 4.085s, 4.095s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

This confirms `dead --json --full`, the dead health phase, and `health --json`
still preserve their output contracts while hovering around the 3s-4.6s band
on Vega_2.0. The next optimization target remains the shared source-fallback
and reference-evidence path behind dead/health.

## Post JS/TS Exclusion Prefilter Refresh

Focused rerun after tightening the JS/TS framework-exclusion prefilter so
ordinary React hook calls no longer force an AST exclusion pass:

| Command                                      | First probe | Warm repeats  | stdout bytes | SHA-256                                                            |
| -------------------------------------------- | ----------: | ------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`              |      4.274s | 3.330s, 3.312s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead --full`      |      2.192s | 2.219s, 2.193s |          189 | `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| `scip-query health --json`                   |      4.091s | 4.116s, 3.985s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The dead command and dead health phase are materially faster with identical
output hashes. `health --json` is roughly neutral because other health phases
now dominate the aggregate command.

## Biggest Confirmed Delta

| Command                                      | Earlier heavy/focused baseline | Current warm | Notes                                                                                                                                                                                              |
| -------------------------------------------- | -----------------------------: | -----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scip-query similar --json --full`           |  300.7s heavy / 315.3s focused |       1.507s | Same 88,859-byte output size; now about 209x faster than the focused baseline.                                                                                                                     |
| `scip-query recent-duplicates --json --full` |                         6.439s |       4.900s | Same 3,618-byte output and SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`; React profile cache avoids rebuilding per-file profiles inside the aggregate command.       |
| `scip-query health --json`                   |                         6.864s |       3.913s | Same 15,342-byte output and SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`; latest warm matrix is materially lower, but attribution is mixed with runtime/cache noise. |
| `scip-query diff-gate --json`                |                         4.193s |       3.053s | Same 3,089-byte output and SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`; targeted similarity and incomplete-migration now reuse existing callee-index work.          |
| `scip-query dead --json --full`              |                         4.325s |       3.312s | Same 3,803,655-byte output and SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`; JS/TS exclusion prefilter now avoids ordinary React hook-call files.                    |

## Current Next Targets

1. `recent-duplicates --json --full`: still the slowest full-matrix command at
   4.900s, but the set-kernel trial was rejected because it did not improve the
   real Vega workload.
2. `health --json` and `doc-drift --json --full`: health is still around 4s and
   doc-drift remains the next standalone full-matrix command above 3.5s.
3. `dead --json --full`: now around 3.31s in focused warm repeats; remaining
   work is likely caller-map, source-reference, or candidate definition
   correction rather than the JS/TS exclusion prefilter.

Cold/heavy-matrix spikes in `passthrough-candidates`, `complexity-hotspots`,
`wrapper-candidates`, and `stale-abstractions` were largely source/evidence
cache fill effects; their warm runs are now 1.4s-2.6s.
