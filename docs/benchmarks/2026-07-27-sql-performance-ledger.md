# SQL Performance Remediation Ledger

Date opened: 2026-07-27  
Baseline: `docs/benchmarks/2026-07-27-sql-performance-baseline.md`  
Machine-readable history:
`docs/benchmarks/runs/2026-07-27-sql-performance.jsonl`

The ledger is append-only. A row can be rejected without being deleted; its
failure is part of the evidence that constrains later designs.

| Candidate | Status | Correctness evidence | Performance evidence | Decision |
| --- | --- | --- | --- | --- |
| Full `(role, symbol_id, chunk_id)` mentions index | Rejected | Rows unchanged | Vega targeted lookup regressed 0.531 ms → 74.684 ms without statistics | Do not ship; leading role attracts a harmful plan. |
| Partial `(symbol_id, chunk_id) WHERE role = 1` index | Experiment accepted | Row hashes unchanged on both corpora | Definition map 10.118 → 5.231 ms and 53.001 → 30.762 ms; targeted lookups also improved | Implement with plan tests. |
| Final `ANALYZE` | Experiment accepted | Rows unchanged | Definition map improved again to 4.659 ms and 29.528 ms; exact-range join order also improved | Run after augmentation and maintenance. |
| Target-first `deps`/`rdeps` | Experiment accepted | Stable row hashes unchanged | 18.8×–478× improvement in observed probes | Extract one shared internal dependency loader. |
| Target-first coupling | Experiment accepted | Count unchanged | 23.228 → 0.142 ms | Replace targeted query only. |
| Exact path before range query | Experiment accepted | Same symbol match | 0.209 → 0.004 ms | Move indexed path resolution to storage and use equality. |
| Bulk semantic evidence SQL | Previously rejected | Hash comparison retained in the 2026-07-09 ledger | No relevant span improvement | Remains out of scope. |

## Implementation observations

The first target-first implementation allowed SQLite to reorder the forward
query from all target documents and all definition rows. It was rejected
before landing even though its relational text looked target-bounded.
`EXPLAIN QUERY PLAN` showed `SCAN target_d` and an automatic role-only partial
index. The corrected query materializes only symbols mentioned by the selected
documents, then joins outward by exact symbol identity.

| Workload | Before | Accepted implementation | Result |
| --- | ---: | ---: | --- |
| scip-query `deps(src/reindex/index.ts)` | 65.482 ms | 3.605 ms | 45 ordered paths, identical |
| scip-query `rdeps(src/reindex/index.ts)` | 8.053 ms | 0.567 ms | 4 ordered paths, identical |
| scip-query targeted coupling | 28.394 ms | 0.568 ms | 4 shared symbols, identical |
| scip-query whole definition map | 9.546 ms | 4.433 ms | identical rows; covering partial index selected |

The layout-maintenance probe used a private copy of the active database. It
added `idx_mentions_definitions`, removed both proven redundant indexes,
created eight `sqlite_stat1` rows, and produced the expected
`SCAN m USING COVERING INDEX idx_mentions_definitions` plan.

Final repository-wide validation will be appended below rather than rewriting
these observations.

## Closure

All four slices passed their focused suites and the full Vitest suite. The
repository-wide lint command also passed Prettier, ESLint, a production build,
the stable public TypeScript API check, the public-consumer compile check, and
skill-link validation.

Two refutation attempts were retained:

1. The built pre-change implementation and working-tree implementation were
   run against the same published database. Forward dependencies, reverse
   dependencies, and coupling produced byte-equivalent JSON values.
2. Adverse `EXPLAIN QUERY PLAN` inspection rejected the first forward-query
   rewrite because SQLite could still start from a broad role scan. The
   accepted form materializes symbols from selected documents first; its plan
   enters through `sqlite_autoindex_documents_1`, chunk document access, and
   exact mention keys before joining outward.

The metadata upgrade integration test also proves the first layout refresh
does not increase language-indexer attempt counts and the next unchanged
refresh uses whole-index reuse.
