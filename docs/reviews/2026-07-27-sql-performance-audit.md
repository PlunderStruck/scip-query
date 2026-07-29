# scip-query — SQL Performance Audit

Date: 2026-07-27  
Audited revision: `9de38b98ac75fe0fa620d921c83911e7634e255c`  
Audited package version: `0.19.8`  
Method: `sql-performance`, `scip-audit`, and compiler-resolved `scip-query`
relationship evidence; no sub-agents

## Outcome

The audit found four actionable SQL-performance defects:

| ID | Severity | Finding | Representative evidence |
| --- | --- | --- | --- |
| SQL-01 | High | Definition lookup lacks a definition-selective covering access path, and published databases lack planner statistics. | A whole-project definition map took 53.001 ms on Vega_2.0. A partial definition index reduced it to 30.762 ms, and `ANALYZE` reduced it to 29.528 ms without changing rows. |
| SQL-02 | High | Target-specific dependency and coupling queries first materialize or inspect whole-project symbol sets. | Vega_2.0 `deps` fell from 111.060 ms to 0.531 ms with a target-first join. The scip-query corpus fell from 24.380 ms to 0.051 ms. |
| SQL-03 | Medium | `file:line-line` symbol lookup wraps an exact document identity in a leading-wildcard `LIKE`. | The scip-query range lookup fell from 0.209 ms to 0.004 ms when exact path resolution preceded the range query. |
| SQL-04 | High | Query-layout maintenance runs only on newly materialized SQLite databases and has no persisted layout version. | The active database still contained both indexes an earlier remediation intended to remove because whole-project reuse bypassed maintenance indefinitely. |

The defects are related but not interchangeable. SQL-01 concerns the physical
access paths and statistics made available to SQLite. SQL-02 and SQL-03 concern
query shapes that ask SQLite to inspect far more rows than the user’s target
requires. SQL-04 concerns deployment: a correct optimization that never reaches
an existing reusable generation is not a shipped optimization.

**Remediation status:** SQL-01 through SQL-04 were implemented and verified on
2026-07-27. The physical layout now adds the partial definition index and
planner statistics; target dependency, system, coupling, and exact range
queries enter through their named targets; and metadata layout version 1
deploys the optimization to existing cached shards without rerunning unchanged
indexers.

## Scope and evidence

The audit covered:

- the official SCIP SQLite tables and indexes used by query commands;
- the query shapes for dependencies, reverse dependencies, system maps,
  coupling, symbol/range resolution, imports, graph rankings, and health
  detectors;
- the evidence-cache databases and retention queries;
- full and incremental SQLite publication;
- whole-project and language-shard reuse;
- local and shared generation identity;
- production database plans and timings in this repository and Vega_2.0.

`scip-query plan-context`, `trace`, `refs`, and `affected` established the
entry-to-effect paths and consumers. Native source reads were used for literal
SQL, metadata fields, tests, and documentation. Complete result sets were
consumed whenever a SCIP command paginated.

The active scip-query database contained 400 documents, 1,256 chunks, 28,448
global symbols, 94,685 mentions, and 5,753 corrected definition ranges. The
Vega_2.0 sample contained 2,670 documents, 132,010 symbols, and 374,806
mentions. These are large enough to expose table-wide query work while still
being ordinary project indexes, not synthetic stress-only data.

## Essential distinctions

A **filter predicate** is a condition applied after candidate rows are found.
Its concrete referents here include `role = 1`, path exclusions, and
`relative_path = ?`. What distinguishes it from an access predicate is that it
does not itself guarantee a narrow starting range in an index.

An **access predicate** is a condition SQLite can use to enter an ordered index
at the first relevant key. `relative_path = ?` against the documents unique
index and `role = 1` against a role-selective partial index are access
predicates. Their essential performance property is that irrelevant rows do
not have to be visited and rejected.

A **target-first query** is a relational query whose first bounded row set is
the exact file or symbol named by the user. It differs from a whole-project
query followed by a target filter because project size does not determine the
amount of preliminary work.

A **query-layout version** is persisted metadata identifying which
post-conversion indexes and planner statistics a published database is
guaranteed to contain. Its essential role is deployment: a metadata match
allows safe whole-database reuse; absence or mismatch requires one
rematerialization or maintenance pass even when source inputs are unchanged.

## SQL-01 — Missing definition-selective covering index and planner statistics

### Current behavior

The official converter supplies
`idx_mentions_symbol_id_role(symbol_id, role)`. This is valuable for exact
symbol lookups, but the leading key is `symbol_id`. The recurring definition
map:

```sql
SELECT m.symbol_id, c.document_id
FROM mentions m
JOIN chunks c ON c.id = m.chunk_id
WHERE m.role = 1
GROUP BY m.symbol_id
```

therefore scans the mentions index and filters role after visiting rows. It
also performs a table lookup for `chunk_id`, because the existing index does
not cover that column.

Several production commands genuinely need a whole-project definition map:
top fan-in, top fan-out, top coupling, hotspots, drift, redundant re-exports,
and full file-dependency graph construction. Their work cannot be eliminated
by merely moving a file filter.

Published databases also contain no `sqlite_stat1` rows. SQLite must infer
selectivity from schema alone. A trial full index beginning with
`(role, symbol_id, chunk_id)` made the whole-project query faster but caused a
Vega_2.0 targeted dependency query to regress from 0.531 ms to 74.684 ms before
`ANALYZE`, because the planner chose the role prefix instead of the exact
symbol path. That candidate is rejected.

