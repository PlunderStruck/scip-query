# Bounded TypeScript compiler shards and bounded health analysis

## Outcome

A forced or cold full reindex of a large single-project TypeScript repository completes with bounded child memory: the declared compiler inputs are partitioned into balanced, path-sorted shards, each shard runs as its own scip-typescript process against a transient in-project config, shard outputs are streamed together byte-for-byte, and a failed shard blocks publication instead of publishing a silently incomplete index. `health --full` semantic prewarm computes callee evidence in file batches whose completed rows persist before the next batch starts, releasing its compiler session only under measured heap pressure, so the prewarm converges across runs instead of losing all work to one out-of-memory crash. Consumer classification reads its persisted per-file usage product before touching the AST and walks trees with a cursor, so whole-repository health phases no longer re-parse warm files or materialize a native cache entry per syntax node.

## Terms and referents

A **compiler shard** is one ordinary TypeScript project config whose explicit input list bounds one scip-typescript Program. Its real referents are the transient `<projectRoot>/.scipquery-compiler-shard-N.tsconfig.json` files and the per-shard `.scip` outputs they produce. What bounds it is not `files` alone: `include` inherited through `extends` is unioned with `files`, so every shard config also overrides `include` and `exclude` explicitly — without that override each shard silently compiles and emits the whole repository again.

An **in-project shard config** is a shard config written inside the repository root rather than the cache directory. What makes placement load-bearing is TypeScript's automatic `@types` resolution, which walks up from the directory containing the config file; a config outside the project silently drops ambient typings (`@types/mapbox-gl`, `@types/ws`, `@types/geojson` on the measured repository) and degrades emitted occurrences. These configs are excluded from project fingerprints (`isTypeScriptCompilerShardConfigPath`) so a concurrent enumeration cannot observe them as inputs.

A **memory-gated shard pool** is the bounded concurrency under which shard children run: at most `min(shardCount, 4, totalmem/2 ÷ 6 GiB, cpus/2)` at once, overridable with `SCIP_QUERY_TS_COMPILER_SHARD_CONCURRENCY`. What distinguishes it from the general indexer pool is that each child holds an independent compiler program whose peak is bounded by physical memory, not CPU count.

A **streamed composition** is the byte concatenation of disjoint shard outputs (`concatenateScipFiles`). Its correctness referent is the protobuf encoding rule that repeated encodings of one message concatenate into their merge; scip-typescript already streams documents this way inside one run. What it avoids is deserializing the whole repository index into the coordinator heap merely to combine shards, and what guards it is all-or-nothing composition: any skipped shard blocks the language output.

A **convergent callee prewarm** is the batched form of `health --full` semantic callee materialization. Its real referents are file-grouped definition batches (256 files each) whose computed rows are written to `semantic_callees` before the next batch starts, plus an adaptive provider release that discards the compiler session only when measured heap use crosses 60% of the isolate limit. What makes it convergent is that a release, crash, or timeout loses at most one batch; the next run resumes from persisted rows instead of repaying the whole pass.

## Diagnosis (measured on Launchpoint Backend, 7,694 compiler inputs, 48 GB machine)

- The monolithic program needs slightly more than the 8 GiB child heap today: direct reproduction crashed at 112 s with 9.0 GB peak RSS after writing 96% of its output, while the same command fit the night before at 77 s. The failure is a boundary crossing, not a cliff — the repository simply grew past the heap.
- Memory model: peak ≈ 2.4 GB (parsed dependency closure including `node_modules` typings) + ~0.9 MB × declared input. Path-sorted 2,048-file shards keep the parsed closure near 60% of the repository, so large shards beat small ones; a 256-file shard pays almost the same closure parse ~30× more often.
- The prior sharding prototype was unbounded in disguise: its shard configs did not override the inherited `include`, so every "shard" compiled and emitted the entire repository, and its cache-directory placement dropped walk-up `@types` packages.
- `health --full` semantic prewarm crashed at a 9.1 GB peak inside its 8 GiB isolated heap during the callee pass, which computed every definition in one sweep and wrote nothing until the end. The failed prewarm then cascaded: `similar`, `extract-candidates`, and `complexity-hotspots` workers computed whole-repository semantics in-process and exceeded their own limits, with worker RSS observed up to 17.4 GB (off-heap memory is not bounded by the V8 old-space flag).
- Even with warm semantic evidence, `wrapper-candidates` and `stale-abstractions` workers ballooned to 17.6 GB and 14.4 GB RSS while `heapUsed` stayed near 1 GB. Two mechanisms compounded:
  - **A parse storm.** `computeFileLeafUsage` requested `{ text, ast }` before reading its persisted `consumer-file-usage` product, so every warm consumer-file classification re-parsed the file it was about to serve from cache; tree-sitter `Parser.parse` was 55% of the phase CPU profile.
  - **Deferred native release.** tree-sitter trees and per-node cache entries are freed by V8 second-pass weak callbacks, which run only on event-loop turns. A synchronous whole-repository sweep never yields, so no native memory is released until the process exits — `gc()` alone does not free it (measured: parse rounds grow linearly under forced GC, and plateau completely once loop ticks are inserted). Additionally, every materialized node object pins ~300–400 bytes of native cache memory; cursor traversal pins none.

## Measured results

