# Rust Semantic References Plan

Date: 2026-07-08

## Goal

Add the first real Rust semantic accuracy slice: Rust definitions should be able to ask rust-analyzer for semantic references through the Language Server Protocol.

A Rust semantic reference is a compiler-informed location where a Rust definition is used. Its real-world referents are code spans such as calls to a function, reads of a field, or uses of a type; it is a kind of code relationship whose distinguishing feature is that rust-analyzer resolves it through Rust's name-resolution model instead of matching text.

A Language Server Protocol client is the local process code that talks to a language server over JSON-RPC. Its real-world referent here is the scip-query code that starts `rust-analyzer`, sends `textDocument/references`, and converts returned locations into `SemanticReference` records; it is a process adapter whose distinguishing feature is that it preserves a long-lived semantic session instead of running one-off shell commands.

Done means:

- `createRustSemanticProvider()` returns references for Rust definitions instead of always returning empty arrays.
- Rust reference support is exposed through the existing `SemanticProvider.referencesForDefinitions` path used by `semanticReferenceMap()`.
- Rust status and readiness remain honest: dependency detection can be cheap, while real semantic availability is tied to a rust-analyzer backend that can answer reference requests.
- Persistent caching is not enabled for Rust references until the cache key includes Rust-specific semantic state.

This plan assumes the current provider wedge already exists in the working tree:

- `src/semantic/rust/provider.ts`
- `src/semantic/rust/status.ts`
- `tests/semantic/rust/rust-semantic-provider.test.ts`
- the provider-cache/readiness/config wiring for Rust semantic status

## Evidence

- `scip-query status --capabilities`
  - The current SCIP index is fresh and contains TypeScript symbols only. Rust semantic support is therefore runtime support layered on indexed Rust SCIP data, not a change to the current repository's own source language.
- `scip-query plan-context src/semantic/rust`
  - `createRustSemanticProvider()` is currently a shell provider at `src/semantic/rust/provider.ts:10`; `referencesFor()` and `referencesForDefinitions()` return empty results.
  - `getRustSemanticStatus()` is currently dependency-driven at `src/semantic/rust/status.ts:11`; it checks `rust-analyzer` through the indexer dependency machinery and still reports semantic queries as not implemented.
- `scip-query code semanticReferenceMap`
  - `semanticReferenceMap()` already groups definitions by `availableSemanticProvider()` and prefers the provider's bulk `referencesForDefinitions()` method. This is the correct reuse point for Rust references.
- `scip-query code buildSemanticCallerMap`
  - The caller-map cache path only persists TypeScript-like definitions. Rust definitions currently flow through the unkeyed semantic path, which is correct until a Rust-specific cache identity exists.
- `scip-query code projectEvidenceFingerprint`
  - The current project evidence fingerprint includes index metadata and indexed languages, but not rust-analyzer version, Cargo feature flags, Cargo metadata, `Cargo.lock`, `rust-toolchain`, or Rust semantic configuration. That is not enough to safely cache Rust references.
- `scip-query code 'src/reindex/indexers.ts:87-99'`
  - Rust indexing already uses `rust-analyzer`, checks `rust-analyzer --version`, and treats `Cargo.toml` as the project marker. Semantic Rust support should reuse this dependency identity instead of inventing a parallel binary lookup.
- `scip-query refs SemanticProvider`
  - The provider contract is consumed by shared semantic primitives, provider cache wiring, TypeScript provider code, and the new Rust provider.
