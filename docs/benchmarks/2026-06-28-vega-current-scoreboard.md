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

| Command                                 | Hash probe | Warm repeats   | stdout bytes | SHA-256                                                            |
| --------------------------------------- | ---------: | -------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`         |     4.325s | 4.070s, 4.580s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead --full` |     2.926s | 3.176s, 2.895s |          189 | `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| `scip-query health --json`              |     4.178s | 4.085s, 4.095s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

This confirms `dead --json --full`, the dead health phase, and `health --json`
still preserve their output contracts while hovering around the 3s-4.6s band
on Vega_2.0. The next optimization target remains the shared source-fallback
and reference-evidence path behind dead/health.

## Post JS/TS Exclusion Prefilter Refresh

Focused rerun after tightening the JS/TS framework-exclusion prefilter so
ordinary React hook calls no longer force an AST exclusion pass:

| Command                                 | First probe | Warm repeats   | stdout bytes | SHA-256                                                            |
| --------------------------------------- | ----------: | -------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`         |      4.274s | 3.330s, 3.312s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead --full` |      2.192s | 2.219s, 2.193s |          189 | `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| `scip-query health --json`              |      4.091s | 4.116s, 3.985s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The dead command and dead health phase are materially faster with identical
output hashes. `health --json` is roughly neutral because other health phases
now dominate the aggregate command.

## Post Import-Index Cache Refresh

Focused rerun after caching the per-file import local-name map used by source
fallback attribution:

| Command                                       |                        Baseline | Current | stdout bytes | SHA-256                                                            |
| --------------------------------------------- | ------------------------------: | ------: | -----------: | ------------------------------------------------------------------ |
| `scip-query stale-abstractions --json --full` | 43.268s cache-fill / 3.13s warm |  2.362s |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |

The 43.268s stale-abstractions run reproduced a cold/cache-fill outlier while
the installed warmed command ran in 3.13s. The accepted cache keeps output
byte-identical and drops the warmed focused bench to 2.362s.

## Post Stable Evidence Cache Version Refresh

Focused rerun after replacing package-version evidence-cache reads with stable
payload-version reads plus content-compatible fallback to existing cache rows:

| Command                                      | Current | stdout bytes | SHA-256                                                            |
| -------------------------------------------- | ------: | -----------: | ------------------------------------------------------------------ |
| `scip-query similar --json --full`           |  2.169s |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |
| `scip-query recent-duplicates --json --full` |  5.287s |        3,618 | `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |
| `scip-query dead --json --full`              |  3.844s |    3,803,655 | not rehashed in this focused pass                                  |
| `scip-query health --json`                   |  4.336s |       15,342 | not rehashed in this focused pass                                  |
| `scip-query doc-drift --json --full`         |  4.885s |      963,953 | not rehashed in this focused pass                                  |

The `0.10.9` package bump invalidated existing `0.10.8` semantic callee rows
under the old package-version cache key, causing `similar --full` and
`recent-duplicates --full` to fall into a multi-GB semantic rebuild. Stable
evidence-cache versioning restores the warm semantic path while preserving the
recorded output hashes.

## Post Recent Duplicate Focus-Pair Refresh

Focused rerun after using recent-file add records to skip unobservable old-old
pairs inside the unbounded `recent-duplicates --full` candidate scans:

| Command                                      | Current                     | stdout bytes | SHA-256                                                            |
| -------------------------------------------- | --------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query recent-duplicates --json --full` | 4.190s median               |        3,618 | `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |
| repeats                                      | 4.242s-4.182s-4.194s-4.186s |        3,618 | same                                                               |

The full command already drops pairs where neither file was added inside the
recent window. Pushing that existing recency rule into callable and frontend
pairwise scans keeps the output byte-identical while avoiding comparison work
that could not produce findings.

## Post React Profile Persistent Cache Refresh

Focused rerun with the local built CLI after adding content-hash-keyed
`react-component-behavior-profiles` rows to `evidence.db`:

| Command                                      | Current                    | stdout bytes | SHA-256                                                            |
| -------------------------------------------- | -------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query recent-duplicates --json --full` | 1.936s median              |        3,618 | `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |
| first patched run                            | 4.155s, populated 689 rows |        3,618 | same                                                               |
| warm repeats                                 | 1.945s-1.927s-1.936s       |        3,618 | same                                                               |

This measurement used `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js`
from the checkout build; the shell `scip-query` command still points at the
installed Hermes package until the package is installed or published.

## Post Doc Drift Path Evidence Cache Refresh

Focused rerun with the local built CLI after adding content-hash-keyed
`doc-path-evidence` rows that cache both markdown path candidates and citation
contexts:

| Command                              | Current                      | stdout bytes | SHA-256                                                            |
| ------------------------------------ | ---------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query doc-drift --json --full` | 1.085s median                |      963,953 | `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c` |
| first patched run                    | 3.760s, populated cache rows |      963,953 | same                                                               |
| warm repeats                         | 1.085s-1.087s-1.053s         |      963,953 | same                                                               |

