# Durable rust-analyzer Session Plan

Date: 2026-07-09

## Goal

Make an opt-in Rust semantic session survive separate `scip-query` CLI
processes, so repeated evidence-cold commands can reuse rust-analyzer's ready
compiler state without weakening the command-output or semantic-fact contract
recorded in
`docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`.

Completion requires cross-process reuse, fail-closed invalidation, crash/stale
state recovery, an unchanged per-command fallback, representative benchmark
evidence, targeted tests, type checking, and a passing SCIP diff gate.

## Current State

- `RustAnalyzerSessionResolver` synchronously delegates semantic and import
  requests through `RustAnalyzerSessionRequester`, an existing narrow seam that
  tests already replace without constructing rust-analyzer.
  **Source:** `scip-query code RustAnalyzerSessionResolverOptions`,
  `scip-query code createRustAnalyzerSessionResolver`.
- `createWorkerRustAnalyzerSessionRequester()` lazily creates one worker thread,
  waits synchronously through a shared buffer, and destroys that worker when
  its requester is shut down. The worker therefore cannot outlive the CLI
  process that owns it.
  **Source:** `scip-query code createWorkerRustAnalyzerSessionRequester`,
  `scip-query call-graph createWorkerRustAnalyzerSessionRequester`.
- The worker already owns the expensive reusable state: `sessionForPaths()`
  keeps initialized `RustAnalyzerLspClient` instances and opened-document sets
  in its process-local session map.
  **Source:** `scip-query code sessionForPaths`,
  `scip-query code shutdownSessions`.
- Rust providers are cached only inside a `ScipDatabase` object and provider
  cache clearing calls `dispose()`, which reaches requester shutdown. A new CLI
  process necessarily creates a new cache and provider.
  **Source:** `scip-query code getSemanticProvider`,
  `scip-query code SemanticSessionManager`,
  `scip-query trace createRustSemanticProvider`.
- Existing project fingerprinting hashes tracked/unignored source contents and
  common index inputs, including Rust files, `Cargo.toml`, and `Cargo.lock`.
  Existing Rust engine identity records the resolved rust-analyzer binary,
  version, and SCIP-occurrence reference mode.
  **Source:** `scip-query code fingerprintProjectFiles`,
  `scip-query code rustSemanticEngineIdentity`.
- The session resolver file has a medium aggregate change surface, but the
  requester implementation itself has no external consumers; the worker file
  has no external consumers. This favors extending the requester boundary
  without changing the semantic provider API.
  **Source:** `scip-query change-surface src/semantic/rust/lsp-session.ts --json --full`,
  `scip-query change-surface src/semantic/rust/lsp-session-worker.ts --json --full`.

## Reuse Audit

- Reuse `RustAnalyzerSessionRequester` rather than introduce a second semantic
  provider contract. It already represents exactly the synchronous boundary
  that must choose per-command or durable transport.
- Reuse `createWorkerRustAnalyzerSessionRequester()` inside the durable helper
  process. The helper needs to move the existing worker's ownership, not
  duplicate LSP initialization, document opening, retries, or result parsing.
- Reuse `fingerprintProjectFiles()` and `rustSemanticEngineIdentity()` for
  invalidation. A new live-session identity module is justified because no
  existing unit combines source/Cargo content, compiler identity, worker build
  identity, protocol version, and compiler-affecting environment. Per-request
  timeout, diagnostics, settle, concurrency, and retry settings are execution
  policy and must not invalidate compatible compiler state.
- Add one durable helper entry point because the repository contains no daemon,
  socket, or cross-command session owner (`scip-query files daemon`,
  `scip-query files socket`). A repository-scoped filesystem mailbox is chosen
  because the provider contract is synchronous and the existing worker bridge
  already uses file-backed responses plus synchronous waiting.

## Testability Design

| Behavior                | Test seam                             | Dependencies to inject                           | Pure core                      | Side-effect shell                      | Contract                                                                      |
| ----------------------- | ------------------------------------- | ------------------------------------------------ | ------------------------------ | -------------------------------------- | ----------------------------------------------------------------------------- |
| Stable session identity | `createDurableRustSessionIdentity()`  | file fingerprint and engine identity providers   | canonical identity object/hash | live file and binary inspection        | equal semantic inputs produce the same key; any relevant mismatch changes it  |
| Reuse and invalidation  | `DurableRustSessionHost.handle()`     | requester factory and environment applier        | identity transition decision   | worker creation/shutdown/request       | same key reuses; changed key shuts down before replacement                    |
| Cross-process request   | durable requester                     | clock/sleep, process liveness, spawn, filesystem | state/request naming           | detached helper and mailbox files      | bounded synchronous response or an error that activates the existing fallback |
| Crash/stale recovery    | server-state helpers                  | process liveness and clock                       | stale/live classification      | stale state cleanup and helper restart | dead or mismatched helper state is never trusted                              |
| Opt-in selection        | requester factory in `lsp-session.ts` | environment                                      | mode selection                 | worker/durable requester construction  | default remains per-command; explicit opt-in selects durable reuse            |

