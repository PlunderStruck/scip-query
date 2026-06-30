# Vega 2.0 Current Speed Scoreboard - 2026-06-28

This scoreboard records the latest full warm command matrix for
`/Users/aydansalois/Documents/GitHub/Vega_2.0` after the `similar --full`,
React profile-cache, source identifier prefilter, diff-gate callee-index reuse,
JS/TS framework-exclusion prefilter, doc path evidence cache, SQLite
statement-cache, dead scoped-cache reuse, wrapper source-fallback prefilter, and
incomplete-migration lazy-index passes. The focused dead refresh also includes
the definition-exclusion persistent cache, and the focused diff-gate refreshes
include callable and bounded source-fallback prefilters. The latest focused
refreshes add persistent JavaScript/TypeScript re-export evidence and
source-token fingerprint evidence. The latest focused health reruns also remove
the separate overview subprocess from health scheduling and make drift's
source-reference fallback candidate-first. The newest focused production
callable pass adds per-file role caches and a scoped direct row loader for
`requireCallableSymbol` scans. The newest focused diff-gate pass adds
file-scoped production-callable loading for changed-file-only unused-parameter
checks. The latest shared-cache pass persists source-corrected per-file
definition catalogs as project-fingerprint-guarded evidence. The latest focused
health pass raises the adaptive health phase concurrency ceiling from 10 to 12.
The newest diff-gate pass narrows the co-change partner check to directional
history for changed files while preserving the same bounded git-history window.
The newest complexity-hotspots pass applies the existing LOC threshold during
candidate collection and reduces per-candidate callee scoring allocations.
The newest caller-evidence pass prefilters AST callsites by target leaf names
before expensive candidate matching, improving target-scoped caller maps used
by complexity scoring.
The 2026-06-30 health cleanup moved profiling helpers to
`src/instrumentation/profile.ts`, declared this optimization ledger as an
intentional coupling group, removed a dead evidence-cache row-count helper, and
extracted the source-facts type to break the Clojure/source-facts cycle. It did
not change the optimized similarity, evidence-cache read/write, or benchmarked
Vega command algorithms; targeted tests and local built-CLI health checks cover
that cleanup.
The newest recent-duplicates pass persists the parsed Git file-add map by HEAD
so warm CLI processes avoid a repeated add-history scan.
The newest isolated pass prunes strict non-self callees before caller evidence
and uses direct semantic caller evidence after non-semantic caller absence is
already established.
The newest health orchestration pass groups measured cheap phase tasks so the
default 12-worker schedule no longer spills Vega health into a second wave.
The newest health hot-path pass adds count-only similar-pair scoring for health
and exact function-like definition loading for production-callable scans.
The newest complexity-hotspots pass pushes callable-symbol filtering into the
scoped definition SQL used by `requireCallableSymbol` candidate scans.
The newest diff-gate echo pass sends zero-callee targets straight to the
source-token fallback and avoids splitting source lines for cache-hit source
fingerprints.
The newest bench sub-profiling pass adds JSONL phase spans to focused benchmark
runs and confirms that Vega `similar --full` now spends its time in callee
fingerprint construction rather than pair scoring.
The newest cold semantic-callee pass cuts the Vega `similar --json --full`
cache-miss path from roughly five minutes to about twelve seconds by batching
TypeScript callee extraction, preloading project source files, caching the raw
TypeScript checker per project, and traversing compiler AST nodes directly.
The newest cold semantic-reference pass cuts Vega `dead --json --full`
semantic-reference cache-fill time by using a filtered inverted TypeScript
symbol scan for large non-member batches while preserving precise
`findReferences()` for member symbols.
The newest remaining semantic pass extends the inverted scan to safe member
symbols, lowers the bulk threshold for medium batches, trims wrapper semantic
candidates before source fallback, reorders drift's conservative skip gates,
and cuts ts-morph project-bundle startup by skipping eager dependency
resolution.
Focused reruns after the full matrix are recorded separately below so partial
measurements do not silently reshuffle the whole ranking.

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
|    1 | `scip-query diff-gate --json`                     |               2.672s |    1 |        3,089 |
|    2 | `scip-query health --json --full`                 |               2.560s |    0 |       15,360 |
|    3 | `scip-query health --json`                        |               2.537s |    0 |       15,342 |
|    4 | `scip-query dead --json --full`                   |               2.001s |    0 |    3,803,655 |
|    5 | `scip-query recent-duplicates --json --full`      |               1.954s |    0 |        3,618 |
|    6 | `scip-query isolated --json --full`               |               1.822s |    0 |          130 |
|    7 | `scip-query wrapper-candidates --json --full`     |               1.653s |    0 |       78,437 |
|    8 | `scip-query complexity-hotspots --json --full`    |               1.603s |    0 |    2,160,117 |
|    9 | `scip-query stale-abstractions --json --full`     |               1.590s |    0 |       83,654 |
|   10 | `scip-query incomplete-migration --json --full`   |               1.459s |    0 |        1,101 |
|   11 | `scip-query similar --json --full`                |               1.401s |    0 |       88,859 |
|   12 | `scip-query passthrough-candidates --json --full` |               1.320s |    0 |      146,739 |
|   13 | `scip-query cleanup-plan --verify --json`         |               1.272s |    0 |          237 |
|   14 | `scip-query doc-drift --json --full`              |               1.111s |    0 |      963,953 |
|   15 | `scip-query unused-params --json --full`          |               0.863s |    0 |          135 |
|   16 | `scip-query diff-impact --json`                   |               0.660s |    0 |        4,194 |
|   17 | `scip-query similar-files --json --full`          |               0.500s |    0 |      194,564 |

`diff-gate` exits 1 because Vega_2.0 has findings; the timing is still valid.

## Post Count-Only Health Refresh

Focused paired cold-evidence rerun against copied Vega cache directories. Both
runs cleared `file_evidence` and `semantic_callees` before execution; the
baseline CLI was built from commit `8a6ba32`, and the current CLI was the local
rebuilt worktree.