The previous local-CLI warm median was 3.472s, so the persistent doc path
evidence cache removes 2.387s from the warm path, a 3.2x speedup, while keeping
the ranked findings and citation-context payload byte-identical.

Final verification after extracting shared evidence-payload validators kept the
same output hash. The local built CLI repeated at 1.755s, 1.112s, and 1.076s;
the first run was a process outlier, and the two following warm probes stayed
in the same ~1.09s band.

## Biggest Confirmed Delta

| Command                                       | Earlier heavy/focused baseline | Current warm | Notes                                                                                                                                                                                              |
| --------------------------------------------- | -----------------------------: | -----------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scip-query similar --json --full`            |  300.7s heavy / 315.3s focused |       2.169s | Same 88,859-byte output and SHA-256 `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf`; stable evidence-cache reads avoid post-version-bump semantic cache misses.                 |
| `scip-query recent-duplicates --json --full`  |                         6.439s |       1.936s | Same 3,618-byte output and SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`; full-mode scans skip old-old pairs and React profile rows now persist across CLI processes. |
| `scip-query doc-drift --json --full`          |                         3.472s |       1.085s | Same 963,953-byte output and SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`; markdown path candidates and citation contexts now persist as content-hash evidence.      |
| `scip-query health --json`                    |                         6.864s |       3.913s | Same 15,342-byte output and SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`; latest warm matrix is materially lower, but attribution is mixed with runtime/cache noise. |
| `scip-query diff-gate --json`                 |                         4.193s |       3.053s | Same 3,089-byte output and SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`; targeted similarity and incomplete-migration now reuse existing callee-index work.          |
| `scip-query dead --json --full`               |                         4.325s |       3.312s | Same 3,803,655-byte output and SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`; JS/TS exclusion prefilter now avoids ordinary React hook-call files.                    |
| `scip-query stale-abstractions --json --full` |      43.268s cold / 3.13s warm |       2.362s | Same 83,654-byte output and SHA-256 `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2`; source fallback now reuses per-file import local-name maps.                                |

## Current Next Targets

1. `health --json`: still sits near the 4s band in focused repeats and should
   be traced by phase to identify the current dominant path.
2. `dead --json --full`: now around 3.31s in focused warm repeats; remaining
   work is likely caller-map, source-reference, or candidate definition
   correction rather than the JS/TS exclusion prefilter.
3. Re-run the full Vega warm matrix with the installed CLI after the next
   package install/publish so `health` captures the persistent React profile
   cache through the normal `scip-query` command.

Cold/heavy-matrix spikes in `passthrough-candidates`, `complexity-hotspots`,
`wrapper-candidates`, and `stale-abstractions` were largely source/evidence
cache fill effects; their warm runs are now 1.4s-2.6s.
