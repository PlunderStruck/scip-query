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
- Persistent-query method: for each of three unchanged-tree replicates, spawn 1, 8, and 32 byte-identical compact result-only searches, sample the aligned RSS of all clients and project-scoped service processes every 20 ms, and report wall time plus client min/median/p95/max. Service lanes expire after an idle bound so the retained set cannot grow without limit.

## Starting observations

- Full fingerprint median: 38.194 ms. One-path journal median: 0.105 ms.
- Warm CLI medians: status 623.1 ms, exact search 635.7 ms, code 608.5 ms, depth-one evidence 1,876.3 ms, cached full health 731.0 ms.
- CLI load control: 143 ms median for `scip-query --help`.
- Latest incremental publication stages: TypeScript producer 1,492 ms, SCIP-to-SQLite conversion 987 ms, SQLite patch 655 ms.
- Watch activity reported 1,122,601,560 estimated bytes against a 1,073,741,824-byte budget and paused with changes pending.

## Persistent query result

A generation-pinned query service is a bounded set of local processes that each hold one immutable published index generation and serialize only the requests assigned to that lane. A thin client is the small CLI path that validates an eligible machine-readable invocation and reaches that service before loading the full command registry. Six lazy lanes were the measured balance: across three unchanged-tree replicates at 32 workers, trusted-watcher automatic mode produced median paired reductions of 37.0% in aligned peak RSS, 7.0% in wall time, and 32.1% in median completion. The service is automatic only for compact result-only JSON forms of `search` and `outline` when a live, idle, error-free watcher reports the same published generation; an explicit disable, absent or stale watcher, profiling, unsupported option, startup failure, capacity rejection, deadline, process-identity mismatch, protocol mismatch, generation change, or invalid response returns to the established direct command path. `SCIP_QUERY_QUERY_SERVICE=1` is the explicit override for controlled high-concurrency environments.

The next service pass kept six lanes and removed their dominant transient allocation. A streaming literal probe is a descriptor-bound project-file read that validates UTF-8, detects NUL bytes, optionally hashes the file, and tests a byte literal through one reusable 1 MiB buffer; it materializes the complete file only after a match. On this 628.9 MB corpus, the warm source-search median remained effectively flat (315.712 ms to 315.337 ms) while observed RSS fell from 540,737,536 to 210,436,096 bytes. Across three service replicates, aligned peak RSS fell 53.4% at one client, 47.8% at eight, and 27.6% at 32; wall time improved 9.5%, 6.6%, and 7.1%, respectively. The six server processes themselves used 68.3% less peak memory at 32 clients. Literal output was byte-identical to the direct command, and the streaming scan matched the prior materialized filter exactly in the lossless source-sensor fixture. Regexp and ignore-case searches retain the established materialized path.

The outline extension sends one exact file selector to the same generation-pinned lanes and returns the same compiler-owned symbol tree as the direct command. Across three paired warm-pool replicates, median wall time improved 30.8% at one client, 28.7% at eight, and 35.8% at 32; median completion improved 32.5%, 33.5%, and 36.7%. Aligned peak RSS was 9.6% lower at 32 clients and 4.4% higher at eight. The one-client warm-pool total includes all six already-running service processes and was 251.5% higher than a standalone direct process; the extension creates no additional lanes, and a cold lazy single-lane run used less aligned RSS than direct. Every paired output hash was identical. Unsupported outline shapes and every untrusted watcher state retain direct execution.

The code extension serves the exact compact result-only JSON form through those same lanes while keeping exploration-session authorization in the invoking process. It is a persistent navigation read whose distinguishing constraint is that the service returns hash-verified serialized JSON from a generation-pinned database without inheriting the client's session authority. Across three final paired replicates, median wall time improved 34.3% at one client, 36.4% at eight, and 38.5% at 32; median completion improved 36.0%, 39.6%, and 37.1%. At 32 clients aligned peak RSS fell 11.2%; at eight it rose 10.7%. The cold first-lane run cost 7.1% wall time and 6.1% aligned RSS, while later warm-pool runs produced the latency reduction. A warm one-client total includes all six retained servers and therefore rose 292.5% at the paired median, but code creates no additional lanes and is loaded lazily so search/outline-only servers retain their prior module footprint. Single-symbol, mixed-selector, complete-file, context, and member-mode outputs were byte-identical between direct and service paths. Unsupported syntax, local session denial, untrusted watcher state, invalid transport, and generation change retain direct execution.

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
- Warm-query alternative: the generation-pinned local query service now reuses database state across workers, while its case-sensitive literal scan bounds nonmatching file allocation to one reusable buffer. Pool reduction and demand-adaptive lane prototypes were rejected because they regressed 32-worker throughput.