| Command                      | Baseline | Current | stdout bytes | SHA-256                                                            |
| ---------------------------- | -------: | ------: | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`    |   3.69s  |  3.56s  |       14,434 | `9d17f0dc18f0b35a8063877dcd1e317af6bfcecf90118bbaf2f1733f0aa71973` |
| `similar.all` health span     |  2.179s  | 1.048s  |            - | Same pair count: 7,804                                             |
| similar health pair scan      |  1.217s  | 0.118s  |            - | Same candidate pairs: 130,972                                      |
| `dead.candidates` health span |  0.368s  | 0.325s  |            - | Same candidate count: 9,523                                        |

CPU time moved from 19.49s to 18.14s. The health JSON outputs were
byte-identical.

## Post Bench Sub-Profiling Refresh

Focused rerun with the local built CLI after adding `bench --profile`,
`bench --profile-out`, and `bench --progress`, plus phase spans for
`similarAll`:

| Command                            | Profiled | Unprofiled control | stdout bytes | Profile finding                                               |
| ---------------------------------- | -------: | -----------------: | -----------: | ------------------------------------------------------------- |
| `scip-query similar --json --full` |   2.047s |             1.054s |       88,859 | Candidate loading 1.167s, callee map 0.668s, pair scan 0.006s |

The active Vega index was marked stale during this focused run, but the command
used the existing 104,090-symbol index and produced the same 88,859-byte output
size as previous focused `similar --full` checks. The profiling overhead is
diagnostic-only: normal commands do not set `SCIP_QUERY_PROFILE`, so the
additional callee-edge and pair counters stay off.

## Post Cold Semantic-Callee Refresh

Focused reruns with the local built CLI after deleting Vega's
`semantic_callees` evidence rows to force the cold semantic path. The SCIP index
itself was kept present, isolating the command-time semantic rebuild from a
full repository reindex.

| Command / cache state                    |   Before | Current | stdout bytes | SHA-256                                                            |
| ---------------------------------------- | -------: | ------: | -----------: | ------------------------------------------------------------------ |
| `similar --json --full`, cold profiled   | 291.197s | 13.628s |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |
| `similar --json --full`, cold unprofiled | 298.781s | 12.047s |       88,859 | same                                                               |
| `similar --json --full`, warm unprofiled |   1.658s |  1.037s |       88,859 | same                                                               |
| `similar --json --full`, warm profiled   |   0.984s |  1.004s |       88,859 | same                                                               |

The accepted cold profile reports `corpusSize: 922`, `candidateCount: 5920`,
and `insertedResults: 42`, matching the previous output contract. The remaining
cold cost is concentrated in `semantic.callees.provider-loop` at 11.977s,
mostly raw TypeScript traversal and expression symbol lookup. Cache scan and
cache write are small by comparison at 318ms and 26ms.

The attempted syntactic `minCallees` prefilter is intentionally excluded from
the accepted scoreboard because it changed the result corpus from 922 to 912
and output size from 88,859 to 88,858 bytes.

## Post Cold Semantic-Reference Refresh

Focused reruns with the local built CLI after deleting Vega's
`semantic_references` evidence rows to force the cold semantic reference path.
The comparison baseline used a temporary worktree at commit `0720bac`.

| Command / cache state                  |  Before | Current | stdout bytes | SHA-256                                                            |
| -------------------------------------- | ------: | ------: | -----------: | ------------------------------------------------------------------ |
| `dead --json --full`, cold direct      | 24.400s | 14.310s |    3,804,419 | `b7afa7e3cdd88c02ed31ffaf02da9547b6187591ef681dc67882dbfef76bc2e8` |
| `dead --json --full`, cold profiled    | 25.556s | 13.333s |    3,804,419 | same                                                               |
| `dead --json --full`, warm after cache |       - |  1.064s |    3,804,419 | same output size                                                   |

The accepted cold profile reports `semantic.references.compute-misses` at
12.051s. Inside it, `typescript.references-map.inverted-scan` handles 3,623
non-member definitions in 3.034s after reducing checker lookups to 103,232,
while precise member fallback handles 572 definitions in 5.386s. The final
output hash matches the legacy baseline.

## Post Remaining Semantic Optimization Refresh

Focused reruns with the local built CLI after extending the inverted reference
scan to safe member symbols, lowering the bulk threshold to 32, trimming
wrapper semantic candidates, reordering drift skip gates, profiling TypeScript
provider startup, and setting `skipFileDependencyResolution` for ts-morph
project bundles.

| Command                                                                    | Before this pass | Final accepted cold | Warm after cache | stdout bytes | Output check   |
| -------------------------------------------------------------------------- | ---------------: | ------------------: | ---------------: | -----------: | -------------- |
| `scip-query stale-abstractions --json --full`                              |          34.863s |              7.729s |           0.966s |       83,654 | `f8e0a9c7...`  |
| `scip-query isolated --json --full`                                        |           8.797s |              6.327s |           1.158s |          130 | `04e17adc...`  |
| `scip-query wrapper-candidates --json --full`                              |          18.857s |              7.316s |           1.228s |       78,437 | `311a9254...`  |
| `scip-query imports artifact-generation-run-store.ts --json --full`        |           7.146s |              3.946s |    not persisted |        4,723 | byte-identical |
| `scip-query unused-imports artifact-generation-run-store.ts --json --full` |           7.138s |              3.947s |    not persisted |          203 | byte-identical |
| `scip-query imports work-session.service.ts --json --full`                 |           7.776s |              4.024s |    not persisted |        3,148 | byte-identical |
| `scip-query unused-imports work-session.service.ts --json --full`          |           7.770s |              4.211s |    not persisted |          196 | byte-identical |
| `scip-query drift --json --full`                                           |           0.773s |              0.712s |              n/a |      725,988 | `4303db17...`  |

The final accepted cold profile is
`/tmp/scipq-remaining-bench/final-accepted-cold.jsonl`. The largest remaining
cold spans are `typescript.references-map.inverted-scan` at 13.566s total
across the three cleanup reports and `typescript.import-usage.file` at 9.866s
total across four import reports. TypeScript project-bundle startup is now
about 0.8s per CLI process instead of about 3.8s. Import usage is not persisted
in `evidence.db`, so import commands still pay their per-file semantic scan on
each process.

## Full Heavy Cold Matrix Refresh

Full `bench --json --cold-index --include-heavy --timeout-ms 600000 --profile`
rerun from `/Users/aydansalois/Documents/GitHub/Vega_2.0` with the local built
CLI after the remaining semantic optimization pass.

- Total measured time: 141.903s.
- Cold index rebuild: 41.045s for 1,779 indexed files and 104,090 symbols.
- Warm index reuse check: 0.452s.
- Command matrix total: 100.406s.
- Profile JSONL: `/tmp/vega-heavy-cold-20260628-125130.jsonl`.
- Result JSON: `/tmp/vega-heavy-cold-20260628-125130.json`.
- No command timed out. `diff-gate` exited 1 because Vega has findings.

| Command                                           | Duration | Exit | stdout bytes |
| ------------------------------------------------- | -------: | ---: | -----------: |
| `scip-query diff-gate --json`                     |  23.027s |    1 |       19,708 |
| `scip-query health --json`                        |  11.461s |    0 |       15,342 |
| `scip-query similar --json --full`                |  10.049s |    0 |       88,859 |
| `scip-query complexity-hotspots --json --full`    |   8.032s |    0 |    2,160,083 |
| `scip-query wrapper-candidates --json --full`     |   7.938s |    0 |       78,437 |
| `scip-query stale-abstractions --json --full`     |   7.785s |    0 |       83,654 |
| `scip-query dead --json --full`                   |   7.466s |    0 |    3,822,329 |
| `scip-query isolated --json --full`               |   6.648s |    0 |          130 |
| `scip-query passthrough-candidates --json --full` |   5.513s |    0 |      146,739 |
| `scip-query incomplete-migration --json --full`   |   5.111s |    0 |        1,711 |
| `scip-query doc-drift --json --full`              |   1.685s |    0 |      963,953 |
| `scip-query recent-duplicates --json --full`      |   1.540s |    0 |        3,618 |
| `scip-query cleanup-plan --verify --json`         |   0.801s |    0 |          237 |
| `scip-query diff-impact --json`                   |   0.791s |    0 |        7,020 |
| `scip-query similar-files --json --full`          |   0.535s |    0 |      194,564 |
| `scip-query status --json`                        |   0.505s |    0 |        6,724 |
| `scip-query status --capabilities`                |   0.496s |    0 |        2,223 |
| `scip-query unused-params --json --full`          |   0.365s |    0 |          135 |
| `scip-query kind-counts`                          |   0.207s |    0 |          201 |
| `scip-query capabilities --json`                  |   0.154s |    0 |        4,106 |
| `scip-query capability-matrix --json`             |   0.150s |    0 |        4,111 |
| `scip-query stats`                                |   0.147s |    0 |          131 |

The top cold profile spans show that remaining cold time is concentrated in
semantic evidence fill rather than report rendering:

| Span                                                               |  Total |
| ------------------------------------------------------------------ | -----: |
| `similar --full`: `semantic.callees.compute-misses`                | 8.994s |
| `complexity-hotspots --full`: `semantic.references.compute-misses` | 6.774s |
| `stale-abstractions --full`: `semantic.references.compute-misses`  | 6.677s |
| `wrapper-candidates --full`: `semantic.references.compute-misses`  | 6.639s |
| `dead --full`: `semantic.references.compute-misses`                | 5.944s |
| `isolated --full`: `semantic.references.compute-misses`            | 5.317s |
| `passthrough-candidates --full`: `semantic.callees.compute-misses` | 4.606s |
| `incomplete-migration --full`: `semantic.callees.compute-misses`   | 4.112s |

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

## Post SQLite Statement Cache Refresh

Focused rerun with the local built CLI after caching prepared SQLite statements
inside each `ScipDatabase` connection:

| Command                         | Current              | stdout bytes | SHA-256                                                            |
| ------------------------------- | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full` | 2.928s median        |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| warm repeats                    | 2.928s-2.996s-2.894s |    3,803,655 | same                                                               |
| `scip-query health --json`      | 2.938s median        |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query diff-gate --json`   | 2.933s warm median   |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

The previous focused `dead --json --full` median was 3.289s, so this removes
361ms from the current slowest command while preserving the 3,803,655-byte
output. The profile's 225.0ms `prepare` self-time dropped to a 15.9ms
`statement()` helper entry; remaining cost is actual SQLite execution plus
source/AST work.

## Post Dead Scoped-Cache Reuse Refresh

Focused rerun with the local built CLI after routing `deadCandidateDefinitions`
through the existing scoped definition catalog and preserving source-backed
definition caches for the subsequent source fallback phase:

| Command                                 | Current               | stdout bytes | SHA-256                                                            |
| --------------------------------------- | --------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`         | 2.737s focused median |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| warm repeats                            | 2.935s-2.715s-2.737s  |    3,803,655 | same                                                               |
| `scip-query __health-phase dead --full` | 2.035s focused median |          189 | `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| `scip-query health --json`              | 2.971s focused median |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query diff-gate --json`           | 2.972s focused median |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

