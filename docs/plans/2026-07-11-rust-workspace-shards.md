# Rust Workspace Shards and Affected-Set Shadow Plan

Date: 2026-07-11

## Goal

Make a Rust edit in a Cargo workspace rerun only the owning crate and its workspace dependents while unrelated crate SCIP shards are reused. Preserve exact graph output by rebasing and merging crate indexes, fail back to the complete workspace index whenever Cargo structure or parity is uncertain, and publish affected-file measurements without claiming file-level Rust SCIP production.

## Current State

- `scip-query plan-context src/reindex/indexer-runner.ts` identifies `runPreparedIndexers` as the process boundary and `src/reindex/index.ts` as its only orchestration consumer.
- `scip-query code prepareIndexerRunsForLanguage --json` shows that only TypeScript workspace mode currently expands one language into project runs; every Rust index is one `rust-analyzer scip .` run.
- `scip-query code collectIndexerOutputs --json` and `scip-query code mergeScipIndexes --json` show that multiple runs can already merge into one language output, but the merger intentionally rejects differing SCIP project roots.
- `scip-query code computeProjectShardFingerprints --json` shows a reusable pure invalidation primitive: a project fingerprint contains its own files, transitive dependency files, and conservative shared inputs.
- The 2026-07-09 indexing ledger records the upstream boundary: `rust-analyzer scip` creates one complete `StaticIndex`; neither its CLI nor LSP emits individual changed documents.
- Feasibility probe: `rust-analyzer scip crates/scip-query-kernels --output /tmp/scip-query-rust-member.scip` completed in 2.63s. After rebasing `src/*.rs` to `crates/scip-query-kernels/src/*.rs`, its two documents were byte-identical in JSON form to the cached repository-root Rust shard. Raw protobuf hashes differed because `metadata.project_root` and relative paths intentionally differed.

## Reuse Audit

- Extend `PreparedIndexerRun` with an optional working/project-root normalization contract rather than adding a second process runner.
- Reuse `assignFilesToProjects`, `computeProjectShardFingerprints`, `projectShardSlug`, cache classification, concurrency, diagnostics, and atomic language-output publication. Generalize only the TypeScript-specific cache plumbing that has identical Rust semantics.
- Add a Cargo workspace reader because `readProjectManifestInputs` parses npm/tsconfig concepts and cannot represent Cargo package IDs, renamed dependencies, workspace membership, build scripts, or target source roots without package-dealing two different manifest models.
- Extend the existing SCIP merger with project-root rebasing before merge; do not create a parallel protobuf merger.
- Reuse the existing affected-set shadow report format where it can state predicted/changed Rust documents honestly. Do not route Rust through the TypeScript compiler document producer.

## Testability Design

| Behavior | Test seam | Dependencies to inject | Pure core | Side-effect shell | Contract |
| --- | --- | --- | --- | --- | --- |
| Discover Cargo members and dependencies | Cargo workspace discovery function | `cargo metadata` executor and filesystem root | metadata-to-project graph conversion | command invocation | Return repo-relative member roots and conservative transitive dependency edges; malformed/incomplete metadata returns an explicit fallback reason |
| Decide crate cache reuse | Existing project-shard functions plus language-specific plan | fingerprints and cache existence probes | assignment, dependency closure, classification | cache reads/copies | A crate is reusable only when its own, dependency, and shared input fingerprints match |
| Merge crate indexes safely | SCIP rebase function plus existing merger | decoded indexes | path/root normalization | file decode/encode | Every output document is repository-relative; roots outside the repository reject the crate path and trigger full-workspace fallback |
| Run only missed crates | Existing `runPreparedIndexers` | prepared runs and concurrency | missed-run selection | `rust-analyzer` processes | Unrelated cache hits do not spawn; any failed crate run retries serially then falls back to one complete Rust run |
| Report Rust affected-set shadow | shadow comparison helper | previous/current document hashes | predicted-vs-changed set comparison | report persistence | Rust report is observational until 100% recall is demonstrated across registered corpora |

## Design Phases

### 1. Prove multi-crate output parity

