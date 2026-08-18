# Non-cold performance campaign baseline

## Target and corpus

- Corpus: `scip-query` at revision `948ccdbdc8c32e485f7996a4384254573992d098`, clean worktree before harness creation.
- Host: Apple `Mac16,7`, arm64, 51,539,607,552 bytes of physical memory.
- Toolchain: Node.js `v26.7.0`, npm `11.19.0`.
- Target: watcher edit publication, write-budget accounting, warm CLI latency, and multi-worker repeated setup. Cold indexing is outside this campaign.

## Measurement states

- Accounting fixture: sparse 30 MiB accepted SQLite database, 30 MiB accepted combined SCIP file, 30 MiB accepted TypeScript shard, and one 256 KiB affected incremental fragment. It performs no cache mutation outside a temporary directory.
- Warm CLI state: one unmeasured warmup followed by three measured subprocess invocations against the accepted local generation. The comparison statistic is the median; min and max expose tails.
- Edit fingerprint state: repository filesystem cache warmed before 25 one-path delta repetitions and five full-scan repetitions.
- Peak memory method for later edit/query experiments: `/usr/bin/time -l`, recording maximum resident set size and non-zero/OOM outcome. The deterministic accounting fixture is not memory-sensitive.

## Starting observations

- Full fingerprint median: 38.194 ms. One-path journal median: 0.105 ms.
- Warm CLI medians: status 623.1 ms, exact search 635.7 ms, code 608.5 ms, depth-one evidence 1,876.3 ms, cached full health 731.0 ms.
- CLI load control: 143 ms median for `scip-query --help`.
- Latest incremental publication stages: TypeScript producer 1,492 ms, SCIP-to-SQLite conversion 987 ms, SQLite patch 655 ms.
- Watch activity reported 1,122,601,560 estimated bytes against a 1,073,741,824-byte budget and paused with changes pending.

## Output and safety contract

- Incremental accounting must charge newly produced logical output, not immutable artifacts merely referenced by the new generation.
- Old version-1 activity JSONL records remain readable. New optional fields must not make old records invalid.
- Full rebuild accounting remains unchanged.
- Fallback byte copies remain additive to logical output and continue to protect the disk-pressure budget.
- Atomic generation publication, accepted-generation identity, rollback, deferred whole-SCIP behavior, diagnostics, and query results remain byte-for-byte or fact-for-fact equivalent.
- Focused tests compare persisted activity JSON and budget decisions. End-to-end reindex tests compare accepted database facts and publication behavior.

## Alternative designs

- Current-pipeline correction: add an optional produced-byte measurement to shard diagnostics and exclude the deferred unchanged combined SCIP file from incremental logical output.
- Broader alternative: measure physical filesystem allocation or every write operation. This is not the first change because copy-on-write allocation is platform-specific and incomplete instrumentation could undercount safety-relevant writes.
- Warm-query alternative: a generation-pinned local query service can reuse database and graph state across workers; compare it later against narrower lazy initialization inside each CLI process.
