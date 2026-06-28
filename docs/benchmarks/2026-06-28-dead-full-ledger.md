# dead --full Optimization Ledger

## Output Contract

- Target command: `scip-query dead --json --full`
- Health phase target: `scip-query __health-phase dead --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve dead-symbol classification, skip reasons,
  summary fields, symbol rows, source-backed evidence, and health dead summary
  semantics.

## Measurements

| Case                                               |                        Before |                                        After |                                   Delta | Evidence                                                                                                                                                                 |
| -------------------------------------------------- | ----------------------------: | -------------------------------------------: | --------------------------------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Vega_2.0 focused warm `dead --json --full`         |                        4.222s | 4.070s latest matrix / 4.186s focused median | 3.6% faster latest / 0.9% faster median | `scip-query bench --json --command "dead --json --full"`; stdout 3,803,655 bytes; SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`             |
| Vega_2.0 focused warm `__health-phase dead --full` |                        2.895s |                        3.000s focused median |                            no phase win | Internal phase timing repeated after source prefilter pass: 3.022s, 2.977s; stdout 189 bytes; SHA-256 `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| Vega_2.0 JS/TS exclusion prefilter `dead --json --full` | 4.070s, 4.580s latest focused warm | 3.330s, 3.312s warm after first 4.274s probe | about 23% faster by focused-repeat average | Local `dist/cli.js` run from Vega_2.0; stdout 3,803,655 bytes; SHA-256 `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1` |
| Vega_2.0 JS/TS exclusion prefilter `__health-phase dead --full` | 3.176s, 2.895s latest focused warm | 2.219s, 2.193s warm after first 2.192s probe | about 27% faster by focused-repeat average | Local `dist/cli.js` run from Vega_2.0; stdout 189 bytes; SHA-256 `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab` |
| Vega_2.0 JS/TS exclusion prefilter `health --json` | 4.085s, 4.095s latest focused warm | 4.116s, 3.985s warm after first 4.091s probe | roughly neutral | Local `dist/cli.js` run from Vega_2.0; stdout 15,342 bytes; SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| Vega_2.0 deadCodeOnly caller-map skip trial        | 2.895s phase / 4.222s command |                3.840s phase / 4.520s command |                         no measured win | Phase output hash stayed `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`; code change reverted                                                        |

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
