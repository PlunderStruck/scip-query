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
