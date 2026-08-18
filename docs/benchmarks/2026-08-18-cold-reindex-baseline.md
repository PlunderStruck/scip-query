# Cold reindex performance baseline — 2026-08-18

## Target

This campaign targets a cold reindex of the `scip-query` repository. A cold reindex is a complete index build whose output directory contains no accepted SQLite generation, language shard, reindex metadata, or shared-generation attachment. What makes it cold is the absence of reusable scip-query artifacts; operating-system file caches, installed packages, and compiler binaries remain available and are reported rather than artificially purged.

The observable result is the accepted SCIP file, SQLite generation, runtime-boundary observations and links, diagnostics, generation publication, and unchanged-warm reuse behavior. A faster run is acceptable only if it preserves those results and the lock, validation, atomic-promotion, cleanup, and recovery sequence.

## Environment

- Corpus: `/Users/aydansalois/Documents/GitHub/scip-query`
- Starting revision: `2e7d5b459cc7b3b67aed4396269a0e6487b2e423`
- Starting worktree: dirty only with this campaign's restored skill and benchmark harness; the first timing preceded runtime-boundary production edits
- Languages: TypeScript and Rust
- Accepted source inputs at final measurement: 496
- Machine: Apple `Mac16,7`, 48 GiB physical memory
- OS: Darwin 25.5.0, arm64
- Node.js: 26.7.0
- npm: 11.19.0
- scip-query: 0.20.0
- Indexer concurrency: 2 from `.scipquery.json`
- Run history: `docs/benchmarks/runs/2026-08-18-cold-reindex-campaign.jsonl`

## Harness

`npm run bench:cold-reindex` invokes the real `reindex()` implementation with `index.scip`, `index.db`, metadata, language shards, and immutable generations rooted in a new temporary directory for each cold iteration. It immediately follows each cold build with an unchanged warm call against the same directory. Artifact hashing runs outside the timed region.

The harness reports coordinator RSS only. That is the resident memory of the Node.js process coordinating the build; it excludes language-indexer and SCIP-converter child processes, so it is evidence about the coordinator but not a whole-build peak-memory claim.

## Starting measurements

| Scenario | Wall time | Internal time | Direct runtime-boundary extraction | Coordinator peak RSS | Result |
| --- | ---: | ---: | ---: | ---: | --- |
| Unprofiled isolated cold, one control | 24,406ms | 24,175ms | 15,171ms | 1,072MiB | 593 observations, 0 links, 225 frontiers |
| Profiled isolated cold, one control | 25,198ms | 24,909ms | 16,130ms | 926MiB | same observation/link/frontier counts |
| Immediate unchanged warm after the unprofiled control | 399ms | 358ms | reused | 1,300MiB cumulative-process sample | raw SCIP and SQLite bytes unchanged |

The profiled control localized 7,343ms across 683 eager definition-catalog builds and 1,197ms across 683 eager literal-constant walks. `builtin.capability-registry` was subsequently measured at 6,294ms across 647 files after the eager-context fix exposed extractor cost.

## Correctness checks

- The cold and immediate unchanged-warm artifacts must have identical raw SHA-256 identities within each pair.
- Repeated cold SCIP outputs must have one raw identity.
- Independent SQLite files may have different raw identities because runtime-boundary phase durations are intentionally persisted. Semantic observation tuples are compared separately.
- Runtime-boundary focused tests must pass, including exact capability descriptors and instructions, ambiguous handlers, incremental replacement, persistence, and clean/incremental graph parity.
- Reindex reliability tests must preserve full/incremental fallback, shard reuse, accepted-generation checks, atomic publication, cleanup, and recovery behavior.

## Baseline limitation

The starting unprofiled control has one repetition because the missing end-to-end harness was created as the first campaign step. The profiled baseline independently confirms the same cost shape. Final claims therefore report both the conservative unprofiled single-control delta and the profiled stage delta, and retain every later outlier in run history.
