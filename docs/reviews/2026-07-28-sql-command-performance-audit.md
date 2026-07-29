# scip-query — SQL-backed command performance audit

Date: 2026-07-28  
Audited revision: `9de38b98ac75fe0fa620d921c83911e7634e255c` plus the working-tree campaign  
Method: `sql-performance`, `scip-audit`, `scip-plan`, `scip-improve`, and
compiler-resolved scip-query evidence; no sub-agents

## Outcome

The audit confirmed six actionable defects and three high-value shared
improvements.

| ID      | Severity | Finding                                                                                                   | Status                                 |
| ------- | -------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| SQLC-01 | High     | Re-export analysis repeatedly reloads the immutable document table                                        | Fixed                                  |
| SQLC-02 | High     | Source fallback rescans imports for every barrel/source decision                                          | Fixed                                  |
| SQLC-03 | High     | Bottleneck analysis chooses caller strategy and loads caller/reference evidence once per candidate symbol | Fixed                                  |
| SQLC-04 | High     | Re-export SQL builds a project-wide definition map before applying the small barrel set                   | Fixed                                  |
| SQLC-05 | Medium   | Bulk definition fallback includes rows already superseded by corrected definition ranges                  | Fixed                                  |
| SQLC-06 | Medium   | Composite analyses can reproduce an identical scoped, predicate-specific definition catalog               | Fixed                                  |
| SQLC-07 | Medium   | Benchmark class targets are ambiguous, hiding real command status behind exit-one samples                 | Fixed                                  |
| SQLC-08 | High     | Several remaining commands are slow for source/semantic reasons, not SQL reasons                          | Classified; moved out of SQL scope     |
| SQLC-09 | Medium   | Some scalar SQL call counts look alarming but consume negligible time                                     | Measured and intentionally left scalar |

## Essential distinctions

A **database generation** is one immutable SQLite artifact and its identity
metadata, opened read-only by a command. Its defining operational fact is that
table contents cannot change during the connection’s life, so a value derived
only from those contents may be cached for that connection without a
time-based expiry.

A **target-first query** is a relational operation whose outer row set is the
exact file or symbol family named by the user or detector. It differs from a
whole-project scan followed by a filter because irrelevant rows are never
visited merely to reject them.

A **batch query** is one statement whose keys are the complete bounded set
already known to the caller. It differs from a scalar loop because database
planning, statement dispatch, and shared table walks occur once for the set
rather than once per key.

A **dominant cost** is the resource responsible for enough wall time that
removing it can materially improve the user-visible command. A large call
count is not a dominant cost when all calls together consume a few
milliseconds inside a multi-second source or semantic computation.

## Scope and evidence

The audit covered:

- all query modules that issue `db.all`, `db.get`, or prepared SQLite reads;
- shared storage, definition-catalog, mention, caller, and reference helpers;
- every query and analysis case represented by the calibration harness,
  including full variants where their work differs; operational preflight
  commands were inventoried but were not treated as SQL optimization targets;
- default and full variants where their work differs;
- scip-query and Vega_2.0 as small and large corpora;
- ordered output hashes, SQL statement counts, returned-row counts, built-in
  profile spans, and `EXPLAIN QUERY PLAN`.

The complete paginated `plan-context src/queries` result was consumed through
104 transport pages and validated at SHA-256
`a93294627fdf3d7356eaef39be52889c1fc79fd71cc0fc06c96a3cd63dc8766f`.
It covered 102 query module files and 1,993 external surface uses. Exact
consumer checks were then run from each touched symbol.

## SQLC-01 — Repeated immutable document scans

`indexedDocumentPaths` queried and sorted the same read-only `documents`
table for every source-barrel decision. On Vega_2.0, one
`redundant-reexports` invocation issued 309 copies of that statement and
returned 825,030 duplicate path rows.

The fix caches by database identity plus normalized options: scope, SQL-like
filter, sorted normalized extension set, and ignored-path policy. The returned
array is copied so a caller cannot poison later reads by sorting or removing
entries. Because the database generation and ignore filter are immutable for
the connection, there is no freshness interval to guess.

## SQLC-02 — Repeated source importer inversion

The source fallback asked “who imports this target?” separately for each
barrel and re-export. The imported files and resolved targets are one
project-wide relation for the invocation.

The fix builds one `target -> importers` inverse and performs set lookups,
subtracting the excluded file at the decision boundary. A fixture proves a
direct source consumer remains counted.

## SQLC-03 — Per-symbol bottleneck evidence

The original bottleneck flow mapped every production callable through the
scalar caller helper. On a large index, each scalar call:

1. counted global symbols to choose targeted versus inverted strategy;
2. resolved the symbol prelude;
3. loaded reference chunks for one symbol;
4. optionally obtained semantic references.

Vega_2.0 therefore executed 8,981 count statements and thousands of reference
queries. The corrected flow caches the generation-wide strategy and passes
all definitions to one caller-map operation. Resolved reference chunks are
loaded in bounded key batches and regrouped by symbol and file before the
existing source-line refinement runs.

The result is still ordered and deduplicated by the original policies. Tests
compare bulk and scalar reference sites and assert one strategy count.

## SQLC-04 — Whole-project definition map for a bounded barrel set

