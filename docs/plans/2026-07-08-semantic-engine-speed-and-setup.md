# Semantic Engine Speed and Setup Plan

Date: 2026-07-08

## Goal

Make TypeScript and Rust semantic support converge without regressing the
current TypeScript path. The near-term goal is speed: Rust semantic references
should be cached and batched well enough that full-mode commands can use them
instead of disabling semantic evidence. The broader goal is a guided setup flow
that installs local project support deliberately and makes semantic readiness
obvious.

## Progress Ledger

2026-07-08 implementation notes:

- Rust semantic references now materialize at the semantic evidence product
  boundary, reuse command-scope in-memory results, and persist with a Rust-aware
  cache fingerprint.
- Rust call hierarchy/callees are wired through `rust-analyzer` and mapped back
  to SCIP symbols when the indexed definition is available.
- VegaAssistant smoke results:
  - Rust semantic references: cold run about 25.60s; warm cache repeat about
    0.56s.
  - Rust semantic callees: cold provider loop about 10.20s for one definition
    and 15 callees; warm repeat hit the semantic callee cache in about 3ms.
- `scip-query setup --guided` now has a consent-first planner for agent docs,
  hooks, missing indexers, and parser runtimes.
- A TypeScript language-service comparison provider exists beside ts-morph. It
  matches the ts-morph reference baseline on the current semantic fixture, but
  ts-morph remains the default.
- `SemanticSessionManager` now names the provider/session lifecycle boundary
  behind `getSemanticProvider()`. This is command-scoped groundwork, not a
  cross-command daemon yet.
- The first native Rust kernel experiment covers SCIP symbol leaf extraction.
  It is equivalent to the TypeScript implementation on fixtures, but the helper
  binary benchmark is slower for 100k symbols because process and pipe overhead
  dominate: JS about 24ms, Rust helper about 340ms. Do not promote this kernel
  through a helper binary; use larger kernels or in-process native embedding for
  future Rust acceleration.

2026-07-08 active goal:

Bring Rust semantic support to TypeScript-parity by adding a persistent
`rust-analyzer` session, compiler-backed Rust module/import facts, durable
semantic caching for expensive Rust fact slots, and measured calibration on real
Rust-heavy repositories. TypeScript-parity here means Rust can answer the same
kinds of questions the TypeScript provider answers: references, caller files,
callees, signatures, and import/module usage, while reporting when a fact is
cached, partial, unavailable, or source-fallback-only.

The first implementation slice is the persistent Rust session. A persistent Rust
session is a command-scoped connection to one warmed `rust-analyzer` process for
one project root. Its essential purpose is to let references, callees, hovers,
and future module facts share one loaded Cargo project instead of restarting the
language engine for each semantic operation.

2026-07-08 persistent-session slice completed:

- Added a worker-thread Rust session sidecar that keeps `rust-analyzer` warm for
  the command and serves references, callees, and hover-derived signatures
  through the existing synchronous Rust provider contract.
- Kept the existing one-shot batch worker as the fallback when the session
  sidecar cannot start or times out.
- Added deterministic semantic-provider disposal so clearing the command-scoped
  provider cache shuts down Rust session workers.
- Added `rust.semantic.session.request` profiling. Post-reindex smoke on
  `call-graph 'rust-analyzer cargo scip-query-kernels 0.1.0 leaf_name().'`
  recorded one Rust session request for 16 Rust definitions in about 6.6s and
  returned 6 callees.
- Verification: focused Rust/session tests, full `npm test`, `cargo test
--workspace`, `npm run typecheck`, `npm run lint`, `npm run build`,
  `node dist/cli.js reindex`, and `node dist/cli.js diff-gate`.

2026-07-08 compiler-backed Rust import slice completed:

- Added `textDocument/definition` support to the Rust LSP client and session
  worker.
- Rust `importUsage()` now records import-name source positions, asks the warmed
  `rust-analyzer` session for project-local definitions, and overlays those
  resolved source files onto source-fallback import facts.
- Source fallback remains the contract when `rust-analyzer` is unavailable,
  cannot answer, or resolves an import outside the project.
- Smoke on `crates/scip-query-kernels/src/main.rs` recorded a
  `rust.semantic.import-definitions.session.request` span for 3 positions. It
  resolved the project-local `leaf_name` import to
  `crates/scip-query-kernels/src/lib.rs` and kept `std::io` imports external.
