# TypeScript and Rust Indexing/Analysis Optimization

Date: 2026-07-09

## Goal

Make TypeScript and Rust indexing plus semantic analysis faster without changing
public command output. The first accepted slices must be measured on real
corpora and must preserve output hashes unless an accuracy correction is
explicitly documented before acceptance.

The immediate target is not a whole-CLI rewrite. The target is to keep moving
stable hot paths toward faster storage, batching, persistent sessions, or native
Rust only when the boundary actually wins.

## Current State

`node dist/cli.js status --capabilities` reports this repository as fresh with
293 files, 18,494 symbols, TypeScript semantics through ts-morph, Rust semantics
through rust-analyzer, and compiler cleanup verification through `tsc --noEmit`
and `cargo check --quiet --manifest-path Cargo.toml`.

`node dist/cli.js plan-context src/reindex/index.ts` shows `reindex()` in
`src/reindex/index.ts` is the public indexing entry point. The file is medium
risk: it is consumed by the worker, command handlers, setup, and about 20 other
files. It usually co-changes with `tests/reindex/reindex-reliability.test.ts`.

`node dist/cli.js code reuseExistingIndexIfPossible` shows full-project reuse
returns early only when the whole project fingerprint is unchanged and the
output SCIP and SQLite files exist. Otherwise fresh reindex proceeds.

`node dist/cli.js code runLanguageIndexersForFreshReindex` shows fresh reindex
can reuse per-language SCIP shards, including TypeScript and Rust. Even when all
language shards are reused, the publish phase still materializes combined SCIP,
converts it to SQLite, runs post-index augmentation, writes metadata, and
promotes artifacts.

`node dist/cli.js code publishFreshReindexArtifacts` shows the publish phase
calls `cacheLanguageShards()`, `materializeScipOutput()`,
`convertScipToSqlite()`, post-index augmentation, metadata write, and artifact
promotion in one atomic handoff.

`node dist/cli.js plan-context semanticCallerMap` shows
`src/semantic/shared-primitives.ts` is a high-risk shared module. Its caller map
feeds dead, isolated, change-surface, diff-impact, and consumer evidence.

`node dist/cli.js code materializeSemanticReferenceBatch` shows semantic
reference materialization groups definitions by file and calls
`readCachedSemanticReferencesForFile()` once per file. It then computes misses
through `semanticReferenceMap()` and writes misses as a batch.

`node dist/cli.js code readCachedSemanticReferencesForFile` shows storage reads
one file at a time from `semantic_references`, and also reads legacy rows for
that file before merging rows by symbol.

`node dist/cli.js code createTypeScriptSourceFiles` shows TypeScript source-file
resolution lazily builds project source-file indexes with a
`typescript.source-file-index` profile span, then caches path-to-source-file
matches per process.

`node dist/cli.js code TsMorphSemanticProvider:referencesForDefinitions` shows
the ts-morph provider keeps an in-memory references cache, uses a symbol-scan
bulk path when definitions do not need precise search, and otherwise groups
precise searches by file.

`node dist/cli.js code RustAnalyzerSessionResolver:requestSession` shows Rust
semantic requests are already command-scoped through a Rust analyzer session
requester, with configured request timeout, diagnostics timeout, settle delay,
and concurrency.

Recent `codex/codex-rs` Rust-heavy measurements in
`docs/benchmarks/2026-07-09-rust-native-acceleration-ledger.md` show:

- `health --full --json` warm reverse pair: Rust opt-in 15.291s, default
  15.253s, identical hash.
- `wrapper-candidates --json --full`: Rust opt-in 8.348s, default 8.240s,
  identical hash.
- `stale-abstractions --json --full`: Rust opt-in 2.962s, default 2.899s,
  identical hash.
- Consumer classification can look faster in cold-ish first pairs, but once
  lower-level evidence is warm, the helper-process Rust boundary is not faster.

## Reuse Audit

Do not replace ts-morph by default. The current TypeScript semantic provider
already has compiler-backed behavior, bulk reference scans, source-file indexes,
and in-memory caches. Any tsserver path must remain comparison-only until it
proves parity on reference, callee, import usage, and signature results.

Reuse the existing semantic evidence storage in `src/storage/evidence-cache.ts`
before adding new persistent stores. The missing shape is a multi-file semantic
reference read, not a new cache kind.

Reuse the existing reindex metadata and language-shard cache before adding a new
index format. The missing shape is a safe fast path when every requested
language shard is reused but the whole-project fingerprint cannot be reused.

Keep `crates/scip-query-kernels` for native experiments, but do not enable
helper-process kernels by default unless benchmark evidence beats TypeScript on
direct commands and warm-state profiles.

## Testability Design

| Behavior                                                                              | Test seam                                                                    | Dependencies to inject                          | Pure core                                  | Side-effect shell                                           | Contract                                                                         |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Multi-file semantic reference cache read preserves current one-file results           | new storage helper plus existing `materializeSemanticReferenceBatch()` tests | SQLite evidence DB fixture                      | row grouping and legacy/current precedence | better-sqlite3 statements                                   | map from file to symbol payloads equals repeated per-file reads                  |
| Repeat reindex with all language shards reused avoids unnecessary work only when safe | reindex reliability tests with cached shards                                 | temp project, fake indexer results, file system | reuse decision and metadata resolution     | SCIP materialization, SQLite conversion, artifact promotion | output DB/SCIP/meta remain valid and status reports correct reused/rebuilt state |
| TypeScript semantic provider changes do not alter ts-morph results                    | existing provider tests plus hash checks on commands                         | tsconfig fixture, source files                  | grouping/caching decisions                 | ts-morph project loading                                    | reference/callee/import/signature maps are identical                             |
| Rust semantic path remains compiler-backed and cache-safe                             | Rust provider tests plus codex-rs/VegaAssistant smokes                       | rust-analyzer binary, environment timeouts      | cache key and request grouping             | LSP worker/session                                          | identical command hashes and no fallback-only regression                         |

## Design Phases

### 1. Baseline TS and Rust indexing/analysis hot paths

- [x] **File**: `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl`
- **Source**: `node dist/cli.js status --capabilities`;
  `docs/benchmarks/2026-07-09-rust-native-acceleration-ledger.md`
- **What**: Current ledgers contain command timings, but this specific campaign
  needs paired indexing, TypeScript semantic, Rust semantic, and full-mode
  analysis baselines.
- **Change**: Create a run history with:
  - scip-query repeat `reindex`;
  - VegaAssistant `health --full --json`, `complexity-hotspots --json --full`,
    and `similar --json --full`;
  - codex-rs `health --full --json`, `wrapper-candidates --json --full`, and
    `stale-abstractions --json --full`;
  - profile files for health/full-mode runs.
- **Testability**:
  - Test seam: JSONL run history and output hashes.
  - Injected dependencies: CLI path, repo cwd, env toggles.
  - Pure core: hash/timing record construction.
  - Side-effect shell: spawned commands and profile files.
  - Contract: baseline records include command, corpus, duration, bytes, hash,
    profile path, and cache-state notes.
- **Validation**: The run history contains successful records with stable hashes
  for each paired command.
- **Why**: This prevents optimizing the wrong warmth state.

### 2. Evaluate semantic cache read batching

- [x] **File**: `src/storage/evidence-cache.ts:461-482` and
      `src/semantic/shared-primitives.ts:156-273`
- **Source**: `node dist/cli.js code readCachedSemanticReferencesForFile`;
  `node dist/cli.js code materializeSemanticReferenceBatch`;
  `node dist/cli.js code readCachedSemanticCalleesForFile`
- **What**: Semantic reference and callee materialization loop file-by-file and
  storage executes current and legacy SELECTs once per file.
- **Attempt**: Added multi-file reference batching and tuple-shaped callee
  batching, then measured on VegaAssistant, codex-rs, and SynthRunnerRust.
- **Testability**:
  - Test seam: storage evidence-cache tests plus semantic shared-primitives
    fixture tests.
  - Injected dependencies: temp evidence DB.
  - Pure core: row grouping and precedence.
  - Side-effect shell: SQLite prepared statements.
  - Contract: results match repeated `readCachedSemanticReferencesForFile()`.
- **Validation**: targeted storage tests, semantic tests, VegaAssistant and
  codex-rs health hashes unchanged; profile span
  `semantic.references.cache-scan` improves or is documented as rejected.
