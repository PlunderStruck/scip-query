# SQL Performance Remediation Plan

Date: 2026-07-27  
Baseline revision: `9de38b98ac75fe0fa620d921c83911e7634e255c`  
Audit: `docs/reviews/2026-07-27-sql-performance-audit.md`  
Status: implemented and verified

## Goal

Make target-specific SQL work proportional to the named target, give
whole-project definition queries a selective covering access path, and ensure
the improved query layout reaches already indexed repositories without
rerunning unchanged language indexers.

Completion requires identical command results on representative corpora,
query-plan regression tests, a persisted layout upgrade contract, targeted and
full test suites, compiler-resolved postchecks, and a final diff gate.

## Current flow

1. SCIP indexers produce language `.scip` artifacts.
2. `scip expt-convert` materializes the official SQLite schema and indexes.
3. post-index augmentation adds source-backed evidence.
4. `removeRedundantSqliteIndexes` drops two provably duplicated indexes, but
   only on the fresh-materialization path.
5. metadata and the SQLite/SCIP artifacts are published as one immutable local
   generation.
6. unchanged work can bypass steps 2–5 through whole-project reuse.
7. target commands resolve a file pattern and then execute navigation or graph
   SQL against the published generation.

The performance defects arise at steps 4, 6, and 7: physical optimization is
incomplete, its deployment has no versioned eligibility rule, and several
target commands discard the target’s selectivity.

## Affected consumers

- `src/reindex/index.ts` is the sole production owner of SQLite maintenance
  and metadata publication.
- `src/reindex/incremental-sqlite-publication.ts` carries forward the prior
  database and must remain compatible with additive post-conversion indexes
  and statistics.
- `src/queries/navigation/deps.ts` is consumed by the query export surface,
  navigation runtime, and plan-context workflows.
- `src/queries/navigation/system.ts` supplies system exploration and planning.
- `src/queries/graph/coupling.ts` supplies graph risk output.
- `src/symbols/symbol-lookup.ts` is a high-fanout resolution boundary used by
  navigation, graph, cleanup, health, source-backed, and runtime commands.
- `src/queries/internal/file-resolution.ts` and
  `src/storage/scip-documents.ts` jointly own current path resolution.
- reindex metadata is consumed by freshness, generation identity, TypeScript
  semantic generation identity, shared-cache admission, and tests.

## Reuse decision

Reuse the existing official converter schema, `ScipDatabase` query port,
document-path scoring rules, language-shard cache, and immutable generation
publisher.

Extract only one new internal mechanism: target-bounded forward and reverse
dependency path loaders. `deps` and `system` currently duplicate the same SQL
and need one semantic owner. Do not introduce a generic query-builder
abstraction; the coupling query has a different shape and remains local.

Move indexed candidate resolution down to `src/storage/scip-documents.ts`.
The on-disk fallback stays query-owned because it serves source-text commands,
not SQLite identity.

## Invariants

1. Query outputs and ordering remain stable for valid current indexes.
2. Compiler-resolved symbol identity remains the relationship authority.
3. Exact path resolution precedes exact range SQL.
4. Whole-project commands remain complete; only target-specific commands are
   bounded by target.
5. `idx_mentions_definitions` contains only role-one rows, leads with
   `symbol_id`, and covers `chunk_id`.
6. Maintenance runs after the last row mutation and before final publication.
7. Current metadata records name the SQLite query-layout version.
8. Metadata without the layout field remains queryable and reusable for
   language shards, but cannot bypass layout maintenance.
9. A layout-only upgrade does not rerun unchanged language indexers.
10. No immutable published generation is modified behind an existing reader;
    the established metadata-only publication mechanism advances generation
    identity after maintenance.

## Slice SQL-01 — Physical query layout and planner statistics

**Finding:** SQL-01.

**Change:**

- rename the maintenance operation to describe complete query-layout
  optimization;
- add `idx_mentions_definitions(symbol_id, chunk_id) WHERE role = 1`;
- retain proof-based removal of the two redundant indexes;
- run `ANALYZE` after all layout changes;
- report added, removed, retained, and analyzed work without failing converter
  test doubles that are intentionally not SQLite.

**Tests:**

- schema and exact partial-index predicate;
- `EXPLAIN QUERY PLAN` for whole-definition and exact-symbol definition paths;
- retained unique-symbol and chunk-prefix access paths;
- `sqlite_stat1` creation;
- idempotent second maintenance run;
- non-SQLite skip behavior;
- unchanged result rows before and after maintenance.

**Acceptance:** both representative corpora keep identical result hashes and
show a material definition-map improvement; no role-leading full index is
introduced.

## Slice SQL-02 — Target-first dependency and coupling queries

**Finding:** SQL-02.

**Change:**

- add internal forward and reverse dependency-path loaders that enter through
  exact documents and their chunks;
- route `deps` and `system` through those loaders;
- replace targeted coupling’s global-symbol scan with two target-bounded
  directions combined by `UNION`;
- retain complete graph SQL for ranking commands.

**Tests:**

