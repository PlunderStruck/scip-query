# SQL-backed command performance campaign

Date: 2026-07-28

## Goal

Reduce the warm and cold latency of every scip-query command whose dominant
work is SQLite access, without changing its ordered result, evidence label,
coverage disclosure, diagnostics, pagination contract, supported input, or
failure behavior.

A SQL-backed command is a CLI operation whose observable result is materially
produced by statements against the compiler index database. This distinguishes
it from commands dominated by process startup, Git, source parsing, language
servers, serialization, or filesystem work: those commands remain in the
regression matrix, but SQL changes are accepted for them only when profiling
shows database work is actually dominant.

## Current Flow

The public command descriptors dispatch through the runtime query-command
handlers into `src/queries/**`. Query functions either issue focused statements
through `ScipDatabase`, or first materialize broad project structures such as
all definitions, reference maps, file-dependency graphs, and source-backed
semantic evidence. Results then pass through rendering and output pagination.

The phase-one SQL campaign established four reusable facts:

1. Definition discovery is a frequent shared primitive and is faster through
   the partial covering index
   `idx_mentions_definitions(symbol_id, chunk_id) WHERE role = 1`.
2. A target-specific command must enter the graph from the selected target;
   relational text that appears targeted is insufficient when
   `EXPLAIN QUERY PLAN` still begins with a broad scan.
3. Exact file identities should use indexed equality before fuzzy candidate
   scoring.
4. SQLite layout changes need a persisted layout version, maintenance tests,
   statistics refresh, and a no-indexer metadata-upgrade path.

The complete paginated `plan-context src/queries` snapshot covered 102 query
module files and reported 1,993 external surface uses. Its command-level
coverage was bounded, so it establishes broad coupling but is not treated as a
complete consumer oracle. Exact consumers for each accepted optimization will
be re-established from its touched symbol before editing.

## Affected Consumers

The campaign can affect:

- public CLI query commands and the programmatic query exports that share their
  implementations;
- health, diff-gate, plan-context, and cleanup commands that compose lower-level
  query functions;
- index publication and incremental patching if a physical index or derived
  table changes;
- output pagination and rendering only as correctness comparators, not as
  optimization targets in this SQL phase;
- tests and benchmark documentation that assert query plans, ordered results,
  output hashes, and performance history.

No command is assigned a behavior change. A candidate that changes output bytes
or stable parsed values is rejected unless the difference is proven to be
non-semantic transport metadata.

## Reuse Decision

The campaign extends the existing
`scripts/semantic-command-calibration.mjs` harness because it already records
command identity, corpus, duration, exit status, output size, output hash,
parsed summary, and built-in profile spans. A parallel command runner would
duplicate the trusted measurement contract.

Accepted SQL rewrites will extend the narrowest existing storage or internal
query helper. A new derived table, persistent cache, or general graph service
is permitted only if multiple measured commands share the same dominant work
and an ordinary query/index rewrite cannot remove it. Every such unit must name
the existing helper or table it could have extended and explain why that reuse
would not preserve ownership or invalidation.

## Slices

1. **Complete command inventory and harness coverage**
   - Add Vega_2.0 as a representative large corpus to the existing calibration
     harness and prevent benchmark subprocesses from starting background
     watchers.
   - Map every SQL-bearing query file to its public commands and composite
     consumers.
   - Validate with harness listing, a focused smoke run, and exact output hashes.

2. **Rank the current pipeline**
   - Run bounded SQL-backed commands on scip-query and Vega_2.0 twice to
     distinguish first-fill from warm latency.
   - Run heavy/full variants only with explicit timeouts and built-in profiling.
   - Classify each slow command as database time, broad scan, N+1 work,
     repeated setup, source/semantic work, serialization, or subprocess cost.
   - Write the baseline, append-only JSONL history, audit, and decision ledger.

3. **Remove repeated scalar database work**
   - For every confirmed N+1 family, batch exact keys in one statement or build
     one bounded map per invocation.
   - Preserve stable ordering and duplicates exactly.
   - Validate with focused unit tests, adverse-cardinality fixtures, output
     hashes, and before/after profiles.