- **Decision**: Rejected and reverted. VegaAssistant stayed hash-identical, but
  `semantic.references.cache-scan` moved from 3.827s to 4.088s. The callee tuple
  batch was worse on a Rust-heavy stale/mixed codex-rs state because it forced
  cache misses and compiler-backed recomputation. The known-good per-file
  prepared statements remain the production path.
- **Why**: The next bottleneck is not SQLite read count. It is cold semantic
  evidence materialization being repeated across full-health worker phases.

### 2b. Shared semantic prewarm for full-health phases

- [x] **File**: `src/runtime/cli-support.ts:140-204`,
      `src/semantic/shared-primitives.ts`, and `src/symbols/graph/call-graph-evidence.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-after-reference-batch-cold.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-after-reference-batch-warm-repeat.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-semantic-prewarm-all-defs-cold.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-semantic-prewarm-all-defs-marker-hit.profile.jsonl`
- **What**: Full-health runs spawn phase workers. When semantic evidence is
  cold, each worker can recompute overlapping compiler-backed references or
  callees before rows are durable enough for the other workers to hit.
- **Change**: Added measured prewarm/shared materialization before phase
  workers run. The parent process reads a project-level prewarm marker keyed by
  project fingerprint, `cliVersion`, and scope. On a miss, it materializes
  semantic references and callees for all semantic-supported indexed
  definitions, writes durable evidence rows, then writes the marker. On a hit,
  it skips in about 1ms and lets workers read warmed rows.
- **Boundary finding**: Production-callable prewarm was rejected after a
  SynthRunnerRust cold profile. It warmed 1,045 definitions, but worker phases
  still computed 7 reference misses and 616 callee misses. Full health needs
  all semantic-supported indexed definitions as the prewarm boundary.
- **Testability**:
  - `tests/runtime/cli-support.test.ts` covers default skip, env disable,
    marker hit, materialization before marker write, and provider-unavailable
    no-marker behavior.
  - `tests/storage/evidence-products.test.ts` covers the new project evidence
    product manifest entry.
- **Validation**:
  - `npx vitest run tests/runtime/cli-support.test.ts tests/storage/evidence-products.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust cold from empty evidence DB: 45.450s, hash
    `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348`.
  - SynthRunnerRust marker hit with health cache cleared: 0.900s, same hash.
- **Why**: SynthRunnerRust measured 58.363s cold but 0.999s warm before this
  slice. The accepted prewarm made cold phase-worker semantic misses disappear
  and cut cold full health to 45.450s. The remaining first-fill bottleneck is
  Rust reference computation in the parent prewarm.

### 2c. Accelerate the Rust semantic first fill

- [x] **File**: `src/semantic/rust/provider.ts`,
      `src/semantic/rust/callee-symbol-resolution.ts`,
      `src/semantic/provider-cache.ts`, and
      `src/semantic/rust/lsp-session-worker.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-semantic-prewarm-all-defs-cold.profile.jsonl`;
  `node dist/cli.js plan-context src/semantic/rust/provider.ts`;
  `node dist/cli.js plan-context src/semantic/rust/lsp-session-worker.ts`;
  `node dist/cli.js plan-context src/semantic/rust/callee-symbol-resolution.ts`
- **What**: The accepted prewarm makes full health worker phases cache-only, but
  the parent prewarm still spends 33.109s in
  `semantic.references.compute-misses` for 1,661 Rust definitions. It also
  spends 5.180s in `semantic.callees.compute-misses` even though the enclosing
  Rust LSP session request is only 201ms, which points at local callee symbol
  normalization rather than rust-analyzer call hierarchy.
- **Change**: Split the Rust session worker profile into session,
  document-open/diagnostics/settle, references, callees, and signatures spans.
  Replaced per-callee file/name filtering with a provider-scoped Rust callee
  symbol resolver that indexes definitions by file, leaf name, and start line
  while keeping the existing single-callee resolver behavior available for
  tests and compatibility. Also made diagnostics timeout and settle delay accept
  explicit `0` values for measured experiments without changing defaults.
- **Testability**:
  - Test seam: `tests/semantic/rust/rust-callee-symbol-resolution.test.ts` and
    `tests/semantic/rust/rust-semantic-provider.test.ts`.
  - Injected dependencies: evidence fixture DB and provider-injected resolver.
  - Pure core: callee name candidate selection, file index lookup, containing
    range selection.
  - Side-effect shell: definition catalog reads and rust-analyzer worker
    requests.
  - Contract: returned callee symbols, references, and command hashes stay
    unchanged.
- **Validation**:
  - `npx vitest run tests/semantic/rust/rust-lsp-session.test.ts tests/semantic/rust/rust-callee-symbol-resolution.test.ts tests/semantic/rust/rust-semantic-provider.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust default repeat from empty evidence: 47.843s,
    hash `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348`.
  - SynthRunnerRust marker hit with health cache cleared: 0.851s, same hash.
  - Rejected zero diagnostics + zero settle: 21.928s but hash changed to
    `c3c3847bf84219f57dc38061a8f36e075262d7996f93bedbae559a9987654de5`
    because reference facts collapsed.
  - Kept settle=0 only as an explicit experiment knob: 47.450s and same hash,
    but not enough paired improvement to make it the default.

### 2d. Profile Rust reference requests deeply

- [x] **File**: `src/semantic/rust/lsp-session-worker.ts`,
      `src/symbols/definition-catalog.ts`, and
      `tests/symbols/definition-catalog.test.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-first-fill-default-repeat.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-reference-profile-cold.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-impl-owner-range-cold.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-request-timeout-5s-cold.profile.jsonl`
- **What**: The split profile shows reference requests are now the largest
  concrete cost: 21.872s inside `rust.semantic.worker.references` after the
  5.733s diagnostics wait and 5.002s settle. Skipping diagnostics is not
  accurate; it reduces reference facts from about 3,011 to 13.
- **Change**: Added `rust.semantic.worker.references.by-file` profile rollups
  and threshold-gated `rust.semantic.worker.reference-task` events controlled by
  `SCIP_RUST_SEMANTIC_REFERENCE_TASK_PROFILE_MS`. The profile showed repeated
  Rust `impl Default` methods were sometimes resolved to the first same-name
  fallback method in a chunk. Fixed Rust AST range correction so SCIP symbols of
  the form `impl#[Owner][Trait]method()` choose the callable inside the matching
  owner `impl` block.
- **Testability**:
  - Test seam: profile JSONL records and Rust provider fixture tests.
  - Injected dependencies: profile env threshold and fake requester where
    needed.
  - Pure core: slow-event metadata selection, grouping, and Rust impl owner
    range matching.
  - Side-effect shell: profile event writes, source AST reads, and
    rust-analyzer requests.
  - Contract: profiling does not change command output; Rust range correction is
    accepted only as an explicit accuracy correction.
- **Validation**:
  - `npx vitest run tests/symbols/definition-catalog.test.ts tests/semantic/rust/rust-lsp-session.test.ts tests/semantic/rust/rust-callee-symbol-resolution.test.ts tests/semantic/rust/rust-semantic-provider.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust reference-profile cold: 44.907s, hash
    `1beb7bc74124c4a23ccbfc95a7270e833b9a8da75f093ffd270f43bfe5611348`,
    3,011 Rust reference facts.
  - SynthRunnerRust impl-owner range cold: 45.413s, hash
    `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`,
    3,048 Rust reference facts. Hash change accepted because the range fix
    corrects repeated Rust impl methods, for example
    `PerformanceDiagnostics::default` now starts at line 56 instead of line 31.
  - Rejected `SCIP_RUST_SEMANTIC_REQUEST_TIMEOUT_MS=5000`: 48.213s with the
    same health hash as the corrected run, but semantic references dropped to
    2,927. Command hashes alone are not sufficient for accepting semantic-speed
    knobs.
- **Next**: keep the reference-task profile events and move speed work toward
  request scheduling, cancellation/negative-result handling, or a Rust-specific
  source-assisted reference strategy that can prove semantic fact parity.

### 2e. Accept SCIP-refined Rust `Default::default` references

- [x] **File**: `src/semantic/rust/default-impl-references.ts`,
      `src/semantic/shared-primitives.ts`, and
      `tests/semantic/rust/rust-default-impl-references.test.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-default-impl-fast-path-cold.profile.jsonl`
- **What**: The slow reference-task profile showed repeated Rust
  `impl Default::default` requests taking the full 15s timeout and returning
  zero references. A direct comparison on SynthRunnerRust showed SCIP mention
  chunks plus exact `Owner::default` source refinement were a superset of the
  current LSP rows for all 16 Default impls: 167 refined direct references
  versus 97 LSP references, with no LSP-only rows.
- **Change**: Added a Rust-only fast path that handles
  `impl#[Owner][Default]default().` symbols before provider dispatch. The path
  only answers when SCIP has reference chunks for the exact impl symbol, every
  chunk contains a direct `Owner::default` call, and no chunk contains ambiguous
  `Default::default` syntax. Otherwise the existing rust-analyzer path runs.
