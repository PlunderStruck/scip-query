# stale-abstractions --full Optimization Ledger

## Output Contract

- Target command: `scip-query stale-abstractions --json --full`
- Large benchmark corpus: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- Required behavior: preserve the JSON envelope and every stale-abstraction
  finding, including confidence, action tier, consumer evidence, reasons, and
  root ordering.
- Correctness checks: byte-for-byte output comparison against the installed
  `0.10.8` CLI, focused stale/identifier tests, typecheck, build, and
  diff-gate.

## Current Pipeline

- `staleAbstractions` loads type-like candidates, prepares consumer evidence in
  bulk, scores every candidate, sorts by confidence/LOC/path, and applies the
  requested limit.
  Source: `scip-query plan-context staleAbstractions`.
- `consumerMapForPossiblyStaleTypeCandidates` builds indexed caller evidence,
  then semantic evidence for possible stale rows, then source fallback for
  candidates that still appear to have at most one real consumer.
  Source: `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 12`.
- Source fallback calls `findCallerFiles`, which walks source files and calls
  `attributeIdentifier(db, file, name)` for candidate-name hits.
  Source: `scip-query trace findCallerFiles`.
- `attributeIdentifier` uses `sourceImportPathsByLocalName` for ambiguous leaf
  attribution. Before this pass, that derived per-file import map was rebuilt
  on every call even though `getSourceImports` itself was cached.
  Source: `scip-query code attributeIdentifier -C 8`;
  `scip-query code sourceImportPathsByLocalName -C 8`.

## Measurements

| Case                                                                    |  Before |   After |        Delta | Evidence                                                                                                              |
| ----------------------------------------------------------------------- | ------: | ------: | -----------: | --------------------------------------------------------------------------------------------------------------------- |
| Vega_2.0 focused `stale-abstractions --json --full`, cache-fill outlier | 43.268s | pending |      pending | `node dist/cli.js bench --json --command "stale-abstractions --json --full" --timeout-ms 600000`; stdout 83,654 bytes |
| Vega_2.0 warmed direct installed `0.10.8`                               |   3.13s |   2.43s | 22.4% faster | `/usr/bin/time -p`; byte-identical output, SHA-256 `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2` |
| Vega_2.0 warmed local bench after import-index cache                    |   3.13s |  2.362s | 24.5% faster | `node dist/cli.js bench --json --command "stale-abstractions --json --full" --timeout-ms 600000`; stdout 83,654 bytes |

## Decisions

- Accepted: cache `sourceImportPathsByLocalName(db, file)` per database and
  source file. The map is a pure derivation of cached source imports, and the
  existing `whole-project`/`source-file` invalidation groups match its
  lifecycle.
- Rejected: keeping the similar upper-bound pruning experiment from this pass.
  It preserved output, but the focused Vega `similar --json --full` workload
  did not improve over the installed baseline, so the code was removed.
- Deferred: the 43.268s stale-abstractions outlier appears to be a cache-fill
  path. A future pass should isolate which persistent evidence cache was cold
  before broadening the fix beyond the warmed command path.