The full Vega matrix after this pass put `dead --json --full` at 2.746s,
down from the immediately previous full matrix's 3.453s, with the same output
size and hash. `health --json` is now the slowest command in the matrix at
3.077s.

## Post Wrapper Source-Fallback Prefilter Refresh

Focused rerun with the local built CLI after routing wrapper candidate caller
evidence through a viability prefilter. The accepted pass skips source fallback
for wrapper scan symbols that cheap indexed/semantic caller evidence already
rules out, while preserving the original fan-in evidence domain.

| Command                                        | Current median | Warm repeats         | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | -------------: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query wrapper-candidates --json --full`  |         2.150s | 2.169s-2.124s-2.150s |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query __health-phase wrapper-candidates` |         2.096s | 2.064s-2.096s-2.107s |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query health --json`                     |         2.879s | 2.871s-2.879s-2.932s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The baseline/current comparison preserved byte-identical output for all three
commands. The standalone wrapper command moved from 2.165s to 2.147s in the
paired probe, while composite `health --json` moved from 2.991s to 2.890s in
that same probe. The improvement is intentionally recorded as modest: Vega
pruned 290 of 3,310 wrapper scan symbols from source fallback, so the next
large win likely needs a deeper source-fallback or health-phase change.

## Post Dead JS Regex Guard Refresh

Focused rerun with the local built CLI after adding cheap substring guards
before the JS/TS framework-exclusion regexes used by dead-code candidate
filtering:

| Command                          | Baseline median | Current median | stdout bytes | SHA-256                                                            |
| -------------------------------- | --------------: | -------------: | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`  |          2.689s |         2.674s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead` |          1.985s |         2.008s |           55 | `decdc3187d74e82cb158362174e58a4de3f8a490dd798571e16794f90f7a65e5` |
| `scip-query health --json`       |          2.975s |         2.932s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

This pass avoided 640 impossible regex evaluations across 2,277 Vega JS/TS
files with zero boolean mismatches in the source-text probe. The runtime change
is small and within process noise, but the accepted change removes pure wasted
work while preserving output hashes.

## Post Incomplete-Migration Lazy Index Refresh

Focused rerun with the local built CLI after deferring the global callee
fingerprint index until a new helper has enough meaningful callees to score:

| Command                                         | Baseline median | Current median | stdout bytes | SHA-256                                                            |
| ----------------------------------------------- | --------------: | -------------: | -----------: | ------------------------------------------------------------------ |
| `scip-query incomplete-migration --json --full` |          1.623s |         1.432s |        1,101 | `8c9573e427ee68a30e74bb1d27fbd9d4b49ec02b095c3d7fa7440d2317fd4c51` |
| `scip-query diff-gate --json`                   |          2.860s |         2.872s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `scip-query health --json`                      |          2.997s |         2.923s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

Vega's current diff has two new helpers, both too small to score. The lazy index
keeps the skipped output byte-identical and avoids building the global callee
fingerprint index for the standalone command. Full `diff-gate --json` is flat
because co-change/doc-reference/new-dead and base overhead dominate the combined
run on this corpus.

## Post Definition-Exclusion Cache Refresh

Focused paired rerun with the local built CLI after persisting framework
definition exclusions as content-hash-keyed file evidence:

| Command                                 | Baseline median | Current median | stdout bytes | SHA-256                                                            |
| --------------------------------------- | --------------: | -------------: | -----------: | ------------------------------------------------------------------ |
| `scip-query dead --json --full`         |          2.742s |         1.968s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query __health-phase dead --full` |          2.053s |         1.265s |          189 | `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| `scip-query health --json`              |          2.931s |         2.961s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The standalone dead command is 28.2% faster and the internal dead health phase
is 38.4% faster with byte-identical output. Composite `health --json` is neutral
because wrapper/stale/source-fallback work now dominates the remaining parallel
phase wall time.

## Deferred Caller Evidence Probe Refresh

Focused paired rerun with the local built CLI after testing two rejected caller
evidence ideas: staged source-callsite evidence for wrapper/stale candidates
and a larger SQLite mention `IN (...)` batch. Both preserved output hashes, but
neither improved the public command medians enough to keep the code change.

| Command                                        | Baseline median | Candidate median | Delta | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | --------------: | ---------------: | ----: | -----------: | ------------------------------------------------------------------ |
| `scip-query wrapper-candidates --json --full`  |          2.139s |           2.162s | +22ms |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full`  |          2.125s |           2.116s | -10ms |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query __health-phase wrapper-candidates` |          2.103s |           2.107s |  +4ms |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query __health-phase stale-abstractions` |          2.109s |           2.120s | +11ms |        2,755 | `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322` |
| `scip-query health --json`                     |          2.916s |           2.937s | +21ms |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query diff-gate --json`                  |          3.027s |           3.045s | +18ms |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

The source tree was reverted after this probe. The next candidate should focus
on reducing repeated source-facts/source-fallback work or health orchestration
rather than changing caller-map staging or SQLite mention batch size.

## Post Diff-Gate Echo Callable Prefilter Refresh

Focused paired rerun with the local built CLI after skipping non-callable
changed symbols before the diff-gate echo check calls `similar()`, plus an
early non-function guard inside `similar()`'s callee lookup.

| Command / probe                                    | Baseline median | Current median |   Delta | stdout bytes | SHA-256                                                            |
| -------------------------------------------------- | --------------: | -------------: | ------: | -----------: | ------------------------------------------------------------------ |
| `scip-query diff-gate --json`                      |          2.955s |         2.920s |   -34ms |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `only echo`                                        |          2.147s |         2.118s |   -29ms |        1,211 | `162f52479ad23d4e481f4fe0cea288a3f0dfbe568b056190bd01e5c766697a90` |
| `only echo --max-echo-checks 1`                    |          2.113s |         0.356s | -1.757s |        1,341 | `96a1a06be3e0b814fe881eacf5fd3d1399290df9535cbaf3c3727518465977d3` |
| `scip-query similar DiffGateFinding --json --full` |          0.211s |         0.153s |   -58ms |          241 | `aad94553fb65ca62538c6974685bff36443869c09142c68bef04c06c35c00825` |

The full Vega diff still contains callable changed symbols, so the aggregate
gate improvement is small. Diffs whose echo window is dominated by constants,
types, or other non-callable symbols avoid the expensive similarity index path
entirely while keeping byte-identical output.

## Post Diff-Gate Source-Fallback Scan-Limit Refresh

Focused paired rerun with the local built CLI after keying the lexical
source-fingerprint fallback by scan limit and applying the same bounded
candidate policy used by callee fingerprints. This preserves `--full` behavior
while avoiding a complete source-token corpus for bounded large-index callers
such as diff-gate echo.

| Command / probe                      | Baseline median | Current median |  Delta | stdout bytes | SHA-256                                                            |
| ------------------------------------ | --------------: | -------------: | -----: | -----------: | ------------------------------------------------------------------ |
| `scip-query diff-gate --json`        |          2.913s |         2.620s | -294ms |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `only echo`                          |          2.123s |         1.842s | -281ms |        1,211 | `162f52479ad23d4e481f4fe0cea288a3f0dfbe568b056190bd01e5c766697a90` |
| `similar ActiveNavIndicator --json`  |          2.182s |         1.911s | -272ms |          226 | `3316707fbf6cbab3f4543fecbe5e65a223d06bd2e563db876965ff7fc9c93c6d` |
| `similar ProjectHeroTintMenu --json` |          2.166s |         1.892s | -274ms |       10,384 | `9544740bea6d4b7efa31d3033ddfedb36035776049b1ce5e0e2f4258c0d393e8` |
| `scip-query similar --json --full`   |          1.409s |         1.380s |  -28ms |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |

All probes remained byte-identical. The unbounded `similar --json --full`
guardrail confirms the complete corpus path is unchanged.

## Post Source-Reexports Evidence Cache Refresh

Focused rerun with the local built CLI after persisting JavaScript/TypeScript
`getReExports()` results as content-hash-keyed `source-reexports` file
evidence, additionally guarded by the import-resolution fingerprint. A CPU
profile of warm `wrapper-candidates --json --full` showed 158 `tree-sitter`
parse calls in re-export parsing before this change; a post-cache parse hook
reported zero parse calls on the same warm command.

| Command                                       | Baseline median | Current median | Warm repeats         | stdout bytes | SHA-256                                                            |
| --------------------------------------------- | --------------: | -------------: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query wrapper-candidates --json --full` |          2.236s |         1.608s | 1.608s-1.598s-1.616s |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full` |          2.202s |         1.527s | 1.542s-1.527s-1.520s |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query health --json`                    |          2.903s |         2.512s | 2.597s-2.500s-2.512s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`             |          2.959s |         2.530s | 2.512s-2.586s-2.530s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query diff-gate --json`                 |          2.711s |         2.763s | 3.676s-2.763s-2.718s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