- Verification: focused Rust semantic import/session tests, full `npm test`,
  `cargo test --workspace`, `npm run typecheck`, `npm run lint`,
  `npm run build`, `node dist/cli.js reindex`, and
  `node dist/cli.js diff-gate`.

2026-07-08 durable Rust semantic cache slice completed:

- Added Rust semantic engine identity to Rust reference and callee cache
  namespaces. The identity includes `rust-analyzer`, the resolved binary, and a
  cached `rust-analyzer --version` result.
- Added project-scoped evidence products for Rust semantic import usage and
  Rust semantic signatures.
- Rust import usage and signatures now read the durable project cache before
  constructing the semantic provider, then write results only after a live
  provider computes them.
- Cached signature misses are stored too, so repeated null hover/signature
  answers do not wake `rust-analyzer` again for the same project identity.
- Intentional partial indexes now produce project evidence fingerprints, with
  the index status included in the cache key. This lets Rust semantic caches
  work on partial indexes such as Codex's Rust/TypeScript/Python index while
  still preventing partial and complete indexes from sharing rows.
- Updated the evidence-cache invalidation matrix for the new products.
- Smoke on `crates/scip-query-kernels/src/main.rs` showed the second
  `imports --json` run hit `project:semantic-import-usage` in 1ms with
  payload size 691 bytes and made 0 Rust import-definition LSP requests.
- Verification: focused Rust cache/storage/manifest tests, full `npm test`,
  `cargo test --workspace`, `npm run typecheck`, `npm run lint`,
  `npm run build`, `node dist/cli.js reindex`, and
  `node dist/cli.js diff-gate`.

2026-07-08 calibration slice completed:

- Calibrated scip-query, VegaAssistant, and Codex `codex-rs` with local
  `dist/cli.js`, profiling enabled, `SCIP_RUST_SEMANTIC_SETTLE_MS=0`, and
  `SCIP_RUST_SEMANTIC_DIAGNOSTICS_TIMEOUT_MS=1000`.
- scip-query: Rust import full path dropped from 6.301s with one
  import-definition LSP request to 0.624s with a project-cache hit; full
  `leaf_name` call graph returned 6 callees from semantic callee cache.
- VegaAssistant: full Rust import query dropped from 9.905s to 0.232s; full
  Rust call graph dropped from 19.224s with one Rust session request to 0.472s
  with a callee-cache hit.
- Codex `codex-rs`: indexed with `RUSTUP_TOOLCHAIN=stable` because the repo's
  `1.93.0` toolchain lacks `rust-analyzer`; `--allow-partial` indexed
  TypeScript/Rust/Python and skipped C in 250.9s. Full Rust import query dropped
  from 22.337s to 0.277s; full Rust call graph dropped from 43.205s to 1.297s.
- Results are recorded in
  `docs/architecture/rust-semantic-performance-ledger.md`.

## Current State

- Source: `scip-query status --capabilities`
  - The repository index is fresh and TypeScript semantic support is available.
- Source: `scip-query plan-context src/semantic/provider-cache.ts`
  - `getSemanticProvider()` is the provider cache boundary, and
    `semanticProviderLanguageForPath()` chooses TypeScript or Rust by path.
- Source: `scip-query plan-context src/semantic/typescript/ts-morph-provider.ts`
  - `createTsMorphProvider()` constructs the TypeScript provider from ts-morph
    project bundles. The provider already caches references, callees, import
    usage, signatures, and does bulk reference scans for larger batches.
- Source: `scip-query plan-context src/semantic/rust/lsp-batch-worker.ts`
  - `runRustAnalyzerReferenceBatch()` starts one `rust-analyzer` LSP session for
    a batch, opens documents, waits for diagnostics, and asks for references.
- Source: `scip-query plan-context src/runtime/project-readiness.ts`
  - Readiness already reports indexer, source fallback, semantic, checker, and
    Tree-sitter/source-parser capability.
- Source: `scip-query plan-context src/runtime/project-setup.ts`
  - `runProjectSetup()` already performs skills, config validation, indexer
    remediation, reindex, hooks/agent setup, and health smoke in a
    non-interactive workflow.

## Reuse Audit

- Reuse `SemanticProvider` and `semanticEvidenceProduct` rather than adding
  detector-specific Rust behavior.
- Reuse the existing semantic reference cache shape where possible, but extend
  its identity for language and Rust engine metadata instead of pretending Rust
  and TypeScript have the same invalidation needs.
