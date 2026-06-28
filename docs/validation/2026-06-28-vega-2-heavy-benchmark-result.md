# Vega 2.0 Heavy Benchmark Result - 2026-06-28

This note records the Vega_2.0 benchmark run used to assess the current
scip-query performance work.

## Repository

- Target repository: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- scip-query index languages: TypeScript, Python
- Repository files: 14,553
- Source files: 2,290
- Indexed files: 1,779
- Indexed symbols: 103,982
- Index size: 74,207,232 bytes, reported as 70.8 MB

## Primary Command

```bash
scip-query bench --json --cold-index --include-heavy --timeout-ms 600000
```

`--include-heavy` adds the expensive detector commands to the default benchmark
matrix. It includes `health --json`, but it does not include
`health --json --full`; that full-health timing was measured separately below.

## Indexing

| Measurement | Result |
| --- | ---: |
| Previous recorded Vega rebuild | 49.0s |
| Cold index | 38.8s |
| Warm index reuse | 0.38s |

The cold index improved from 49.0s to 38.8s, about 21% faster.

## Default Commands

| Command | Duration | Exit |
| --- | ---: | ---: |
| `scip-query status --json` | 0.51s | 0 |
| `scip-query status --capabilities` | 0.47s | 0 |
| `scip-query capabilities --json` | 0.15s | 0 |
| `scip-query capability-matrix --json` | 0.15s | 0 |
| `scip-query stats` | 0.15s | 0 |
| `scip-query kind-counts` | 0.20s | 0 |
| `scip-query diff-impact --json` | 0.70s | 0 |
| `scip-query diff-gate --json` | 25.0s | 1 |

`diff-gate` exited 1 because Vega_2.0 had findings. The timing is still useful
as a runtime measurement.

## Heavy Commands

| Command | Duration | Exit |
| --- | ---: | ---: |
| `scip-query health --json` | 11.6s | 0 |
| `scip-query dead --json --full` | 30.4s | 0 |
| `scip-query isolated --json --full` | 12.1s | 0 |
| `scip-query similar --json --full` | 300.7s | 0 |
| `scip-query similar-files --json --full` | 0.51s | 0 |
| `scip-query recent-duplicates --json --full` | 6.3s | 0 |
| `scip-query doc-drift --json --full` | 3.6s | 0 |
| `scip-query unused-params --json --full` | 0.98s | 0 |
| `scip-query wrapper-candidates --json --full` | 60.3s | 0 |
| `scip-query passthrough-candidates --json --full` | 71.9s | 0 |
| `scip-query stale-abstractions --json --full` | 41.6s | 0 |
| `scip-query incomplete-migration --json --full` | 6.5s | 0 |
| `scip-query cleanup-plan --verify --json` | 2.9s | 0 |
| `scip-query complexity-hotspots --json --full` | 68.9s | 0 |

## Warm Follow-Up Timings

These commands were run after the cold benchmark completed and the index was
fresh.

| Command | Duration | Exit |
| --- | ---: | ---: |
| `scip-query health --json` | 7.2s | 0 |
| `scip-query health --json --full` | 6.8s | 0 |
| `scip-query diff-gate --json` | 3.1s | 1 |

## Current Bottlenecks

The slowest measured commands on Vega_2.0 were:

1. `similar --json --full` at 300.7s.
2. `passthrough-candidates --json --full` at 71.9s.
3. `complexity-hotspots --json --full` at 68.9s.
4. `wrapper-candidates --json --full` at 60.3s.
5. `stale-abstractions --json --full` at 41.6s.
6. `dead --json --full` at 30.4s.

The next optimization target should be `similar --full`, followed by the
wrapper/passthrough/stale-abstraction detector family and
`complexity-hotspots --full`.

## 2026-06-28 Hyper-Optimization Follow-Up

Latest warm ranking: `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`.

After precomputing weighted magnitudes in the `similarAll` callee fingerprint
index, the same Vega_2.0 command became a low-single-second query:

| Command | Before | After | Notes |
| --- | ---: | ---: | --- |
| `scip-query similar --json --full` | 300.7s heavy / 315.3s focused | 1.443s heavy / 1.503s focused confirmation | stdout stayed 88,859 bytes |

The refreshed heavy matrix after the `similar` change showed the remaining
large numbers were mostly cold evidence-cache fills:

| Command | Refreshed heavy matrix | Focused warm follow-up |
| --- | ---: | ---: |
| `scip-query passthrough-candidates --json --full` | 68.96s | 1.430s |
| `scip-query complexity-hotspots --json --full` | 65.85s | 1.666s |
| `scip-query wrapper-candidates --json --full` | 60.28s | 2.616s |
| `scip-query stale-abstractions --json --full` | 40.69s | 2.402s |
| `scip-query dead --json --full` | 29.61s | 4.222s |
| `scip-query health --json` | 10.11s | 6.979s |
| `scip-query diff-gate --json` | 10.88s | 3.107s |

Health orchestration experiments rejected two tempting alternatives:

- Lowering health concurrency to 4 was flat (`7.105s`), and 2 was slower
  (`12.599s`).
- Serial in-process `health(db, { full: true })` was slower (`18.325s`) than
  the existing isolated phase runner.