- Forced cold reindex: 7,694 inputs as 4 shards, 4 concurrent; peak child RSS 5.1 GB; indexer phase ~50 s (was 77 s monolithic when it fit at all); full pipeline 135 s; output 7,694 documents, byte-size parity with the last known good index; queries verified against the produced generation.
- `reindex --force` now implies the whole-project rebuild permission — an explicit force is a request to rebuild, and its cost is bounded by sharding rather than gated behind `--allow-expensive-rebuild`.
- Incremental indexing on the shard-built generation: a whitespace-only edit republished in 11.1 s and a source edit in 3.8 s, both via the incremental strategy with ~5 KB produced.
- `health --full` progression on the same repository and index:
  - Baseline after the reindex fix only: 833 s, complete report, but four disclosed memory omissions (semantic prewarm, similar, extract-candidates, complexity-hotspots); worker RSS up to 17.4 GB.
  - After the convergent prewarm: 516 s converging, 300 s warm, zero omissions; prewarm peak 5.9 GB (was a 9.1 GB crash), marker written so later runs skip it.
  - After the consumer-evidence parse-storm fix and cursor traversal: **160 s, zero omissions, every phase worker ≤ 3.6 GB RSS**. Solo phases: wrapper-candidates 17.6 GB/110 s → 2.0 GB/30 s; stale-abstractions 14.4 GB/73 s → 1.8 GB/20 s.

## Invariants

1. A shard config bounds its program by explicit `files` plus explicit `include: []` and `exclude: []`; a config that merely lists `files` is not a shard.
2. Shard configs live in the project root, are excluded from project fingerprints, are replaced (not fatal) when a stale one is found, and are removed after the run and swept before the next.
3. A concatenated language output exists only when every shard succeeded; one failed shard blocks the whole language rather than publishing a partial index.
4. Callee prewarm rows persist per batch before further compute; provider releases are paid only under measured heap pressure, never on a fixed schedule.
5. Sharding activates only above `floor(targetFiles × 1.5)` declared inputs (target 2,048, `SCIP_QUERY_TS_COMPILER_SHARD_FILES`); below it a single program remains cheaper because shards re-parse their shared closure.
6. A per-file evidence product is read before the source it summarizes is parsed; requesting an AST ahead of the product check silently re-parses every warm file.
7. Whole-file syntax sweeps traverse with a tree cursor (`Tree.walk()`), not per-node objects; a node object pins native cache memory that a synchronous sweep cannot release, because tree-sitter's native frees run in V8 second-pass callbacks that need event-loop turns.
8. `src/platform/native-gc.ts` can trigger collection without `--expose-gc` (runtime flag route) and accumulates finalizer-owned allocation estimates from the AST parse funnel; it bounds dead-tree accumulation wherever the event loop does turn, and is a no-op guard, never a correctness dependency.

## Second round: forced-run semantics and coordinator bounds (same day)

Confirming on the real repository (not the clone) exposed four more defects, each invisible on a cold cache:

- **`--force` didn't force.** With an unchanged accepted generation, a forced run served the cached language shard or the incremental materialization — carrying forward exactly the state `--force` exists to escape. Forced runs now classify every language and project shard as missed and skip incremental materialization; freshly built shards are still fingerprinted and cached.
- **The coordinator deserialized the whole index three ways.** `sanitizeScipFile` materialized a ~355 MB artifact into gigabytes of objects on every full conversion; shared-generation publication and validation each did the same just to read `metadata.projectRoot`; baseline hydration did it again to rewrite that one string. All four now use protobuf wire framing (`src/reindex/scip-wire.ts`): sanitize is a two-pass framing scan that copies untouched documents verbatim, the metadata reads decode nothing but the field they need, and rebase rewrites only metadata occurrences. The coordinator's earlier default-heap OOM (4 GB) on the real cache came from these, stacked on incremental-path state.
- **Static value evaluation was quadratic.** `findVariableInitializer` walked the whole tree per identifier lookup — including other files' trees for imported constants — making single files cost over a second in the capability-registry extractor. A memoized per-root const-initializer index (first passing declarator wins, preserving the scan's semantics) answers lookups O(1): 1,755 ms → 2 ms warm on the worst file; the extractor went 17.5 s → 3.8 s repo-wide.
- **Extraction re-scanned and re-parsed.** Up to eight full-tree `descendantsOfType` scans per file (native cursor traversal dominated the phase) collapse into one per-root type-indexed pass (`src/source/ast/ast-node-index.ts`); extraction's per-file parse now enters the source-keyed tree cache (`getAstForSource`) so cross-file constant resolution shares trees instead of re-parsing.

Measured end state on the real repository, forced full reindex at the **default heap**: **91.3 s, published**, coordinator JS heap within the 4 GB default (peak RSS 6.6 GB is dominated by extraction's native trees), max shard child 5.6 GB. The session started with this exact command crashing at 112 s with nothing published. Runtime-boundary extraction: 54 s → 36 s.

## Named follow-ups

- The dev watch-server's RSS grows over hours (observed 3.9 → 5.4 GB on one repository); its semantic/index service heap is the next bounded-memory candidate.
- Cold-path source-facts computation still materializes node objects per file once per content hash; converting the remaining hot walkers to cursor traversal would cut cold health/reindex churn further.