- Repository search for JSON-RPC/LSP terms found no existing generic LSP client in `src/`. A new narrow LSP adapter is justified.
- Official LSP 3.17 specification:
  - Base protocol messages use JSON-RPC with `Content-Length` framing.
  - `textDocument/references` takes `ReferenceParams` and returns `Location[] | null`.
  - LSP sessions use `initialize`, `initialized`, `shutdown`, and `exit`.
  - Source: [Language Server Protocol 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- Official rust-analyzer configuration docs:
  - rust-analyzer accepts LSP configuration through initialization options.
  - Cargo/build-script/feature settings affect the semantic world rust-analyzer analyzes.
  - `references.excludeImports` and `references.excludeTests` exist and should be explicit if scip-query changes them.
  - Source: [rust-analyzer configuration](https://rust-analyzer.github.io/book/configuration.html)

## Reuse Decisions

Reuse `SemanticProvider.referencesForDefinitions`. The existing provider contract is the wider class of runtime semantic engines; its essential job is to supply compiler-resolved facts behind a stable scip-query shape. Rust should fit that contract instead of adding a Rust-only query path.

Reuse the indexer dependency machinery. The existing Rust indexer config is the source of truth for the `rust-analyzer` binary and install guidance. Rust semantic support should depend on that same configuration so users do not see two different concepts of whether Rust support is installed.

Use a narrow LSP adapter. No generic LSP adapter exists in this codebase, and `rust-analyzer` reference queries require a persistent JSON-RPC process. The adapter should be contained under `src/semantic/rust/` and expose only what the Rust provider needs.

Do not persist Rust reference results in the first slice. A cache identity is the set of facts that make a cached answer still represent the current world. For Rust references, that world includes Cargo configuration, rust-analyzer version, feature flags, and lock/toolchain files. The current semantic cache key does not include those facts.

## Implementation Slices

### 1. Add Pure LSP Mapping

Files:

- `src/semantic/rust/lsp-types.ts`
- `src/semantic/rust/reference-mapping.ts`
- `tests/semantic/rust/rust-reference-mapping.test.ts`

Implement small local types for the LSP shapes scip-query needs:

- document URI
- position
- range
- location
- reference params
- initialize result capability subset

Add pure helpers:

- `definitionToReferenceParams(definition, includeDeclaration)`
- `filePathToDocumentUri(projectRoot, relativePath)`
- `documentUriToRelativePath(projectRoot, uri)`
- `locationsToSemanticReferences(projectRoot, locations)`
- `dedupeSemanticReferences(references)`

Source anchors:

- `src/semantic/types.ts` for `IndexedDefinition` and `SemanticReference`
- `scip-query code semanticReferenceMap` for the expected provider return shape
- LSP spec `textDocument/references` for request/result shape

Tests:

- URI conversion preserves spaces and platform separators.
- LSP zero-based positions are passed through without off-by-one adjustment.
- Returned `Location[]` values become `SemanticReference[]` with repository-relative paths.
- Duplicate references collapse deterministically.

Risk to watch:

- SCIP and LSP both commonly use zero-based line/character positions, but this must be locked by test fixture evidence instead of assumed from memory.

### 2. Add Rust Analyzer LSP Client

Files:

- `src/semantic/rust/lsp-client.ts`
- `tests/semantic/rust/rust-lsp-client.test.ts`

Implement a small side-effect shell that can:

- start `rust-analyzer`
- send `initialize`
- send `initialized`
- send `textDocument/references`
- tolerate server notifications
- apply request timeouts
- shut down with `shutdown` and `exit`

Prefer adding a direct dependency on `vscode-jsonrpc` if the current package setup supports it cleanly. If module-format friction makes that larger than the feature, keep the protocol adapter internal but cover header framing and notification handling with unit tests.

Source anchors:

- LSP spec base protocol and lifecycle sections
- `scip-query code 'src/reindex/indexers.ts:87-99'` for the rust-analyzer binary source
- `scip-query code execFileBuffered` only as process-style evidence; this feature needs a long-lived process rather than a buffered one-shot command

Tests:

- Fake transport responds to `initialize` and reference requests.
- Client handles unrelated notifications while waiting for a response.
- Timeout rejects one request without poisoning later shutdown.
- Shutdown is idempotent.

Risk to watch:

- rust-analyzer may perform Cargo work during initialization. The client must have bounded initialization and request timeouts so semantic queries do not hang full-mode analysis.

### 3. Replace Rust Provider Shell With Real References

Files:

- `src/semantic/rust/provider.ts`
- `src/semantic/rust/status.ts`
- `src/semantic/provider-cache.ts`
- `tests/semantic/rust/rust-semantic-provider.test.ts`

Change `createRustSemanticProvider(projectRoot)` to accept an optional client factory for tests and to lazily create one rust-analyzer session per provider instance.

Provider behavior:

- `referencesForDefinitions(definitions)` sends `textDocument/references` for each Rust definition.
- `referencesFor(definition)` delegates through the bulk path for consistency.
- `availability()` remains truthful:
  - binary missing: unavailable
  - dependency present but client not initialized yet: registered/dependency-ready, reference support not yet proven
  - initialized server with `referencesProvider`: available for references
  - initialized server without reference capability: unavailable with explicit reason
- `importUsage`, `calleesFor`, `calleesForDefinitions`, and `signatureFor` stay empty/null in this slice.

Source anchors:

- `scip-query code createRustSemanticProvider`
- `scip-query code referencesForDefinitions`
- `scip-query code semanticReferenceMap`
- `scip-query plan-context src/semantic/rust`

Tests:

- bulk references return one map entry per requested definition.
- failed rust-analyzer request returns an empty reference list for that definition and records unavailable status without throwing through callers.
- provider reuses one client instance across a bulk call.
- provider shutdown/cleanup path does not leave a live child process when the provider is discarded or explicit cleanup is called.

Risk to watch:

- The provider cache currently owns provider instances. If the Rust provider owns a process, there must be a clear disposal strategy before long-running watch or server modes use it heavily.

### 4. Keep Persistent Cache Disabled For Rust

Files:

- `src/semantic/shared-primitives.ts`
- `tests/semantic/shared-primitives.test.ts` or the nearest existing caller-map cache test

Keep the current TypeScript-only persistent cache gate in `buildSemanticCallerMap()`.

Add a regression test that a Rust definition can flow through `semanticReferenceMap()`/provider references, but is not written to `writeCachedSemanticReferencesBatch()` until a Rust-specific fingerprint exists.

Source anchors:

- `scip-query code buildSemanticCallerMap`
- `scip-query code readCachedSemanticReferences`
- `scip-query code writeCachedSemanticReferencesBatch`
- `scip-query code projectEvidenceFingerprint`

Risk to watch:

- This is a deliberate accuracy choice. It costs repeated rust-analyzer requests across process runs, but it prevents stale semantic answers while the Rust cache key is incomplete.

### 5. Add Rust Semantic Cache Identity Later

Files:

- `src/storage/evidence-cache.ts`
- `src/semantic/rust/cache-fingerprint.ts`
- `tests/semantic/rust/rust-cache-fingerprint.test.ts`
- `tests/storage/evidence-cache.test.ts`

This is the next performance slice after real references work.

A Rust semantic cache identity should include:

- base `projectEvidenceFingerprint`
- resolved `rust-analyzer --version`
- scip-query Rust semantic config
- relevant rust-analyzer initialization options
- `Cargo.toml` hashes for workspace members
- `Cargo.lock` hash when present
- `rust-toolchain` / `rust-toolchain.toml` hashes when present
- selected Cargo feature/target settings

Enable persistent Rust reference caching only after this identity exists and is part of the cache key.

Source anchors:

- rust-analyzer docs for Cargo/features/build-script settings
- `scip-query plan-context src/storage/evidence-cache.ts`
- `scip-query code projectEvidenceFingerprint`

Risk to watch:

- A fast wrong cache is worse than no cache. The fingerprint must represent the semantic inputs that can change Rust name resolution.

## Validation

Run after slice 1:

```bash
npm run typecheck
npm test -- tests/semantic/rust/rust-reference-mapping.test.ts
```

Run after slice 2:

```bash
npm run typecheck
npm test -- tests/semantic/rust/rust-lsp-client.test.ts
```

Run after slice 3:

```bash
npm run typecheck
npm test -- tests/semantic/rust/rust-semantic-provider.test.ts tests/runtime/project-readiness.test.ts
```

Run after cache-gating or cache-identity edits:

```bash
scip-query recent-duplicates
scip-query wrapper-candidates
scip-query co-change src/storage/evidence-cache.ts
npm test -- tests/storage/evidence-cache.test.ts
```

Before declaring the implementation done:

```bash
npm test
scip-query reindex
scip-query diff-gate
```

## Open Questions To Resolve During Implementation

- Whether `vscode-jsonrpc` can be added as a direct dependency without awkward module-format issues.
- Whether provider disposal needs a general `SemanticProvider.dispose()` contract now, or whether Rust can keep disposal internal for command-lifetime use.
- Whether rust-analyzer initialization should use scip-query config defaults such as excluding imports/tests from reference results, or whether the provider should request complete results and filter inside scip-query.
- Whether the first real integration smoke test should create a temporary Cargo fixture and run real rust-analyzer when available, or stay entirely fake in CI and rely on manual smoke for machine-local validation.

## Smallest Useful First Commit

The smallest shippable commit is slices 1 through 4:

1. pure mapping helpers
2. bounded rust-analyzer reference client
3. Rust provider bulk references
4. explicit no-persistent-cache test for Rust

That commit gives users real Rust semantic references without pretending the heavy-mode performance story is complete. The next commit should be the Rust semantic cache identity, because that is where full-mode performance starts to become realistic.