- Reuse `project-readiness` for setup discovery and status rendering.
- Reuse `project-setup` as the setup orchestrator, adding an interactive decision
  layer rather than inventing a second setup command.
- Keep `ts-morph` as the TypeScript baseline. Add `tsserver` only as an optional
  comparison provider until parity is proven.
- Reuse `RustAnalyzerLspClient` for protocol behavior. The session slice should
  not introduce a second LSP implementation.
- Reuse `SemanticSessionManager` as the provider lifetime boundary. Add Rust
  engine lifetime under the Rust provider before considering a cross-command
  daemon.
- Reuse the Rust batch worker's mapping/parsing helpers where practical, but
  extract shared helpers only where tests show reuse is clearer than coupling to
  worker process code.
- Treat `src/storage/evidence-cache.ts` as a later, higher-risk change for
  durable cache expansion. The persistent-session slice should improve cold
  command behavior without changing cache schemas.

## Testability Design

| Behavior                               | Test seam                                        | Dependencies to inject                                                 | Pure core                                            | Side-effect shell               | Contract                                                                             |
| -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| Rust semantic reference cache identity | cache key builder and cache read/write functions | rust-analyzer version, Cargo metadata fingerprint, project fingerprint | key construction and payload validation              | evidence DB reads/writes        | Same source/project/tool identity returns cached references; changed identity misses |
| Rust command-level batching            | semantic caller map over mixed definitions       | fake Rust resolver, fake cache, fake project fingerprint               | grouping definitions by language/session root        | rust-analyzer worker invocation | One Rust batch per session root; cached definitions are not sent                     |
| Rust LSP worker behavior               | `runRustAnalyzerReferenceBatch()`                | fake transport/client where possible                                   | manifest/session-root selection                      | rust-analyzer process           | Definitions return references or explicit misses without crashing the whole batch    |
| Rust persistent LSP session            | Rust session facade over an injected LSP client  | fake client, fake status, fake clock, fake source reader               | request grouping, open-document memoization          | process-backed client startup   | One initialized client serves references, callees, and signatures until shutdown     |
| Rust compiler-backed imports           | Rust import resolver interface                   | fake LSP answers and source fallback                                   | mapping resolved paths/re-exports to import facts    | LSP definition/module requests  | LSP facts replace syntax guesses when available; fallback remains explicit           |
| Rust semantic fact caches              | semantic evidence materializers                  | fake evidence store, fingerprint, engine identity                      | cache key and payload validation                     | evidence DB reads/writes        | Cached callees/signatures/imports are used only for matching project and engine      |
| tsserver comparison                    | comparison provider harness                      | ts-morph provider, tsserver provider, fixture project                  | diff classification                                  | language server process         | No default behavior changes; compare mode emits deltas                               |
| Guided setup choices                   | setup decision planner                           | detected files, readiness, existing config, prompt answers             | list of recommended actions and consent requirements | file edits, installs, hooks     | No local project file is created or modified without a recorded affirmative choice   |

## Active Execution Plan

### A1. Persistent Rust LSP Session

- [x] **File**: `src/semantic/rust/lsp-session.ts`
- **Sources**:
  - `node dist/cli.js plan-context src/semantic/rust/provider.ts`
  - `node dist/cli.js plan-context src/semantic/rust/lsp-batch-worker.ts`
  - `node dist/cli.js plan-context src/semantic/rust/lsp-client.ts`
  - `node dist/cli.js plan-context src/semantic/session-manager.ts`
- **What**: Add a reusable Rust session facade that initializes
  `rust-analyzer` once, memoizes opened source documents, and serves references,
  callees, and hover-derived signatures through the existing Rust semantic
  provider.
- **Why first**: This attacks the current dominant cost, `rust-analyzer`
  startup, without touching detector policy or evidence-cache schema.
- **Testability**:
  - Test seam: session facade with an injected fake `RustAnalyzerLspClient`.
  - Dependencies to inject: client factory, status collector, current time, and
    source reader.
  - Pure core: grouping definitions by file, memoizing document opens, mapping
    LSP failures to empty semantic facts.
  - Side-effect shell: spawning and shutting down the real language server.
  - Contract: a provider instance initializes one Rust session, repeated
    operations reuse it, and shutdown is deterministic when the provider session
    is cleared.
- **Validation**: targeted Rust semantic session tests, existing Rust semantic
  provider tests, `npm run typecheck`, and a VegaAssistant smoke comparison.

### A2. Compiler-Backed Rust Import And Module Facts