The prior re-export statement grouped every role-one mention into
`symbol -> definition document`, then joined it to mentions in barrel files.
Only a small set of `index.ts` and `index.js` documents can contribute
results, so project-wide definition production is unnecessary.

Two superficially attractive rewrites were rejected:

- using only corrected definition ranges was fast but lost fallback-only
  symbols in scip-query;
- unioning primary definitions with fallback mentions retained rows but was
  slower than the original.

The accepted query materializes the barrel-reference identities first.
`CROSS JOIN` then preserves that bounded set as the outer loop while
`idx_mentions_symbol_id_role` performs exact definition lookups. This changes
the Vega SQL core from about 226 ms to 1.83 ms and keeps exact rows on both
corpora.

## SQLC-05 — Superseded fallback rows

The bulk definition catalog loaded role-one mention fallbacks even when the
same symbol already had a corrected `defn_enclosing_ranges` row. The merge
always overwrites that fallback by symbol identity.

An anti-join now excludes those provably superseded rows. Vega fallback output
fell from 29,490 to 19,523 rows. The improvement is modest—about 10 ms in the
isolated statement—but it reduces memory and transfer without changing the
merged catalog.

## SQLC-06 — Repeated exact matched catalogs

Several composite analyses request the same scope, SQL prefilter, and stable
matcher function more than once. The complete source-corrected result is now
cached by all three identities. A different function object cannot collide
even if its source text looks similar, and definition-catalog invalidation
clears the entire project projection conservatively.

The cache returns a new array on each read. A test mutates the first result,
observes the second result intact, and proves a new predicate identity causes
a fresh query.

## SQLC-07 — False benchmark failures

`methods` deliberately rejects ambiguous class names. The harness supplied
unqualified names, so both primary corpora recorded exit one even though the
command was healthy. Targets are now path-qualified:

- `src/semantic/rust/lsp-session.ts/RustAnalyzerSessionResolver`
- `apps/api/src/modules/coding-agents/coding-agents.service.ts/CodingAgentsService`

Both validation probes now exit zero. Benchmark correctness includes valid
inputs; a fast error path is not evidence that the successful command is fast.

## SQLC-08 — Residual slow commands are not SQL-dominant

Profiles reject the premise that one SQL campaign can make every command
fast:

- `affected` spends more than five seconds in TypeScript semantic references;
- `imports --full` spends about 5.8 seconds materializing TypeScript import use;
- `similar --full`, `isolated --full`, and several cleanup full modes spend
  most of their time in semantic callees;
- `dead` spends most of its time producing and source-correcting candidates;
- `plan-context` combines semantic impact with Git history;
- `health` composes many detectors and has meaningful persistent-cache state.

SQL rewrites cannot remove these costs. They should be reviewed through
semantic-provider, source-analysis, Git-history, and composite-pipeline
performance lenses with separate correctness oracles.

## SQLC-09 — Scalar count is not sufficient evidence

Two adverse-cardinality probes prevent cargo-cult batching:

- wrapper analysis issued 2,996 `mentionChunkForCaller` statements, but they
  consumed 12.6 ms inside a 7.68-second direct run;
- change-surface issued 85 consumer statements for a definition-heavy file,
  but they consumed 0.91 ms inside a 71 ms direct run.

Batching either path would add query construction, regrouping, and tests for a
cost too small to move the command. Both are documented non-findings.

## UX and compatibility

No command syntax, result field, evidence tier, coverage disclosure,
pagination behavior, or diagnostic changed. Users see only lower latency.

No new SQLite index or layout version was added, so publication time and
database size do not increase. The accepted target-first query uses the
converter’s existing `(symbol_id, role)` mention index.

## Verification

- `npm run lint`, including build, declaration generation, public API checks,
  public-consumer checks, and skill-link validation: passed.
- Complete Vitest suite: 261 files and 2,066 tests passed.
- Focused SQL regression suite after the adverse-cardinality addition: 5 files
  and 22 tests passed.
- `cargo check --quiet --manifest-path Cargo.toml`: passed.
- `scip-query doctor`: OK; the watcher produced a fresh generation without a
  competing manual reindex.
- Routed postchecks found no incomplete migration or recent-duplicate finding;
  targeted documentation checks found no drift after the two cited documents
  were reconciled.
- `scip-query self-audit`: reference precision 0.983 and recall 1.0 on the
  50-symbol sample.
- `scip-query diff-gate --json --compact`: passed with zero blocking or
  advisory findings after documentation reconciliation.
- `scip-query health --baseline`: the repository-wide baseline remains red
  with 125 deltas from the larger pre-existing dirty worktree. None names the
  optimized `bottlenecks` or `redundant-reexports` result paths; this is not
  treated as an SQL-campaign regression.

The two explicit refutations also survived: a 1,501-symbol mention request
crossed two 750-parameter boundaries without omission or duplication, and a
caller-mutated cached document-path result could not alter the next read.

## Remediation mapping

The approved and executed slices live in
[`../plans/2026-07-28-sql-command-performance-campaign.md`](../plans/2026-07-28-sql-command-performance-campaign.md).
The numerical baseline and append-only decision ledger live under
`docs/benchmarks/`.
