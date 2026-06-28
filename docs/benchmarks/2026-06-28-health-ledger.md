# health Optimization Ledger

## Output Contract

- Target commands: `scip-query health --json` and `scip-query health --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve the health JSON envelope, category summaries,
  score, scoring reasons, detector counts, warnings, and advice semantics.

## Measurements

| Case                                                                         | Before |         After |        Delta | Evidence                                                                                                                                              |
| ---------------------------------------------------------------------------- | -----: | ------------: | -----------: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 focused warm `health --json`                                        | 6.979s |        3.913s | 43.9% faster | Latest warm matrix; stdout 15,342 bytes; SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`                                   |
| Vega_2.0 focused warm `health --json --full`                                 | 6.879s | 3.892s median | 43.4% faster | Repeated after source prefilter pass: 3.828s, 3.956s; stdout 15,360 bytes; SHA-256 `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |
| Vega_2.0 focused warm `health --json` with `SCIP_QUERY_HEALTH_CONCURRENCY=4` | 6.979s |        7.105s |       no win | Existing adaptive default is not improved by forcing 4 workers.                                                                                       |
| Vega_2.0 focused warm `health --json` with `SCIP_QUERY_HEALTH_CONCURRENCY=2` | 6.979s |       12.599s |       slower | Too little phase parallelism.                                                                                                                         |
| Vega_2.0 in-process `health(db, { full: true })` probe                       | 6.979s |       18.325s |       slower | Child-process phase parallelism is materially faster than serial in-process health on this corpus.                                                    |

## Initial Hypotheses

- Health phase orchestration is already faster than serial in-process health on
  Vega_2.0.
- Existing adaptive concurrency is near the useful band; forcing lower
  concurrency regresses.
- Remaining health work should target the slow individual phases rather than
  collapsing phase isolation.

## Decisions

- Accepted: keep the source identifier prefilter matcher as a shared
  source-fallback micro-optimization; health output hashes stayed unchanged and
  the latest warm health commands are materially lower than the ledger baseline.
  Attribution is not claimed as exclusively caused by the matcher because health
  phase timing has visible warm-cache/runtime variance.
- Rejected: lower health concurrency (`4` was flat, `2` was slower).
- Rejected: replacing isolated health with serial in-process `health()`; it was
  roughly 2.6x slower on Vega_2.0.
- Deferred: next health-specific work should target the remaining slow phases
  individually instead of changing phase orchestration.
