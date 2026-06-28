# dead --full Optimization Ledger

## Output Contract

- Target command: `scip-query dead --json --full`
- Health phase target: `scip-query __health-phase dead --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve dead-symbol classification, skip reasons,
  summary fields, symbol rows, source-backed evidence, and health dead summary
  semantics.

## Measurements

| Case                                                            |                                            Before |                                          After |                                                                    Delta | Evidence                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------: | ---------------------------------------------: | -----------------------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 focused warm `dead --json --full`                      |                                            4.222s |   4.070s latest matrix / 4.186s focused median |                                  3.6% faster latest / 0.9% faster median | `scip-query bench --json --command "dead --json --full"`; stdout 3,803,655 bytes; SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`                                                                |
| Vega_2.0 focused warm `__health-phase dead --full`              |                                            2.895s |                          3.000s focused median |                                                             no phase win | Internal phase timing repeated after source prefilter pass: 3.022s, 2.977s; stdout 189 bytes; SHA-256 `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`                                                    |
| Vega_2.0 JS/TS exclusion prefilter `dead --json --full`         |                4.070s, 4.580s latest focused warm |   3.330s, 3.312s warm after first 4.274s probe |                               about 23% faster by focused-repeat average | Local `dist/cli.js` run from Vega_2.0; stdout 3,803,655 bytes; SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`                                                                                   |
| Vega_2.0 JS/TS exclusion prefilter `__health-phase dead --full` |                3.176s, 2.895s latest focused warm |   2.219s, 2.193s warm after first 2.192s probe |                               about 27% faster by focused-repeat average | Local `dist/cli.js` run from Vega_2.0; stdout 189 bytes; SHA-256 `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`                                                                                         |
| Vega_2.0 JS/TS exclusion prefilter `health --json`              |                4.085s, 4.095s latest focused warm |   4.116s, 3.985s warm after first 4.091s probe |                                                          roughly neutral | Local `dist/cli.js` run from Vega_2.0; stdout 15,342 bytes; SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`                                                                                      |
| Vega_2.0 deadCodeOnly caller-map skip trial                     |                     2.895s phase / 4.222s command |                  3.840s phase / 4.520s command |                                                          no measured win | Phase output hash stayed `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`; code change reverted                                                                                                           |
| Vega_2.0 post doc-drift cache heavy bench `dead --json --full`  |       3.157s single bench / 3.289s focused median |                          2.928s focused median |                                           11.0% faster by focused median | Local `dist/cli.js`; before repeats 3.414s, 3.289s, 3.173s; after repeats 2.928s, 2.996s, 2.894s; stdout 3,803,655 bytes; SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`                        |
| Vega_2.0 statement-cache `health --json`                        |                             2.946s focused median |                          2.938s focused median |                                                          roughly neutral | Before repeats 2.946s, 2.901s, 3.162s; after repeats 2.929s, 2.938s, 2.964s; stdout 15,342 bytes; SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`                                                |
| Vega_2.0 statement-cache `diff-gate --json`                     |                             2.994s focused median |                             2.933s warm median |                                roughly neutral / small win after outlier | Before repeats 2.994s, 2.980s, 3.026s; after repeats 3.476s, 2.931s, 2.933s; stdout 3,089 bytes; SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`                                                 |
| CPU profile, same command                                       |                               3.257s sampled wall |                            3.051s sampled wall |                                                 6.3% faster sampled wall | Same output hash; before top self-time included SQLite `all` 602.1ms, SQLite `get` 308.9ms, `prepare` 225.0ms. After top self-time had SQLite `all` 592.1ms, SQLite `get` 282.8ms, and a 15.9ms `statement()` helper entry. |
| Vega_2.0 scoped dead-candidate cache reuse `dead --json --full` | 3.453s latest full matrix / 2.928s focused median |     2.746s full matrix / 2.737s focused median | 20.5% faster vs latest full matrix / 6.5% faster vs prior focused median | Focused repeats 2.935s, 2.715s, 2.737s; full matrix 2.746s; stdout 3,803,655 bytes; SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`                                                              |
| Vega_2.0 scoped cache reuse `__health-phase dead --full`        |                         2.193s prior focused warm |                          2.035s focused median |                                                              7.2% faster | Focused repeats 2.041s, 2.024s, 2.035s; stdout 189 bytes; SHA-256 `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`                                                                                        |
| Vega_2.0 rejected shared catalog batch trial                    |                                       hashes same | health 3.554s-3.721s / diff-gate 4.463s-5.509s |                                                                 rejected | The batch `getScopedDefinitions()` prototype preserved `dead`, `health`, and `diff-gate` output hashes but slowed shared commands, so it was removed before shipping.                                                       |

