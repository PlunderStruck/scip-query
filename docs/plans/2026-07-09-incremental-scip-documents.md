# Incremental SCIP Document Plan

Date: 2026-07-09
Status: Phases 4.1–4.3 complete; Phase 4.4 authoritative reindex integration next
Parent: [`2026-07-09-automatic-incremental-indexing-roadmap.md`](./2026-07-09-automatic-incremental-indexing-roadmap.md)

## Outcome

Implement compiler-correct incremental SCIP documents for TypeScript by
retaining the TypeScript compiler program and scip-typescript's project-wide
symbol tables in the repository service. Keep the whole-project
`scip-typescript` command as the fallback and clean parity oracle. Do not claim
the same capability for Rust: the installed rust-analyzer CLI and its current
upstream implementation expose only a project-wide static-index computation.

A **SCIP document** is the protocol record for one real source file; its
essential characteristic is that it contains the occurrences and symbol
information needed to reconstruct that file's part of the compiler-resolved
code graph. A **canonical fragment** is a serialized SCIP document coupled to
the exact producer, compiler, configuration, and source identities that made
it; those identities make reuse safe rather than merely convenient. An
**incremental producer** is a compiler-backed indexer that accepts changed
source state and emits only the affected documents while preserving the clean
whole-project indexer's output. These definitions refer here to actual
protobuf documents emitted by scip-typescript 0.4.0, not syntax-only summaries.

## Verified Boundary

Local environment:

- `@sourcegraph/scip-typescript` 0.4.0 and TypeScript 5.9.3;
- rust-analyzer `1.92.0 (ded5c06c 2025-12-08)`;
- scip-query commit `eb5f3ab8` before Phase 4 edits;
- 311 TypeScript documents in the root project shard.

