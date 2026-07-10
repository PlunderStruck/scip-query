# Detector Speed Slice: Complexity Hotspots And Twin Drift

Date: 2026-07-08

## Goal

Make the two VegaAssistant health phases that currently defer, `complexity-hotspots`
and `twin-drift`, fast enough for default health without weakening `--full`.
Done for this slice means default `complexity-hotspots` no longer takes roughly
42 seconds on VegaAssistant, `twin-drift` has an evidence-backed bounded
candidate path, the old exhaustive semantics remain available in full mode, and
the measured before/after numbers are recorded.

## Current State

`complexityHotspots()` loads production callable definitions, applies the
candidate scan budget, prepares caller/callee maps plus branch estimates, scores
candidates, and returns the top rows. Source:
`node dist/cli.js plan-context complexity-hotspots --json` and
`node dist/cli.js code complexityHotspots -C 20`.

`summarizeHealthComplexity()` passes `budget.semantic` and
`budget.candidateScanLimit` into `complexityHotspots()`, so large-index default
health already asks for bounded non-semantic analysis. Source:
`node dist/cli.js code summarizeHealthComplexity -C 20`.

`branchEstimateForDefinition()` currently estimates branches one definition at
a time by locating the smallest AST node covering the definition's line range
and walking that subtree. Source:
`node dist/cli.js code branchEstimateForDefinition -C 40`.

`twinDrift()` calls `allTwinGroups()`, which builds all twin drift records,
clusters by exact or near leaf name, then compares cross-file pairs inside each
cluster. Source: `node dist/cli.js plan-context twin-drift --json` and
`node dist/cli.js call-graph twinDrift --json`.

VegaAssistant baseline measurements with built `dist/cli.js`:

| Command                             | Result  | Runtime | Notes                                  |
| ----------------------------------- | ------- | ------: | -------------------------------------- |
| `complexity-hotspots --json`        | ok      |   42.1s | 20 rows; candidate pipeline 41.3s      |
| `complexity-hotspots --full --json` | timeout |  180.0s | semantic/full path still too expensive |
| `twin-drift --json`                 | timeout |  180.0s | did not finish                         |

VegaAssistant index size for the smoke target:

- 708 documents
- 41,475 symbols
- 38,236 definitions
- 222,471 references

Profile sidecars:

- `/tmp/scip-query-speed/vega-complexity-hotspots.jsonl`
- `/tmp/scip-query-speed/vega-twin-drift.jsonl`

## Reuse Audit

Reuse `runCandidateAnalysis()` for bounded/default detector behavior instead of
inventing a scheduler. Source: `node dist/cli.js code runCandidateAnalysis -C 20`.

Reuse `ProjectIndex.crossFileCallerMap()` and `ProjectIndex.calleeMap()` for
fan-in/fan-out evidence so output semantics stay aligned with the existing
query. Source: `node dist/cli.js code ProjectIndex.crossFileCallerMap -C 20` and
`node dist/cli.js code ProjectIndex.calleeMap -C 20`.

Extend the complexity branch estimator in `src/queries/quality/complexity.ts`
rather than duplicating branch counting in `complexity-hotspots.ts`; the existing
single-symbol query also owns branch semantics. Source:
`node dist/cli.js refs branchEstimateForDefinition --json`.

For twin drift, reuse the pure `groupTwins()` test seam and improve candidate
record selection ahead of it. Source: `node dist/cli.js plan-context twin-drift --json`.

## Testability Design

| Behavior                                                                    | Test seam                                         | Dependencies to inject       | Pure core                                        | Side-effect shell                      | Contract                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------- | ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------- |
| Bulk branch estimates match single-symbol estimates                         | `branchEstimatesForDefinitions()`                 | fake DB fixture              | branch counting over definitions grouped by file | AST/source/db reads inside estimator   | same `BranchEstimate` per symbol as `branchEstimateForDefinition()` |
| Complexity default avoids repeated per-symbol AST scans                     | `complexityHotspots()` fixture and Vega smoke     | real fixture DB / Vega index | score calculation unchanged                      | ProjectIndex maps and source AST reads | same top-row identity for tested fixtures; faster on Vega           |
| Twin drift compares only plausible cross-file leaf clusters in bounded mode | `groupTwins()` plus db-backed `twinDrift()` tests | fake records / fixture DB    | clustering and similarity classification         | record extraction from db/source       | full mode can remain exhaustive; bounded/default must be explicit   |

## Design Phases

### 1. Instrument and bulk-score complexity branches

- [x] **File**: `src/queries/quality/complexity.ts`
- **Source**: `node dist/cli.js code branchEstimateForDefinition -C 40`
- **What**: Branch estimates are computed per definition, causing repeated AST
  lookup/search work across many definitions in the same file.
- **Change**: Add `branchEstimatesForDefinitions()` that groups definitions by
  file, traverses each AST once when available, and falls back to the existing
  regex path only when needed.
- **Testability**: Compare bulk and single-symbol estimates on existing
  complexity fixture data.
