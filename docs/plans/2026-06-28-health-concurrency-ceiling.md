# Health Concurrency Ceiling Plan

## Target

Make `scip-query health --json` faster on large repositories without changing
the health report's score, findings, actions, or JSON shape.

A health phase is one independently computed section of the codebase health
report, such as dead-code evidence, similarity evidence, or complexity
evidence. Health phase concurrency is the scheduler limit that decides how many
of those independent phase subprocesses can run at the same time.

## Evidence

- Benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`.
- Current focused warm repeats before the change:
  - `health --json`: 2.281s, 2.252s, 2.261s.
  - `health --json --full`: 2.278s, 2.325s, 2.256s.
  - `diff-gate --json`: 1.583s, 1.540s, 1.598s.
  - `complexity-hotspots --json --full`: 1.516s, 1.480s, 1.481s.
- `scip-query plan-context healthPhaseConcurrency --json` shows
  `healthPhaseConcurrency` is defined in `src/runtime/cli-support.ts`, is used
  by `runIsolatedHealthReport()`, and reaches `handleHealth()` and setup health.
- `scip-query refs healthPhaseConcurrency --json` shows the only direct runtime
  call site is `src/runtime/cli-support.ts` inside `runIsolatedHealthReport()`.
- `scip-query change-surface src/runtime/cli-support.ts --json --full` marks the
  file as medium risk overall, but the `MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY`
  constant itself has no external consumers.

## Measurement

Vega `health --json` concurrency sweep with the local built CLI kept the same
15,342-byte SHA-256 output
`edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`:

| `SCIP_QUERY_HEALTH_CONCURRENCY` | Warm repeats     |
| ------------------------------: | ---------------- |
|                               1 | 10.459s, 10.518s |
|                               2 | 5.627s, 5.667s   |
|                               3 | 4.255s, 4.180s   |
|                               4 | 3.349s, 3.379s   |
|                               5 | 2.843s, 2.810s   |
|                               6 | 2.564s, 2.553s   |
|                               8 | 2.395s, 2.320s   |
|                              10 | 2.157s, 2.149s   |
|                              12 | 1.897s, 1.962s   |
|                              14 | 1.983s, 1.924s   |
|                              16 | 1.877s, 1.957s   |
|                              20 | 1.996s, 1.941s   |

## Plan

1. Raise the adaptive default maximum health phase concurrency from 10 to 12.
2. Keep the minimum, CPU-aware default, item-count cap, and
   `SCIP_QUERY_HEALTH_CONCURRENCY` override behavior unchanged.
3. Update the unit tests for high-core defaults and invalid environment
   fallbacks.
4. Rebuild and rerun Vega `health --json` and `health --json --full` hash
   probes to prove the output contract stays unchanged.
5. Run focused runtime tests, typecheck, build, reindex, and diff-gate.

## Acceptance

- `healthPhaseConcurrency(20, {}, () => 14)` returns 12.
- `healthPhaseConcurrency(20, {}, () => 6)` still returns 5.
- `healthPhaseConcurrency(3, {}, () => 14)` still returns 3.
- Explicit `SCIP_QUERY_HEALTH_CONCURRENCY` overrides still win.
- Vega `health --json` keeps the same 15,342-byte SHA-256 output.
- Vega `health --json --full` keeps the same 15,360-byte SHA-256 output.
- Focused warm `health --json` timing moves from the current 2.25s-2.32s band
  toward the measured 1.90s-1.96s band.

## Rollback

If the post-change hash changes, the runtime tests fail, or the warm health
timing regresses after rebuilding, revert the cap to 10 and keep the
measurement table as a rejected probe.

## Outcome

- Implemented: `MAX_DEFAULT_HEALTH_PHASE_CONCURRENCY` moved from 10 to 12.
- Focused unit tests and typecheck passed.
- Rebuilt local CLI passed Vega probes with byte-identical output:
  - `health --json`: 2.116s, 1.933s, 1.949s; 15,342 bytes; SHA-256
    `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`.
  - `health --json --full`: 1.938s, 1.916s, 1.925s; 15,360 bytes; SHA-256
    `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff`.