- [x] **File**: `src/semantic/rust/`
- **Sources**:
  - `node dist/cli.js plan-context src/semantic/rust/provider.ts`
  - `node dist/cli.js plan-context src/semantic/types.ts`
  - `node dist/cli.js plan-context src/semantic/rust/lsp-client.ts`
  - `node dist/cli.js plan-context src/semantic/rust/import-usage.ts`
- **What**: Upgrade Rust `importUsage()` from source-only `use` parsing to
  prefer `rust-analyzer` facts where it can disambiguate modules, re-exports,
  aliases, and macro-expanded surfaces. Keep the source parser as the explicit
  fallback.
- **Current behavior**: `src/semantic/rust/import-usage.ts` maps
  `getSourceImports()` into `SemanticImportUsage`; `provider-cache` is its only
  direct production consumer. The Rust provider already owns the warmed session
  created in A1, so the semantic overlay should live inside the provider rather
  than in `provider-cache`.
- **Change**:
  - Add `textDocument/definition` support to `RustAnalyzerLspClient`.
  - Extend the Rust session worker with an import-definition request that opens a
    Rust source file once and resolves import-name positions to project-relative
    definition files.
  - Extend Rust source import facts with import-name positions derived from the
    Rust AST. Match positions back to existing source import entries by
    imported/local name and occurrence order.
  - Add a semantic Rust import resolver that overlays LSP-resolved `sourcePath`
    values onto source import usage entries while preserving source fallback when
    LSP is unavailable, out-of-project, or cannot answer.
- **Testability**:
  - Test seam: `rustImportUsageWithResolvedDefinitions()` and
    `RustAnalyzerSessionResolver.importDefinitionsForFile()`.
  - Injected dependencies: fake Rust session requester, fake source import fact
    resolver, and scripted LSP transport.
  - Pure core: import-position-to-usage matching and sourcePath overlay.
  - Side-effect shell: LSP `definition` request, source-file open, worker-thread
    bridge.
  - Contract: source import usage is unchanged unless `rust-analyzer` returns a
    project-local definition file for that exact import position.
- **Validation**: fixture tests for `use`, `pub use`, aliases, inline modules,
  file modules, and fallback behavior when the LSP cannot answer.

### A3. Durable Rust Caches For Remaining Fact Slots

- [x] **Files**: `src/semantic/shared-primitives.ts`,
      `src/storage/evidence-cache.ts`
- **Sources**:
  - `node dist/cli.js plan-context src/semantic/shared-primitives.ts`
  - `node dist/cli.js plan-context src/storage/evidence-cache.ts`
- **What**: Persist Rust callees, signatures, and import/module usage with
  project, source, language, semantic engine, and payload-version identity.
- **Why later**: `shared-primitives` and `evidence-cache` are high-fanout
  files, so this should happen after the session behavior is stable.
- **Validation**: storage round-trip tests, stale-fingerprint miss tests, and
  repeat-command smoke runs that prove provider calls are skipped.

### A4. Calibration Ledger

- [x] **Files**: `docs/architecture/rust-semantic-performance-ledger.md`,
      future `docs/validation/` ledgers as needed
- **Sources**:
  - `node dist/cli.js status --capabilities`
  - `node dist/cli.js diff-gate --full`
- **What**: Measure accuracy and runtime on scip-query, VegaAssistant, and one
  Rust-heavy repo such as Codex. Record semantic references, callees,
  signatures, import/module facts, cache hit behavior, fallbacks, and runtime.
- **Validation**: keep raw command names and summaries so future work can
  compare against these numbers rather than memory.

## Stress Tests

- Missing `rust-analyzer` must degrade to explicit unavailable status, not a
  thrown detector failure.
- A failed Rust session must not poison TypeScript semantic analysis.
- Large workspaces must open each source document at most once per session.
- Session shutdown must not leave child language-server processes running.
- Cached Rust facts must be invalidated by project/source/engine identity, not
  by language-neutral guesses.
- Full mode must use available Rust semantic facts; bounded mode may still
  apply latency limits and must say when it does.

## Design Phases

### 1. Instrument the Rust semantic cost

- [ ] **File**: `src/semantic/rust/provider.ts`
- **Source**: `scip-query plan-context src/semantic/rust/lsp-batch-worker.ts`
- **What**: Rust references currently run through a batch worker, but command
  output does not clearly show how many batches, definitions, misses, and
  startup costs occurred.
