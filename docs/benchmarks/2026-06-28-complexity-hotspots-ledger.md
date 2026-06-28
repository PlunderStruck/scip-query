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
- Accepted: prefilter AST caller-evidence callsites by the requested target
  leaf names before running language matching and candidate picking. A callsite
  whose parsed callee leaf is absent from the requested definition set cannot
  resolve to one of those target symbol IDs, so the gate preserves caller maps
  while skipping impossible resolution work.

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

## Post Caller Target-Leaf Prefilter Measurements

Focused rerun with the rebuilt local CLI after `buildCrossFileCallerMap()`
started deriving the target leaf set once and skipping AST callsites plus Rust
attribute references whose names cannot match the requested definitions.

Stage probe:

| Case                                          | Before | Current | Evidence                                                                         |
| --------------------------------------------- | -----: | ------: | -------------------------------------------------------------------------------- |
| Vega AST callsites entering candidate picking | 107377 | 12872\* | `getCallSites()` pass counted callsites whose `calleeLeaf` is in the target set. |
| Vega target definitions at `minLoc >= 10`     |   4642 |    4642 | Same callable candidate set.                                                     |
| Vega target leaf names                        |   4293 |    4293 | Derived from the requested definition records.                                   |
| Vega semantic-on caller map                   |  748ms |   627ms | Same 4,598 caller-map keys in the source-module stage probe.                     |
| `complexityHotspots(... semantic: true)`      | 1046ms |   623ms | Same top result in the source-module stage probe after warm caches.              |

`*` The source files are still parsed/read through the existing AST cache; the
new gate skips expensive leaf-index candidate filtering and AST candidate
selection for callsite leaves outside the target set.

CLI rerun:

| Case                                      | Previous focused median | Current median | Warm repeats                                            | stdout bytes | SHA-256                                                            |
| ----------------------------------------- | ----------------------: | -------------: | ------------------------------------------------------- | -----------: | ------------------------------------------------------------------ |
| Vega `complexity-hotspots --json --full`  |                  1.376s |         1.308s | 1.265s-1.274s-1.365s-1.265s-1.277s-1.308s-1.372s-1.388s |    2,160,117 | `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f` |
| Vega `__health-phase complexity-hotspots` |                  0.957s |         0.915s | 0.956s-0.934s-0.915s-0.888s-0.896s-0.871s-0.864s-0.925s |          670 | `38b928cf4b5e56ece26278a67c8bec1ad8b076629846392bbb91c8baac67741a` |
| Vega `health --json`                      |                  1.766s |   noisy 2.440s | 1.960s-2.825s-2.440s-2.163s-2.457s                      |       15,342 | `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d` |
| Vega `diff-gate --json`                   |                  1.179s |         1.271s | 1.411s-1.591s-1.271s-1.253s-1.269s                      |        3,089 | `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| Vega `isolated --json --full`             |                  1.140s |         1.246s | 1.241s-1.256s-1.322s-1.239s-1.246s                      |          130 | `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702` |

The accepted change is judged primarily on `complexity-hotspots` and its
isolated health phase, where target-scoped caller maps dominate. `diff-gate`,
`isolated`, and aggregate health stayed byte-identical; their same-session
runtime variation did not show a clean win because other phases dominate.
