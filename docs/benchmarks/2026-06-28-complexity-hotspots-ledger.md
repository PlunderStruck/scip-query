# complexity-hotspots --full Optimization Ledger

## Output Contract

- Target command: `scip-query complexity-hotspots --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve the JSON envelope and every complexity hotspot
  finding, including LOC threshold semantics, fan-in/fan-out/callee counts,
  score calculation, and score/LOC ordering.

## Current Pipeline

- `complexityHotspots()` collects production callable definitions, prepares
  cross-file caller and callee evidence maps in bulk, scores each candidate,
  sorts by score then LOC, and applies the requested limit.
  Source: `scip-query trace complexityHotspots`.
- The CLI handler passes `--min-loc` as `minLoc`, `--full` as an infinite
  result limit, and the command analysis budget's scan/semantic settings.
  Source: `scip-query code handleComplexityHotspots -C 12`.
- `productionCallableDefinitions()` already supports a `minLoc` filter during
  candidate collection, but `complexityHotspots()` previously applied the
  threshold only inside per-candidate scoring after caller/callee evidence had
  been built.
  Source: `scip-query code productionCallableDefinitions -C 20`.

## Baseline Measurements

| Case                                          | Timings / value                      | Evidence                                                                                                             |
| --------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Vega warm `complexity-hotspots --json --full` | 1.437s, 1.424s, 1.416s, 1.436s       | Local built CLI; stdout 2,160,117 bytes; SHA-256 `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f`. |
| Vega callable candidates                      | 6,442 total; 4,642 at `minLoc >= 10` | `ProjectIndex.productionCallableDefinitions({ requireCallableSymbol: true, includeSuppressed: true })` probe.        |
| Vega semantic-off caller map                  | 599ms all candidates; 309ms filtered | Direct `ProjectIndex.crossFileCallerMap(..., { semantic: false })` probe.                                            |
| Vega semantic-off callee map                  | 254ms all candidates; 220ms filtered | Direct `ProjectIndex.calleeMap(..., { semantic: false })` probe.                                                     |
| Vega semantic-on caller map                   | 616ms all candidates; 345ms filtered | Direct `ProjectIndex.crossFileCallerMap(..., { semantic: true })` probe.                                             |
| Vega semantic-on callee map                   | 526ms all candidates; 257ms filtered | Direct `ProjectIndex.calleeMap(..., { semantic: true })` probe.                                                      |

## Decisions

- Accepted: pass `minLoc` into `productionCallableDefinitions()` from
  `complexityHotspots()`. A definition below the LOC threshold could only be
  discarded later, so excluding it before evidence preparation removes work
  without changing any visible finding.
- Accepted: compute unique callees and unique external callees in a single
  scoring loop instead of allocating filtered arrays and mapped key arrays per
  candidate.
- Accepted: push the callable-symbol suffix prefilter into the scoped
  definition SQL used by `productionCallableDefinitions({ requireCallableSymbol:
true })`. The JS `isCallableSymbol` filter remains authoritative, and loaded
  rows still pass through mixed-row merge and source range correction, so this
  only avoids loading obviously non-callable definition rows before the same
  filtering pipeline.

## Post LOC-Prefilter Measurements

| Case                                          | Before warm band               | After warm band                | stdout bytes | SHA-256                                                            |
| --------------------------------------------- | ------------------------------ | ------------------------------ | -----------: | ------------------------------------------------------------------ |
| Vega warm `complexity-hotspots --json --full` | 1.416s, 1.424s, 1.436s, 1.437s | 1.392s, 1.401s, 1.417s, 1.420s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| Vega `__health-phase complexity-hotspots`     | not previously isolated        | 1.080s, 1.081s, 1.084s, 1.097s |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |
| Vega `health --json`                          | 1.854s-1.914s current refresh  | 1.869s, 1.871s, 1.881s, 1.969s |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |

The standalone full command improvement is modest because output serialization
and the remaining large evidence passes now dominate the ~1.4s warm path. The
change is still accepted because it removes 1,800 impossible Vega candidates
before evidence preparation and keeps both standalone and health outputs
byte-identical.

## Post Callable SQL-Prefilter Measurements

Focused rerun with the rebuilt local CLI after the scoped definition catalog
added a SQL prefilter for callable-shaped symbols when the caller already asks
for `requireCallableSymbol`. The result set still goes through
`isCallableSymbol`, `mergeMixedSymbolQueryRows()`, and
`correctDefinitionRangesFromSource()`.

Stage probe:

| Case                                                      | Current value / timing | Evidence                                                               |
| --------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------- |
| Vega callable candidates at `minLoc >= 10`                | 4,642 candidates       | Same count as the prior ledger measurements.                           |
| `productionCallableDefinitions()` with callable prefilter | 339ms                  | Fresh source-module stage probe against Vega index.                    |
| `complexityHotspots(... semantic: true, full)`            | 952ms                  | Same process after candidate stage; useful for stage attribution only. |
| `complexityHotspots(... semantic: false, health shape)`   | 365ms                  | Same process after candidate stage; useful for stage attribution only. |

CLI rerun:

| Case                                      | Baseline median | Current median | Warm repeats                                                   | stdout bytes | SHA-256                                                            |
| ----------------------------------------- | --------------: | -------------: | -------------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| Vega `complexity-hotspots --json --full`  |          1.480s |         1.376s | 2.023s outlier, then 1.336s-1.395s-1.375s-1.413s-1.376s-1.369s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| Vega `__health-phase complexity-hotspots` |          1.127s |         0.957s | 1.070s-1.007s-0.942s-0.938s-0.957s-0.957s-0.936s               |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |
| Vega `health --json`                      |          1.766s |   noisy 1.938s | 1.881s-1.938s-1.932s-2.138s-2.021s                             |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| Vega `health --json --full`               |          1.791s |   noisy 2.049s | 2.058s-1.907s-1.972s-2.583s-2.049s                             |       15,360 | `04b21eddee3b52083217caa645599952fe9df998a917784516c43299c72b83ff` |

The accepted change is judged on the standalone command and isolated health
phase because those directly exercise the optimized catalog path. Aggregate
health kept byte-identical output but did not produce a clean same-session
runtime win in the short rerun; other parallel phases and machine noise
dominated that composite measurement.