- **Change**: Add profile spans and counters around Rust semantic provider calls:
  batch count, definition count, cache hits/misses once caching exists, worker
  duration, and provider unavailable reasons.
- **Testability**:
  - Test seam: provider call with fake resolver.
  - Injected dependencies: fake resolver and profiling sink.
  - Pure core: profile payload construction.
  - Side-effect shell: worker process call.
  - Contract: profiles diagnose cost without changing semantic results.
- **Validation**: targeted provider tests plus VegaAssistant profile run.
- **Why**: We need measurements before choosing daemon/native work.

### 2. Add Rust semantic reference evidence caching

- [ ] **File**: `src/semantic/shared-primitives.ts`
- **Source**: `scip-query plan-context src/semantic/typescript/ts-morph-provider.ts`
- **What**: Semantic reference caching currently treats TypeScript as the only
  persistent semantic-reference language.
- **Change**: Generalize semantic reference cache lookup/write so Rust references
  can be cached with language and engine identity. Include rust-analyzer version
  and Cargo/session identity in the key or payload guard.
- **Testability**:
  - Test seam: cache read/write around `semanticEvidenceProduct(db).callerMap`.
  - Injected dependencies: project fingerprint, provider language, engine
    version.
  - Pure core: cache key and payload parse/validation.
  - Side-effect shell: evidence DB.
  - Contract: TypeScript cache behavior remains unchanged; Rust cache hits skip
    provider calls.
- **Validation**: unit tests with fake Rust provider; repeat VegaAssistant smoke
  showing warm-cache speedup.
- **Why**: This gives speed now without changing sync provider APIs.

### 3. Batch Rust semantic work at command scope

- [ ] **File**: `src/semantic/shared-primitives.ts`
- **Source**: `scip-query plan-context src/semantic/provider-cache.ts`
- **What**: Existing callers can request semantic evidence in separate detector
  phases, causing repeated Rust LSP startup if cache misses are split.
- **Change**: Add a command/phase-level materialization path that groups Rust
  definitions by session root, fetches missing references once, and writes the
  results before downstream detector reads.
- **Testability**:
  - Test seam: materializer with fake definitions and fake resolver.
  - Injected dependencies: cache adapter, provider resolver, session-root
    grouping.
  - Pure core: grouping and miss selection.
  - Side-effect shell: worker invocation and cache writes.
  - Contract: provider gets one request per Rust session root for uncached
    definitions.
- **Validation**: unit tests plus VegaAssistant full-command profile.
- **Why**: This reduces startup count while keeping the current synchronous
  semantic provider usable.

### 4. Fill Rust parity fact slots

- [ ] **File**: `src/semantic/rust/`
- **Source**: `scip-query plan-context src/semantic/rust/lsp-batch-worker.ts`
- **What**: Rust references exist; callees, signatures, and import/module facts
  are still unavailable.
- **Change**: Add one fact slot at a time: call hierarchy/callees, signatures,
  then use/module facts. Each slot gets capability reporting and cache identity.
- **Testability**:
  - Test seam: Rust LSP client method per fact slot.
  - Injected dependencies: fake LSP transport.
  - Pure core: LSP response mapping to `SemanticCallee`, signature strings, and
    import/module facts.
  - Side-effect shell: rust-analyzer LSP requests.
  - Contract: unavailable LSP features degrade to explicit empty/partial
    capability, not crashes.
- **Validation**: Rust unit fixtures and VegaAssistant smoke per slot.
- **Why**: This is what TypeScript parity means in practice.

### 5. Add tsserver compare mode

- [ ] **File**: `src/semantic/typescript/`
- **Source**: `scip-query plan-context src/semantic/typescript/ts-morph-provider.ts`
- **What**: ts-morph is robust but may not be the fastest warmed engine for all
  TypeScript semantic work.
- **Change**: Add an optional `tsserver` provider behind config/experiment flags
  that can compare answers against ts-morph without changing defaults.
- **Testability**:
  - Test seam: comparison harness over fixture definitions.
  - Injected dependencies: ts-morph provider and tsserver provider.
  - Pure core: diff classification.
  - Side-effect shell: tsserver process.
  - Contract: default TypeScript behavior is unchanged unless compare mode is
    explicitly enabled.
- **Validation**: calibration repos with mismatch reports.
- **Why**: TypeScript speed work must prove no regressions before switching.

### 6. Introduce a semantic session manager

- [ ] **File**: `src/semantic/`
- **Source**: `scip-query plan-context src/semantic/provider-cache.ts`
- **What**: Provider cache is the current lifecycle boundary, but it does not own
  persistent language-server sessions.