## Initial Hypotheses

- Standalone `dead --full` may spend meaningful time serializing a very large
  JSON payload, but the health phase stays slow with a tiny payload, so query
  work still matters.
- The likely code-level target is repeated consumer/reference evidence lookup
  while classifying many definitions.
- CPU profiling showed `deadCandidateDefinitions()` as the largest inclusive
  cost before caller-map and source-reference work. A Vega index probe found
  that the old JS/TS exclusion prefilter matched 851 indexed JS/TS files, while
  a declaration-shaped hook prefilter matched 556, avoiding 295 likely
  unnecessary AST exclusion scans.

## Decisions

- Accepted: precompute source identifier candidate metadata once per scan via
  the source identifier matcher. The standalone `dead --json --full` output hash
  stayed unchanged and the latest public-command timings are slightly lower.
  This is not counted as a health dead-phase win because that internal phase was
  neutral to slightly slower in repeated focused runs.
- Accepted: tighten the JS/TS framework-exclusion prefilter so ordinary React
  hook calls such as `useState` do not force an AST exclusion pass. The AST
  exclusion path remains the authority for test files, custom hook declarations,
  and suppression comments. Vega output hashes stayed unchanged; focused warm
  `dead --json --full` improved to 3.330s/3.312s, and the dead health phase
  improved to 2.219s/2.193s.
- Rejected: skipping the final caller-map supplement for `deadCodeOnly` after
  source fallback. Vega output stayed identical, but runtime did not improve,
  so the accuracy-sensitive shortcut was reverted.
- Deferred: the next dead-specific pass should trace the source-fallback caller
  evidence scan itself, because metadata precomputation did not remove the main
  health-phase cost.
- Accepted: add a private prepared-statement cache to `ScipDatabase` so repeated
  SQL text uses one better-sqlite3 statement per connection. This removed the
  profile's `prepare` hot spot, kept `dead`, `health`, and `diff-gate` output
  hashes unchanged, and gave the clearest measured win to `dead --json --full`.
- Rejected: replacing `getScopedDefinitions()` with two broad scoped SQL reads
  grouped by path. The output hashes stayed unchanged, but `health --json` and
  `diff-gate --json` got materially slower in focused Vega probes, so the shared
  catalog batch path and `PerDbCache.set()` API were removed.
- Accepted: route `deadCandidateDefinitions()` through the existing scoped
  definition catalog instead of its bespoke path loop and stop clearing
  definition/source caches before the source fallback phase. This keeps the dead
  output hash unchanged, improves the standalone full command and dead health
  phase, and leaves `health` / `diff-gate` within their prior timing band.

## Verification

- Passed: `npm test -- tests/storage/db-path-exclusions.test.ts tests/resolution/path-resolver.test.ts tests/queries/navigation/queries.test.ts tests/queries/navigation/command-accuracy.test.ts`
- Passed: `npm run typecheck`
- Passed: `npm run build`
- Passed: `npm test`
- Passed: Vega local CLI hash probes for `dead --json --full`, `health --json`,
  and `diff-gate --json`.
- Passed: Vega local CLI `bench --json --include-heavy --timeout-ms 600000`.
- Passed: focused Vega local CLI hash probes after scoped cache reuse for
  `dead --json --full`, `__health-phase dead --full`, `health --json`, and
  `diff-gate --json`.
- Passed: latest Vega local CLI `bench --json --include-heavy --timeout-ms 600000`;
  `dead --json --full` recorded at 2.746s.
- Passed: `scip-query reindex`
- Passed: `scip-query diff-impact --json`
- Passed: `scip-query unused-params --json --full`
- Passed: `scip-query wrapper-candidates --json --full`
- Passed: `scip-query doc-drift --json --full`
- Passed: `scip-query recent-duplicates --json --full`
- Passed: `scip-query self-audit --json`
- Previous statement-cache pass: `scip-query diff-gate --json` passed with
  zero findings and zero root-cause groups.
- Latest scoped-cache pass: `scip-query diff-gate --json` reported only
  support-tier `doc-reference` findings for README and historical validation
  docs that cite `src/queries/cleanup/dead.ts` as a configuration-example path.
  The cited file target did not change, so these are accepted support findings.
  `scip-query diff-gate --json --skip doc-reference` passed with zero code or
  behavioral findings.
