# Merge-readiness gate record

## Result

The blocker-remediation tree passed the required repository and package gates on 2026-08-09.

| Gate                     | Result                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch diff hygiene      | `git diff --check main...HEAD` passed                                                                                                        |
| Type safety              | Main TypeScript project and both contract fixtures passed                                                                                    |
| Formatting and ESLint    | Passed                                                                                                                                       |
| Build and declarations   | Passed                                                                                                                                       |
| Public API compatibility | API manifest and public-consumer compilation passed                                                                                          |
| Generated skills         | Skill-link validation passed                                                                                                                 |
| Full test suite          | 289 files and 2,364 tests passed with two workers                                                                                            |
| Architecture             | 476/476 files mapped across 37 boundaries; 37/37 dependency policies declared; no forbidden edges                                            |
| Packaged identity corpus | Passed                                                                                                                                       |
| Clean tarball install    | `scip-query@0.20.0` installed from its tarball; `--help`, `capabilities`, and the deprecated `scip-query/queries/plan-context` import passed |
| Cache lifecycle          | Eight incremental daemon cycles returned managed storage to the exact warm baseline                                                          |

## Package observation

`npm pack` produced a 1.4 MB tarball containing 392 files and 4.6 MB unpacked. The clean consumer installed 83 packages into an isolated temporary directory. The directory and tarball were removed after the smoke test.

## Architecture correction found by the gate

The first architecture run found the restored historical outcome-event type file outside every declared boundary. The final configuration gives deprecated, type-only contracts their own `queries-compatibility` boundary. That boundary may depend only on `domain`, and `queries-facade` may re-export it. The focused architecture and CLI suites then passed 67/67 tests before the final complete suite.

The first final-tree full-suite repetition also exposed a wall-clock assumption in the asynchronous process-lock test: a 5 ms release timer could be delivered after its 100 ms acquisition deadline under suite-wide process load. The test now queues the owner release as a microtask, which deterministically proves that acquisition yields the event loop. The corrected assertion passed 20 isolated repetitions before the final complete suite.

## Related evidence

- `docs/plans/2026-08-09-merge-readiness-blocker-remediation.md`
- `docs/validation/2026-08-09-cache-lifecycle-soak.md`
- `docs/API_EVOLUTION.md`
- `docs/DURABILITY.md`
