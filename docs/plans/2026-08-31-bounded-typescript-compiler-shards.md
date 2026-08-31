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

## Third round: HTTP summary propagation and shard planning (same day)

- **Covering-callable lookups were quadratic.** `smallestCoveringCallable` walked the caller's whole tree per resolved call site, and HTTP summary propagation asks once per site; a memoized per-root callable index (cursor pass, named nodes only — anonymous `function` keyword tokens share the type names) answers from a short list. Forwarded-role derivation went 5.5 s → 1.9 s, and the carrier phase halved for the same reason.
- **Call-syntax indexes now come from the shared per-root type index** instead of a private node-object recursion.
- **Shard planning is makespan-aware.** Shard count now minimizes waves × per-shard size against the machine's parallelism (a count below the target is allowed while per-shard inputs stay under 1.25× target), and shards are balanced by source bytes rather than file counts. Byte weighting did **not** tame the densest shard on the measured repository (~43 s vs ~32 s peers — its cost is type-check density, not bytes); measured-cost feedback would be the next lever there.
- Ruled out cheaply: scip-typescript's O(files × program) membership scan costs only ~24 ms per shard — not worth patching.

Measured: http-summary 10.5 s → 6.4 s on both the clone and the real repository; whole extraction 34.3 s → 27.7 s standalone; clone forced reindex 124.6 s → 93.2 s; real-repository forced reindex published at 99.8 s on a tree that had just grown by a large merged refactor.

## Fourth round: extraction fingerprints and the dense-shard verdict (same day)

- **Boundary source hashes are now a persisted evidence product.** Every full extraction tokenized every file with a TypeScript scanner (plus two running SHA-256s) to compute the syntax/shape hashes that power incremental reuse — 6.3 s of the per-file overhead. They are pure functions of the bytes, so `runtime-boundary-source-hashes` now serves them by content hash like the other evidence products; a warm run pays ~185 ms. Direct extraction: 21.8 s → 15.1 s.
- **The dense-shard question is closed with data.** Byte-balanced shards have near-equal bytes (±1%) _and_ near-equal previous-index mention density (±7%), yet a ~40% duration spread remains. Parse-only closure measurement explains it: the shard holding `e2e/` parses an 11,094-file / 95 MB closure versus ~8.2–9.7 k / 69–79 MB for its peers, because end-to-end tests import the whole application — wherever they land, that shard pays a near-whole-repo closure. Contiguous path partitioning has hit its ceiling; per-shard measured-cost feedback or a warm compile server are the remaining levers.
- Deferred deliberately: yielding the event loop inside the extraction sweep (so tree-sitter second-pass finalizers can run mid-sweep) requires async-ifying the post-index augmentation stage chain; the coordinator's JS heap is already safe, so the transient native RSS stays a follow-up.

Validating the fingerprint product on the real repository exposed one latent regression and one measurement contract:

- **Publish applied a stale deferred companion onto fresh builds.** When the accepted generation's publication recorded `scipCompanion: 'deferred'` (the watcher's incremental publishes leave it that way), publish spent ~17 s and a ~4 GB coordinator heap spike materializing the previous generation's overlay onto a typescript output that had just been rebuilt from scratch — reintroducing the default-heap OOM on watcher-managed caches. A freshly built output already covers every current input, so materialization now runs only when the typescript shard was reused.
- Evidence batch writes now truncate the WAL at their durability point, and the cache-lifecycle plateau accounting ignores SQLite `-shm`/`-wal` files, whose presence tracks connection lifetime rather than retained content.

Measured steady state, forced full reindex at the default heap: clone **85.6 s**, real repository **87.8 s** (session start: an OOM crash; first fix round: 135 s).

## Fifth round: yielding extraction and the async augmentation chain (same day)

The fourth round deferred the one structural fix tree-sitter's memory model demands: native trees and node-wrapper cache entries are freed by V8 second-pass weak callbacks that only run on event-loop turns, so a fully synchronous whole-repository extraction sweep retains every tree it ever parsed until the phase exits. The post-index augmentation chain is now async end to end (`AsyncPostIndexAugmentationStage`, `runPostIndexAugmentationAsync`): `collectRuntimeBoundaryGraph` awaits a `setImmediate` yield every 256 files, giving finalizers ~30 windows per sweep, and the reuse-check/publish spans moved to `profileAsyncSpan`. The parse funnel's 512 MB finalizer-owned-allocation threshold (`native-gc.ts`) now actually bounds accumulation, because the loop turns it needs exist mid-sweep.

Measured on the clone, forced full reindex at the default heap: peak coordinator RSS **6.6 GB → 4.7 GB** on an idle machine (and 2.6 GB under CPU contention, where the sweep gets more loop turns per unit work — direct evidence the finalizer windows are what frees the trees). Wall time 96.4 s with profiling enabled, inside the 85.6–102.2 s spread of identical pre-refactor runs — the yields cost nothing measurable.