### Required correction

Create a partial covering index:

```sql
CREATE INDEX IF NOT EXISTS idx_mentions_definitions
ON mentions(symbol_id, chunk_id)
WHERE role = 1;
```

Only definition rows occupy the index. It preserves `symbol_id` as the first
key for exact lookups, covers the join to chunks, and lets SQLite scan a much
smaller structure for whole-project definition maps. Run `ANALYZE` after all
augmentation and index maintenance so published statistics describe the final
database.

### Acceptance evidence

- output row hashes remain identical on scip-query and Vega_2.0 probes;
- `EXPLAIN QUERY PLAN` selects `idx_mentions_definitions` for both the
  whole-definition scan and a symbol-specific definition lookup;
- the global-symbol unique autoindex and the wider chunk document/range index
  continue to serve the indexes removed as redundant;
- `sqlite_stat1` exists after maintenance;
- a role-leading full index is not introduced.

## SQL-02 — Target-specific graph queries perform whole-project work

### Current behavior

`deps`, `rdeps`, and both dependency halves of `system` join a derived
definition table that groups every role-one mention in the project, then
apply the requested path. `coupling(file1, file2)` scans every global symbol
and evaluates four correlated `EXISTS` subqueries.

These are target-specific commands: the user has already named one or two
files. Their result size is bounded by relationships touching those files,
but their preliminary work currently grows with every symbol or definition in
the repository.

### Required correction

Resolve the file pattern once, enter through the unique document path, read
only mentions belonging to those document chunks, and join outward by symbol
identity. Share the forward and reverse dependency row loaders between
`deps` and `system` so the optimized semantics cannot drift. Count coupling
from the union of two target-bounded directions rather than from a scan of
`global_symbols`.

The optimization must preserve:

- compiler-resolved symbol identity;
- local-symbol and ignored-path filtering;
- deterministic path ordering;
- self-dependency exclusion;
- existing output shapes and action-tier text.

Commands whose purpose is a whole-project ranking keep their complete graph
queries. This finding does not justify converting every definition-map query
to a target-first form.

## SQL-03 — Exact range lookup is expressed as a leading-wildcard search

### Current behavior

`findFileLineSymbolRow` parses a user input such as
`src/predicates.ts:2-2`, but passes `%src/predicates.ts%` into both the
corrected definition-range query and its mention fallback. A leading wildcard
cannot use the unique `documents(relative_path)` access path. The observed
plan scanned definition ranges before filtering the path.

The query layer already has a deterministic resolution policy: normalized
exact path, suffix, basename, fuzzy substring, then a symbol fallback. That
policy is trapped in a query-owned module, so the foundational symbol lookup
reimplements only the fuzzy SQL portion.

### Required correction

Move indexed-document candidate resolution to the storage boundary, retain
the query layer’s on-disk fallback, and have `file:line-line` resolution obtain
one canonical indexed relative path before issuing the range query. The final
SQL predicate becomes `d.relative_path = ?`.

Regression coverage must include exact paths, leading `./`, Windows
separators, suffixes, basenames, ambiguous basenames, and the fallback from
corrected ranges to definition mentions.

## SQL-04 — Existing reusable databases never receive query-layout maintenance

### Current behavior

`removeRedundantSqliteIndexes` is called only from fresh SQLite publication.
`reuseExistingIndexIfPossible` returns before that point. When source inputs
change but every language shard is reusable, the metadata-only path also
skips the maintenance function.

The active database demonstrated the consequence: it retained
`idx_global_symbols_symbol`, although the table’s unique constraint already
provides the same key, and `idx_chunks_doc_id`, although
`idx_chunks_line_range(document_id, start_line, end_line)` already provides
that prefix. The prior remediation exists in source and tests but did not
reach the reusable generation.

### Required correction

Persist `sqliteLayoutVersion` in current reindex metadata and include it in the
canonical generation identity. Current metadata without the field remains
valid for querying and language-shard reuse, but is not eligible for
whole-SQLite reuse. The next refresh reuses unchanged language shards, applies
query-layout maintenance and statistics, publishes current metadata, and then
resumes ordinary whole-project reuse.

This is a cache upgrade, not a source reindex requirement. It must not rerun a
language indexer merely because the SQLite query layout changed.

## Verified non-findings

- Evidence-cache point lookups use exact primary keys; shared evidence has a
  dedicated LRU index. No production query justified an additional index.
- The only database `OFFSET` use in the reviewed retention code is capped at
  5,000 rows per maintenance check. It is bounded trimming, not interactive
  user pagination, so keyset pagination would add complexity without a
  measured benefit.
- Leading-wildcard scope and fuzzy-path searches implement intentional
  substring semantics. The documents table is comparatively small, and exact
  entry points are retained where the input is exact.
- Parameter batches are capped below SQLite’s variable ceiling.
- No catch-all nullable predicate, implicit numeric/text cast, or
  function-wrapped indexed timestamp predicate was found in a performance-
  sensitive query.
- A prior experiment to bulk-load semantic evidence did not improve the
  measured semantic-prewarm cost and remains rejected. This audit does not
  relabel that rejected N+1 hypothesis as a finding.

## Remediation mapping

The approved implementation is
[`../plans/2026-07-27-sql-performance-remediation.md`](../plans/2026-07-27-sql-performance-remediation.md).
Each finding is an independently testable slice. The benchmark baseline and
append-only ledger live under `docs/benchmarks/`.