The first patched `wrapper-candidates --json --full` run populated the new
cache in 2.916s and kept the same 78,437-byte output hash. The focused stale
run was measured after wrapper populated shared re-export evidence, which is
the intended warm health path.

## Post Source-Fingerprints Evidence Cache Refresh

Focused rerun with the local built CLI after persisting source-token
fingerprints for the targeted `similar()` fallback. Each entry is keyed by the
file content hash plus the symbol/start/end/leaf definition key, so changed
source bytes or changed callable ranges fall back to recomputing. The first
patched `only echo` run populated 864 `source-fingerprints` evidence rows in
2.653s with the same output hash.

| Command / probe                      | Baseline median | Current median | Warm repeats         | stdout bytes | SHA-256                                                            |
| ------------------------------------ | --------------: | -------------: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `only echo`                          |          1.864s |         1.388s | 1.388s-1.565s-1.386s |        1,211 | `162f52479ad23d4e481f4fe0cea288a3f0dfbe568b056190bd01e5c766697a90` |
| `scip-query diff-gate --json`        |          2.672s |         2.152s | 3.371s-2.152s-2.114s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `similar ActiveNavIndicator --json`  |          1.899s |         1.443s | 1.444s-1.443s-1.433s |          226 | `3316707fbf6cbab3f4543fecbe5e65a223d06bd2e563db876965ff7fc9c93c6d` |
| `similar ProjectHeroTintMenu --json` |          1.899s |         1.415s | 1.415s-1.411s-1.442s |       10,384 | `9544740bea6d4b7efa31d3033ddfedb36035776049b1ce5e0e2f4258c0d393e8` |
| `scip-query similar --json --full`   |          1.401s |         1.372s | 1.385s-1.372s-1.370s |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |
| `scip-query health --json`           |          2.537s |         2.569s | 2.569s-2.475s-2.775s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The aggregate gate's first measured repeat was a process outlier, but the next
two warm repeats settled around 2.1s with byte-identical findings. Health is
effectively neutral because it does not depend on targeted source-shape echo.