- existing navigation and graph command accuracy;
- ignored/self path filtering and deterministic ordering;
- multi-file `system` matches;
- bidirectional coupling and duplicate-symbol suppression;
- query-plan assertions that the target-specific forms enter through
  document identities and do not materialize an unbounded definition map;
- before/after row hashes on scip-query and Vega_2.0.

**Acceptance:** scip-query and Vega_2.0 target timings improve materially with
identical outputs.

## Slice SQL-03 — Indexed file-range resolution

**Finding:** SQL-03.

**Change:**

- move normalized indexed-document candidate scoring to storage;
- retain query-owned on-disk fallback;
- resolve a canonical indexed path before range lookup;
- use exact `relative_path = ?` predicates for corrected ranges and mention
  fallback.

**Tests:**

- exact, dot-prefixed, slash-normalized, suffix, basename, ambiguous basename,
  and fuzzy path behavior;
- range and fallback definition correctness;
- query plan uses the documents unique autoindex and the document-leading
  definition-range index instead of scanning all ranges.

**Acceptance:** public symbol resolution behavior is unchanged while the
exact-path plan and timing become index-bounded.

## Slice SQL-04 — Versioned layout deployment

**Finding:** SQL-04.

**Change:**

- define `CURRENT_SQLITE_QUERY_LAYOUT_VERSION`;
- add optional `sqliteLayoutVersion` to metadata v3 and validate it when
  present;
- write the current version on every publication and include it in canonical
  generation identity;
- require the current version for whole-SQLite unchanged reuse;
- run layout maintenance on the all-language-shards-reused publication path;
- preserve query and language-shard capabilities for older v3 metadata.

**Tests:**

- decoder accepts absence for overlap and rejects malformed present values;
- canonical identity changes when layout version changes;
- current metadata is whole-index reusable;
- missing/mismatched layout metadata reuses language shards, performs
  maintenance, and publishes current metadata without another indexer run;
- the upgraded database contains the partial index and statistics and lacks
  redundant indexes;
- a subsequent unchanged refresh takes the ordinary whole-index reuse path.

**Documentation:** update local generation publication and upgrade behavior.

## Risks and refutation

- **Planner regression:** a role-leading full index can attract a poor plan.
  The design rejects that index and tests both global and exact-symbol plans.
- **Semantic broadening:** directly joining all duplicate definitions can add
  dependency files. Production probes and fixtures will compare outputs;
  relationship queries retain current symbol-identity assumptions rather than
  inventing a new duplicate-definition contract in this performance slice.
- **Immutable generation mutation:** the upgrade must pass through the
  existing metadata-only publication and generation refresh sequence. Tests
  assert old handles retain old identity where the generation suite exposes
  that behavior.
- **Statistics staleness:** maintenance occurs after augmentation and after an
  incremental patch, not before.
- **Path-resolution drift:** the scoring implementation moves without changing
  values or priority thresholds. Query-resolution tests cover both indexed and
  on-disk behavior.
- **Benchmark overfitting:** scip-query and Vega_2.0 have different sizes and
  symbol distributions. A candidate must preserve output on both; one small
  fixture timing is not sufficient evidence.

## Verification sequence

For each slice:

1. focused tests for the modified boundary;
2. TypeScript typecheck and lint for changed source;
3. relevant `scip-query` postcheck after watcher refresh;
4. append measured results to the benchmark ledger.

Final closure:

1. `scip-query doctor`;
2. `scip-query status --capabilities`;
3. `scip-query diff-impact`;
4. full test suite, build, lint, and public API contract;
5. two explicit refutation attempts: output equivalence and adverse
   `EXPLAIN QUERY PLAN`;
6. `scip-query diff-gate`, with every finding fixed or explicitly accepted.

## Completion record

- SQL-01: partial definition index, redundant-index proof, final `ANALYZE`,
  idempotence, incompatible-index rejection, and query-plan coverage pass.
- SQL-02: target-symbol materialization and targeted coupling preserve exact
  outputs; an initially broad reordered plan was rejected before landing.
- SQL-03: normalized exact/suffix/basename path resolution and exact range SQL
  pass command-accuracy and adverse-plan tests.
- SQL-04: old layout metadata remains readable, upgrades from cached language
  shards once, publishes layout version 1, and then returns to whole-index
  reuse.
- Focused SQL/reindex/navigation/source/API suite: 155 tests passed.
- Full Vitest suite: passed.
- Typecheck, Prettier, ESLint, build, public API compatibility, public consumer
  typecheck, and skill-link validation: passed.
- `scip-query doctor`: fresh and healthy.
- Complete paginated `diff-impact`: 21 changed production files, 88 changed
  symbols, and 15 affected consumer files across this SQL program and the
  concurrently retained durability program; the full suite covers both.
- Complete `incomplete-migration`: no finding.
- Complete `recent-duplicates` in `src/queries/internal`: no finding.
- `similar fileDependencyPaths`: one low-similarity same-module
  wrapper/builder signal, reviewed and retained as two distinct
  responsibilities.
- Complete `doc-drift`: no finding naming the SQL performance documents or
  `INDEX_GENERATIONS.md`.
- Diff-gate’s metadata-guide advisory was fixed in
  `docs/REINDEX_METADATA_COMPATIBILITY.md`.