## Design Phases

### 1.1 - Specify identity, host transitions, and opt-in selection with failing tests

- [x] **Files**: `tests/semantic/rust/rust-durable-session.test.ts`,
      `tests/semantic/rust/rust-lsp-session.test.ts`
- **Source:** `scip-query refs RustAnalyzerSessionRequester`,
  `scip-query refs fingerprintProjectFiles`,
  `scip-query code rustSemanticEngineIdentity`.
- **What:** The requester seam is injectable, but no durable identity or host
  state machine exists and default construction always selects a worker thread.
- **Change:** Write tests for stable identity, every required invalidator,
  same-key reuse, mismatch shutdown/replacement, durable shutdown semantics,
  dead-state recovery decisions, and explicit opt-in selection.
- **Testability:** Use injected fingerprints, engine identity, requester
  factories, liveness checks, clocks, and filesystem roots. Do not start real
  rust-analyzer in unit tests.
- **Validation:** Run the new focused Vitest files and observe failures caused
  by missing production symbols/behavior.
- **Why:** This fixes the contract before process and filesystem side effects
  make incorrect reuse easy to hide.

### 1.2 - Implement the pure identity and durable host core

- [x] **File**: `src/semantic/rust/durable-session.ts`
- **Source:** `scip-query code fingerprintProjectFiles`,
  `scip-query code rustSemanticEngineIdentity`,
  `scip-query code createWorkerRustAnalyzerSessionRequester`.
- **What:** Existing primitives cover source/manifest content and engine
  identity, while the current worker requester already owns the correct LSP
  behavior.
- **Change:** Add a versioned identity containing canonical project root,
  Rust-relevant live file hashes, rust-analyzer identity, semantic-worker build
  hash, protocol version, and compiler-affecting environment. Add a host that
  owns at most one requester identity and shuts the old requester down before
  creating the replacement.
- **Testability:** Identity assembly and transition decisions are deterministic;
  file, engine, environment, and requester effects are injected.
- **Validation:** Focused tests turn green without starting a helper process.
- **Why:** Invalidation belongs next to the reusable state owner and must be
  proven independently of transport.

### 1.3 - Add a bounded filesystem mailbox and detached helper shell

- [x] **Files**: `src/semantic/rust/durable-session.ts`,
      `src/semantic/rust/durable-session-server.ts`, `tsup.config.ts`
- **Source:** `scip-query code createWorkerRustAnalyzerSessionRequester`,
  `scip-query code withDb`, `scip-query files daemon`,
  `scip-query files socket`.
- **What:** The public semantic API is synchronous, and the current bridge
  proves that synchronous file-backed responses work without changing query
  APIs. No cross-command owner exists.
- **Change:** Add repository/install-scoped state, atomic request/response
  files, a detached helper entry, bounded polling, idle shutdown, serialized
  request handling, stale/dead helper replacement, and cleanup. Share selected
  per-command profiling environment with the worker while treating
  answer-affecting environment as identity.
- **Testability:** Keep state classification and path derivation pure; inject
  filesystem/process/clock operations into the requester where practical.
  Exercise the helper shell with a fake requester host.
- **Validation:** Focused transport/recovery tests, build, and a smoke request
  through built artifacts.
- **Why:** The helper owns the existing worker across CLI exits while bounded
  waits preserve current fallback behavior.

### 1.4 - Select durable reuse only through an explicit opt-in

- [x] **Files**: `src/semantic/rust/lsp-session.ts`,
      `src/semantic/rust/provider.ts`
- **Source:** `scip-query code createRustSemanticProvider`,
  `scip-query code shouldUsePersistentRustSession`,
  `scip-query code createRustAnalyzerSessionResolver`.
- **What:** `SCIP_RUST_SEMANTIC_SESSION` currently selects the session resolver
  versus one-shot workers; it does not promise cross-command durability.
- **Change:** Preserve that meaning and add a separate explicit durable opt-in
  that selects the mailbox requester. Export/extend the existing worker
  requester only as needed by the helper. Durable provider disposal releases
  the client without terminating the repository helper.
- **Testability:** Inject requester factories and assert default, opt-in, and
  failure/fallback selection directly.
- **Validation:** Session and provider tests; typecheck.
- **Why:** A reversible opt-in permits direct A/B measurement and keeps the
  accepted per-command path intact.