## Post Health Drift Pattern-Deviation Skip

Focused rerun with the local built CLI after `health` and `health-baseline`
stopped computing drift `pattern-deviation` rows that neither path exposes.
Public `drift --json` remains enabled and emitted 725,970 bytes with SHA-256
`a7754846099d3424020aa3a26764fec84698dc3f5cfdb1c861c30228d1366462`.

| Command                                        | Current median | Warm repeats                       | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | -------------: | ---------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`                     |         2.530s | 2.552s-2.533s-2.530s-2.521s-2.518s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`              |         2.550s | 2.522s-3.056s-2.550s-2.559s-2.536s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query __health-phase drift`              |         1.745s | 1.769s-1.770s-1.745s-1.726s-1.733s |           98 | `7409f1c8ad7c5ae6a6ac5ae17778707e1b03f9e990a521de4376357f4a48bacd` |
| `scip-query __health-phase isolated`           |         1.694s | 1.717s-1.693s-1.694s               |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query __health-phase wrapper-candidates` |         1.646s | 1.694s-1.646s-1.633s               |        1,585 | `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b` |
| `scip-query __health-phase stale-abstractions` |         1.598s | 1.581s-1.598s-1.599s               |        2,755 | `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322` |

Rejected probes from this health pass:

| Probe                                                        |                                                            Result | Decision                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------: | -------------------------------------- |
| Bulk `getScopedDefinitions()` row load                       | `productionCallableDefinitions` stage moved from 0.971s to 1.614s | Reverted                               |
| `__health-phase dead,isolated`                               |                                                     1.968s median | Do not group; serializes too much work |
| `__health-phase wrapper-candidates,stale-abstractions`       |                                                     2.021s median | Do not group                           |
| `__health-phase isolated,drift`                              |                                                     2.545s median | Do not group                           |
| `__health-phase isolated,wrapper-candidates`                 |                                                     1.960s median | Do not group                           |
| `__health-phase drift,wrapper-candidates,stale-abstractions` |                                                     2.920s median | Do not group                           |
| `__health-phase dead,isolated,similar,extract-candidates`    |                                                     2.245s median | Do not group                           |

## Post Parent Overview Scheduling Refresh

Focused rerun with the local built CLI after health computed the cheap
`overview` phase in the parent process while the parent already had the database
open for phase applicability. This avoids one child process per health command
without changing phase aggregation or output payloads.

| Command                           | Baseline median | Current median | Warm repeats                                     | stdout bytes | SHA-256                                                            |
| --------------------------------- | --------------: | -------------: | ------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`        |          2.608s |         2.442s | 2.674s-2.442s-2.518s-2.391s-2.408s-2.432s-2.543s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full` |          2.550s |         2.432s | 2.438s-2.420s-2.413s-2.553s-2.432s               |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

## Post Candidate-First Drift Source Scan Refresh

Focused rerun with the local built CLI after `drift()` moved source-scanned
symbol-reference fallback behind SCIP reference evidence and the existing
semantic/source/type-only/side-effect/Vue skip gates. Public drift output is
unchanged; the source scan now only covers files that can still become
unused-import findings.

| Command                                  |        Baseline median | Current median | Warm repeats                                     | stdout bytes | SHA-256                                                            |
| ---------------------------------------- | ---------------------: | -------------: | ------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query __health-phase drift --full` |                 1.709s |         0.723s | 1.154s-0.730s-0.729s-0.706s-0.723s-0.714s-0.712s |           98 | `7409f1c8ad7c5ae6a6ac5ae17778707e1b03f9e990a521de4376357f4a48bacd` |
| `scip-query drift --json`                | 1.7s phase-family band |         0.723s | 0.726s-0.728s-0.723s-0.715s-0.719s               |      725,970 | `a7754846099d3424020aa3a26764fec84698dc3f5cfdb1c861c30228d1366462` |
| `scip-query health --json`               |                 2.487s |         2.384s | 2.375s-2.384s-2.428s-2.377s-2.368s-2.423s-2.392s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`        |                 2.445s |         2.455s | 2.455s-2.378s-2.576s-2.466s-2.403s               |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

Rejected probes from this continuation:

| Probe                                                        |                                                                                    Result | Decision          |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------: | ----------------- |
| Priority-sort health child tasks by measured broad-scan cost | `health --json` moved 2.487s -> 2.457s, but `health --json --full` moved 2.445s -> 2.464s | Reverted as noise |
| Same priority order with concurrency 11                      |                                                                             2.489s median | Keep default cap  |
| Same priority order with concurrency 12                      |                                                                             2.565s median | Keep default cap  |
| Same priority order with concurrency 14                      |                                                                             2.550s median | Keep default cap  |

## Post Scoped Callable-Row Loading Refresh

Focused rerun with the local built CLI after `productionCallableDefinitions()`
kept function-like health detectors on the original catalog path, cached
per-file role checks during filtering, and used direct merged primary/fallback
row loading only for `requireCallableSymbol` scans. A candidate-set probe on
Vega confirmed the new `requireCallableSymbol` path returns the same 6,442
source-corrected definitions as the old all-definition filter.

