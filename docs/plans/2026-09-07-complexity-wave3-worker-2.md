# Complexity wave 3 worker 2 — 2026-09-07

Base: `6fa43612`.

## Targets

- complexity:src/runtime/query-service-fastpath.ts:parseFastPathInvocation — parseFastPathInvocation: cyclomatic 22, cognitive 21.
- complexity:src/runtime/query-service-fastpath.ts:queryNavigationFastPath — queryNavigationFastPath: cyclomatic 20, cognitive 3.
- complexity:src/semantic/rust/durable-session-protocol.ts:decodeDurableRustMailboxRequest — decodeDurableRustMailboxRequest: cyclomatic 20, cognitive 16.
- complexity:src/semantic/rust/durable-session-protocol.ts:isIndexedDefinition — isIndexedDefinition: cyclomatic 20, cognitive 5.
- complexity:src/semantic/rust/durable-session.ts:readDurableRustSessionServerState — readDurableRustSessionServerState: cyclomatic 20, cognitive 15.
- complexity:src/semantic/rust/lsp-batch-worker.ts:runRustAnalyzerReferenceBatch — runRustAnalyzerReferenceBatch: cyclomatic 20, cognitive 17.
- complexity:src/semantic/rust/lsp-client.ts:RustAnalyzerLspClient.handleData — RustAnalyzerLspClient.handleData: cyclomatic 15, cognitive 30.
- complexity:src/semantic/types.ts:decodeSemanticAvailability — decodeSemanticAvailability: cyclomatic 20, cognitive 15.
- complexity:src/runtime/evidence-command-freshness.ts:ensureEvidenceCommandFreshness — ensureEvidenceCommandFreshness: cyclomatic 19, cognitive 23.
- complexity:src/runtime/query-service-fastpath.ts:parseCodeInvocation — parseCodeInvocation: cyclomatic 19, cognitive 26.
- complexity:src/semantic/shared-primitives.ts:materializeSemanticReferenceBatch.<callback:profileSpan:1> — materializeSemanticReferenceBatch.<callback:profileSpan:1>: cyclomatic 13, cognitive 28.
- complexity:src/storage/bounded-mailbox.ts:claimBoundedMailboxRequestsUnlocked — claimBoundedMailboxRequestsUnlocked: cyclomatic 17, cognitive 28.

## Plan

Complete target implementations were read during authorized read-only preparation. Refactor parser dispatch/options, protocol validation, durable-state parsing, batch capability/execution responsibilities, LSP framing, availability validation, freshness preparation, semantic cache scanning and mailbox claim publication. Preserve runtime fallback, validated field scope, deadlines, resource lifetime, output differences, all counters and durability hooks. Run focused source tests, installed ESLint/Prettier, scoped health/review, and inspect every added helper for <=10 cyclomatic / <=15 cognitive. Root owns combined build/types/API/full suite/impact. Own only manifest files, unique regression test if needed, and this checkpoint. No builds, reindexes, commits, dependency/policy/suppression changes or VM/benchmark actions.

## Results

All 12 assigned targets completed. Scoped source reviews against `6fa43612` report accounted coverage; every target and added helper is <=10 cyclomatic and <=15 cognitive. Added helper maxima are 10/12.

| Target                                                  | Cyclomatic | Cognitive |
| ------------------------------------------------------- | ---------: | --------: |
| `decodeDurableRustMailboxRequest`                       |          4 |         3 |
| `isIndexedDefinition`                                   |          4 |         1 |
| `readDurableRustSessionServerState`                     |          8 |         7 |
| `runRustAnalyzerReferenceBatch`                         |          6 |         3 |
| `RustAnalyzerLspClient.handleData`                      |          7 |         8 |
| `decodeSemanticAvailability`                            |          9 |         8 |
| `ensureEvidenceCommandFreshness`                        |          9 |        10 |
| `claimBoundedMailboxRequestsUnlocked`                   |          7 |        10 |
| `parseCodeInvocation`                                   |          6 |         8 |
| `parseFastPathInvocation`                               |          2 |         0 |
| `queryNavigationFastPath`                               |          4 |         3 |
| `materializeSemanticReferenceBatch cache-scan callback` |          2 |         1 |

Parser grouping preserves known dispatch, unknown-command fallback, option order and selector bounds. Protocol and state helpers preserve validation precedence, optional-field acceptance and response identity. Batch helpers retain capability rejection precedence, category output differences, shared request options and shutdown cleanup. LSP framing preserves byte bounds, buffer reset and protocol failure effects. Freshness preserves bypass, watcher, stale-queryable and synchronous-reindex order. Cache helpers preserve lookup precedence and immediately updated counters; claim publication preserves rename, lease, durability hooks and batch ordering.

Validation: 216 distinct focused tests across 11 files passed, covering fastpath, query service, freshness, Rust protocol/session/batch/LSP, availability, Rust cache gating, bounded mailbox and TypeScript semantic provider. The latter covers cold assembly counters, warm fragment reuse and leaf-edit invalidation. Final fastpath 11 tests reran after validator extraction. Source `tsc --noEmit`, all nine changed-file ESLint and Prettier checks passed. Review caught and corrected an accidental `assembled.cacheScan.cacheHits` property replacement before final tests/types. No test or check process remains running.

The existing enclosing `materializeSemanticReferenceBatch` remains 16/20 before and after; only its assigned cache-scan callback was targeted, now 2/1. No finding is suppressed. Parent owns combined build, full suite, API and final health/diff-impact checks. No dependencies, policy, threshold or suppression files changed.
