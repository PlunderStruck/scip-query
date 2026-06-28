---
name: scip-hyper-optimization
description: Run scientific performance optimization campaigns with scip-query evidence, hierarchical profiling, command ledgers, and benchmark corpora. Use when the user asks to hyper optimize, make commands blazing fast, speed up a CLI/tool/app, find bottlenecks, benchmark regressions, optimize cold or warm paths, or compare targeted tuning against radically different implementations.
---

# SCIP Hyper Optimization

Use this skill to make a command, workflow, service, page, or tool as fast as
feasibly possible without changing its observable result. Hyper optimization is
a bounded campaign that improves runtime, memory use, or computational cost
against objective measurements; every accepted change is proven by a repeatable
benchmark and unchanged output.

A measurement harness is the repeatable set of commands, fixtures, corpora,
environment notes, and result documents used to decide whether performance
changed. A run history is the durable time-series of those measurements: one
record per run, command, subprocess, or profiled stage, with enough metadata to
compare commits and draw charts later. A profile span is one named timed piece
of work inside the target process, such as input loading, cache reads, database
queries, graph traversal, rendering, or a child process. Hierarchical profiling
is using coarse spans to find the dominant stage, then recursively splitting
only that stage until the expensive operation is concrete enough to fix. A
command ledger is the living document for one target: what it returns, what code
runs, where time is spent, what was tried, and what evidence accepted or
rejected each idea.

## Rules

1. Do not optimize until a measurement harness exists or has been created.
2. Use scip-query for code understanding: `status`, `plan-context`, `trace`,
   `call-graph`, `code`, `dataflow`, `complexity`, `diff-impact`, `diff-gate`.
3. Capture representative inputs, required output behavior, and correctness
   checks before editing.
4. Record every benchmark in a machine-readable run history before and after
   each optimization; Markdown summaries are secondary.
5. Measure cold-index, cold-cache or evidence-fill, warm steady-state, and
   repeated focused paths separately when they can diverge.
6. Profile the target's internal chain before editing. A bare command duration
   is enough to rank targets, not enough to choose a fix.
7. Treat profiling as a search algorithm: place coarse spans first, split the
   biggest span, and stop descending only when the slow operation is identifiable
   as a specific repeated lookup, initialization, scan, traversal, subprocess,
   serialization step, or wait.
8. Attach counts to spans: files, rows, symbols, candidates, cache hits/misses,
   subprocesses, bytes, edges, nodes, retries, and output rows. Time without
   cardinality hides the cause.
9. Work both tracks: tune the current pipeline and evaluate radically different
   algorithms or data models that preserve the same result.
10. Keep only changes that improve real workloads without reducing accuracy,
    diagnostics, safety checks, or supported inputs.

## Phase 0: Target And Measurement Harness

If the target repository is not already a reliable scip-query workspace, invoke
`scip-query-setup` first. Do not run setup-ci in this workflow.

Choose the optimization target explicitly. Use user-reported pain, production
telemetry, benchmark ranking, regression data, cost, frequency, or risk to
justify why this target comes first. Do not optimize the slowest thing by habit
if another path dominates real user time or compute spend.

Create or update a benchmark note and a run-history store before code changes.
Prefer the repo's existing convention; otherwise use
`docs/benchmarks/YYYY-MM-DD-<target>-baseline.md` and
`docs/benchmarks/runs/YYYY-MM-DD-<target>.jsonl`. Include target, machine/date
context, corpus or fixture list, cold/warm/correctness commands, baseline
timings, output-contract evidence, and slowest stages. Append a structured run
record for each measurement with at least timestamp, commit/version, target,
corpus, scenario, command, duration, exit status, output hash or size, and
notes for outliers.

Choose the measurement mechanism from the target's real workload. For app
paths, use the app's benchmark, test, route smoke, build, profiler, load test,
or timing script; if none exists, create the smallest repeatable timing command.
For scip-query command, detector, or indexer targets, benchmark the relevant
command matrix:

```bash
scip-query bench --json
scip-query bench --json --cold-index --include-heavy --timeout-ms 600000
```

For long benchmark matrices, prefer progress output or incremental JSONL writes
so the current command, subprocess, elapsed time, and completed measurements are
visible while the run is still active and useful if interrupted.

## Phase 1: Command Ledger

Create one ledger per target:
`docs/benchmarks/YYYY-MM-DD-<target>-ledger.md`. Include Output Contract,
Target Selection, Current Pipeline, Run History Location, Profile Spans,
Bottleneck Candidates, Measurements, Current-Pipeline Optimizations,
Alternative Designs, and Decisions.

## Phase 2: Trace Current Behavior

Trace the target end to end and write the actual path into the ledger:

```bash
scip-query status --capabilities
# If stale, missing, or unknown: scip-query reindex
scip-query plan-context <entry-symbol-or-file>
scip-query trace <entry-symbol>
scip-query call-graph <entry-symbol>
scip-query code <entry-symbol>
scip-query dataflow <entry-symbol>
scip-query complexity <hot-symbol>
scip-query change-surface <touched-file> --json --full
```

Record the chain reaction from entry point to result: input parsing, option
resolution, subprocesses, lookups, database queries, graph traversal, source
scans, semantic calls, cache reads/writes, rendering, output serialization, and
verification. The trace should be concrete enough that each major step can be
timed as a profile span.

Before adding spans, use the trace to predict span boundaries. Good first spans
usually match the target's real pipeline nouns: load inputs, compute candidates,
read cache, compute misses, write cache, build graph, score, render, serialize,
and child process. Use `call-graph` to find nested helpers inside the slow
stage, `dataflow` to follow the expensive object or cache key, `refs` to learn
whether a suspected fix affects other paths, and `complexity` to avoid spending
the first profiling pass on low-risk glue.