| Command                                        | Previous focused median | Current median | Warm repeats         | stdout bytes | SHA-256                                                            |
| ---------------------------------------------- | ----------------------: | -------------: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query __health-phase isolated --full`    |                  1.694s |         1.672s | 2.391s-1.627s-1.672s |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query isolated --json --full`            |                  1.857s |         1.744s | 1.750s-1.744s-1.734s |          130 | `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702` |
| `scip-query health --json --full`              |                  2.455s |         2.326s | 2.341s-2.294s-2.326s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query health --json`                     |                  2.384s |         2.329s | 2.400s-2.309s-2.329s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query wrapper-candidates --json --full`  |                  1.608s |         1.689s | 1.744s-1.689s-1.684s |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full`  |                  1.527s |         1.672s | 1.672s-1.610s-1.677s |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query complexity-hotspots --json --full` |                  1.603s |         1.528s | 1.528s-1.499s-1.533s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |

Rejected variants: file-only preselection slowed health full to 2.637s, and
using the direct merged row loader for every callable mode slowed health full
to 2.580s. The scoped version keeps the health win and limits the direct loader
to the command family where the candidate-set shortcut is behavior-identical.

## Post Diff-Gate Unused-Params File Scope Refresh

Focused rerun with the local built CLI after `unusedParams()` passed its
changed-file list into `productionCallableDefinitions()`. The public
`unused-params --json --full` path is unchanged; the diff-gate check now avoids
loading whole-repo callable candidates when it can only report changed files.

| Command                                                                                                                             | Baseline | Current | Warm repeats         | stdout bytes | SHA-256                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------: | ------: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query diff-gate --json --skip echo --skip incomplete-migration --skip co-change-partner --skip doc-reference --skip new-dead` |   0.991s |  0.364s | 0.356s-0.377s-0.364s |        1,202 | `e02b4859ace33f159476ebaeb8e67c377472d94bbc488ee69ccef0a93f028a41` |
| `scip-query diff-gate --json`                                                                                                       |   2.082s |  1.981s | 3.721s-1.986s-1.976s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `scip-query unused-params --json --full`                                                                                            |   0.863s |  0.812s | 0.835s-0.806s-0.812s |          135 | `db71d3c18134a2a61734cf0673380426ab2f1999a7f45b6535724b68024880cb` |

## Post Persistent Definition Cache Refresh

Focused rerun with the local built CLI after persisting `getDefinitionsForFile()`
results as `file-definitions` evidence guarded by source content hash and the
project evidence fingerprint. The first `isolated --json --full` run populated
1,779 Vega rows in 2.726s; the rows are reused by fresh CLI processes after
that fill.

| Command                                       | Baseline |       Current | Warm repeats                                             | stdout bytes | SHA-256                                                            |
| --------------------------------------------- | -------: | ------------: | -------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query isolated --json --full`           |   1.744s |        1.306s | 2.726s fill, then 1.314s-1.306s                          |          130 | `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702` |
| `scip-query health --json`                    |   2.329s | 2.120s-2.178s | 2.120s-2.136s-2.161s; matrix 2.178s                      |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`             |   2.326s | 2.095s-2.198s | 2.095s-2.198s-2.142s                                     |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query diff-gate --json`                 |   1.981s | 1.503s-1.651s | 2.644s matrix outlier, then 1.651s-1.548s-1.503s         |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `scip-query dead --json --full`               |   1.968s | 1.119s-1.139s | 1.137s-1.139s-1.119s after 1.819s outlier; matrix 1.132s |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `scip-query recent-duplicates --json --full`  |   1.936s | 1.442s-1.510s | 1.469s-1.510s-1.501s; matrix 1.442s                      |        3,618 | `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |
| `scip-query wrapper-candidates --json --full` |   1.608s |        1.206s | matrix run; direct hash probe 1.251s                     |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `scip-query stale-abstractions --json --full` |   1.527s |        1.142s | matrix run; direct hash probe 1.127s                     |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| `scip-query similar --json --full`            |   1.372s |        0.939s | matrix run; direct hash probe 0.966s                     |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |

## Post Health Concurrency Ceiling Refresh

Focused rerun with the rebuilt local CLI after raising the adaptive default
health phase concurrency ceiling from 10 to 12. This only affects hosts with
enough available parallelism; explicit `SCIP_QUERY_HEALTH_CONCURRENCY` overrides
and item-count caps still apply.

| Command                           | Previous focused warm band | Current warm repeats | stdout bytes | SHA-256                                                            |
| --------------------------------- | -------------------------: | -------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`        |              2.252s-2.325s | 2.116s-1.933s-1.949s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full` |              2.256s-2.325s | 1.938s-1.916s-1.925s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

The pre-edit concurrency sweep kept the `health --json` hash unchanged from
concurrency 1 through 20. Cap 12 was the conservative measured win at
1.897s-1.962s; higher probes flattened into timing noise.

## Post Diff-Gate Focused Co-Change Refresh

Focused rerun with the rebuilt local CLI after routing diff-gate's
co-change-partner check through a directional focused-history helper. A
directional co-change check asks whether a file in the current diff historically
requires an absent partner file; because the question is anchored to changed
files, the helper can inspect only commits in the global 2,000-commit window
that touched those files.

| Command                                                                                                                         | Previous focused warm band | Current warm repeats               | stdout bytes | SHA-256                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------: | ---------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query diff-gate --json`                                                                                                   |              1.536s-1.563s | 2.791s outlier, then 1.331s-1.339s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `scip-query diff-gate --json --skip echo --skip incomplete-migration --skip doc-reference --skip unused-params --skip new-dead` |              0.669s-0.671s | 0.477s-0.479s-0.476s               |        1,198 | `51faa0ffa7a97ee3dcd99f88d89a32b6d6ecdb188c29308634a77185daa01085` |
| `scip-query complexity-hotspots --json --full`                                                                                  |              1.480s-1.521s | 1.526s-1.465s-1.462s               |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| `scip-query recent-duplicates --json --full`                                                                                    |              1.471s-1.496s | 1.489s-1.461s-1.468s               |        3,618 | `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |

## Post Complexity LOC-Prefilter Refresh

Focused rerun with the rebuilt local CLI after passing `minLoc` into
`productionCallableDefinitions()` and scoring unique callees in one loop. This
skips 1,800 Vega callable definitions below the default 10 LOC threshold before
bulk caller/callee evidence preparation.

| Command                                         | Previous focused warm band | Current warm repeats                             | stdout bytes | SHA-256                                                            |
| ----------------------------------------------- | -------------------------: | ------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query complexity-hotspots --json --full`  |              1.416s-1.437s | 2.019s outlier, then 1.417s-1.420s-1.392s-1.401s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| `scip-query __health-phase complexity-hotspots` |               not isolated | 1.081s-1.080s-1.084s-1.097s                      |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |
| `scip-query health --json`                      |              1.854s-1.914s | 1.969s-1.869s-1.871s-1.881s                      |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