Upstream was inspected at scip-typescript HEAD `891eb4293709a6a587bf4468dfa1b45a85182fd9`
and rust-analyzer HEAD `9edb92ec00e7c7d42effa6dc12fc65be65a214d9`.
The relevant primary sources are scip-typescript's
[`ProjectIndexer.ts`](https://github.com/sourcegraph/scip-typescript/blob/891eb4293709a6a587bf4468dfa1b45a85182fd9/src/ProjectIndexer.ts)
and rust-analyzer's
[`scip.rs`](https://github.com/rust-lang/rust-analyzer/blob/9edb92ec00e7c7d42effa6dc12fc65be65a214d9/crates/rust-analyzer/src/cli/scip.rs).

The installed scip-typescript package has no `exports` map or supported
document API, but it ships `FileIndexer`, `Input`, `Packages`, and protobuf
runtime modules. `ProjectIndexer` creates one compiler `Program`, retains a
project-wide node-to-SCIP-symbol map, then invokes `FileIndexer` once per
source file. The upstream main branch still has this shape and release 0.4.0
is current as of the probe.

Discriminating probes:

| Probe | Result | Meaning |
| --- | ---: | --- |
| Full installed CLI | 2,460ms wall; 311 documents | Clean oracle and current rebuild cost |
| One ts-morph-backed isolated document | exact for the trivial leaf only | Rejected: ts-morph's virtual standard-library paths change SCIP symbols |
| Fresh root-TypeScript isolated documents | 251/311 exact | Rejected: 60 documents depend on the project-wide symbol table |
| Warm retained compiler plus symbol tables | 311/311 exact | Required producer state identified |
| Exported-symbol leaf edit | 2.782ms program update + 0.494ms document emission | 3.277ms total; byte-exact against a clean edited full oracle |

The 60 isolated mismatches are not protobuf ordering noise. Foreign anonymous
type literals receive names from the `FileIndexer` counter at first discovery;
without the retained project symbol table, later local symbol numbers also
shift. This falsified the simpler stateless-document design before it could
become authoritative.

rust-analyzer's current `scip` command loads the Cargo workspace, creates an
`AnalysisHost`, calls `StaticIndex::compute` for the complete analysis, then
derives all documents and the global external-symbol set. The CLI exposes no
file selector and the running LSP exposes no SCIP-document request. A Rust
incremental producer would require an upstream API or an embedded native
component built from rust-analyzer's internal crates. That is the roadmap's
authorized upstream boundary; Rust continues to use project shards and the
whole-project oracle.

## Contracts

1. Only a source-only modified-file manifest with a Phase 2 `closure` plan may
   use incremental TypeScript documents. Adds, deletes, config, ambient,
   unreadable, unknown, missing-prior, or identity changes rebuild the project.
2. The emitter must reject unsupported scip-typescript module shape or producer
   identity. A deep import failure is a normal fallback, never a partial index.
3. The retained compiler host reuses unchanged `SourceFile` nodes, replaces
   changed nodes, and prunes old-node symbol-cache entries before advancing.
4. Every affected document is emitted with the new `TypeChecker`. Unaffected
   canonical fragments remain unchanged.
5. A candidate TypeScript shard is assembled completely under a temporary
   generation. Readers continue to use the preceding published generation.
6. Any missing affected document, duplicate path, serialization failure,
   timeout, service crash, parity failure, or publication failure invokes the
   existing whole-project indexer.
7. The clean full indexer remains the manual repair route and periodic canary
   oracle.

## Executable Steps

### 4.1 — Supported emitter adapter

- Add a narrow runtime adapter for scip-typescript 0.4.0's shipped internal
  modules and TypeScript 5.9.3.
- Retain compiler host, `Program`, checker, package resolver, global symbol
  table, constructor table, and canonical document buffers.
- Advance modified source files with `createProgram(..., oldProgram)` and emit
  an explicit affected set.
- Unit-test cold full parity, true leaf-edit parity, dependent-file parity,
  unsupported runtime fallback, and repeated-edit cache pruning.

Commit boundary: adapter plus focused tests and this feasibility record.

**Result:** Complete in `src/reindex/typescript-document-emitter.ts`. The
adapter loads the optional 0.4.0 runtime by absolute package path, rejects any
other version or module shape, uses that package's own TypeScript dependency,
retains compiler/source/symbol/package state, prunes old changed-file AST keys,
and emits explicit affected paths. Its independent test invokes the real
scip-typescript CLI as the clean oracle before and after two source edits. All
base and affected document bytes matched, both changed source nodes were
replaced, and stale symbol entries were pruned. Focused tests, typecheck,
format, ESLint, build, and diff checks passed.

### 4.2 — Durable fragment store

- Store one versioned document record per relative path under the index cache.
- Key the store by scip-typescript version, TypeScript version, tsconfig and
  project membership identity, and document source/dependency identity.
- Seed or repair fragments from the last accepted whole-project shard.
- Assemble a deterministic candidate TypeScript shard by replacing every
  affected path and retaining all other documents and metadata.
- Treat external symbols as a producer-wide unit; scip-typescript 0.4.0 emits
  none, but validate that fact instead of assuming it forever.

Commit boundary: storage/assembly code plus corruption, deletion, ordering,
identity, and round-trip tests.

**Result:** Complete in `src/reindex/typescript-fragment-store.ts`. Document
bytes are content-addressed, while an immutable atomic manifest names the
complete document set for one producer/project/source generation. Reads verify
every blob's length and SHA-256 before returning it. Assembly preserves the
prior shard's metadata and document order, replaces only existing paths, and
rejects unexpected external symbols. The true-edit fixture assembled an
entire shard byte-for-byte equal to the installed CLI oracle. Missing paths,
wrong project identity, mutation of an existing generation, and a corrupted
blob all failed as required. Garbage collection validates kept manifests
before deleting prior generations or unreferenced blobs.

### 4.3 — Service transport and fallback

- Add a versioned TypeScript index mailbox owned by the existing one-writer
  repository service; do not overload generation-bound semantic requests.
- Let the reindex worker send prior generation, change manifest, affected
  paths, producer identity, and deadline.
- Return canonical fragment bytes and diagnostics. On timeout or rejection,
  the worker runs the existing project indexer.
- Report warm/cold state, requests, documents emitted/reused, fallback reason,
  update duration, and last parity result in service status.

Commit boundary: transport, lifecycle tests, and status surface.

**Result:** Complete across `typescript-index-protocol.ts`,
`typescript-index-service.ts`, and `typescript-index-requester.ts`. A dedicated
mailbox binds each request and response to the currently published base
generation, exact producer/project identities, a deadline, and complete
modified/affected path sets. The repository service retains one emitter,
advertises cold warmups/program updates/document counts, and publishes a busy
deadline before blocking compiler work. Protocol 3 replaces older daemons.
Malformed, expired, stale-generation, dead-service, timeout, and omitted-
affected-document controls all failed; a cold request followed by a real warm
source update reused one session and advanced its compiler program once.

### 4.4 — Reindex authority and Phase 4 calibration

- Compute the authoritative eligibility plan before preparing indexer runs.
- Patch the prior TypeScript language shard only after every affected fragment
  validates, then feed it through the existing merge/publish pipeline.
- Exercise service cold/warm, direct manual fallback, crash, timeout,
  concurrent refresh, config/add/delete widening, and package install.
- Alternate five clean controls with five warm leaf edits on scip-query and
  OpenCode. Require exact normalized SCIP and SQLite/fact parity, local p95 at
  most 2s, large-corpus p95 at most 5s, and no-op regression at most 10%.

Commit boundary: authoritative integration, benchmark evidence, and Phase 4
roadmap closure.

## Verification

Each commit runs its focused tests, typecheck, lint, build, `git diff --check`,
and the matching SCIP migration/duplicate/co-change checks. The Phase 4
boundary additionally runs all tests, package dry-run plus packed-install
smoke, `scip-query reindex`, and `scip-query diff-gate`. A deliberately
corrupted fragment and a deliberately omitted affected document must make the
verifier fail before canary results are trusted.

## Exact Next Action

```sh
SCIP_QUERY_SKIP_WATCH_SERVICE=1 node dist/cli.js plan-context \
  src/reindex/index.ts --json
```