## Phase 3: Profile The Timed Chain

Before editing, produce a stage profile for the selected target. Prefer existing
runtime profilers, tracing systems, structured logs, or benchmark hooks. If none
exist, add temporary or permanent instrumentation that names timed spans without
changing observable output. For CLIs and build tools, include child processes
and worker tasks; for services, include request handlers, database calls,
network calls, queue jobs, cache hits/misses, rendering, and serialization.

Use this discovery ladder:

1. Measure the target unprofiled so the user-facing baseline is real.
2. Measure it profiled once. If profiled and unprofiled times are close, the
   profiler is diagnostic overhead, not the bottleneck. If profiling dominates,
   fix the harness before trusting fine spans.
3. Measure distinct states separately: cold index, cold derived-cache/evidence
   fill, warm cache hit, repeated focused run, and production-like mixed state.
4. Add coarse spans that cover the whole chain. If span time does not explain
   wall time, look for uninstrumented child processes, async waits, I/O, process
   startup, or profiler gaps.
5. Pick the largest span by wall time multiplied by real workload frequency.
   Split only that span into child spans.
6. Repeat until a fixable operation appears: a repeated singleton creation, a
   per-item lookup, a broad scan, a wrapper traversal, a cache miss storm, a
   subprocess startup, a serialization step, or a wait.
7. Add cardinality metadata to every split: count of rows/files/symbols/nodes,
   cache hits/misses, bytes, output rows, and skipped items.
8. Record the before profile in the ledger before touching code.

Write profile records to the run history with parent/child span names when
possible. Separate wall time from CPU time when the tools allow it. Mark cache
state explicitly: cold index, cold evidence/cache fill, warm cache hit, repeated
focused run, or production-like mixed state.

## Phase 4: Diagnose And Find Speedups

Classify the dominant span before choosing a fix:

| Profile shape                                         | Likely cause                                                                   | First fixes to test                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Cold path huge, warm path fast                        | Derived evidence/cache fill, expensive initialization, or cache invalidation   | Persist the derived result, reuse compatible cache versions, batch cache fills, hoist initialization              |
| Warm path still slow                                  | Cache scan, query shape, deserialization, reshaping, rendering, or output size | Narrow query, add indexes, store compact payloads, stream or avoid repeated object shaping                        |
| Same expensive setup repeated across many files/items | Singleton/client/checker/session/project built inside a loop                   | Preload required inputs, create once after inputs are stable, cache per project/process                           |
| Many medium-cost per-item operations                  | N+1 lookups, scalar provider calls, repeated source reads                      | Batch by provider/file/key, load rows in bulk, group work by locality                                             |
| Traversal span grows with AST/source nodes            | Wrapper allocation or broad source scan                                        | Use lower-level APIs, prefilter by exact names only when output identity proves equivalence, index reusable facts |
| Database time dominates                               | Broad scan, missing index, many statements, repeated prepares                  | Push filters into SQL, batch queries, cache prepared statements, add measured indexes                             |
| Child process or startup dominates                    | Too many subprocesses or cold tool startup                                     | Reuse workers, batch commands, keep warm daemons, collapse process boundaries                                     |
| Serialization/output dominates                        | Large JSON, repeated formatting, full materialization                          | Stream, summarize, avoid duplicate fields, or add an explicit compact mode                                        |

For the current pipeline, look for repeated work, broad scans, N+1 lookups,
uncached pure work, avoidable source or semantic reads, large arrays, late
filters, batchable per-file work, excessive subprocess startup, serialization
cost, cache invalidation churn, and safe parallelism. Prioritize by measured
span cost multiplied by real workload frequency; do not chase a large cold-only
span if the stated purpose depends on warm interactive latency.

Favor fixes in this order when they preserve output:

1. Remove accidental repetition: hoist, memoize, reuse, or preload.
2. Batch scalar work by provider, file, database key, network endpoint, or
   process.
3. Move stable derived work from the hot path into an index/cache with a clear
   invalidation key.
4. Replace broad scans with indexed lookups or candidate-first retrieval.
5. Replace high-overhead wrapper APIs with lower-level APIs only after output
   identity checks prove equivalence.
6. Add pruning only when it is mathematically equivalent or output-identity
   checks across representative corpora prove no observable change.

For alternative designs, restate the output contract first. Ask whether SQLite
can answer directly, an index/cache/precomputed table can move work out of the
hot path, batch queries can replace loops, a cheap pruning stage can precede
exact work, or workers can run independent phases safely.

## Phase 5: Implement And Verify

Make the smallest reversible change that tests one performance hypothesis.
Update the ledger and run history with hypothesis, changed files/symbols,
before/after timings, profile-span deltas, output comparison, tests, and gates.

After each candidate fix, run the smallest valid before/after matrix for the
target scenario: unprofiled control, profiled profile, output hash or semantic
identity check, and representative correctness tests. If a faster change alters
the output contract, reject or revert it unless the user explicitly approved a
behavior change.

Run the narrow correctness check, benchmark cases, `scip-query diff-impact
--json`, and `scip-query diff-gate --json`; reindex first if freshness is not
proven. Also run postchecks matching the change type. End with starting time,
final time, percentage change, accepted changes, rejected ideas, remaining
bottlenecks, and the next target. If results conflict, keep the change only when
the target scenario and output contract justify it; otherwise revert and record
the rejected hypothesis.

## Phase 6: Report And Visualize

End every optimization round with a compact scoreboard generated from the run
history, not hand-copied memory. At minimum, show starting value, current value,
delta, scenario, corpus, commit/version, and output identity evidence. When the
history has enough rows, produce a trend table or chart for the target command
or workflow. Keep Markdown readable for humans, but treat the structured
history as the source of truth.