- **Testability**:
  - Test seam: fixture SQLite documents/chunks/mentions plus filesystem source.
  - Injected dependencies: temp `ScipDatabase` and source files.
  - Pure core: owner parsing, chunk refinement, deduped reference sorting.
  - Side-effect shell: reading indexed document source or source files.
  - Contract: exact line/column references are returned only for
    compiler-grounded direct calls; ambiguous calls fall back.
- **Validation**:
  - `npx vitest run tests/semantic/rust/rust-default-impl-references.test.ts tests/semantic/rust/rust-semantic-provider.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust cold with semantic references and health report cache
    cleared: 19.822s, hash
    `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`,
    3,118 Rust semantic reference facts.
  - Profile confirmation: 16 Rust Default fast-path rows, 167 fast-path refs,
    rust-analyzer reference requests reduced from 1,661 to 1,645, and
    `rust.semantic.worker.references` reduced to 2.896s.
- **Rejected follow-up**: `SCIP_RUST_SEMANTIC_SETTLE_MS=0` with the Default fast
  path preserved the same hash and 3,118 reference facts, but measured 19.961s
  versus 19.822s. Removing the 5.002s settle made references grow from 2.896s
  to 7.999s, so it is not a default speed win.
- **Why**: This is both faster and more accurate than asking rust-analyzer for
  this narrow direct-default class, while preserving the LSP fallback for cases
  the source refinement cannot prove.

### 2f. Accept conservative Rust SCIP occurrence references

- [x] **File**: `src/semantic/rust/scip-occurrence-references.ts`,
      `src/semantic/shared-primitives.ts`, and
      `tests/semantic/rust/rust-scip-occurrence-references.test.ts`
- **Source**: `node dist/cli.js plan-context src/semantic/shared-primitives.ts`;
  `node dist/cli.js plan-context src/semantic/rust/default-impl-references.ts`
- **What**: `index.scip` stores exact occurrence positions. SynthRunnerRust
  comparison showed fields, types, and modules have too many SCIP-only
  occurrences, while Rust function/value-like symbols matched accepted semantic
  facts except for one rust-analyzer same-name false-positive case.
- **Change**: Added a cached Rust-only SCIP occurrence reference source for
  method symbols and top-level term symbols. The path refuses fields, types,
  modules, trait impl members, and `Default::default` impls so those shapes keep
  using the existing rust-analyzer or refined Default fallback.
- **Testability**:
  - Test seam: pure module tests over a synthetic SCIP protobuf fixture.
  - Injected dependencies: temporary `ScipDatabase` with an `index.scip` path.
  - Pure core: symbol-shape acceptance predicate and occurrence-to-reference
    projection.
  - Side-effect shell: one cached read of the SCIP protobuf index.
  - Contract: accepted shapes return deduped non-definition occurrences; refused
    shapes return `null` and fall back to the semantic provider.
- **Validation**:
  - `npx vitest run tests/semantic/rust/rust-scip-occurrence-references.test.ts tests/semantic/rust/rust-default-impl-references.test.ts tests/semantic/rust/rust-semantic-provider.test.ts tests/semantic/rust/rust-lsp-session.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust full cold with semantic references, semantic callees, health
    prewarm marker, and health report cache cleared: 21.210s, health hash
    `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`,
    3,117 Rust semantic reference facts and 2,564 callee facts.
  - Profile confirmation: 906 Rust SCIP-occurrence fast-path rows, 2,773
    fast-path refs, rust-analyzer reference requests reduced to 739, and
    `rust.semantic.worker.references` reduced to 1.607s.
- **Rejected follow-ups**:
  - `SCIP_RUST_SEMANTIC_SETTLE_MS=0`: 21.630s, same health hash and same 3,117
    reference facts, but slower.
  - `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=0`: 21.530s, same health hash and
    same 3,117 reference facts, but slower.
  - `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=0 SCIP_RUST_SEMANTIC_SETTLE_MS=0`:
    16.140s, rejected because it dropped semantic references to 2,953, callee
    facts to 2,415, and changed the health hash.
- **Why**: This removes most Rust function/value reference work from
  rust-analyzer without trusting SCIP occurrence classes that measured noisy.

### 2g. Cache Rust provider availability in semantic hot paths

- [x] **File**: `src/semantic/rust/provider.ts`,
      `src/semantic/rust/engine-identity.ts`, and
      `tests/semantic/rust/rust-semantic-provider.test.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-scip-occurrence-fast-path-full-semantic-cold.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-rust-provider-status-cache-safe-full-semantic-cold.profile.jsonl`
- **What**: `availableSemanticProvider()` checks provider availability for every
  definition during reference and callee materialization. The Rust provider was
  recomputing its base rust-analyzer dependency status for those repeated
  checks.
- **Change**: Cache the base Rust semantic availability per provider instance.
  Keep `lastAvailability` for worker failures. Also filter Rust callee LSP
  requests to definitions that can contain callees, while returning empty callee
  arrays for non-callable definitions. Include the experimental SCIP occurrence
  mode in the Rust semantic engine identity so comparison-mode reference
  payloads cannot reuse the safe-mode cache key. Include the semantic engine
  fingerprint in the health prewarm marker key so a warm marker cannot skip
  prewarm after an engine-level semantic cache identity change.
- **Testability**:
  - Test seam: injected Rust status function and injected callee resolver.
  - Pure core: callee-capable definition filter.
  - Contract: same returned callee map shape; no default reference-mode change.
- **Validation**:
  - `npx vitest run tests/semantic/rust/rust-semantic-provider.test.ts tests/semantic/rust/rust-scip-occurrence-references.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust full cold with semantic references, semantic callees, health
    prewarm marker, and health report cache cleared: 14.940s, health hash
    `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`,
    3,117 Rust semantic reference facts and 2,564 callee facts.
  - After the marker-key fix, the same default safe-mode cold run measured
    14.820s with the same hash and facts.
  - `semantic.callees.provider-loop` improved from 2.395s to 0.368s. Rust
    Analyzer callee work stayed ~0.34s.
- **Rejected follow-up**:
  `SCIP_RUST_SCIP_OCCURRENCE_REFERENCE_MODE=all` produced the same health hash
  but 12,575 semantic reference facts and a slower 25.850s run. After the marker
  fix and provider-status cache it still measured 18.640s, slower than safe mode,
  so it remains comparison-only. A broad zero-reference shortcut was also
  rejected because rust-analyzer found three references for two symbols whose
  SCIP occurrence reference count was zero.
- **Current follow-up**: Re-audited broad fallback-class promotion after the
  indexing speed slices. SynthRunnerRust still had only 81 exact rows out of
  755 fallback definitions, and scip-query had only 1 exact row out of 36
  fallback definitions. Type-owned terms, type symbols, and most namespaces are
  not safe SCIP occurrence shortcuts; they produced 159 SCIP-only references on
  scip-query where rust-analyzer returned zero.
- **Why**: This removes a repeated local dependency-resolution tax without
  changing semantic evidence. The remaining first-fill bottleneck is Rust
  Analyzer reference readiness for 739 unresolved definitions.

### 2h. Accept adaptive settle for small Rust reference batches

- [x] **File**: `src/semantic/rust/lsp-session.ts`,
      `src/semantic/rust/provider.ts`, and
      `tests/semantic/rust/rust-lsp-session.test.ts`
- **Source**:
  `node dist/cli.js plan-context src/semantic/rust/lsp-session.ts`;
  `node dist/cli.js plan-context src/semantic/rust/provider.ts`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-scip-query-health-full-forced5000.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-scip-query-health-full-adaptive.profile.jsonl`
- **What**: On the mixed scip-query repo, TypeScript semantic reference scanning
  took about 0.7s, while a 36-definition Rust fallback reference batch paid a
  fixed 5s settle delay and returned zero references. On SynthRunnerRust, the
  main Rust fallback batch is 739 definitions and still needs the conservative
  readiness path.