- [x] **Files**: `docs/benchmarks/runs/2026-07-11-rust-workspace-shards.jsonl`, `docs/benchmarks/2026-07-11-rust-workspace-shards-ledger.md`
- **Source**: `rust-analyzer scip --help`; `scip-query code mergeScipIndexes --json`; the scip-query member probe recorded above.
- **Change**: Compare full-workspace and per-member indexes on scip-query plus a representative multi-crate workspace. Normalize only project root and relative paths; compare documents, occurrences, symbol information, and external-symbol relationships. Record time and bytes for every run.
- **Testability**: The parity script operates on explicit input paths and emits hashes/counts; subprocess invocation remains outside comparison logic.
- **Validation**: Exact normalized document identity for every indexed workspace member. If it fails, stop before activation and retain only shadow/discovery work.
- **Why**: Crate caching is invalid unless independently produced SCIP facts equal the full workspace oracle.

**Result**: Correctness passed for the sampled scip-query and codex-rs members, but performance failed: one codex-rs member took 176.89s, 75.7% of the 233.56s complete-workspace oracle. The member process repeated workspace metadata, build-script, procedural-macro, analysis-host, and static-index setup. Per-crate subprocess activation is rejected.

### 2. Add conservative Cargo workspace discovery

- [ ] **Files**: `src/reindex/rust-workspace.ts`, `tests/reindex/rust-workspace.test.ts`
- **Source**: `scip-query code prepareIndexerRunsForLanguage --json`; Cargo metadata output from Phase 1.
- **Change**: Parse workspace members, repo-relative manifest roots, targets, and workspace dependency edges from injected Cargo metadata. Classify root/package/build/config files not owned by a member as shared. Reject members outside the repository, duplicate roots, missing resolve nodes, or non-file manifest paths with a named fallback reason.
- **Testability**: Pure metadata parser tests cover renamed deps, transitive deps, independent crates, nested roots, malformed metadata, and external members. One shell test covers command arguments.
- **Validation**: Focused Vitest suite and fixtures generated from representative metadata shapes.
- **Why**: Cache invalidation must follow Cargo's resolved package graph rather than directory guesses.

**Status**: Not started. Blocked by the Phase 1 performance rejection; discovery alone would not remove work.

### 3. Rebase and merge crate SCIP indexes

- [ ] **Files**: `src/reindex/merge.ts`, `tests/reindex/merge.test.ts`
- **Source**: `scip-query code mergeScipIndexes --json`; Phase 1 root/path difference.
- **Change**: Add a pure rebase operation that rewrites a crate index's `metadata.projectRoot` and document paths to the repository root, validates containment, and then delegates to the existing merger.
- **Testability**: In-memory protobuf fixtures prove rebasing, root equality, traversal rejection, duplicate-document behavior, and unchanged symbols/occurrences.
- **Validation**: Existing merge tests plus normalized full-vs-member fixture equality.
- **Why**: The existing root mismatch rejection is correct; explicit validated rebasing is the only safe way to cross it.

**Status**: Not started. The feasibility harness proved normalized rebasing is correct, but production rebasing would serve a rejected execution strategy.

### 4. Add crate shard caching with full-workspace fallback

- [ ] **Files**: `src/reindex/index.ts`, `src/reindex/indexers.ts`, `src/reindex/indexer-runner.ts`, `src/reindex/project-shards.ts`, `tests/reindex/reindex-reliability.test.ts`
- **Source**: `scip-query plan-context src/reindex/indexer-runner.ts`; `scip-query code prepareIndexerRunsForLanguage --json`; `scip-query code computeProjectShardFingerprints --json`.
- **Change**: Automatically plan Rust crate shards for Cargo workspaces with at least two safe in-repository members. Run `rust-analyzer scip <member>` only for misses, copy hits from `language-indexes/rust-projects/`, rebase all member indexes, and merge them into the canonical Rust language shard. Persist additive `rustProjectShards` metadata. On discovery, run, rebase, or merge failure, discard the candidate plan and run the existing complete workspace indexer.
- **Testability**: Injected prepared runs and synthetic SCIP files prove first fill, no-op reuse, leaf edit, dependent invalidation, independent reuse, deleted member pruning, old-metadata migration, parallel failure retry, and complete fallback.
- **Validation**: Reliability suite, packed CLI smoke, and full-workspace output hash parity.
- **Why**: This is the first user-visible speedup and remains reversible because the old Rust run is preserved as fallback.

