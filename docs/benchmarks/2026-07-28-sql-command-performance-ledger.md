# SQL-backed command performance decision ledger

Date opened: 2026-07-28  
Baseline:
`docs/benchmarks/2026-07-28-sql-command-performance-baseline.md`  
Machine-readable history:
`docs/benchmarks/runs/2026-07-28-sql-command-performance.jsonl`

This ledger keeps successful and failed experiments. A rejected design is
evidence about what the system must not assume; it is not removed when a later
candidate succeeds.

## Accepted changes

| Candidate                                                                                                       | Correctness evidence                                                                          | Performance evidence                                                                            | Decision                                |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------- |
| Cache immutable indexed document paths per database and option set                                              | Mutation-safety test; identical result hashes                                                 | Vega re-export analysis stopped returning 825,030 duplicate document rows across 309 calls      | Accepted                                |
| Build one source-importer inverse per re-export analysis                                                        | Fixture retains direct-consumer count; identical large-corpus hash                            | Vega direct analysis settled around 435 ms after the first two slices versus 1,886 ms initially | Accepted                                |
| Cache the large-index targeted-caller strategy per database                                                     | Graph regression asserts one symbol-count statement                                           | Removes up to one count statement per candidate; prerequisite to caller batching                | Accepted                                |
| Batch caller rows for all bottleneck candidates                                                                 | Scalar/bulk equivalence test; identical command hash                                          | Vega CLI median 3,094.5 ms → 1,992 ms in the final three-run repeat                             | Accepted                                |
| Batch resolved reference chunks across symbols                                                                  | Bulk/scalar reference-site equivalence; pagination/reference suites pass                      | Vega bottleneck SQL calls collapse from thousands to a bounded batch set                        | Accepted                                |
| Exclude mention fallbacks for symbols already represented by corrected definition ranges                        | Merged rows identical on both corpora                                                         | Vega fallback rows 29,490 → 19,523; statement median 244.6 → 234.0 ms                           | Accepted as a low-risk shared reduction |
| Cache scoped matched definitions by matcher identity, scope, and SQL prefilter                                  | Test proves repeat reuse, predicate isolation, and mutation-safe arrays                       | Prevents duplicate exact catalog production inside composite commands                           | Accepted                                |
| Start re-export SQL from barrel references and keep that bounded set on the outer side of the definition lookup | Exact ordered rows on both corpora; fixture covers scoped SCIP barrel; final hashes unchanged | SQL core: Vega 226.0 → 1.83 ms; scip-query 44.2 → 2.46 ms                                       | Accepted                                |
| Add Vega_2.0 and valid path-qualified class targets to the calibration harness                                  | Both `methods` probes now exit zero                                                           | Removes false command failures from future matrices                                             | Accepted                                |

## Rejected or bounded experiments

| Candidate                                                                             | Evidence                                                                                                                     | Decision                                                                               |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Force ordinary materialized barrel/definition CTEs without controlling join order     | Vega 229.5 → 230.2 ms; no improvement                                                                                        | Rejected                                                                               |
| Replace mention-derived definition identity with only `defn_enclosing_ranges`         | Vega was exact and 225 → 50 ms, but scip-query lost 10 fallback-only rows                                                    | Rejected for incompleteness                                                            |
| Union primary definitions with mention fallback through an anti-join                  | Exact rows, but Vega 223.2 → 236.8 ms and scip-query 44.2 → 47.8 ms                                                          | Rejected                                                                               |
| Materialize bounded barrel references but allow SQLite to reorder the definition join | Exact rows; Vega 226 → 28 ms                                                                                                 | Superseded by `CROSS JOIN`, which preserves the bounded outer loop and reaches 1.83 ms |
| Force `INDEXED BY idx_mentions_definitions`                                           | Active published generations did not all contain that newer optional index                                                   | Rejected as an unnecessary compatibility constraint                                    |
| Cache a project-wide projection over `getScopedDefinitions`                           | After existing per-file caches warmed, repeated walks were already about 0.45–3.9 ms                                         | Rejected as complexity without material command benefit                                |
| Replace scoped bulk definition SQL with the persisted per-file definition cache       | Vega 562 → 211 ms, but omitted 50 fallback/interface method rows                                                             | Rejected for output loss                                                               |
| Batch wrapper `mentionChunkForCaller` reads                                           | 2,996 scalar calls sounded severe, but together took only 12.6 ms in a 7,683 ms direct run                                   | Rejected; source and consumer classification dominate                                  |
| Batch `change-surface` consumer reads                                                 | 85 scalar calls took 0.91 ms in a 71 ms direct run                                                                           | Rejected; below the meaningful threshold                                               |
| SQL-tune `affected`                                                                   | 5.3–6.1 seconds sits in the TypeScript semantic reference provider                                                           | Rejected for this lens                                                                 |
| SQL-tune `dead` beyond the shared fallback reduction                                  | SQL was about 14.5% of the measured Vega direct run; candidates and source fallback dominated                                | Rejected for this lens                                                                 |
| SQL-tune `isolated` through statement batching                                        | Only 14 SQL calls were observed; candidate production and strict callees dominated                                           | Rejected for this lens                                                                 |
| Add another physical SQLite index                                                     | Accepted rewrites use existing document, chunk, and mention access paths; no remaining plan justified publication/write cost | Rejected                                                                               |

## Final query-plan evidence

The accepted re-export query first materializes `barrel_refs` from the small
set of `index.ts`/`index.js` documents. Its definition subquery uses:

```text
SEARCH m2 USING INDEX idx_mentions_symbol_id_role (symbol_id=? AND role=?)
```

`CROSS JOIN` is used for loop-order control: the bounded barrel-symbol set is
the outer loop, and each definition lookup enters the existing
`(symbol_id, role)` index. Without that constraint, SQLite scans definition
mentions and applies a bloom filter afterward.

No index was added. The query works with the converter’s longstanding
`idx_mentions_symbol_id_role` access path and does not require the newer
optional definition-only index.

## Closure criteria

The campaign closes only after:

- focused equivalence and adverse-cardinality tests pass;
- the build and public TypeScript declarations succeed;
- the complete Vitest suite passes;
- the final large-corpus hashes match the baseline;
- SCIP postchecks and `diff-gate` are reconciled;
- residual slow commands are classified by their measured dominant resource,
  not merely left as “still slow.”

All closure criteria passed for the SQL campaign. The complete suite passed
2,066 tests in 261 files; lint, build, declarations, API checks, Cargo, fresh
SCIP impact, routed postchecks, self-audit, and diff-gate completed. The broad
health baseline remains red with 125 deltas from the larger pre-existing
working-tree program, recorded separately from these exact-output SQL
optimizations.
