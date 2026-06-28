# Remaining Semantic Optimization Ledger

Date: 2026-06-28

## Scope

This ledger records the follow-up optimization pass over the remaining commands
most likely to benefit from the semantic-reference bulk workflow. The benchmark
corpus is `/Users/aydansalois/Documents/GitHub/Vega_2.0`.

The run treated semantic evidence as a compiler-backed fact that a source
location refers to a definition. Cold runs deleted `semantic_references` and,
where relevant, `semantic_callees` from Vega's `evidence.db` while keeping the
SCIP index itself in place.

## Processes Covered

- `stale-abstractions --json --full`
- `isolated --json --full`
- `wrapper-candidates --json --full`
- `imports <file> --json --full`
- `unused-imports <file> --json --full`
- `drift --json --full`
- Representative graph/impact commands: `diff-impact`, `change-surface`,
  `bottlenecks`, and `hotspots`

## Accepted Changes

- `wrapper-candidates` now runs indexed consumer evidence first, sends only
  still-possible findings through semantic caller evidence, and runs source
  fallback only for candidates that remain possible.
- `stale-abstractions`, `isolated`, and `wrapper-candidates` can now use the
  TypeScript inverted reference scan for member symbols too; only `.d.ts` type
  members stay on precise `findReferences()`.
- The bulk reference scan threshold moved from 128 to 32 definitions so
  medium-sized commands such as `isolated --full` use one compiler-symbol scan
  instead of many precise reference calls.
- TypeScript semantic provider startup is now profiled at load, tsconfig
  discovery, project-bundle construction, provider construction, and source-file
  index construction.
- `ts-morph` project bundles now skip eager dependency resolution. Vega output
  hashes stayed identical, and project-bundle startup dropped from about 3.8s
  to about 0.8s per CLI process.
- `semanticImportUsage` now scans each import-bearing file once for imported
  local bindings instead of calling `findReferences()` per value import.
- `drift` now checks source, type-only, side-effect, and Vue conservative gates
  before semantic import usage. The boolean result is unchanged because each of
  those gates already caused the same skip before the reorder.

## Rejected Changes

- Lowering the bulk reference threshold before relaxing the member guard did
  not help `isolated`; it was rejected during the first experiment.
- Routing all `.d.ts` type members through the inverted scan changed
  `stale-abstractions` output by adding `ImportMetaEnv` / `ImportMeta` findings,
  so `.d.ts` type members remain precise.
- Replacing the accepted import scan with a raw compiler-AST import scan
  preserved output but did not improve the `typescript.import-usage.file` span,
  so it was reverted.

## Cold Measurements

| Command                                                         | Before this pass | Final accepted cold | Warm after cache | stdout bytes | Output check   |
| --------------------------------------------------------------- | ---------------: | ------------------: | ---------------: | -----------: | -------------- |
| `stale-abstractions --json --full`                              |          34.863s |              7.729s |           0.966s |       83,654 | `f8e0a9c7...`  |
| `isolated --json --full`                                        |           8.797s |              6.327s |           1.158s |          130 | `04e17adc...`  |
| `wrapper-candidates --json --full`                              |          18.857s |              7.316s |           1.228s |       78,437 | `311a9254...`  |
| `imports artifact-generation-run-store.ts --json --full`        |           7.146s |              3.946s |    not persisted |        4,723 | byte-identical |
| `unused-imports artifact-generation-run-store.ts --json --full` |           7.138s |              3.947s |    not persisted |          203 | byte-identical |
| `imports work-session.service.ts --json --full`                 |           7.776s |              4.024s |    not persisted |        3,148 | byte-identical |
| `unused-imports work-session.service.ts --json --full`          |           7.770s |              4.211s |    not persisted |          196 | byte-identical |
| `drift --json --full`                                           |           0.773s |              0.712s |              n/a |      725,988 | `4303db17...`  |

Notes:

- The final cold benchmark profile is
  `/tmp/scipq-remaining-bench/final-accepted-cold.jsonl`.
- Import usage is not persisted in `evidence.db`, so import commands still pay
  the TypeScript provider and per-file usage scan on each CLI process.
- Cleanup warm timings improve sharply because semantic reference rows are
  persisted after the cold run.

## Final Profile Highlights

Final accepted cold run:

- `typescript.provider.project-bundles`: about 0.8s per command process,
  down from about 3.8s before `skipFileDependencyResolution`.
- `typescript.references-map.inverted-scan`: 13.566s total across
  `stale-abstractions`, `isolated`, and `wrapper-candidates`.
- `typescript.references-map.file`: 0.758s total, now limited to `.d.ts` type
  member precision.
- `typescript.import-usage.file`: 9.866s total across four import commands.
- `semantic.callees.provider-loop`: 0.060s for `isolated`; it is no longer a
  meaningful bottleneck in this pass.

## Graph And Impact Commands

The representative graph/impact commands were already fast and did not justify
code changes:

| Command                                                              | Duration | stdout bytes | Notes                                    |
| -------------------------------------------------------------------- | -------: | -----------: | ---------------------------------------- |
| `diff-impact --json`                                                 |   0.709s |        7,020 | No hot semantic-reference span.          |
| `change-surface src/semantic/typescript/ts-morph-provider.ts --json` |   0.308s |          157 | Already dominated by indexed graph work. |
| `bottlenecks --json`                                                 |   1.036s |       16,090 | No change.                               |
| `hotspots --json`                                                    |   0.316s |        7,969 | No change.                               |

## Verification Notes

- `stale-abstractions`, `isolated`, `wrapper-candidates`, `imports`, and
  `unused-imports` were compared against pre-change JSON. Accepted outputs were
  byte-for-byte identical.
- `drift --json --full` was compared against the `0720bac` temporary worktree
  output and stayed byte-for-byte identical.
- The raw compiler-AST import scan was excluded because it did not improve the
  accepted profile.
