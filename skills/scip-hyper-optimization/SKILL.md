---
name: scip-hyper-optimization
description: Run scientific performance optimization campaigns with scip-query evidence, command ledgers, and benchmark corpora. Use when the user asks to hyper optimize, make commands blazing fast, speed up a CLI/tool/app, benchmark regressions, or compare targeted tuning against radically different implementations.
---

# SCIP Hyper Optimization
Use this skill to make a command, workflow, service, page, or tool as fast as
feasibly possible without changing its observable result. Hyper optimization is
a bounded campaign that improves runtime, memory use, or computational cost
against objective measurements; every accepted change is proven by a repeatable
benchmark and unchanged output.

A measurement harness is the repeatable set of commands, fixtures, corpora,
environment notes, and result documents used to decide whether performance
changed. A command ledger is the living document for one target: what it
returns, what code runs, where time is spent, what was tried, and what evidence
accepted or rejected each idea.

## Rules

1. Do not optimize until a measurement harness exists or has been created.
2. Use scip-query for code understanding: `status`, `plan-context`, `trace`,
   `call-graph`, `code`, `dataflow`, `complexity`, `diff-impact`, `diff-gate`.
3. Capture representative inputs, required output behavior, and correctness
   checks before editing.
4. Measure cold and warm paths when both matter; record exact commands, corpus,
   elapsed time, repetitions, and outliers.
5. Work both tracks: tune the current pipeline and evaluate radically different
   algorithms or data models that preserve the same result.
6. Keep only changes that improve real workloads without reducing accuracy,
   diagnostics, safety checks, or supported inputs.

## Phase 0: Measurement Harness
If the target repository is not already a reliable scip-query workspace, invoke
`scip-query-setup` first. Do not run setup-ci in this workflow.

Create or update a benchmark note before code changes. Prefer the repo's
existing convention; otherwise use
`docs/benchmarks/YYYY-MM-DD-<target>-baseline.md`. Include target, machine/date
context, corpus or fixture list, cold/warm/correctness commands, baseline
timings, output-contract evidence, and slowest stages.

Choose the measurement mechanism from the target's real workload. For app
paths, use the app's benchmark, test, route smoke, build, profiler, load test,
or timing script; if none exists, create the smallest repeatable timing command.
For scip-query command, detector, or indexer targets, benchmark the relevant
command matrix:

```bash
scip-query bench --json
scip-query bench --json --cold-index --include-heavy --timeout-ms 600000
```

## Phase 1: Command Ledger
Create one ledger per target:
`docs/benchmarks/YYYY-MM-DD-<target>-ledger.md`. Include Output Contract,
Current Pipeline, Measurements, Current-Pipeline Optimizations, Alternative
Designs, and Decisions.

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

Record input parsing, lookups, database queries, graph traversal, source scans,
semantic calls, cache reads/writes, rendering, and verification.

## Phase 3: Find Speedups
For the current pipeline, look for repeated work, broad scans, N+1 lookups,
uncached pure work, avoidable source or semantic reads, large arrays, late
filters, batchable per-file work, and safe parallelism.

For alternative designs, restate the output contract first. Ask whether SQLite
can answer directly, an index/cache/precomputed table can move work out of the
hot path, batch queries can replace loops, a cheap pruning stage can precede
exact work, or workers can run independent phases safely.

## Phase 4: Implement and Verify
Make the smallest reversible change that tests one performance hypothesis.
Update the ledger with hypothesis, changed files/symbols, before/after timings,
output comparison, tests, and gates.

Run the narrow correctness check, benchmark cases, `scip-query diff-impact
--json`, and `scip-query diff-gate --json`; reindex first if freshness is not
proven. Also run postchecks matching the change type. End with starting time,
final time, percentage change, accepted changes, rejected ideas, remaining
bottlenecks, and the next target.
