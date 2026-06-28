# Diff-Gate Echo Ledger

Date: 2026-06-28

## Goal

Make Vega_2.0 `diff-gate --json` faster without changing its findings,
suppression behavior, output shape, or exit code. The current target is the
echo check, which detects new changed symbols that look like already-existing
code outside the diff.

## Output Contract

- `diff-gate --json` on Vega_2.0 currently exits 1 with 3,089 stdout bytes and
  SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.
- `only-echo` currently exits 0 with no findings on the Vega_2.0 diff, but it
  must still run the same symbol similarity semantics when applicable.

## Current Pipeline

- `diffGate()` in `src/queries/impact/diff-gate.ts:160-246` builds a
  `diffImpactPlan()`, computes `diffImpact()`, prepares base-content lookup,
  then runs checks in order: echo, incomplete migration, co-change partner,
  doc reference, unused params, new dead, and optional baseline. Source:
  `scip-query plan-context diffGate`; `scip-query trace diffGate`.
- `runEchoCheck()` in `src/queries/impact/diff-gate.ts:351-412` loops over
  changed symbols up to `maxEchoChecks`, skips symbols that preexisted at the
  base ref, and calls `similar(db, changedSymbol.symbol, { minSimilarity,
limit: 5, scanLimit, semantic })`. Source:
  `scip-query plan-context runEchoCheck`; `scip-query code runEchoCheck -C 60`.
- `similar()` in `src/queries/cleanup/similar.ts:72-89` calls `findCallees()`,
  rejects non-function-like symbols, compares callee fingerprints, and falls
  back to `similarBySourceShape()` when no callee result is found. Source:
  `scip-query plan-context similar`; `scip-query code similar -C 60`.
- `findCallees()` in `src/queries/cleanup/similar.ts:352-366` currently finds
  the symbol, constructs a `ProjectIndex`, reads callee rows, and asks for the
  callable signature before `similar()` rejects non-function-like symbols.
  Source: `scip-query code src/queries/cleanup/similar.ts:260-430`.
- `getCalleeFingerprintIndex()` in `src/queries/cleanup/similar.ts:401-422`
  memoizes the expensive callee fingerprint index per database and option key.
  Source: `scip-query code getCalleeFingerprintIndex -C 40`.

## Measurements

Refreshed Vega_2.0 local CLI medians before source edits:

| Command                            | Median | Exit | stdout bytes | SHA-256                                                            |
| ---------------------------------- | -----: | ---: | -----------: | ------------------------------------------------------------------ |
| `health --json`                    | 2.939s |    0 |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `diff-gate --json`                 | 2.906s |    1 |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `dead --json --full`               | 1.989s |    0 |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `wrapper-candidates --json --full` | 2.192s |    0 |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `stale-abstractions --json --full` | 2.175s |    0 |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |

Diff-gate check isolation on Vega_2.0:

| Case               | Median |
| ------------------ | -----: |
| all checks         | 3.033s |
| skip echo          | 1.980s |
| only echo          | 2.182s |
| only incomplete    | 1.243s |
| only co-change     | 0.712s |
| only doc-reference | 0.697s |
| only unused        | 1.069s |
| only new-dead      | 0.373s |

Echo cap probe:

| `--max-echo-checks` |   Time |
| ------------------: | -----: |
|                   0 | 0.584s |
|                   1 | 2.133s |
|                   8 | 2.147s |

Vega_2.0 `diff-impact --json` reports 8 changed symbols. The first changed
symbol is `NAV_TRANSITION`, a constant, so any callee or callable-signature
work before the function-like check is wasted.

## Hypothesis

1. Move the `isFunctionLikeSymbol(target.symbol)` rejection into
   `findCallees()` immediately after `findFirstSymbolMatch()`. This preserves
   `similar()` output because non-function-like targets already return no
   results, but avoids constructing `ProjectIndex`, reading callee rows, and
   reading callable signatures for type/interface/module-like targets.
2. In `runEchoCheck()`, skip symbols that fail `isCallableSymbol()` before
   calling `similar()`. This uses the same callable predicate as production
   callable selection (`matchesCallableMode()` in
   `src/core/production-callables.ts:112-123`; Source:
   `scip-query code matchesCallableMode -C 20`) and avoids running code-echo
   similarity for changed constants like Vega's `NAV_TRANSITION`.

## Result

Accepted both guards. Paired baseline/current runs against the previous source
tree preserved output hashes:

| Probe                                   | Baseline | Current |   Delta | Output |
| --------------------------------------- | -------: | ------: | ------: | ------ |
| `only-echo --max-echo-checks 1`         |   2.113s |  0.356s | -1.757s | same   |
| `only-echo`                             |   2.147s |  2.118s |   -29ms | same   |
| `diff-gate --json`                      |   2.955s |  2.920s |   -34ms | same   |
| `similar DiffGateFinding --json --full` |   0.211s |  0.153s |   -58ms | same   |

The largest win appears when a diff's echo window is dominated by constants or
type-like symbols. The full Vega_2.0 diff still contains callable symbols, so
the aggregate `diff-gate` improvement is intentionally recorded as modest.

## Follow-Up: Source Fallback Scan Limit

After the callable prefilter, Vega_2.0 still spends most echo time in the first
callable target that falls through to source-shape similarity:

| Probe                                |   Time | Rows |
| ------------------------------------ | -----: | ---: |
| `similar ActiveNavIndicator --json`  | 2.384s |    0 |
| `similar NavItems --json`            | 1.227s |    1 |
| `similar ProjectHeroTintMenu --json` | 2.184s |    6 |