4. **Replace confirmed broad scans**
   - Rewrite target-specific scans to enter from their target and make equality
     predicates access predicates.
   - Add or reorder an index only when production-scale plans show that the
     existing index cannot bound the walk.
   - Validate both corpora with `EXPLAIN QUERY PLAN`; retain rejected plans in
     the ledger.

5. **Consolidate shared whole-project SQL work**
   - If several commands still spend most of their time rebuilding the same
     definition/reference structure, evaluate one shared query helper before a
     persistent derived structure.
   - A persistent structure is acceptable only with explicit publication,
     incremental-update, layout-version, invalidation, and rollback behavior.
   - Validate output identity, full rebuild, incremental patch, old-layout
     upgrade, and added write cost.

6. **Re-measure every command family**
   - Repeat the two-corpus command matrix and compare medians, profiles, output
     hashes, timeouts, and regressions.
   - Revert any optimization whose realistic improvement is noise, whose output
     changes, or whose write/index cost outweighs its measured read benefit.

7. **Repository verification**
   - Run focused suites after each accepted slice.
   - Finish with formatting, lint, build, public API checks, the full test suite,
     Cargo checks when Rust surfaces are affected, fresh SCIP impact, routed
     postchecks, diff-gate, documentation reconciliation, and two executed
     refutation attempts.

## Risks and Unknowns

- End-to-end command time can hide a faster SQL statement behind fixed Node
  startup; direct statement timings and CLI timings must both be reported.
- Warm evidence and semantic caches can make iteration two faster without a SQL
  improvement. Profile spans and cache-state labels must separate those effects.
- SQLite may choose a harmful plan until statistics exist. Every accepted
  physical design therefore needs adverse-plan inspection before and after
  `ANALYZE`.
- Extra indexes make publication and incremental patching slower. Read wins are
  not free and must be compared with maintenance cost.
- Vega_2.0 is larger than scip-query but is still one workload. A candidate
  requiring a corpus-specific assumption is rejected or scoped explicitly.
- The campaign cannot promise that every command becomes faster. It promises
  that every SQL-backed family is measured and that every retained change has
  exact-output and realistic-latency evidence.

## Execution result

All implementation slices are complete.

1. The calibration harness now covers Vega_2.0, disables watcher startup in
   child processes, and uses successful path-qualified `methods` targets.
2. The 32-command two-corpus baseline and expanded remaining-command matrix
   are recorded in
   `docs/benchmarks/runs/2026-07-28-sql-command-performance.jsonl`.
3. Confirmed scalar repetition was removed from indexed-document discovery,
   source importer lookup, bottleneck caller evidence, and resolved reference
   chunk lookup.
4. Re-export discovery now enters through the bounded barrel-reference set.
   The final definition lookup uses the existing `(symbol_id, role)` access
   path rather than constructing a whole-project definition map.
5. The source-corrected definition catalog reuses exact
   matcher/scope/prefilter results, and fallback SQL excludes symbols already
   represented by corrected definition ranges.
6. The final Vega_2.0 medians are 1,335 ms for
   `redundant-reexports` (3,176.5 ms baseline) and 1,992 ms for
   `bottlenecks` (3,094.5 ms baseline), with identical output hashes.
7. Remaining slow commands were profiled and assigned to source, semantic,
   Git, or composite-pipeline follow-up rather than receiving speculative SQL
   changes.
8. Verification passed lint/build/API checks, Cargo, 2,066 tests across 261
   files, fresh SCIP impact, routed postchecks, self-audit, two executed
   refutations, and a zero-finding diff gate. The repository-wide health
   baseline remains separately red from 125 deltas in the larger pre-existing
   dirty worktree.

The full measurements, rejected designs, and residual classification are in:

- `docs/benchmarks/2026-07-28-sql-command-performance-baseline.md`
- `docs/benchmarks/2026-07-28-sql-command-performance-ledger.md`
- `docs/reviews/2026-07-28-sql-command-performance-audit.md`