The sweep's async-ness surfaced one test-conversion trap worth writing down: `await f(x).y.z` binds the await *after* the property chain, so a mechanical sync→async conversion that inserts `await` without parenthesizing silently reads properties off the Promise.

## Sixth round: forced-run shadow skip and measured-cost shard feedback (same day)

- **The affected-set shadow no longer runs its oracle on a rebuild with unchanged inputs.** A forced rebuild whose input snapshot didn't change gives the predictor nothing to predict, so the paired whole-index fact digests (5.3 s and a large share of the coordinator's residual RSS peak) could only measure tool drift — and misreported it as 0% predictor recall whenever the tool version changed between runs. The record now says `unavailable (no-input-changes)`; a reused index keeps its drift oracle, because there the digests genuinely validate that reuse changed nothing. With the digest pass gone, forced-run peak coordinator RSS measured 2.1–2.6 GB (from 4.7 GB with it).
- **Shard partitioning now learns from measured shard durations.** Each completed shard run records its contiguous path range, raw byte weight, and wall time to `typescript-shard-costs.json` in the cache directory; the next partition scales every file's byte weight by its previous range's measured ms-per-byte (median-normalized, clamped to 4× either way so one contended run cannot capsize the partition). Files outside every recorded range keep plain byte weight, and fewer than two samples leave the partition byte-balanced. Uniform machine contention scales all rates equally, so the relative signal survives a noisy training run.
- First cost-balanced run on the validation clone: per-shard durations 79/85/85/84 s — a 7.6% spread versus 39% byte-balanced — measured under heavy external load (a concurrent `tsgo` build and the watch-server), so the spread is the meaningful number and the absolute times are not.
- Quiet-machine before/after pair, same window: byte-balanced 46.6/36.5/33.4/37.9 s (makespan 46.6 s, total 97.3 s) → cost-balanced 43.2/42.1/38.2/41.5 s (makespan 43.2 s, total 85.8 s, profiling enabled). The indexer wave went 50.5 → 46.5 s and publish 46.6 → 40.2 s (shadow gone). Peak coordinator RSS across the pair: 2.1–2.7 GB — the digest oracle was a large share of the earlier 4.7 GB residual peak. Net: the same 85.6 s wall the fourth round measured *without* profiling, now with profiling on and at ~40% of the memory.
- The model's fixed point is stable, not oscillatory: at balanced durations the per-range ms-per-byte rates still differ (the dense range holds 3.35 ms/KB versus 2.20 for its cheapest peer — that difference is what holds the boundaries in place), so re-deriving weights from a balanced run reproduces the same partition.

## Seventh round: direct extraction as a dependency-validated evidence product (same day)

Runtime-boundary direct extraction re-ran its whole per-file sweep (AST parse, extractor passes, owner resolution — ~17 s of the 27 s phase) on every full rebuild, even though the watcher's incremental path already reused per-file observations on file-hash identity alone. That reuse contract was subtly unsound: an observation can embed values resolved from *other* files (imported constants, bounded call returns followed up to depth 8, definition owners), and nothing invalidated it when a consulted file changed.

The sweep's per-file result is now a persisted product, `runtime-boundary-direct-extraction`, that closes that hole instead of copying it: a file-access recorder armed around each file's extraction (`src/platform/file-access-recorder.ts`, reporting from the shared `getSourceText`/`readSourceTextUncached`/`getDefinitionsForFile` chokepoints) captures exactly which files the resolvers consulted, and the payload names each one with its content hash. A read revalidates every named dependency and the extractor version before serving; a file whose extraction errored is never cached. Observation ids are content-deterministic (sha256 of extractor/action/file/line/keyParts), so cached and fresh rows mix safely.

Measured on the validation clone, same window: the populate run costs nothing extra (27.5 s vs the 27.2 s baseline), and the warm run's runtime-boundaries phase drops **27.5 s → 13.9 s** — the extraction spans vanish entirely (all 7,758 files product-served; reads sub-millisecond each). On the real repository content: 1,407 files carry observations, 86 consulted other files (avg 1.1, max 2), so per-read dependency validation is effectively free. What remains of the phase is the derived half (http-summary propagation, mounts, links), which has its own reuse path in watcher mode.

## Named follow-ups

- The dev watch-server's RSS grows over hours (observed 3.9 → 5.4 GB on one repository); its semantic/index service heap is the next bounded-memory candidate.
- Cold-path source-facts computation still materializes node objects per file once per content hash; converting the remaining hot walkers to cursor traversal would cut cold health/reindex churn further.