`similarBySourceShape()` in `src/queries/cleanup/similar.ts:511-553` currently
calls `getSourceFingerprintIndex(db)` without the `scanLimit` that the bounded
large-index command path passes to callee similarity. Source:
`scip-query plan-context similarBySourceShape`;
`scip-query code similarBySourceShape -C 80`.

`buildSourceFingerprints()` in `src/queries/cleanup/similar.ts:876-890`
currently tokenizes every production callable source snippet. Source:
`scip-query code getSourceFingerprintIndex -C 80`.

Hypothesis: key the source-fingerprint corpus/index by scan limit and use the
same `applyScanLimit()` policy as `buildCalleeFingerprints()` for bounded large
commands. This should preserve `--full` behavior, align bounded source fallback
with the documented bounded command budget, and reduce default diff-gate echo
fallback cost if Vega's findings remain byte-identical.

Accepted. Paired baseline/current runs against commit `522579f` preserved
output hashes while reducing the bounded source fallback used by echo:

| Probe                                | Baseline | Current |  Delta | stdout bytes | SHA-256                                                            |
| ------------------------------------ | -------: | ------: | -----: | -----------: | ------------------------------------------------------------------ |
| `similar ActiveNavIndicator --json`  |   2.182s |  1.911s | -272ms |          226 | `3316707fbf6cbab3f4543fecbe5e65a223d06bd2e563db876965ff7fc9c93c6d` |
| `similar ProjectHeroTintMenu --json` |   2.166s |  1.892s | -274ms |       10,384 | `9544740bea6d4b7efa31d3033ddfedb36035776049b1ce5e0e2f4258c0d393e8` |
| `only-echo`                          |   2.123s |  1.842s | -281ms |        1,211 | `162f52479ad23d4e481f4fe0cea288a3f0dfbe568b056190bd01e5c766697a90` |
| `diff-gate --json`                   |   2.913s |  2.620s | -294ms |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `similar --json --full`              |   1.409s |  1.380s |  -28ms |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |

The unbounded `similar --json --full` comparison confirms `--full` still uses
the complete source-fingerprint corpus. The speedup applies to bounded
large-index callers that already pass a scan limit, including diff-gate echo.

## Follow-Up: Source Fingerprint Evidence Cache

After the scan-limit pass, echo still paid a one-time source-token corpus build
per fresh process. Cap probes showed `--max-echo-checks 0` and `1` stayed near
0.35s because the first changed symbol was a skipped constant, while
`--max-echo-checks 2` jumped to about 1.88s and later changed symbols added
almost no time. Targeted probes showed the source-fallback targets
`ActiveNavIndicator` and `ProjectHeroTintMenu` at about 1.9s each.

Accepted: persist source-token fingerprints as `source-fingerprints` file
evidence. Each entry is guarded by the file content hash and by a
symbol/start/end/leaf definition key, so changed source bytes or changed
callable ranges recompute instead of reusing stale tokens. The first patched
`only echo` run populated 864 Vega_2.0 rows in 2.653s.

| Probe                                | Baseline | Current |   Delta | stdout bytes | SHA-256                                                            |
| ------------------------------------ | -------: | ------: | ------: | -----------: | ------------------------------------------------------------------ |
| `only echo`                          |   1.864s |  1.388s |  -476ms |        1,211 | `162f52479ad23d4e481f4fe0cea288a3f0dfbe568b056190bd01e5c766697a90` |
| `diff-gate --json`                   |   2.672s |  2.152s |  -520ms |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `similar ActiveNavIndicator --json`  |   1.899s |  1.443s |  -456ms |          226 | `3316707fbf6cbab3f4543fecbe5e65a223d06bd2e563db876965ff7fc9c93c6d` |
| `similar ProjectHeroTintMenu --json` |   1.899s |  1.415s |  -484ms |       10,384 | `9544740bea6d4b7efa31d3033ddfedb36035776049b1ce5e0e2f4258c0d393e8` |
| `similar --json --full`              |   1.401s |  1.372s |   -29ms |       88,859 | `59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf` |
| `health --json`                      |   2.537s |  2.569s | neutral |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The current `diff-gate` first repeat had a 3.371s process outlier; the next two
warm repeats were 2.152s and 2.114s. Health is neutral because this cache is
for targeted source-shape similarity, not the health `similarAll` path.

## Verification

- [x] Compared Vega `diff-gate --json`, `only-echo`, and
      `only-echo --max-echo-checks 1` output hashes before and after; all matched.
- [x] `npm run typecheck` passed.
- [x] `npm run build` passed.
- [x] `npm test` passed: 77 test files, 424 tests.
- [x] `node dist/cli.js reindex` rebuilt the local index in 2.7s.
- [x] `node dist/cli.js diff-impact --json` reported only
      `findCallees()` and `runEchoCheck()` as changed symbols.
- [x] `node dist/cli.js unused-params --json --full` returned no findings.
- [x] `node dist/cli.js recent-duplicates --json --full` returned no findings.
- [x] `node dist/cli.js diff-gate --json` passed after updating cited docs.

## 2026-06-28 Co-Change Partner Follow-Up

The `diffGate()` path still starts in `src/queries/impact/diff-gate.ts`. A
later cleanup taught the co-change partner check to use raw git changed paths
when checking whether a partner was already changed; echo output and timing
claims in this ledger are unchanged.
