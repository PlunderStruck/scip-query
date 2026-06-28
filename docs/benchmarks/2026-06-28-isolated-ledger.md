# isolated --full Optimization Ledger

## Output Contract

- Target command: `scip-query isolated --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve the JSON envelope and every isolated callable
  finding. A finding is visible only when a production callable has no
  cross-file callers, no framework references, no non-self callees, no source
  fallback callers, and no additive callee evidence.

## Current Pipeline

- `isolated()` loads production callable candidates, builds strict non-self
  callee evidence, runs cross-file caller and framework reference checks only
  for candidates that still have no strict callees, then runs semantic
  caller/callee, source fallback caller, and additive callee checks before
  sorting output. Source: `scip-query trace isolated`.
- The CLI `--full` path passes an infinite result limit and keeps semantic
  evidence enabled. Health default calls the same query with bounded candidate
  limits and semantic disabled.

## Baseline Measurements

| Case                                      | Timings / value        | Evidence                                                                                                                                   |
| ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Vega warm `isolated --json --full`        | 1.293s, 1.258s, 1.282s | Local built CLI; stdout 130 bytes; SHA-256 `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702`.                             |
| Vega `__health-phase isolated`            | 1.157s, 1.133s, 1.138s | Local built CLI; stdout 63 bytes; SHA-256 `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329`.                              |
| Vega candidates                           | 6,663 total            | Stage probe against `ProjectIndex.productionCallableDefinitions()`.                                                                        |
| Vega strict non-self callees              | 4,050 candidates       | Stage probe against `ProjectIndex.symbolsWithNonSelfCallees(..., { semantic: false })`.                                                    |
| Vega candidates after strict callee prune | 2,623 candidates       | Reordered pipeline probe.                                                                                                                  |
| Vega current in-process query             | 1.650s                 | Probe ran the current `isolated()` implementation after cache state from earlier stage timing.                                             |
| Vega reordered in-process query           | 0.917s                 | Probe reordered strict callee evidence before caller evidence; result JSON matched current `isolated()` byte-for-byte.                     |
| Vega semantic caller evidence             | 277ms vs 0ms           | For 46 narrowed candidates, direct `semanticCallerMap()` returned the same 11 symbol IDs as `crossFileCallerMap(..., { semantic: true })`. |

## Post-Change Measurements

Focused rerun with the rebuilt local CLI after narrowing the caller-map target
set before caller evidence and replacing the repeated semantic caller pass with
direct semantic caller evidence.

| Case                                  | Current timings / value                                         | Evidence                                                                                                                                    |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Vega warm `isolated --json --full`    | 1.140s median; 1.773s outlier, then 1.163s-1.139s-1.132s-1.140s | stdout 130 bytes; SHA-256 `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702`.                                               |
| Vega `__health-phase isolated`        | 1.129s median; 1.127s-1.099s-1.141s-1.134s-1.129s               | stdout 63 bytes; SHA-256 `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329`.                                                |
| Vega `__health-phase isolated --full` | 1.173s median; 1.180s-1.172s-1.173s-1.173s-1.198s               | stdout 63 bytes; SHA-256 `483ba1fc03707fcb197b8eb48207444c446feda7e73732b3e45813b77c0da329`.                                                |
| Vega `health --json`                  | 1.864s median; 1.929s-1.956s-1.818s-1.840s-1.864s               | stdout 15,342 bytes; SHA-256 `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`; aggregate stayed in the same focused band. |
| Vega `health --json --full`           | 1.893s median; 1.901s-1.956s-1.893s-1.854s-1.841s               | stdout 15,360 bytes; SHA-256 `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff`; aggregate stayed in the same focused band. |

## Decisions

- Accepted: build strict non-self callee evidence before cross-file caller
  evidence, then run caller/framework checks only for candidates that still
  have no strict callees. A callable with any non-self callee cannot become an
  isolated result, so removing it before caller evidence preserves the output
  contract and reduces the caller-map target set from 6,663 to 2,623 on Vega.
- Accepted: use semantic-only caller evidence for the narrowed candidate set.
  `isolated()` has already proven SCIP/AST caller absence before this phase, so
  rerunning the full cross-file caller map can only repeat work plus add
  semantic references. The direct semantic map preserves the added evidence and
  skips the repeated non-semantic caller passes.