## Post Recent-Duplicates File-Add Cache Refresh

Focused rerun with the rebuilt local CLI after persisting the parsed
`git log --diff-filter=A` file-add map in `evidence.db`, keyed by the current
Git HEAD. The first patched run filled the cache; subsequent fresh CLI
processes reused the 18,821-row Vega add map.

| Command                                      | Previous focused warm band | Current warm repeats                          | stdout bytes | SHA-256                                                            |
| -------------------------------------------- | -------------------------: | --------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query recent-duplicates --json --full` |              1.476s-1.503s | 2.024s fill, then 1.153s-1.147s-1.145s-1.135s |        3,618 | `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b` |
| `scip-query health --json`                   |              1.908s-2.131s | 1.870s-1.839s-1.826s                          |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query __health-phase git-evidence`     |              0.897s-0.914s | 0.855s-0.878s-0.851s                          |      413,963 | `7750461f2aeea01ef99261bc29cec088c9b8edeb06028bd24e4e5cb4392a96b4` |

## Post Isolated Pipeline Narrowing Refresh

Focused rerun with the rebuilt local CLI after moving strict non-self callee
evidence ahead of caller evidence in `isolated()` and replacing the repeated
semantic caller pass with direct semantic caller evidence. The isolated command
is faster with byte-identical output; composite health remains in the same
timing band because its phases run in parallel.

| Command                                     | Previous focused warm | Current warm repeats                                    | stdout bytes | SHA-256                                                            |
| ------------------------------------------- | --------------------: | ------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query isolated --json --full`         |                1.306s | 1.773s outlier, then 1.163s-1.139s-1.132s-1.140s median |          130 | `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702` |
| `scip-query __health-phase isolated`        |                1.133s | 1.127s-1.099s-1.141s-1.134s-1.129s median               |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query __health-phase isolated --full` |                1.672s | 1.180s-1.172s-1.173s-1.173s-1.198s median               |           63 | `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329` |
| `scip-query health --json`                  |         1.826s-1.933s | 1.929s-1.956s-1.818s-1.840s-1.864s median               |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`           |         1.916s-1.925s | 1.901s-1.956s-1.893s-1.854s-1.841s median               |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

## Post Health Cheap Phase Grouping Refresh

Focused rerun with the rebuilt local CLI after `healthPhaseTasks()` grouped
`similar,extract-candidates` and
`vue-component-duplicates,vue-composable-candidates,vue-large-view-pressure,suppressions`.
On Vega this reduces runnable health tasks from 14 to 12, matching the current
default high-parallelism health concurrency cap and avoiding a late second wave.

| Command                                                | Previous focused median | Current warm repeats                             | stdout bytes | SHA-256                                                            |
| ------------------------------------------------------ | ----------------------: | ------------------------------------------------ | -----------: | ------------------------------------------------------------------ |
| `scip-query health --json`                             |                  1.833s | 1.965s-1.766s-1.879s-1.844s-1.762s-1.725s-1.756s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `scip-query health --json --full`                      |                  1.862s | 1.857s-1.836s-1.791s-1.790s-1.744s-1.750s-1.839s |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| `scip-query __health-phase similar,extract-candidates` |                  0.707s | 0.758s-0.785s-0.740s                             |           87 | `8d475f2ccb1bd2153060aba3569526c49e0000faf2f5b8b8aceda84f0f7e329e` |
| `scip-query __health-phase vue*,suppressions`          |                  0.263s | 0.284s-0.275s-0.278s                             |          461 | `96a35252e19a9f115944f18f165e5a759ee5e3c55f9d7501978db8b51e034c37` |

## Post Complexity Callable SQL-Prefilter Refresh

Focused rerun with the rebuilt local CLI after the definition catalog pushed a
callable-shaped symbol SQL prefilter into
`getScopedDefinitionsMatchingSymbols()` for callers that already pass
`requireCallableSymbol`. The JS `isCallableSymbol` filter and source-corrected
range pipeline remain in place.

| Command                                         | Previous focused median | Current warm repeats                                           | stdout bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------------------: | -------------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query complexity-hotspots --json --full`  |                  1.480s | 2.023s outlier, then 1.336s-1.395s-1.375s-1.413s-1.376s-1.369s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| `scip-query __health-phase complexity-hotspots` |                  1.127s | 1.070s-1.007s-0.942s-0.938s-0.957s-0.957s-0.936s               |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |

## Post Caller Target-Leaf Prefilter Refresh

Focused rerun with the rebuilt local CLI after `buildCrossFileCallerMap()`
started skipping AST callsites and Rust attribute references whose leaf names
are not present in the requested target definition set. On Vega's complexity
run, only 12,872 of 107,377 AST callsites name a target leaf, so the same
caller-map output avoids most impossible candidate-picking work.