- **Validation**: `npm test -- tests/queries/quality/complexity-hotspots.test.ts tests/source/source-backed-accuracy.test.ts`.
- **Why**: This keeps branch semantics owned by the complexity module while
  removing repeated per-symbol tree searches.

### 2. Use bulk branch estimates in complexity hotspots

- [x] **File**: `src/queries/quality/complexity-hotspots.ts`
- **Source**: `node dist/cli.js code complexityHotspots -C 20`
- **What**: `branchEstimatesByDefinition()` maps every candidate through the
  single-definition estimator.
- **Change**: Replace it with the bulk estimator and add profile metadata for
  prepare substeps if needed.
- **Testability**: Existing complexity hotspot tests should keep the same
  result ordering.
- **Validation**: VegaAssistant `complexity-hotspots --json` before/after with
  output hash.
- **Why**: This targets the confirmed 42 second bounded default path.

### 3. Add a bounded twin-drift candidate prefilter

- [x] **File**: `src/queries/cleanup/twin-drift.ts`
- **Source**: `node dist/cli.js plan-context twin-drift --json`
- **What**: `twinDriftRecords()` extracts records for all function-like
  definitions before grouping and pair comparison.
- **Change**: For bounded/default runs, preselect only definitions whose leaf has
  a same-file-excluding cross-file peer or a plausible near-name peer. Keep full
  mode exhaustive.
- **Testability**: Existing pure `groupTwins()` tests should remain unchanged;
  add/adjust db-backed tests for bounded prefilter behavior.
- **Validation**: VegaAssistant `twin-drift --json` returns within the command
  timeout; `twin-drift --full --json` remains the strict exhaustive path.
- **Why**: The fastest record is the one not extracted; twin drift only needs
  records that can participate in a cross-file twin cluster.

## Stress-Test Findings

Purpose: speed up the detector internals, not hide work behind larger timeouts.

Blast radius: `complexityHotspots()` is consumed by health, query exports, and
cleanup command handlers. `twinDrift()` and `allTwinGroups()` are consumed by
health, diff-gate, query exports, and cleanup handlers.

Valid intermediate state: phases 1 and 2 can ship independently and should make
complexity faster even if twin drift is unchanged.

Failure: bulk AST branch scoring must not silently drop regex fallback cases.
Twin drift bounded mode must disclose or preserve the full-mode escape hatch if
it prunes work.

Human experience: default health should stop deferring these phases; full mode
may remain slower until deeper indexing/caching work lands.

## Post-Implementation Measurements

Measured on VegaAssistant with built `dist/cli.js` after the slice:

| Command                      | Before       | After | Count | Notes                                                                 |
| ---------------------------- | ------------ | ----: | ----: | --------------------------------------------------------------------- |
| `complexity-hotspots --json` | 42.1s        |  6.5s |    20 | candidate pipeline 5.1s; 20,810 loaded, 7,183 filtered, 2,500 scanned |
| `twin-drift --json`          | 180s timeout | 0.63s |    20 | bounded prefilter avoids extracting records that cannot form twins    |
| `health --json`              | phase defers |  7.0s |   n/a | no deferred phases; large-index budget warning remains correct        |

Output hashes for reproducible smoke comparison:

- `complexity-hotspots --json`: `d6611ec3bef1`
- `twin-drift --json`: `03d8cf88c0df`
- `health --json`: `6270f5e5c895`

Accuracy notes:

- Complexity now uses a bulk branch estimator that walks each file AST once
  and assigns branch nodes to definitions whose ranges contain those nodes.
  This removes repeated tree searches and avoids previous Rust field/static
  overcounts where a non-callable symbol could inherit a much larger enclosing
  AST node.
- Complexity and twin-drift now treat Rust definitions as callable only when
  SCIP kind says they are function-like. This replaces ad hoc framework or
  library exclusions with language-index metadata.
- Bounded twin-drift prefilters only the scan-limited default candidate set.
  Unbounded/full mode still has no candidate scan cap; making that path fast
  enough for routine use requires persistent indexed detector products rather
  than bigger timeouts.

## Full-Pass Direction

Yes, a full pass without these limits is realistic, but only after the heavy
detectors stop recomputing source-derived products from scratch. A full pass is
the mode that examines the whole indexed project instead of a priority-capped
candidate subset; it becomes fast when branch estimates, normalized bodies,
callable-kind filters, and semantic call/reference products are persisted,
invalidated per changed file, and reused by every command. This slice removes
two immediate algorithmic bottlenecks; the remaining roadmap is durable
incremental products and long-lived semantic services.

## Verification

- [x] `npm test -- tests/queries/quality/complexity-hotspots.test.ts tests/source/source-backed-accuracy.test.ts tests/queries/cleanup/twin-drift.test.ts tests/queries/health/health-twin-drift.test.ts`
- [x] `npm run typecheck`
- [x] `npm run lint`
- [x] VegaAssistant smoke: `complexity-hotspots --json`, `twin-drift --json`, `health --json`
- [x] `node dist/cli.js recent-duplicates --json`
- [x] `node dist/cli.js reindex`
- [x] `node dist/cli.js diff-gate --json`