**Status**: Rejected. One subprocess per missed crate multiplies the dominant workspace-loading cost on codex-rs.

### 5. Publish Rust affected-set shadow evidence

- [ ] **Files**: existing affected-set/shadow modules selected by `scip-query plan-context`, status types/rendering, focused shadow tests
- **Source**: `docs/plans/2026-07-09-automatic-incremental-indexing-roadmap.md`; the existing TypeScript shadow status surface.
- **Change**: Record predicted Rust documents/crates, actually changed documents from the clean oracle during calibration runs, recall, ratio, and widening reasons. Label this as crate-level prediction; do not claim affected-document Rust production.
- **Testability**: Pure set comparison and status serialization tests.
- **Validation**: 100% recall on leaf, shared dependency, Cargo manifest, build script, macro-bearing, delete, and rename scenarios before the report can say `passing`.
- **Why**: File-level Rust work should be justified by measured affected ratios, not assumed from workspace structure.

**Status**: Existing generic affected-set shadow infrastructure already observes full-rebuild document changes. A separate Rust shadow implementation is deferred until a selective producer can consume its prediction.

### 6. Benchmark and ship

- [ ] **Files**: benchmark ledger/run history, README, `skills/scip-setup/SKILL.md`, changelog
- **Source**: Phase 1 baseline and accepted Phase 4 implementation.
- **Change**: Measure cold full workspace, first crate-cache fill, no-op reuse, independent leaf edit, dependency leaf edit, config edit, memory, and output identity on at least scip-query and codex-rs. Teach setup that Cargo workspace sharding is automatic only after safe discovery and that file-level Rust output remains upstream-blocked.
- **Testability**: Machine-readable records contain corpus revision, command, cache state, duration, output hash, crate hits/misses, and fallback reason.
- **Validation**: Focused tests, typecheck, lint, full suite, build, packed install, `cargo check`, `scip-query reindex`, `status --capabilities`, and `diff-gate --json`.
- **Why**: A performance feature ships only if it improves a real edit and preserves the full-workspace graph.

## Stress-Test Findings

- Procedural macros, `build.rs`, workspace configuration, patches, and generated `OUT_DIR` data can affect more than the edited crate; unknown ownership widens to all members or full fallback.
- A Cargo dependency edge points from consumer to dependency. A dependency edit invalidates reverse dependents; an application edit must not invalidate libraries it consumes.
- Crate subprocesses may contend for Cargo locks and memory. Existing configurable indexer concurrency remains the control, and benchmarks must compare serial and bounded parallel execution.
- Multiple crate indexes have distinct project roots by design. Merging without rebasing would create incorrect document paths; silently weakening the merger's root check is forbidden.
- Cross-crate external symbols must retain the same relationships as the full-workspace oracle. Matching document counts alone is insufficient.
- Single-crate repositories keep the existing complete Rust path; project sharding adds no value there.
- This is crate-level incremental indexing. True changed-document Rust SCIP output still requires an upstream or embedded `rust-analyzer` static-index API.

## Execution and Ship Order

1. Phase 1 is an evidence gate and may legitimately reject activation.
2. Phases 2 and 3 are test-only infrastructure until parity is proven.
3. Phase 4 is a two-way door because complete-workspace fallback remains intact; additive metadata is ignored by older versions.
4. Phase 5 remains observational and cannot control publication in this release.
5. Phase 6 updates user-facing claims only after real-corpus measurements pass.

Files created: Cargo workspace discovery/tests, benchmark run history and ledger. Files extended: reindex orchestration, indexer arguments, SCIP merger, metadata/diagnostics, setup documentation, changelog. No Rust source code or native ABI is required for this slice.

## Feasibility Decision Update

The original ship order stopped at its registered gate. The accepted next design is no longer per-crate subprocess caching; it is a persistent/static-index document-export boundary in rust-analyzer itself. The benchmark ledger records the precise contract and acceptance thresholds. No production behavior was changed because the proposed behavior would have been slower on the representative corpus.