- **Change**: Add a session manager abstraction for command-scoped sessions.
  Start with Rust. Later consider cross-command daemon reuse.
- **Testability**:
  - Test seam: session manager with fake engine factory.
  - Injected dependencies: process factory, clock/idle policy, project identity.
  - Pure core: session keying and lifecycle decisions.
  - Side-effect shell: process start/shutdown.
  - Contract: one session per project/language/session-root; shutdown is
    deterministic.
- **Validation**: lifecycle unit tests and long-running Vega smoke.
- **Why**: This is the bridge from batch worker to warmed language servers.

### 7. Make setup guided

- [ ] **File**: `src/runtime/project-setup.ts`
- **Source**: `scip-query plan-context src/runtime/project-setup.ts`
- **What**: Setup already exists, but it is not a consent-driven menu for local
  project changes.
- **Change**: Add an interactive decision planner and keep non-interactive mode.
  Detect `AGENTS.md`/`CLAUDE.md`, hooks, indexers, Tree-sitter runtime/grammars,
  semantic engines, and checkers before asking what to install or edit.
- **Testability**:
  - Test seam: setup decision planner.
  - Injected dependencies: prompt answers, filesystem snapshot, readiness.
  - Pure core: recommended action list.
  - Side-effect shell: file writes, hook install, indexer/parser installs.
  - Contract: no file creation or modification without affirmative choice.
- **Validation**: setup tests with fake prompt answers and temp project roots.
- **Why**: Smooth setup is necessary if semantic engines and parser dependencies
  become core to accuracy.

### 8. Move only measured kernels to Rust

- [ ] **File**: future `crates/` or helper binary boundary
- **Source**: `scip-query plan-context src/runtime/commands/command-handlers.ts`
- **What**: The CLI has many user-facing command handlers, but not every slow
  operation belongs in native code.
- **Change**: After profiling, move stable kernels such as graph traversal,
  SQLite aggregation, source tokenization, or git-history aggregation behind
  narrow contracts.
- **Testability**:
  - Test seam: fixture input/output equivalence tests.
  - Injected dependencies: fixture DB/source/history.
  - Pure core: Rust kernel.
  - Side-effect shell: TypeScript wrapper or helper binary call.
  - Contract: Rust and TypeScript implementations match on calibration fixtures
    before switching defaults.
- **Validation**: performance benchmark plus equivalence suite.
- **Why**: Rust should accelerate named hot cores, not force a broad rewrite.

## Stress-Test Findings

- The synchronous `SemanticProvider` contract makes a daemon harder as the first
  slice. Cache and command-level batching are safer near-term speed wins.
- Rust cache identity is stricter than TypeScript cache identity because Cargo
  metadata, rust-analyzer version/config, and session root can affect answers.
- TypeScript has a robust baseline. `tsserver` must be measured in compare mode
  before it can replace any ts-morph path.
- Setup UX must be consent-first. Agent docs and hooks are local project changes,
  not invisible package installation details.
- Tree-sitter readiness already exists in `project-readiness`; setup should use
  that instead of inventing a separate parser-detection path.

## Execution Order

1. Instrument Rust semantic cost.
2. Add Rust semantic reference cache identity and tests.
3. Add command/phase-level Rust semantic materialization.
4. Re-profile VegaAssistant cold and warm runs.
5. Add the next Rust parity fact slot.
6. Start tsserver compare mode.
7. Add guided setup choices.
8. Move measured kernels to Rust.

## Ship Order

- Two-way doors: instrumentation, cache reads behind feature tests, setup dry-run
  planner, tsserver compare mode.
- One-way doors to delay: changing TypeScript defaults, background daemon,
  native Rust kernel replacement, creating project files in setup without
  explicit user consent.

## Summary of Files

Create/edit likely:

- `src/semantic/shared-primitives.ts`
- `src/semantic/provider-cache.ts`
- `src/semantic/rust/`
- `src/semantic/typescript/`
- `src/runtime/project-readiness.ts`
- `src/runtime/project-setup.ts`
- tests under `tests/semantic/rust`, `tests/semantic/typescript`, and
  `tests/runtime`

Verify with:

- `npm run typecheck`
- targeted Vitest suites for semantic Rust, semantic TypeScript, and setup
- VegaAssistant smoke/profile runs
- `scip-query reindex`
- `scip-query diff-gate`