- **Change**: Add a shared Rust settle-delay default helper. If
  `SCIP_RUST_SEMANTIC_SETTLE_MS` is set, honor it exactly as before. Otherwise,
  use `0` only for reference-only batches with 64 or fewer definitions, and keep
  the 5s default for larger reference batches, callees, signatures, and import
  definition lookups. Reuse the helper from both the persistent session and the
  one-shot worker provider path.
- **Testability**:
  - Test seam: injected `RustAnalyzerSessionRequester`.
  - Injected dependencies: captured semantic request payloads.
  - Pure core: settle-delay default selection.
  - Side-effect shell: worker request construction.
  - Contract: explicit env override wins; small reference-only batches skip the
    artificial wait; non-reference and large batches keep the conservative wait.
- **Validation**:
  - `npx vitest run tests/semantic/rust/rust-lsp-session.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - scip-query cold full health, forced old settle:
    10.467s, hash
    `35b0f7504cb98a59037696923458ef42721e12b3e4af7ccbc6f95034029e4730`,
    16,379 semantic references and 3,097 semantic callees.
  - scip-query cold full health, adaptive default:
    5.165s, same hash, same reference/callee counts. Profile:
    `health.semantic-prewarm` dropped from 8.728s to 3.399s and
    `rust.semantic.worker.settle` dropped from 5.000s to 0ms.
  - SynthRunnerRust cold full health, forced old settle:
    15.549s, hash
    `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`,
    3,117 semantic references and 2,564 semantic callees.
  - SynthRunnerRust cold full health, adaptive default:
    15.249s, same hash and same facts. Profile confirms the 739-definition
    reference batch still used the 5s settle guardrail.
  - Direct SynthRunnerRust positive-fallback audit: 41 non-fast-path definitions
    returned the same 177 rust-analyzer references with `settleDelayMs=5000` and
    `settleDelayMs=0` (`diffCount=0`).
- **Rejected follow-up**:
  `diagnosticsTimeoutMs=0` plus `settleDelayMs=0` on the same 41 positive
  fallback definitions returned only 13 references, 7 rows with refs, and 34
  symbol-level diffs. Diagnostics readiness stays conservative even for small
  batches.
- **Rejected experiment**: Disabling `SCIP_QUERY_HEALTH_SEMANTIC_PREWARM` on
  SynthRunnerRust after clearing the health-report cache took 31.639s, changed
  the health hash, and wrote only 422 semantic reference rows instead of the
  1,661 rows written by parent prewarm. The worker-demand profile is useful for
  future narrowing, but no-prewarm is not an acceptable default.
- **Why**: This removes a fixed local wait from the mixed-repo hot path without
  enabling the rejected full zero-wait mode that changed Rust-heavy facts.

### 2i. Skip Rust callee canonicalization for non-indexed target files

- [x] **File**: `src/semantic/rust/callee-symbol-resolution.ts` and
      `tests/semantic/rust/rust-callee-symbol-resolution.test.ts`
- **Source**:
  `node dist/cli.js plan-context src/semantic/rust/callee-symbol-resolution.ts`;
  `node dist/cli.js change-surface src/semantic/rust/callee-symbol-resolution.ts --json --full`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-callee-symbol-cache-indexed-guard.profile.jsonl`
- **What**: `rust.semantic.callees.complete-map` was still taking about 2.2s on
  SynthRunnerRust. Rust-analyzer returns callees in both project files and
  dependency files. Dependency files are outside the project's SCIP `documents`
  table, so `getDefinitionsForFile()` can only return no project symbol for
  them after paying definition-catalog and source/range-correction overhead.
- **Change**: The provider-scoped Rust callee resolver now loads the indexed
  document path set once and returns the original callee symbol immediately for
  non-indexed files. It also caches exact `(file, symbol, line)` resolutions so
  repeated project-local callees do not redo the same lookup.
- **Testability**:
  - Test seam: Rust callee symbol fixture DB.
  - Injected dependencies: temp `ScipDatabase`.
  - Pure core: cache key and project-file membership decision.
  - Side-effect shell: one direct `documents` query and definition-catalog reads
    only for indexed files.
  - Contract: project-local callees still map to canonical SCIP symbols;
    dependency-file callees remain unchanged.
- **Validation**:
  - `npx vitest run tests/semantic/rust/rust-callee-symbol-resolution.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - SynthRunnerRust cold full health with semantic evidence and health report
    cache cleared: 14.902s, health hash
    `4827f75e36860769d87f328f2c4b4412ccbe9569fb8d39c3d1577be46576ce2a`,
    output size 8,994 bytes.
  - Profile confirmation: `semantic.callees.provider-loop` dropped from about
    2.576s to 0.370s, and `rust.semantic.callees.complete-map` dropped from
    about 2.209s to 0.002s.
- **Rejected diagnostic**: Exact callee-result caching alone was safe but not
  sufficient; the cache-only profile still measured `complete-map` at 2.209s.
- **Rejected follow-up**: `SCIP_RUST_SEMANTIC_SETTLE_MS=0` after this guard
  preserved the same hash and semantic fact counts, but measured 15.948s
  instead of 14.902s. Removing settle made the 739-definition reference batch
  grow from 1.546s to 7.600s, so the large-batch default remains conservative.
- **Rejected readiness knobs**: Intermediate settle values and higher
  concurrency did not beat the accepted default. `settle=1000` measured
  15.906s, `settle=3000` measured 15.864s, `settle=4000` measured 16.019s,
  and `SCIP_RUST_SEMANTIC_CONCURRENCY=16` measured 15.745s. All preserved the
  same hash and fact counts, but each slowed the reference provider loop.
- **Why**: This removes local work that cannot produce a project SCIP symbol,
  while keeping the canonical mapping path for indexed Rust files.

### 2j. Combine Rust reference and callee materialization for one session

- [x] **File**: `src/semantic/rust/lsp-session.ts`,
      `src/semantic/rust/lsp-batch-worker.ts`,
      `src/semantic/rust/lsp-session-worker.ts`,
      `src/semantic/rust/provider.ts`, `src/semantic/shared-primitives.ts`,
      `src/semantic/types.ts`, `src/runtime/cli-support.ts`,
      `src/queries/quality/complexity-hotspots.ts`,
      `tests/semantic/rust/rust-lsp-session.test.ts`, and
      `tests/semantic/rust/rust-semantic-provider.test.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-split-preserve.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-prefetch-hook.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-prefetch-callee-cache-write.profile.jsonl`
- **What**: VegaAssistant cold `__health-phase complexity-hotspots --full`
  paid separate Rust semantic fills for 578 fallback reference definitions and
  7,186 callee definitions. A naive callee-first reorder still opened
  definition documents twice because reference and callee requests had different
  session keys.
- **Change**: Rust session requests now preserve separate reference, callee,
  and signature definition lists while opening the union of relevant documents
  once. The Rust provider exposes `referencesAndCalleesForDefinitions()`,
  stores prefetched callees in provider memory, and lets later
  `calleesForDefinitions()` calls consume that memory before asking
  rust-analyzer again. Shared semantic reference materialization accepts
  `{ prefetchCallees: true }`, and the complexity-hotspots phase uses it before
  constructing caller and callee maps. Full-health semantic prewarm also uses
  the same option. Follow-up: the semantic layer stores prefetched callees in a
  per-DB in-memory map, and the callee cache wrapper consumes those rows before
  reading cache files while still writing normal durable `semantic_callees`
  rows.
- **Testability**:
  - Test seam: Rust session request payloads with split definition lists and
    Rust provider/cache-gate combined-resolution tests.
  - Injected dependencies: fake session requester and injected Rust resolver.
  - Pure core: request-list partitioning and prefetched-callee consumption.
  - Side-effect shell: persistent rust-analyzer session and semantic cache
    writes.
  - Contract: command output hash must match the immediate guarded control.
- **Validation**:
  - `npx vitest run tests/queries/quality/complexity-hotspots.test.ts tests/semantic/rust/rust-lsp-session.test.ts tests/semantic/rust/rust-semantic-provider.test.ts tests/semantic/rust/rust-semantic-callee-cache-gate.test.ts tests/runtime/cli-support.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - VegaAssistant split-list guard: 119.170s, hash
    `0c6810dde566fa963445bad9323c5fef970eb34560877da017d5d96075277338`.
  - VegaAssistant prefetch hook: 80.070s, same hash. The later
    `semantic.callees.provider-loop` fell from 39.785s to 0.007s because the
    callee results were already available from the combined Rust session.
  - VegaAssistant prefetched-callee cache write: 79.500s, same hash.
    `semantic.callees.cache-scan` fell to 0ms, and the durable cache write took
    36ms for 7,186 entries.