### 1.5 - Benchmark evidence-cold/session-cold against evidence-cold/session-warm

- [x] **Files**:
      `docs/benchmarks/runs/2026-07-09-ts-rust-indexing-analysis.jsonl`,
      `docs/benchmarks/2026-07-09-ts-rust-indexing-analysis-ledger.md`
- **Source:** `scip-query plan-context src/semantic/rust/lsp-session.ts`; the
  campaign ledger's Current Checkpoint and Output Contract.
- **What:** Existing warm measurements primarily prove SQLite semantic evidence
  reuse; they do not isolate a live compiler session across separate commands.
- **Change:** Record paired runs that clear semantic evidence before both runs,
  kill the helper before the first, retain it before the second, and capture
  wall time, profile spans, output hash, reference facts, callee facts, and
  incomplete references. Run SynthRunnerRust first and the available large Rust
  stress corpus second when practical.
- **Testability:** The harness controls evidence and helper state separately.
- **Validation:** Hashes and fact counts match; the second run omits
  rust-analyzer initialization/open-document readiness and improves wall time,
  or the change is recorded and reverted/rejected.
- **Why:** Session reuse is accepted only if the real command improves without
  borrowing a win from the existing evidence cache.

### 1.6 - Verify graph health and campaign closure

- [x] **Files**: all touched production, test, build, plan, and benchmark files
- **Source:** `scip-query change-surface src/semantic/rust/lsp-session.ts --json --full`,
  repository `AGENTS.md` verification contract.
- **Change:** Run focused tests, full relevant Rust semantic tests, typecheck,
  build, new-helper duplicate/wrapper/unused-parameter checks, `scip-query
reindex`, and `scip-query diff-gate --json`. Fix or document every finding.
- **Validation:** All required commands pass and the ledger states the measured
  decision.
- **Why:** The helper changes process lifetime and packaging; unit behavior
  alone cannot prove the shipped artifact or graph contract.

## Stress-Test Findings

- **Failure:** Missing helper artifacts, permission failures, timeout, malformed
  responses, or a crashed helper must throw at the requester boundary so the
  existing one-shot fallback remains authoritative.
- **Concurrency:** Requests are serialized by the helper. Atomic request-file
  publication prevents partial reads; each response is uniquely named.
- **Data integrity:** No semantic fact is persisted by the helper. Durable
  evidence remains in the existing SQLite cache; the helper preserves only live
  compiler state.
- **Invalidation:** Reuse is allowed only for an exact identity match. Unknown,
  unreadable, missing, or changed inputs create a different identity and force
  replacement.
- **Observability:** Profile/session metadata must distinguish `created`,
  `reused`, and `invalidated`, and errors must name helper startup, liveness,
  timeout, or response parsing failures.
- **Human experience:** Default behavior is unchanged. The opt-in has no manual
  start step and cleans itself up after an idle period.
- **Reversibility:** Removing the opt-in returns all callers to the current
  worker requester. No schema or public API migration is required.

## Execution and Ship Order

1. Identity/host tests (red), then pure core (green).
2. Transport/recovery tests (red), then helper shell and build entry (green).
3. Selection/fallback tests (red), then opt-in wiring (green).
4. Build smoke test and representative benchmarks.
5. Documentation and full verification.

Every phase is reversible. The only process-lifetime change remains opt-in
until benchmark and accuracy gates accept it.

## File Summary

- Create: `src/semantic/rust/durable-session.ts`,
  `src/semantic/rust/durable-session-server.ts`,
  `tests/semantic/rust/rust-durable-session.test.ts`.
- Edit: `src/semantic/rust/lsp-session.ts`, `tsup.config.ts`, targeted session
  tests, the campaign ledger, and its JSONL run history.
- Delete: none planned.
- Verify: focused Rust semantic tests, typecheck, build, relevant SCIP
  postchecks, reindex, and diff gate.

## Outcome

Readiness protocol version 2 completed on 2026-07-09. Fresh sessions open the
requested documents during initial workspace loading, observe one quiescent
server status, and use an ordered private JSON-RPC request as the post-open
fence. Quiescent warning status is accepted; error status and unexpected
barrier failures still fail closed. Durable requests preserve explicit settle
and retry policy and add a bounded 30s incomplete-reference retry only when the
caller did not configure one.

The exact local pair and all five SynthRunnerRust and VegaAssistant controls
passed with identical output/reference/callee payloads, zero incomplete Rust
references, expected `created`/`reused`/`invalidated` dispositions, and no
worker fallback. Warm reuse improved scip-query by 42.2%, SynthRunnerRust by
91.3% forward and 89.8% in reverse, and VegaAssistant by 48.1% forward and
49.3% in reverse. The route remains opt-in pending a separate product-default
decision.
