---
name: scip-hyper-optimization
description: Optimize performance scientifically with current scip-query evidence. Use for benchmarking, profiling, cold or warm indexing, command latency, memory and computational cost, or comparing current-pipeline tuning with alternative designs.
---

# SCIP Hyper Optimization

This project-local skill restores the last standalone hyper-optimization method from commit `bb02f016` and adapts its retired command names to the current scip-query interface.

Use it to make a command, indexer, watcher, workflow, or service faster without changing its observable result. A hyper-optimization campaign is a bounded engineering program that improves runtime, peak memory, or computational work against repeatable measurements. What distinguishes it from general refactoring is that measurements and output identity decide whether a change survives.

## Choose the scale

- **QUICK** — one target, one already-plausible hot operation, and one before/after measurement can settle the decision. Record the run in `docs/benchmarks/runs/YYYY-MM-DD-<target>.jsonl`; a separate ledger is optional.
- **CAMPAIGN** — several targets, an unclear bottleneck, cold and warm paths that diverge, memory/runtime tradeoffs, or competing designs. Create the baseline, run history, ledger, profiles, and alternative-design track below.

If naming the operation to change requires investigation, use CAMPAIGN.

## Essential terms

A measurement harness is a repeatable experimental setup: commands, fixtures or corpora, cache state, environment facts, and result records. Its defining trait is that another run can reproduce the state being compared.

A run history is a machine-readable measurement record with one row per command, subprocess, or profiled stage. Its defining trait is durability across code changes, so an improvement can be compared to the baseline that motivated it.

A profile span is one named and timed operation inside the target process, such as fingerprinting, compiler startup, conversion, validation, publishing, or cache loading. Its defining trait is that it assigns elapsed work and relevant cardinality to a particular part of the pipeline.

Hierarchical profiling is a bottleneck-localization method that times the whole pipeline, then subdivides only its dominant span. Its defining trait is progressive narrowing until the expensive operation is concrete enough to change.

An output contract is the externally observable result and safety behavior that an optimization must preserve: files, database contents, command output, ordering where guaranteed, diagnostics, accepted-generation rules, rollback or repair behavior, and supported inputs.

## Non-negotiable rules

1. Do not optimize until a measurement harness exists or is created.
2. Capture the representative corpus, cold/warm cache state, output contract, and correctness checks before editing.
3. Record every accepted and rejected benchmark in JSONL run history.
4. Measure cold and warm paths separately whenever their work differs.
5. Profile the internal chain before choosing a non-obvious fix.
6. Attach cardinality to spans: files, bytes, rows, symbols, shards, cache hits and misses, subprocesses, retries, or writes.
7. Evaluate current-pipeline tuning and at least one alternative algorithm or data layout in CAMPAIGN mode.
8. Keep only changes that improve representative work without reducing accuracy, diagnostics, crash safety, recovery, or supported inputs.
9. A lower mean with a materially worse tail or peak-memory result is not an unqualified win.

## Current repository controls

Use current scip-query controls for repository evidence:

```bash
scip-query status
scip-query entrypoints reindex
scip-query evidence --symbol <symbol> --edge execution --direction outgoing --depth 2 --max-edges 80
scip-query inspect --symbol <symbol> --view behavior
scip-query code <symbol-or-range>
scip-query diff-impact
scip-query architecture
```

Use the repository benchmark scripts listed by `npm run`; do not revive the removed `scip-query bench` or `work-audit` commands. For index/watch work, the existing focused harness is:

```bash
npm run bench:edit-latency
```

For process-internal measurements, reuse `src/instrumentation/profile.ts`. Enable it with `SCIP_QUERY_PROFILE=1` and write JSONL with `SCIP_QUERY_PROFILE_OUT=<path>`. Add `profileSpan` or `profileAsyncSpan` only where the existing hierarchy lacks a decision-relevant boundary.

## Campaign workflow

### 1. Establish target and harness

Create:

- `docs/benchmarks/YYYY-MM-DD-<target>-baseline.md`
- `docs/benchmarks/YYYY-MM-DD-<target>-ledger.md`
- `docs/benchmarks/runs/YYYY-MM-DD-<target>.jsonl`

The baseline must identify the corpus revision and dirtiness, toolchain versions, hardware facts relevant to interpretation, cold-state definition, warm-state definition, repetitions, statistic, output identity method, and peak-memory method.

This stage is complete only when the starting value can be reproduced without deleting an unrelated live index or invalidating another worker's state.

### 2. Trace the current pipeline

Locate the external root, project explicit execution, temporal, state, data, ownership, and dependency relationships needed by the output contract, then read only the named behavioral gaps. Record option resolution, locks, fingerprints, cache reads, compiler processes, conversions, validation, atomic publication, cleanup, and recovery.

This stage is complete only when every major pipeline step can be represented by a profile span and the safety-critical ordering is explicit.

### 3. Profile hierarchically

Measure an unprofiled control, then one profiled control to quantify instrumentation overhead. Measure distinct states separately: genuinely cold accepted index, reusable clean base, one-file edit, burst edits, and production-like mixed state when relevant.

Split only the largest workload-weighted span. Continue until the dominant cost is a concrete scan, hash, parse, compiler initialization, subprocess, SQLite operation, serialization step, copy, lock wait, or retry. Include peak resident memory and OOM/recovery outcome for memory-sensitive work.

### 4. Test one hypothesis at a time

Classify the measured shape as cold-only setup, warm slow path, repeated setup, N+1 work, broad scan, database time, subprocess startup, serialization, cache invalidation, lock contention, excess live data, or repair amplification.

Prefer fixes in this order:

1. Remove accidental repetition.
2. Batch scalar work or safely overlap independent work.
3. Reduce live data lifetime or bound concurrency.
4. Move stable derived work to a cache with explicit invalidation.
5. Replace broad scans with indexed or delta lookups.
6. Replace an abstraction only after output identity proves equivalence.
7. Add pruning only when mathematically equivalent or corpus-proven.

Make the smallest reversible change that can falsify one hypothesis. Record rejected ideas as well as accepted ones.

### 5. Verify and close

Run narrow correctness tests, benchmark scenarios, full routed checks proportional to the change, `scip-query diff-impact`, and `scip-query architecture`. Compare output identity and failure/recovery behavior, not just wall time.

End with a scoreboard containing starting value, current value, delta, scenario, corpus, revision, peak memory, output identity, accepted changes, rejected ideas, remaining bottlenecks, and next target.
