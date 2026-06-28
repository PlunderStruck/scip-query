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

| Command                                           | Median | Exit | stdout bytes | SHA-256                                                            |
| ------------------------------------------------- | -----: | ---: | -----------: | ------------------------------------------------------------------ |
| `health --json`                                   | 2.939s |    0 |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| `diff-gate --json`                                | 2.906s |    1 |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `dead --json --full`                              | 1.989s |    0 |    3,803,655 | `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| `wrapper-candidates --json --full`                | 2.192s |    0 |       78,437 | `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58` |
| `stale-abstractions --json --full`                | 2.175s |    0 |       83,654 | `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |

Diff-gate check isolation on Vega_2.0:

| Case              | Median |
| ----------------- | -----: |
| all checks        | 3.033s |
| skip echo         | 1.980s |
| only echo         | 2.182s |
| only incomplete   | 1.243s |
| only co-change    | 0.712s |
| only doc-reference | 0.697s |
| only unused       | 1.069s |
| only new-dead     | 0.373s |

Echo cap probe:

| `--max-echo-checks` | Time   |
| ------------------: | -----: |
| 0                   | 0.584s |
| 1                   | 2.133s |
| 8                   | 2.147s |

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
   `src/core/production-callables.ts:72-83`; Source:
   `scip-query code matchesCallableMode -C 20`) and avoids running code-echo
   similarity for changed constants like Vega's `NAV_TRANSITION`.

## Result

Accepted both guards. Paired baseline/current runs against the previous source
tree preserved output hashes:

| Probe                                             | Baseline | Current | Delta  | Output |
| ------------------------------------------------- | -------: | ------: | -----: | ------ |
| `only-echo --max-echo-checks 1`                   |   2.113s |  0.356s | -1.757s | same   |
| `only-echo`                                       |   2.147s |  2.118s |  -29ms | same   |
| `diff-gate --json`                                |   2.955s |  2.920s |  -34ms | same   |
| `similar DiffGateFinding --json --full`           |   0.211s |  0.153s |  -58ms | same   |

The largest win appears when a diff's echo window is dominated by constants or
type-like symbols. The full Vega_2.0 diff still contains callable symbols, so
the aggregate `diff-gate` improvement is intentionally recorded as modest.

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