- **Caveat**: the older 99.790s Vega artifact had hash
  `09cd4241098ea2db6360bb3ba0671647bc526c22d2838372a5eae2dabbb35a73`.
  Because the split-list guard matched the newer `0c6810...` hash instead, this
  slice is accepted only against the immediate control. The older hash remains
  an output-drift note, not a hidden accuracy assumption.
- **Why**: This removes duplicated rust-analyzer setup and callee recomputation
  without trusting broader SCIP occurrence shortcuts that already measured
  inaccurate or slower.

### 3. Evaluate safe all-language-shard reuse for repeat reindex

- [x] **File**: `src/reindex/index.ts:405-478`,
      `src/reindex/index.ts:856-970`, and
      `tests/reindex/reindex-reliability.test.ts:296-340`
- **Source**: `node dist/cli.js code runLanguageIndexersForFreshReindex`;
  `node dist/cli.js code publishFreshReindexArtifacts`;
  `node dist/cli.js code reuseExistingIndexIfPossible`
- **What**: Whole-project unchanged reuse returns early, but if the whole
  fingerprint misses while every language shard reuses, the code still
  materializes combined SCIP and converts to SQLite.
- **Change**: Added a metadata-only reuse path after per-language shard
  classification. The path preserves the existing combined SCIP and SQLite
  artifacts, runs auxiliary-document augmentation against the existing DB, and
  rewrites metadata with the new whole-project fingerprint only when
  `skipIfUnchanged` is not explicitly false, no language was skipped, every
  requested indexed language came from a reused shard, and the output artifacts
  already exist. Fresh rebuild publish now shares the metadata builder with the
  metadata-only path. Follow-up: metadata publication carries the per-language
  fingerprints from shard classification instead of hashing the same language
  inputs a second time.
- **Testability**:
  - Test seam: reindex reliability tests with synthetic language shard reuse.
  - Injected dependencies: temp project files, fake meta/artifacts, fake
    language output paths.
  - Pure core: reuse eligibility predicate.
  - Side-effect shell: post-index augmentation and metadata write.
  - Contract: `status --capabilities` remains fresh after the fast path, and
    published SCIP/SQLite artifacts are preserved.
