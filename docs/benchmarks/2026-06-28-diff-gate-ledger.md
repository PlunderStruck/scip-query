# diff-gate Optimization Ledger

## Output Contract

- Target command: `scip-query diff-gate --json`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Expected exit on this corpus: 1, because Vega_2.0 has one diff-gate finding.
- Required behavior: preserve the JSON envelope, checks run, finding IDs,
  finding content, root-cause groups, suppressions, output bytes, and exit
  behavior.

## Measurements

| Case                                                     |                                         Before |                                        After |                                                            Delta | Evidence                                                                                                                                      |
| -------------------------------------------------------- | ---------------------------------------------: | -------------------------------------------: | ---------------------------------------------------------------: | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 full `diff-gate --json`                         | 4.193s scoreboard / 3.218s focused warm median | 3.053s latest warm / 3.081s-3.123s warm band | 27.2% faster vs scoreboard / about 4.3% faster vs focused median | stdout 3,089 bytes; SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`                                                |
| Vega_2.0 all checks skipped                              |                                         0.416s |                                    not rerun |                                                    base overhead | `diff-gate --json --skip echo --skip incomplete-migration --skip co-change-partner --skip doc-reference --skip unused-params --skip new-dead` |
| Vega_2.0 echo-only probe                                 |                                         2.723s |                                2.276s-2.339s |                                             about 14%-16% faster | `diff-gate --json --skip incomplete-migration --skip co-change-partner --skip doc-reference --skip unused-params --skip new-dead`             |
| Vega_2.0 incomplete-migration-only probe                 |                                         1.548s |                                1.478s-1.485s |                                               about 4%-5% faster | `diff-gate --json --skip echo --skip co-change-partner --skip doc-reference --skip unused-params --skip new-dead`                             |
| Vega_2.0 `incomplete-migration --json --full` lazy index |                           1.623s paired median |                         1.432s paired median |                                                     11.8% faster | stdout 1,101 bytes; SHA-256 `8c9573e427ee68a30e74bb1d27fbd9d4b49ec02b095c3d7fa7440d2317fd4c51`                                                |
| Vega_2.0 `diff-gate --json` after lazy index             |                           2.860s paired median |                         2.872s paired median |                                                          neutral | stdout 3,089 bytes; SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`                                                |
| Vega_2.0 `diff-gate --json` after source fallback limit  |                           2.913s paired median |                         2.620s paired median |                                                     10.1% faster | stdout 3,089 bytes; SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`                                                |
| Vega_2.0 unused-params-only diff-gate probe              |                                         0.991s |                                0.356s-0.377s |                                             about 62%-64% faster | `diff-gate --json --skip echo --skip incomplete-migration --skip co-change-partner --skip doc-reference --skip new-dead`; same 1,202-byte output and SHA-256 `e02b4859ace33f159476ebaeb8e67c377472d94bbc488ee69ccef0a93f028a41` |
| Vega_2.0 full `diff-gate --json` after file-scoped unused params |                           2.082s focused warm |                 1.976s-1.986s warm band |                                               about 4.6%-5.1% faster | First patched run was a 3.721s process outlier; warm output stayed 3,089 bytes with SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |

## Current Pipeline

- `diffGate()` computes diff impact, changed files, base-content lookup, and
  changed-symbol preexistence, then runs six checks serially. Source:
  `scip-query plan-context diffGate`.
- Echo checks call `similar()` for each new changed symbol. Source:
  `scip-query code runEchoCheck -C 8`.
- Targeted `similar()` used to rebuild target-specific IDF by walking
  `[target, ...index.corpus]` on every target. Source:
  `scip-query plan-context compareAgainstFingerprints`.
- Incomplete migration used to build a fresh callee fingerprint index after
  loading cached callee fingerprints. Source:
  `scip-query plan-context incompleteMigration`.
- `unusedParams()` accepted a changed-file list from diff-gate, but loaded
  production callables for the whole repository before filtering to those
  files. Source: `scip-query plan-context unusedParams`.

## Decisions

- Accepted: derive target-specific IDF from `index.docFreq` plus the target
  callee set, then use the existing precomputed-magnitude path for targeted
  `similar()`. This preserves the old `computeIdf([target, ...corpus])`
  semantics and improves the echo-only diff-gate probe.
- Accepted: export and reuse `getCalleeFingerprintIndex()` from
  incomplete-migration so full diff-gate can reuse the callee index built by
  echo instead of rebuilding it.
- Accepted: lazily build the incomplete-migration callee fingerprint index only
  after a new helper has enough meaningful callees to score. Vega's current diff
  has two new helpers that are skipped before specificity scoring, so
  `incomplete-migration --json --full` avoids the global index while preserving
  output. Full `diff-gate --json` is neutral on this corpus because other checks
  dominate the combined command.
- Accepted: apply the existing scan-limit budget to source-shape similarity
  fallback for bounded callers. The unbounded `similar --json --full` path still
  builds the complete source-fingerprint corpus, while diff-gate echo avoids
  tokenizing the full corpus after callee similarity finds no result.
- Accepted: add a file-scoped path to `productionCallableDefinitions()` and pass
  diff-gate's changed-file list through `unusedParams()`. This preserves the
  unused-parameter detector rules, but starts from only the files the diff check
  is allowed to report on.
- Deferred: parallelizing independent diff-gate checks. The current serial
  order lets incomplete-migration reuse the echo-built index after this change;
  parallel execution would need shared-cache and output-order care.

## Verification

- `npm test -- tests/queries/cleanup/similar-topk.test.ts tests/analysis/similarity.test.ts tests/queries/impact/incomplete-migration.test.ts tests/queries/cleanup/recent-duplicates-pruning.test.ts`:
  passed 58 tests.
- `npm test`: passed 77 files / 422 tests.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- `npx vitest run tests/queries/cleanup/unused-params.test.ts`: passed 2 tests
  for file-scoped callable loading and file-scoped unused-parameter reporting.
- `npm test -- tests/queries/impact/incomplete-migration.test.ts tests/queries/impact/co-change-partner-labels.test.ts tests/runtime/cli-support.test.ts`:
  passed 37 tests after the lazy-index pass.
- Vega_2.0 `incomplete-migration --json --full`: output stayed 1,101 bytes
  with SHA-256 `8c9573e427ee68a30e74bb1d27fbd9d4b49ec02b095c3d7fa7440d2317fd4c51`.
- Vega_2.0 `diff-gate --json`: output stayed 3,089 bytes with SHA-256
  `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.
- Vega_2.0 unused-params-only diff-gate probe: output stayed 1,202 bytes with
  SHA-256 `e02b4859ace33f159476ebaeb8e67c377472d94bbc488ee69ccef0a93f028a41`.
- Vega_2.0 `unused-params --json --full`: output stayed 135 bytes with SHA-256
  `db71d3c18134a2a61734cf0673380426ab2f1999a7f45b6535724b68024880cb`.
- `scip-query reindex`: passed and left the local scip-query index fresh.
- `scip-query diff-gate --json`: passed with zero findings; the only emitted
  item was the accepted React/Vue cache echo suppression `SQ58DA50428777`.