| Command                                         | Previous focused median | Current warm repeats                                    | stdout bytes | SHA-256                                                            |
| ----------------------------------------------- | ----------------------: | ------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query complexity-hotspots --json --full`  |                  1.376s | 1.265s-1.274s-1.365s-1.265s-1.277s-1.308s-1.372s-1.388s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| `scip-query __health-phase complexity-hotspots` |                  0.957s | 0.956s-0.934s-0.915s-0.888s-0.896s-0.871s-0.864s-0.925s |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |
| `scip-query health --json`                      |                  1.766s | noisy 1.960s-2.825s-2.440s-2.163s-2.457s                |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

## Post Diff-Gate Zero-Callee Echo Refresh

Focused rerun with the rebuilt local CLI after routing target-mode `similar()`
directly to source-token fallback when a target has zero meaningful callees.
The same pass keeps source line splitting out of the warm source-fingerprint
cache-hit path.

| Command                                 | Previous focused median | Current warm repeats                      | stdout bytes | SHA-256                                                            |
| --------------------------------------- | ----------------------: | ----------------------------------------- | -----------: | ------------------------------------------------------------------ |
| `scip-query diff-gate --json`           |                  1.326s | 2.226s outlier, then 1.202s-1.156s-1.148s |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `scip-query diff-gate --json` only echo |                  0.860s | 0.991s outlier, then 0.723s-0.688s-0.696s |        1,211 | `162f52479ad23d4e481f4fe0cea288a3f0dfbe568b056190bd01e5c766697a90` |
| `scip-query similar --json --full`      |                  0.939s | 0.984s-0.955s-0.949s-0.966s               |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |

## Post Diff-Gate Hyper Optimization Refresh

Focused cold-like rerun with the rebuilt local CLI after adding check-level
diff-gate spans, scoping incomplete-migration helper discovery to changed
files, adding a doc-reference target path prefilter, and bounding diff-gate
echo source fallback by the exact minimum shared-token count implied by
`minSimilarity`.

This did not rerun the full heavy matrix. It cleared Vega's `file_evidence`,
`semantic_callees`, and `semantic_references` rows to isolate command-time
cache fill while preserving the existing SCIP index.

| Command / cache state                      | Previous cold-like | Current cold-like | Exit | stdout bytes | SHA-256                                                            |
| ------------------------------------------ | -----------------: | ----------------: | ---: | -----------: | ------------------------------------------------------------------ |
| `scip-query diff-gate --json`, cache clear |            22.119s |            3.046s |    1 |       19,708 | `8cb44814e1c5ab700c1caef3b8c8667ee6cb11b939ac7d2d20315c41d9f64d5e` |

Accepted profile:
`/tmp/vega-diffgate-after-echo-threshold-20260628203105.jsonl`.

The final run is byte-identical to the baseline output
`/tmp/vega-diffgate-direct-profile-20260628-130927.json`. Evidence writes
dropped from `doc-path-evidence:11290`, `file-definitions:1779`,
`source-facts:1779`, and `source-fingerprints:864` to `doc-path-evidence:8`,
`file-definitions:9`, `source-facts:9`, and `source-fingerprints:3`.

The final top spans are `doc-reference` at 1.351s, `echo` at 0.762s, and
`co-change-partner` at 0.341s. Echo's hot source fallback was
`ActiveNavIndicator`: 30 target source tokens, 24 required shared tokens,
1,779 files scanned, 3 candidate files, 34 candidate definitions, and 0
findings.

## Biggest Confirmed Delta

| Command                                        | Earlier heavy/focused baseline | Current warm | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------- | -----------------------------: | -----------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scip-query similar --json --full`             |  300.7s heavy / 315.3s focused |       0.939s | Same 88,859-byte output and SHA-256 `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf`; stable semantic evidence and persistent source-corrected definition catalogs avoid fresh-process rebuilds.                                                                                                                                                                                                                                     |
| `scip-query recent-duplicates --json --full`   |                         6.439s |       1.135s | Same 3,618-byte output and SHA-256 `abe43237e5380498d3a999ce4f1b7adee735b58b9c1abafc7fa3c1cef01ed89b`; full-mode scans skip old-old pairs, React profile rows persist, source-corrected definitions persist, and the Git file-add map now persists by HEAD across CLI processes.                                                                                                                                                                       |
| `scip-query doc-drift --json --full`           |                         3.472s |       1.085s | Same 963,953-byte output and SHA-256 `7f8765a247b9e6a0ab2cbd0e99b38b51acf7ce689cd7b7b02165cdb80f97cc8c`; markdown path candidates and citation contexts now persist as content-hash evidence.                                                                                                                                                                                                                                                          |
| `scip-query health --json`                     |                         6.864s |       1.766s | Same 15,342-byte output and SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`; latest focused warm path benefits from source-reexports evidence, hidden drift-row skipping, parent-process overview scheduling, candidate-first drift source scanning, cached production-callable file-role checks, persistent definitions, a higher adaptive health phase concurrency ceiling, and cheap phase task grouping.                |
| `scip-query diff-gate --json`                  |                         4.193s |       1.179s | Same 3,089-byte output and SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`; targeted similarity reuses callee-index work, skips non-callable echo targets, routes zero-callee echo targets straight to source fallback, bounds lexical source fallback, persists source-token fingerprints and definitions, scopes the unused-params check to changed files, and narrows co-change partner history to changed-file commits. |
| `scip-query dead --json --full`                |                         4.325s |       1.119s | Same 3,803,655-byte output and SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`; JS/TS exclusion prefilter avoids ordinary React hook-call files, SQL statements are cached per connection, source fallback reuses scoped definition caches, framework/definition evidence persists, and large candidate sets now batch caller-file evidence instead of resolving per-symbol caller rows.                                    |
| `scip-query wrapper-candidates --json --full`  |                         2.236s |       1.206s | Same 78,437-byte output and SHA-256 `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58`; re-export parsing and source-corrected definitions now persist across fresh CLI processes.                                                                                                                                                                                                                                                     |
| `scip-query stale-abstractions --json --full`  |      43.268s cold / 3.13s warm |       1.142s | Same 83,654-byte output and SHA-256 `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2`; source fallback reuses per-file import local-name maps while re-export parsing and definitions persist across fresh CLI processes.                                                                                                                                                                                                             |
| `scip-query isolated --json --full`            |                         1.822s |       1.140s | Same 130-byte output and SHA-256 `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702`; strict non-self callee evidence now prunes the candidate set before caller evidence, and the semantic phase only adds semantic caller evidence instead of rerunning the non-semantic caller passes.                                                                                                                                               |
| `scip-query complexity-hotspots --json --full` |                         1.603s |       1.308s | Same 2,160,117-byte output and SHA-256 `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f`; candidate collection applies the LOC threshold early, prefilters callable-shaped symbols in SQL, and skips AST caller candidate matching when the callsite leaf is outside the requested target set.                                                                                                                                        |
| `scip-query drift --json`                      |         1.7s phase-family band |       0.723s | Same 725,970-byte output and SHA-256 `a7754846099d3424020aa3a26764fec84698dc3f5cfdb1c861c30228d1366462`; source-reference fallback now runs only after SCIP refs and import skip gates leave possible unused-import findings.                                                                                                                                                                                                                          |

## Current Next Targets

1. `health --json` and `health --json --full` now sit around 1.77s-1.79s.
   A fresh concurrency sweep from 10 through 18 workers kept the same output
   hash and did not beat the current scheduler; the latest cheap-task grouping
   removes the second scheduling wave, so the next health pass should target
   individual phase algorithms or shared phase setup.
2. `diff-gate --json`, `complexity-hotspots --json --full`, and
   `isolated --json --full` are the next standalone cluster, roughly
   1.24s-1.31s in current focused warm local-CLI runs.
3. `recent-duplicates --json --full`, `dead --json --full`,
   `stale-abstractions --json --full`, `wrapper-candidates --json --full`, and
   `similar --json --full` now sit between about 0.95s and 1.21s in focused
   warm local-CLI runs.
4. Re-run the full Vega warm matrix with the installed CLI after the next
   package install/publish so the scoreboard captures normal `scip-query`
   command behavior, not only local `dist/cli.js`.

Cold/heavy-matrix spikes in `passthrough-candidates`, `complexity-hotspots`,
`wrapper-candidates`, and `stale-abstractions` were largely source/evidence
cache fill effects; their warm runs are now 1.4s-2.6s.