- **Validation**:
  - `npx vitest run tests/reindex/reindex-reliability.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - `npm run lint`
  - `node dist/cli.js recent-duplicates --json --full`
  - `node dist/cli.js unused-params --json --full`
  - `node dist/cli.js incomplete-migration --json --full`
  - measured repeat `node dist/cli.js reindex --json` after a docs-only change:
    244ms, `reused: true`, TypeScript and Rust shards both reused, metadata
    status `complete`, refreshed fingerprint includes the changed ledger file.
  - measured after carrying classification fingerprints through metadata:
    238ms, `reused: true`, TypeScript and Rust shards both reused. This is
    within run-to-run noise but removes duplicated hashing and pins metadata to
    the reuse decision's exact fingerprints.
- **Why**: This is the indexing counterpart to semantic cache batching and
  benefits both TypeScript and Rust repeat indexing.

### 3b. Make benchmark cold-state measurements corpus-safe

- [x] **File**: `scripts/performance-architecture-contract.mjs:20-28` and
      `tests/scripts/performance-architecture-contract.test.ts`
- **Source**: discovered while profiling SynthRunnerRust with
  `scripts/performance-architecture-contract.mjs --profile-out <relative path>`
  and then re-running an `evidence-cold` health benchmark that hit an existing
  health-report cache.
- **What**: The harness resolved run-history paths before spawning a benchmark
  command, but forwarded explicit relative `--profile-out` paths unchanged. The
  child command runs with `cwd` set to the benchmark corpus, so profile files
  could be created in the target repository instead of beside the scip-query run
  history. Separately, `evidence-cold` cleared `evidence.db` but not
  `health-report-cache.json`, so a cold health run could return from an old
  report without exercising semantic analysis.
- **Change**: Resolve explicit and default profile paths to absolute paths
  before directory creation and child-process environment injection. Also clear
  `health-report-cache.json` for `evidence-cold` and `cold-index`
  measurements.
- **Testability**:
  - Test seam: harness unit test with fake `spawnSync`.
  - Injected dependencies: fake process runner and fake filesystem operations.
  - Pure core: path resolution and cache-state clearing decisions.
  - Side-effect shell: spawned command environment and cache file removal.
  - Contract: child commands always receive absolute `SCIP_QUERY_PROFILE_OUT`;
    cold health measurements cannot reuse a previous health report.
- **Validation**:
  - `npx vitest run tests/scripts/performance-architecture-contract.test.ts`
- **Why**: Reliable profile placement keeps future TypeScript/Rust speed
  comparisons reproducible across external corpora.

### 4. Keep TypeScript LSP/tsserver comparison explicit

- [x] **File**: `src/semantic/typescript/tsserver-provider.ts`,
      `src/runtime/commands/command-handlers.ts`,
      `src/runtime/commands/command-descriptors.ts`, and
      `scripts/typescript-semantic-provider-comparison.mjs`
- **Source**: `node dist/cli.js code TsMorphSemanticProvider:referencesForDefinitions`;
  `node dist/cli.js code referencesForDefinitions`;
  `node dist/cli.js typescript-semantic-compare --json --full --max-mismatches 20`
- **What**: ts-morph is the trusted TypeScript semantic baseline. tsserver
  exists but its `referencesForDefinitions()` path is scalar in the current
  exposed snippet.
- **Change**: Added timing and reference-count fields to the tsserver comparison
  result, a hidden `typescript-semantic-compare` calibration command, and a
  JSONL runner for repeatable cross-repo measurements. Production TypeScript
  semantics still use ts-morph.
- **Testability**:
  - Test seam: tsserver compare provider tests and calibration script.
  - Injected dependencies: provider selector and fixture tsconfig.
  - Pure core: diff normalization.
  - Side-effect shell: tsserver process/session.
  - Contract: no default command output changes.
- **Validation**:
  - `npm test -- --run tests/semantic/typescript/typescript-semantic-provider.test.ts tests/runtime/cli-contract.test.ts`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - scip-query sample comparison: 50/50 matches, 0 mismatches, ts-morph
    references 586.077ms, tsserver references 663.878ms.
  - scip-query full comparison: 4,349/4,459 matches, 110 mismatches, 773
    missing tsserver references, 108 extra tsserver references. ts-morph
    reference pass 725.470ms; tsserver reference pass 5,183.027ms.
- **Result**: Keep tsserver comparison-only. The small deterministic sample is
  parity-clean, but the full indexed TypeScript corpus is neither accurate
  enough nor faster enough to replace ts-morph.
- **Why**: Faster TypeScript must not regress the mature semantic oracle.

### 5. Re-evaluate Rust native boundary only after larger phase candidates

- [ ] **File**: `crates/scip-query-kernels` and high-cost query phases from
      `docs/benchmarks/runs/2026-07-09-rust-native-acceleration.jsonl`
- **Source**: `docs/benchmarks/2026-07-09-rust-native-acceleration-ledger.md`
- **What**: The helper-process `consumer-classify` kernel is correct but not a
  warm-state win. Codex-rs health is now dominated by larger phases such as
  `complexity-hotspots`, `wrapper-candidates`, similar callee fingerprints, and
  semantic cache scans.
- **Change**: Pick the next Rust-native candidate only after a profile proves
  the unit is a large contiguous computation with a compact input/output
  contract. Candidate classes: branch/complexity aggregation with AST parity,
  semantic cache materialization, graph traversal, or SQLite aggregation.
- **Testability**:
  - Test seam: Rust unit fixtures plus native-on/off CLI hash pairs.
  - Injected dependencies: JSON payload or lower-overhead native boundary.
  - Pure core: native kernel over normalized data.
  - Side-effect shell: process/daemon/in-process bridge.
  - Contract: native and TypeScript outputs match.
- **Validation**: native-off/native-on hashes and profile spans on VegaAssistant
  and codex-rs.
- **Why**: This prevents adding Rust that is technically correct but operationally
  slower.

### 5b. Automate selection of repeated-work targets

- [x] **File**: `src/instrumentation/profile.ts`,
      `src/runtime/profile-work-audit.ts`, and
      `src/queries/internal/consumer-evidence.ts`
- **Source**: `docs/plans/2026-07-10-work-reuse-audit.md` and the repeated
  wrapper-candidates baseline in
  `docs/benchmarks/runs/2026-07-10-work-reuse-audit.jsonl`.
- **What**: The existing profile scoreboard ranks span names but cannot tell
  repeated computation from distinct inputs. That makes target selection a
  manual profile-reading loop.
- **Change**: Give profiled computations stable input identities and top-level
  run identities, then add `scip-query work-audit <profile>` to rank exact
  repeats by measured time. Instrument consumer evidence as the first known
  hotspot.
- **Validation**: exact-repeat unit fixtures, legacy-profile compatibility,
  multi-process run inheritance, wrapper output hashes, and a real repeated
  wrapper profile.
- **Result**: Accepted. The audit runs in 145ms median / 151ms p95 on 6,505
  events. The final wrapper profile found three exact consumer-evidence inputs,
  zero within-command repeats, and a 518ms largest cross-command opportunity.
  Profiled/unprofiled output hashes match and diff-gate is clean.
- **Why**: This replaces slow intuition-driven optimization selection with a
  reusable measurement that tells the next slice where time is actually being
  recomputed.

### 6. Continue Rust semantic materialization after the combined session

- [ ] **File**: `src/semantic/rust/lsp-session.ts`,
      `src/semantic/rust/lsp-session-worker.ts`,
      `src/semantic/shared-primitives.ts`, and
      `src/symbols/graph/call-graph-evidence.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-prefetch-hook.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-split-preserve.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-timeout30-reference-task-profile.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-phase-reference-cache-product-reuse-incomplete-product-skip.profile.jsonl`.
- **What**: The combined request removed the second large callee provider fill
  on Vega, but the accepted profile still spends 54.723s in the reference
  provider loop and 37.604s in Rust reference work. The prefetched-callee cache
  follow-up removed the 5.870s cold callee cache scan, so the remaining problem
  is the Rust reference path.
- **Change**: Measure the next frontier before editing: compare durable
  rust-analyzer session options, remaining Rust reference fallback classes, and
  cache-scan narrowing after combined materialization. Do not add another
  source-assisted reference shortcut unless it proves exact parity on
  SynthRunnerRust, scip-query, and VegaAssistant. A Vega 30s-timeout diagnostic
  kept the command hash and restored the accepted semantic reference count, but
  was slower, so slow standard trait impls must not be treated as proven-zero
  references just because the 15s request run returned empty.
- **Rejected attempt**: a direct `Owner::from(...)` source-assisted fast path
  answered 12 Vega `From` impl rows and kept the command hash, but semantic
  references dropped from 22,316 to 22,314. The missing facts came from two
  separate `mentor/distillation_export.rs` `From` impls that timed out after the
  reference request list changed. Production code was reverted. The next
  accepted Rust speedup must therefore stabilize or avoid timeout-sensitive
  rust-analyzer scheduling, not merely remove a few requests.
- **Accepted follow-up**: `complexity-hotspots` now reuses one semantic
  evidence product for reference materialization and semantic caller maps. The
  second Vega `semantic.references.cache-scan` fell to 1ms with zero cache
  reads. Rust reference rows that are omitted after timeout are tracked in the
  command-local semantic product as incomplete, so the same command does not
  retry them and cache empty rows. This preserves durable-cache honesty while
  leaving future commands free to retry the symbols.
- **Testability**:
  - Test seam: command hash pairs plus semantic fact-count summaries.
  - Injected dependencies: provider/session env toggles and cache-state setup.
  - Pure core: candidate selection and fact-count diffing.
  - Side-effect shell: rust-analyzer project warmup and evidence DB reads.
  - Contract: identical command hashes plus identical semantic reference/callee
    fact counts before accepting.
- **Validation**: VegaAssistant cold complexity and full-health profiles,
  SynthRunnerRust smoke, and fresh scip-query health facts.
- **Why**: The accepted combined session proves session reuse can win. The next
  change should either reduce the remaining Rust reference path or make the
  session durable across processes, not reshuffle work that is already cached
  or cache timeout-shaped empty reference results as if they were compiler
  certainty.

### 7. Cover explicit Rust `Default` struct-update references

- [x] **File**: `src/semantic/rust/default-impl-references.ts:32-73`
- **Source**: `scip-query plan-context src/semantic/rust/default-impl-references.ts`;
  direct VegaAssistant rust-analyzer probe for `SkillDefinition::default` and
  `PersonaPromptConfig::default` on 2026-07-09.
- **What**: The accepted Vega profile still times out on standard `Default`
  impl references at the 15s request timeout. A focused 30s diagnostic returned
  23 `SkillDefinition::default` and 6 `PersonaPromptConfig::default` reference
  sites. The existing fast path only handles direct `Owner::default()` calls and
  falls back for all `Default::default()` syntax.
- **Change**: Extend the existing default-impl reference helper to recognize
  explicit owner struct-update expressions, such as
  `SkillDefinition { ... ..Default::default() }`, when the `Default::default`
  call appears at the same brace depth as the `Owner {` literal. Keep the
  fallback when a `Default::default()` cannot be attributed to the impl owner.
- **Testability**:
  - Test seam: `rustDefaultImplReferencesForDefinition`.
  - Injected dependencies: fixture `ScipDatabase` and source text cache.
  - Pure core: owner-literal/default-call matching inside SCIP reference chunks.
  - Side-effect shell: source text read from indexed documents or disk.
  - Contract: exact `SemanticReference` line/column rows for direct calls and
    struct updates; `null` for ambiguous default syntax.
- **Validation**: focused default-impl unit tests, VegaAssistant complexity
  profile/hash/fact-count comparison, and standard semantic verification.
- **Why**: This removes expensive timeout-prone rust-analyzer work for a common
  Rust idiom while preserving the uncertainty fallback.
- **Result**: Accepted with a definition guard. VegaAssistant
  `__health-phase complexity-hotspots --full` measured 75.830s with 22,316
  semantic references, 18 default fast-path rows, and 72 default fast-path
  references. The output hash changed because `extremeCount` dropped from 20 to
  19 while the top five stayed identical; direct 30s rust-analyzer probes
  matched the two newly source-resolved rows exactly. SynthRunnerRust retained
  3,117 semantic references after rejecting the unguarded derived-default case.
- **Rejected follow-up**: Foreign explicit struct-default accounting made the
  helper source-resolve `SkillDefinition::default` and
  `PersonaPromptConfig::default` in Vega, but the full phase measured 78.548s,
  returned the older `0c6810...` output hash, and dropped semantic references
  from the accepted 22,316 to 22,314. This was reverted.
- **Rejected follow-up**: Target-owner chunk-boundary reconstruction preserved
  SynthRunnerRust, but Vega measured 80.798s, returned the older `0c6810...`
  output hash, wrote only 7,177 durable semantic reference rows, and left 9
  slow reference tasks incomplete. With
  `SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS=30000`, it restored 7,186
  durable rows but measured 81.195s. This was also reverted. Like the rejected
  `From::from` shortcut, both attempts changed rust-analyzer request scheduling
  enough for unrelated rows to time out. More positive standard-trait shortcuts
  should wait until the Rust LSP path can retry or otherwise stabilize
  incomplete reference rows.

### 8. Add opt-in Rust reference retry stabilization

- [x] **File**: `src/semantic/rust/lsp-client.ts:41-153`
- **Source**: `scip-query plan-context src/semantic/rust/lsp-client.ts --json --full`;
  `scip-query refs RustReferenceWorkerRequest --json --full`.
- **What**: `RustAnalyzerLspClient` used one fixed request timeout for every
  request. The batch and session workers marked timed-out reference rows as
  incomplete, which protects the durable cache but leaves full-mode output
  sensitive to rust-analyzer scheduling variance.
- **Change**: Allow `textDocument/references` to accept a per-request timeout,
  add `SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS` as an opt-in retry
  deadline, and thread it through the session and one-shot worker request
  shapes. Keep the default path unchanged when the variable is unset.
- **Testability**:
  - Test seam: `RustAnalyzerLspClient.references`,
    `referencesWithCompletion`, and `RustAnalyzerSessionResolver`.
  - Injected dependencies: scripted LSP transport, fake reference client, fake
    session requester.
  - Pure core: timeout option selection and complete/incomplete result
    classification.
  - Side-effect shell: rust-analyzer subprocess/session worker request.
  - Contract: no retry by default; one retry with the configured timeout when a
    reference request times out; outer session wait budget accounts for the
    longer retry deadline.
- **Validation**:
  `npm test -- --run tests/semantic/rust/rust-lsp-client.test.ts tests/semantic/rust/rust-lsp-batch-worker.test.ts tests/semantic/rust/rust-lsp-session.test.ts`;
  broader Rust semantic suite; `npm run typecheck`; `npm run lint`;
  `npm run build`; VegaAssistant diagnostic benchmark with retry timeout 30s.
- **Result**: Accepted as an opt-in stabilization seam, not as a default
  speedup. VegaAssistant `__health-phase complexity-hotspots --full` with
  `SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS=30000` measured 77.337s,
  restored 22,316 semantic reference facts and 7,186 durable semantic reference
  rows, and reduced slow-profile incomplete tasks from 8 to 0. It remains
  slower than the best 75.830s guarded `Default::default` run, so default retry
  policy should wait for another measured pass.
- **Retry tuning**: `SCIP_RUST_SEMANTIC_REFERENCE_RETRY_TIMEOUT_MS=15000` is
  rejected because it completed all profiled slow tasks but only recorded
  22,314 semantic references. `...=20000` restored the accepted 22,316
  references but measured 78.412s, slower than the 30s retry run. The current
  best observed retry setting is still 30s, and it should stay opt-in until a
  fuller policy can separate full-mode accuracy recovery from interactive
  latency.

### 9. Add Rust callee task profiling and capability calibration

- [x] **File**: `src/semantic/rust/lsp-session-worker.ts:78-650` and
      `src/runtime/project-readiness.ts:147-240`
- **Source**:
  `node dist/cli.js plan-context src/semantic/rust/provider.ts --json --full`;
  `node dist/cli.js refs getProjectCapabilities --json --full`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-callee-task-profile.profile.jsonl`
- **What**: VegaAssistant profiles still show
  `rust.semantic.worker.callees` at roughly 20s-24s for the combined
  reference/callee session, but the worker only had task-level diagnostics for
  references. Separately, `status --capabilities` reported Rust semantics in
  the language matrix but not in the top-level capability summary.
- **Change**: Add gated Rust callee task profiling with
  `SCIP_RUST_SEMANTIC_CALLEE_TASK_PROFILE_MS` and by-file callee rollups when
  `SCIP_QUERY_PROFILE` is enabled. Also make top-level semantic capabilities
  language-driven: preserve `semantic-typescript` and add `semantic-rust` when
  Rust is detected or has semantic readiness.
- **Testability**:
  - Test seam: Rust session worker profile events and
    `getProjectCapabilities`.
  - Injected dependencies: profile environment variables and synthetic
    `ProjectReadiness`.
  - Pure core: per-file profile aggregation and semantic-provider capability
    selection.
  - Side-effect shell: JSONL profile event writes and status rendering.
  - Contract: normal semantic output is unchanged; top-level capability summary
    includes every detected semantic provider.
- **Validation**:
  - `npm test -- --run tests/semantic/rust/rust-lsp-session.test.ts tests/runtime/project-readiness.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - VegaAssistant profiled `__health-phase complexity-hotspots --full`:
    79.082s, `0c6810...` hash, 7,186 durable semantic reference rows, 7,186
    durable semantic callee rows, and new callee task/by-file profile events.
  - `node dist/cli.js status --capabilities --json` shows top-level
    `semantic-typescript` and `semantic-rust` rows as available on scip-query.
- **Result**: Accepted as instrumentation and status calibration, not as a
  speedup. The profile shows the callee path is real project call hierarchy
  work: 7,186 definitions, 6,869 definitions with callees, and 66,469 callee
  facts. No broad callee skip rule is justified from this slice.
- **Rejected follow-up**: Forcing
  `SCIP_RUST_SEMANTIC_PARALLEL_OPERATIONS=0` on the same VegaAssistant phase
  measured 84.140s with the same `0c6810...` hash, but durable semantic
  reference rows dropped from 7,186 to 7,183 while semantic callee rows stayed
  at 7,186. Keep parallel combined reference/callee operations as the default.
- **Why**: The next callee optimization needs task-level evidence before
  source-backed zero-callee shortcuts or durable rust-analyzer session work can
  be designed safely.

### 10. Tighten Rust source facts and add source-proven zero-callee skip

- [x] **File**: `src/source/source-calls.ts`,
      `src/source/source-facts.ts`, `src/semantic/provider-cache.ts`, and
      `src/semantic/rust/provider.ts`
- **Source**:
  `node dist/cli.js code callTargetForNode --json`;
  `node dist/cli.js code extractCallLeaf --json`;
  `node dist/cli.js code createRustSemanticProvider --json`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-source-zero-callee-skip.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-source-zero-callee-skip.profile.jsonl`
- **What**: A source-backed zero-callee audit initially failed because Rust
  method chains were not represented in source callsite facts. Cached source
  facts made that parser behavior durable across process restarts, so the audit
  saw many ordinary method calls as zero-call bodies.
- **Change**: Recognize Rust tree-sitter `field_identifier` leaves and
  `generic_function` wrappers when extracting callsites, and add a source-facts
  payload version so old parser results rebuild as cache misses. Then inject a
  Rust source-zero-callee oracle from the provider cache into the Rust semantic
  provider. The provider skips rust-analyzer callee requests only when current
  source facts contain an exact Rust callable range for the definition and zero
  callsites inside that range.
- **Testability**:
  - Test seam: source-facts fixtures and injected Rust source-zero oracle.
  - Injected dependencies: source oracle, callee resolver, fixture DB source
    files.
  - Pure core: call leaf extraction and source-callable zero-callee decision.
  - Side-effect shell: evidence-cache source-facts read/write and provider
    construction.
  - Contract: stale source-facts payloads rebuild; skipped callee definitions
    return the same empty callee rows rust-analyzer returned on the audited
    corpora.
- **Validation**:
  - `npm test -- --run tests/semantic/rust/rust-semantic-provider.test.ts tests/source/source-facts.test.ts tests/storage/evidence-cache.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - VegaAssistant audit after source-facts fix: exact source-callable
    zero-callee definitions 119, semantic-positive mismatches 0.
  - SynthRunnerRust audit after source-facts fix: exact source-callable
    zero-callee definitions 78, semantic-positive mismatches 0.
  - VegaAssistant profiled `__health-phase complexity-hotspots --full`:
    81.189s, callee worker definitions 7,067, proving 119 callee requests were
    removed. Hash changed to `1ae23ffa...` because Rust method-call source facts
    now add previously missing AST callee evidence.
  - SynthRunnerRust profiled `health --full --json`: 16.052s, callee worker
    definitions 1,312, hash `3d9caaf2...`.
- **Result**: Accepted as a Rust source-facts accuracy fix and a
  redundant-request elimination. Not accepted as a proven wall-time speedup:
  Vega and SynthRunnerRust both remained in the same runtime band or slower
  than the best earlier runs.
- **Why**: Full-mode accuracy must not depend on stale source-facts cache rows,
  and a zero-callee skip is only safe after an exact source-callable proof. The
  remaining speed problem is positive rust-analyzer work, so the next major
  optimization should target durable rust-analyzer session/index reuse.

### 11. Add Rust SCIP-occurrence positive callee proof

- [x] **File**: `src/semantic/rust/scip-occurrence-callees.ts`,
      `src/semantic/rust/provider.ts`, `src/semantic/provider-cache.ts`,
      `src/source/source-calls.ts`, and `src/source/source-facts.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-synth-runner-rust-health-full-scip-occurrence-callee-profiled.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-vega-complexity-scip-occurrence-callee-profiled.profile.jsonl`;
  direct source/SCIP equality audit over SynthRunnerRust and VegaAssistant.
- **What**: Source-zero removes only empty Rust callees. The next safe positive
  shortcut is the caller subset where compiler SCIP occurrences inside a Rust
  callable exactly match current source callsite leaves and lines. This avoids
  rust-analyzer call hierarchy for the proven caller while preserving fallback
  for every ambiguous case.
- **Change**: Add a Rust SCIP-occurrence callee oracle that builds a per-DB
  occurrence index, rejects `main`, Rust trait impl callers, Rust trait impl
  callees, missing source facts, and any source/SCIP multiset mismatch, then
  returns exact `SemanticCallee` rows. The Rust provider consults this oracle
  before rust-analyzer in both callee-only and combined reference/callee paths.
  The combined path now preserves already-proven callees even when no semantic
  request remains.
- **Testability**:
  - Test seam: `tests/semantic/rust/rust-scip-occurrence-callees.test.ts` and
    injected provider oracle tests.
  - Injected dependencies: fixture SCIP index, fixture DB definitions, and
    provider callee resolver.
  - Pure core: source/SCIP line-leaf multiset equality and structural guards.
  - Side-effect shell: SCIP protobuf read, source-facts cache read, and
    definition-catalog lookup.
  - Contract: proven callers return the same callee rows without an LSP request;
    unproven callers still go through rust-analyzer.
- **Validation**:
  - `npm test -- --run tests/source/source-facts.test.ts tests/storage/evidence-cache.test.ts tests/semantic/rust/rust-scip-occurrence-callees.test.ts tests/semantic/rust/rust-semantic-provider.test.ts`
  - `npm test -- --run tests/semantic/rust tests/source/source-facts.test.ts tests/storage/evidence-cache.test.ts`
  - `npm run typecheck`
  - `npm run build`
  - `npm run lint`
  - SynthRunnerRust profiled `health --full --json`: 15.478s, hash
    `3d9caaf2...`, 1,372 candidates, 12 proven definitions, 23 proven callees.
  - VegaAssistant profiled `__health-phase complexity-hotspots --full`:
    79.278s, hash `1ae23ffa...`, 6,573 candidates, 64 proven definitions,
    136 proven callees.
- **Result**: Accepted as a safe redundant-request elimination and profiling
  hook. Not a major wall-time win: the proven set is small, and Vega remains
  dominated by Rust reference resolution.
- **Rejected follow-up**: A standard-trait zero-reference shortcut for Rust
  trait impl members was implemented, measured, and backed out. The audit found
  24 VegaAssistant standard-trait impl members with zero exact SCIP occurrences
  and zero semantic references, but the benchmark
  `vega-complexity-standard-trait-zero-reference` measured 80.799s, kept the
  command hash, wrote only 7,180 durable semantic reference rows instead of
  7,186, and left unrelated reference tasks incomplete. Zero SCIP occurrence is
  not enough for a default standard-trait reference skip.
- **Why**: This improves the Rust semantic path without reducing accuracy, but
  the next material speedup must target `rust.semantic.worker.references`.
  Candidate audit area: trait/fallback reference shapes such as `From::from`,
  `fmt`, `source`, `deserialize`, `clone`, and `default`, where rust-analyzer
  often spends the full request timeout returning zero or very few references.

### 12. Tighten full-health semantic prewarm completion marker

- [x] **File**: `src/runtime/cli-support.ts`,
      `tests/runtime/cli-support.test.ts`
- **Source**:
  `node dist/cli.js plan-context src/runtime/cli-support.ts`;
  `node dist/cli.js refs prewarmHealthSemanticEvidence`;
  VegaAssistant reference profiles showing durable semantic reference row
  counts can drop when rust-analyzer leaves reference tasks incomplete.
- **What**: Full-health prewarm writes a project marker so later full health
  runs can skip the expensive semantic cache fill. The marker previously did
  not record whether Rust reference materialization had incomplete rows, so a
  timed-out first warmup could be treated as reusable warm state.
- **Change**: Bump the health semantic prewarm marker version, add
  `referenceIncomplete`, and return a `partial` prewarm result when references
  are incomplete. Successful reference and callee cache writes are still kept,
  but no reusable project marker is written until incomplete rows are zero.
  Readers also ignore any version-2 marker that records nonzero incomplete
  references.
- **Testability**:
  - Test seam: `prewarmHealthSemanticEvidence` with injected
    `HealthSemanticPrewarmRuntime`.
  - Injected dependencies: project fingerprint, marker read/write,
    candidate definitions, reference materialization, and callee materialization.
  - Pure core: marker write decision from materialization counters.
  - Side-effect shell: project evidence marker write.
  - Contract: marker cache hits skip candidate scans only for version-2 markers;
    incomplete references produce `partial` and do not write the marker.
- **Validation**:
  `npm test -- --run tests/runtime/cli-support.test.ts`;
  `npm run typecheck`.
- **Result**: Accepted as warm-state correctness hardening. This does not claim
  an immediate cold-run wall-time speedup; it prevents false warm markers and
  keeps repeat full passes honest while the Rust reference path is still being
  stabilized.

### 13. Extend adaptive settle to small combined Rust semantic batches

- [x] **File**: `src/semantic/rust/lsp-session.ts`,
      `tests/semantic/rust/rust-lsp-session.test.ts`
- **Source**:
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-scip-query-health-full-small-combined-adaptive96-default.profile.jsonl`;
  `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis-scip-query-health-full-small-combined-forced5000-current.profile.jsonl`
- **What**: The earlier adaptive settle policy covered small reference-only
  Rust requests. After combined Rust reference/callee materialization, the mixed
  scip-query full-health prewarm issues one small combined request: references
  and callees together across 76 Rust definitions. That request still paid the
  fixed 5s rust-analyzer settle delay even though the same request with
  `SCIP_RUST_SEMANTIC_SETTLE_MS=0` preserved the full health JSON output and
  semantic row counts.
- **Change**: Keep the 64-definition reference-only zero-settle threshold, and
  add a separate 96-definition threshold for combined reference+callee requests
  with no signatures. Explicit `SCIP_RUST_SEMANTIC_SETTLE_MS` values still win,
  signature batches still keep the conservative wait, and large Rust-heavy
  combined batches keep the 5s default.
- **Testability**:
  - Test seam: `RustAnalyzerSessionResolver` with an injected requester.
  - Injected dependencies: captured worker request payloads.
  - Pure core: `rustSemanticSettleDelayMs()` request-shape classification.
  - Side-effect shell: rust-analyzer session request construction.
  - Contract: small combined reference/callee batches skip only the artificial
    settle wait; explicit env overrides and large combined batches remain
    conservative.
- **Validation**:
  - `npm test -- --run tests/semantic/rust/rust-lsp-session.test.ts`
  - `npm run typecheck`
  - `npm run lint`
  - `npm run build`
  - scip-query cold full health, forced 5s settle:
    15.756s, hash
    `ddd488b34533ca771b5d2678d086ec4191469fcb879456298c7ec9d4ca4c3aed`,
    4,521 durable semantic reference rows and 4,522 durable semantic callee
    rows.
  - scip-query cold full health, adaptive default:
    11.200s, same hash, same semantic row counts. Profile:
    `health.semantic-prewarm` dropped from 11.869s to 7.339s,
    `rust.semantic.session.request` dropped from 6.911s to 2.414s, and
    `rust.semantic.worker.settle` dropped from 5.003s to 0ms.
- **Result**: Accepted for small mixed Rust semantic batches. This is not a
  global zero-wait policy: SynthRunnerRust/Vega-sized Rust fallback batches keep
  the conservative readiness wait unless a future durability/session change
  proves a stronger boundary.

## Stress-Test Findings

Purpose: make full-mode analysis realistic without diluting accuracy. Full mode
means using every reliable evidence channel over eligible candidates; bounded
mode remains the interactive latency policy.

Blast radius: storage semantic cache changes affect TypeScript and Rust callers
through shared primitives. Reindex changes affect every command because the
SQLite index is the root evidence artifact.

Valid intermediate state: benchmark/profile-only changes can land independently.
Storage batch reads can land behind exact equivalence tests. Reindex fast-path
work must not land unless freshness, metadata, and artifact validity are proven.

Failure: evidence-cache failures must disable the cache and fall back to current
behavior. Reindex fast-path failures must fall back to the existing rebuild path.
Native helper failures must stay opt-in and fall back to TypeScript.

Data integrity: do not change cache key identity unless the ledger records a
payload-version or fingerprint migration. Do not share partial and complete
index evidence accidentally.

Human experience: users should see faster repeat commands and reindex runs, not
new required setup steps.

## Verification

- [ ] `cargo test -p scip-query-kernels`
- [ ] targeted storage, semantic, reindex, and provider tests
- [ ] `npm run typecheck`
- [ ] `npm run build`
- [ ] `npm run lint`
- [ ] VegaAssistant before/after output hashes and profile spans
- [ ] codex-rs before/after output hashes and profile spans
- [ ] `node dist/cli.js reindex`
- [ ] `node dist/cli.js diff-gate --json`
- [ ] routed postchecks: `co-change` for touched storage/reindex files,
      `recent-duplicates` for new helpers, `unused-params` for new options, and
      wrapper/passthrough checks for new boundaries.
