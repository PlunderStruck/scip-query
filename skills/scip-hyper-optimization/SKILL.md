---
name: scip-hyper-optimization
description: Optimize performance scientifically with scip-query evidence. Use for benchmarking, profiling, speeding up commands, workflows, indexers, detectors, app paths, cold/warm regressions, memory/cost reduction, or comparing current-pipeline tuning with alternative designs.
---

# scip-hyper-optimization

Use this skill to make a command, workflow, service, page, or tool faster without changing its observable result. Hyper optimization is a bounded campaign that improves runtime, memory, or computational cost against repeatable measurements.

Load shared mechanics from [`../_shared/SKILL.md`](../_shared/SKILL.md).

## Terms

A measurement harness is the repeatable set of commands, fixtures, corpora, environment notes, and result documents used to decide whether performance changed.

A run history is the durable time series of measurements, with one record per run, command, subprocess, or profiled stage.

A profile span is one named timed piece of work inside the target process, such as input loading, cache reads, database queries, graph traversal, rendering, or a child process.

Hierarchical profiling is measuring coarse spans first, then recursively splitting only the dominant span until the expensive operation is concrete enough to fix.

A command ledger is the living document for one target: output contract, current pipeline, timings, tried ideas, and decisions.

## Rules

1. Do not optimize until a measurement harness exists or is created.
2. Capture representative inputs, output contract, and correctness checks before editing.
3. Record every benchmark in machine-readable run history.
4. Measure cold and warm paths separately when they can diverge.
5. Profile the internal chain before choosing a fix.
6. Attach cardinality to spans: files, rows, symbols, candidates, cache hits/misses, bytes, edges, nodes, retries, or output rows.
7. Work both tracks: tune the current pipeline and evaluate alternative algorithms or data models.
8. Keep only changes that improve real workloads without reducing accuracy, diagnostics, safety, or supported inputs.

## Workflow

### 1. Target and harness

If the repo is not a reliable scip-query workspace, invoke `scip-setup` first. Choose the target from user pain, telemetry, benchmark ranking, regression data, cost, frequency, or risk.

Create or update:

- `docs/benchmarks/YYYY-MM-DD-<target>-baseline.md`
- `docs/benchmarks/runs/YYYY-MM-DD-<target>.jsonl`

For scip-query command targets, start with:

```bash
scip-query bench --json
scip-query bench --json --cold-index --include-heavy --timeout-ms 600000
```

This step is complete only when baseline timings, output identity evidence, corpus, environment, and run-history location exist.

### 2. Create the ledger

Write `docs/benchmarks/YYYY-MM-DD-<target>-ledger.md` with Output Contract, Target Selection, Current Pipeline, Run History Location, Profile Spans, Bottleneck Candidates, Measurements, Current-Pipeline Optimizations, Alternative Designs, and Decisions.

This step is complete only when the ledger can explain what must not change.

### 3. Trace behavior

```bash
scip-query plan-context <entry-symbol-or-file>
scip-query trace <entry-symbol>
scip-query call-graph <entry-symbol>
scip-query code <entry-symbol>
scip-query dataflow <entry-symbol>
scip-query complexity <hot-symbol>
scip-query change-surface <touched-file> --json --full
```

Record input parsing, option resolution, subprocesses, lookups, database queries, graph traversal, source scans, semantic calls, cache reads/writes, rendering, serialization, and verification.

This step is complete only when each major pipeline step can be timed as a profile span.

### 4. Profile the chain

1. Measure the target unprofiled.
2. Measure profiled once and compare overhead.
3. Measure distinct states: cold index, cold evidence/cache fill, warm cache hit, repeated focused run, production-like mixed state.
4. Add coarse spans covering the whole chain.
5. Split the largest workload-weighted span.
6. Repeat until the slow operation is a repeated lookup, initialization, scan, traversal, subprocess, serialization step, or wait.
7. Write span records with cardinality to run history.

This step is complete only when the dominant cost is concrete enough to form a falsifiable hypothesis.

### 5. Diagnose and test one hypothesis

Classify the dominant shape: cold-only setup, warm slow path, repeated setup, N+1 work, broad scan, database time, subprocess startup, serialization, or cache invalidation. Prefer fixes in this order:

1. Remove accidental repetition.
2. Batch scalar work.
3. Move stable derived work to an index/cache with invalidation.
4. Replace broad scans with indexed lookups.
5. Replace wrapper APIs only after output identity proves equivalence.
6. Add pruning only when mathematically equivalent or corpus-proven.

Make the smallest reversible change that tests one hypothesis.

This step is complete only when before/after timings, profile deltas, and output identity are recorded.

### 6. Verify and report

Run the narrow correctness check, benchmark cases, routed postchecks, and invoke `scip-verify`.

Reject faster changes that alter the output contract unless the user approved a behavior change.

End with a scoreboard from run history: starting value, current value, delta, scenario, corpus, commit/version, output identity, accepted changes, rejected ideas, remaining bottlenecks, and next target.
