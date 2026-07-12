# Rust Workspace Shards Feasibility Ledger

Date: 2026-07-11

Run history: [`runs/2026-07-11-rust-workspace-shards.jsonl`](./runs/2026-07-11-rust-workspace-shards.jsonl)

## Output Contract

A crate-scoped Rust index is acceptable only when, after rebasing its project root and document paths to the repository root, every document is exactly equal to the same document in a clean full-workspace `rust-analyzer scip` index. A performance path is acceptable only when it avoids the dominant compiler-loading work on a representative multi-crate workspace; emitting fewer bytes after repeating that work is not an incremental computation.

## Measurements

| Corpus | Scenario | Time | Output | Correctness | Decision |
| --- | --- | ---: | ---: | --- | --- |
| scip-query | `crates/scip-query-kernels` member | 2.63s | 68,768 bytes / 2 docs | Normalized documents exactly match the cached root index | Small-corpus correctness pass |
| codex-rs (119 crates) | Full workspace | 233.56s | 141,051,826 bytes | Clean oracle | Baseline |
| codex-rs | `async-utils` member | 176.89s | 13,048 bytes / 1 doc | Normalized document exactly matches the full oracle | Performance reject: 75.7% of full time for 1 document |
| codex-rs | second member (`protocol`) | 33.66s before termination | incomplete | n/a | Stopped; repeating the first result would consume another workspace load |

## Pipeline Finding

`rust-analyzer scip <member>` narrows the documents it serializes, but it still creates a new process, runs Cargo workspace discovery, loads build scripts and procedural macros, creates a fresh analysis database, and computes a `StaticIndex`. On codex-rs, this startup/analysis boundary dominates the output loop. Running one process for every missed crate would therefore multiply rather than remove work. Parallel execution would add Cargo-lock contention and memory pressure without changing that identity.

The upstream implementation confirms the boundary. `crates/rust-analyzer/src/cli/scip.rs` calls `load_workspace_at`, constructs a new `AnalysisHost`, calls `StaticIndex::compute`, and only then serializes documents. `crates/ide/src/static_index.rs` exposes `StaticIndex` as an internal library structure, not an LSP request or stable command that accepts changed file identities. The public `scip-rust` project is a thin wrapper around the same `rust-analyzer scip .` command, so replacing the executable name does not change the computation.

## Decision

Reject automatic per-crate subprocess sharding. It preserves sampled document correctness but fails the performance gate on the representative workspace. Do not add Cargo cache metadata, crate subprocess concurrency, or merge/rebase production code for this design.

The next viable boundary is one persistent Rust analysis owner that can export selected `StaticIndexedFile` values, or an upstream `rust-analyzer` command/protocol that does so. scip-query's existing durable rust-analyzer LSP session proves lifecycle ownership and crash recovery, but the LSP does not expose `StaticIndex`; semantic-session reuse and SCIP-document production remain different products. Until that producer exists, retain whole-Rust-shard caching and the complete-workspace fallback.

## Next Experiment

Prototype the smallest rust-analyzer-side API that accepts repository-relative file paths after one workspace load and serializes only those files plus the required symbol information. Measure it in one process across two successive codex-rs edits. Accept only if:

- the initial complete output matches the clean CLI oracle;
- an affected-file request matches the corresponding clean-oracle documents and external-symbol relationships;
- the second request avoids Cargo/build-script/proc-macro reload;
- the end-to-end edit path materially beats 176.89s without increasing steady-state memory beyond a documented service budget;
- crash, version, and unsupported-build fallback returns to the installed complete `rust-analyzer scip` path.
