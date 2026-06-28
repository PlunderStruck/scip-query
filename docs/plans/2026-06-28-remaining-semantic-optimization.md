# Remaining Semantic Optimization Plan

Date: 2026-06-28

## Goal

Make the remaining scip-query commands that depend on semantic reference evidence as fast as possible without changing their answers. Done means the slow candidates are benchmarked on Vega_2.0, their hot subprocesses are profiled, output-preserving optimizations are implemented, and the scoreboard records before and after timings.

## Current State

The shared reference path is `semanticCallerMap`, which accepts indexed definitions and returns caller files per definition. `scip-query plan-context semanticCallerMap --json` shows the implementation in `src/semantic/shared-primitives.ts:25-123`, with direct consumers in `src/queries/cleanup/dead.ts`, `src/queries/cleanup/isolated.ts`, `src/queries/cleanup/stale-abstractions.ts`, `src/queries/impact/change-surface.ts`, `src/queries/impact/diff-impact.ts`, and `src/symbols/references/reference-callers.ts`. This path now has a cache scan, a miss-compute phase, provider bulk lookup, and a cache write span.

`definitionConsumerFileMap` is the cleanup facade over `ProjectIndex.callerFileMap`. `scip-query plan-context definitionConsumerFileMap --json` shows it in `src/queries/internal/consumer-evidence.ts:40-49`, consumed by `stale-abstractions`, `wrapper-candidates`, and `locality-candidates`. It preserves the policy that caller evidence can combine SCIP callers, semantic callers, and source fallback callers.

`semanticImportUsage` is a separate import-use primitive. `scip-query plan-context semanticImportUsage --json` shows it in `src/semantic/shared-primitives.ts:13-17`, with callers in `src/queries/navigation/imports.ts:201`, `src/queries/navigation/imports.ts:215`, and `src/queries/cleanup/drift.ts:384`. `scip-query code src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:importUsage() -C 8` shows the provider currently loops import declarations in `src/semantic/typescript/ts-morph-provider.ts:156-167`, and `scip-query code valueImportUsageForEntry -C 8` shows each value import currently calls `entry.identifier.findReferences()` in `src/semantic/typescript/ts-morph-provider.ts:466-497`.

`callerRowsForSymbol` is the graph/navigation caller facade. `scip-query plan-context callerRowsForSymbol --json` shows it in `src/symbols/references/caller-evidence.ts:9-15`, with consumers in `dead`, `affected`, `bottlenecks`, `hotspots`, `call-graph`, and `dataflow`.

Non-obvious invariants to preserve:

- Semantic member references use precise TypeScript reference search for member symbols because inherited, overridden, and interface-related members can share a call surface without sharing a simple symbol identity. `scip-query code TsMorphSemanticProvider#referencesForDefinitions -C 8` shows `needsPreciseReferenceSearch` keeps these out of the inverted scan in `src/semantic/typescript/ts-morph-provider.ts:177-237`.
- Source fallback remains part of cleanup evidence because indexers can miss dynamic or string-shaped references. `scip-query code callerFileEvidenceMap -C 8` shows the merge of cross-file callers and `sourceFallbackCallerEvidenceMap` in `src/symbols/references/caller-evidence.ts:39-47`.
- The import path must distinguish type-only and value usage. `scip-query code valueImportUsageForEntry -C 8` shows both `isTypeOnlyLocation` and declaration-level type-only binding feed `isUsed`, `isTypeUsed`, and `isValueUsed` in `src/semantic/typescript/ts-morph-provider.ts:483-496`.

## Reuse Audit

- Reuse `semanticCallerMap` for cleanup, impact, and reference caller evidence. Source: `scip-query plan-context semanticCallerMap --json`. New per-command loops should not reimplement semantic reference lookup.
- Reuse `ProjectIndex.callerFileMap` / `callerFileEvidenceMap` for consumer-file evidence. Source: `scip-query code ProjectIndex#callerFileMap -C 6` and `scip-query code callerFileEvidenceMap -C 8`.
- Reuse `TsMorphSemanticProvider.referencesForDefinitionsBySymbolScan` for any future bulk reference scan that asks "which requested definitions are referenced by this source file?" Source: `scip-query code referencesForDefinitionsBySymbolScan -C 8`.
- For import usage, extend the existing provider implementation rather than creating a new semantic provider. Source: `scip-query code src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:importUsage() -C 8`.
- Before adding helpers, run `scip-query recent-duplicates --json --full`; if it reports a related duplicate, either reuse it or record why it does not fit.

## Design Phases

### 1.1 - Baseline cleanup reference consumers

- [x] **File**: `docs/benchmarks/2026-06-28-remaining-semantic-optimization-ledger.md`
- **Source**: `scip-query code staleAbstractions -C 6`, `scip-query code isolated -C 6`, `scip-query code wrapperCandidates -C 6`
- **What**: `stale-abstractions`, `isolated`, and `wrapper-candidates` all use caller/consumer evidence but with different candidate filters and fallback paths.
- **Change**: Benchmark each command on Vega_2.0 with semantic caches cleared before cold runs and with profile output enabled. Record runtime, output hash, result count, and top profile spans.
- **Why**: These are the direct cleanup processes most likely to inherit the `dead` command's semantic-reference wins.

### 1.2 - Keep shared caller evidence optimizations only when traces prove benefit

- [x] **File**: `src/semantic/shared-primitives.ts:25-123`
- **Source**: `scip-query plan-context semanticCallerMap --json`
- **What**: `semanticCallerMap` already performs cache scan, bulk miss compute, and cache writes.
- **Change**: If a cleanup command still spends significant time in shared reference lookup, add narrowly scoped batching, prefiltering, or profiling to the shared primitive; otherwise record "no code change" for that process.
- **Why**: Shared changes affect multiple commands, so they need measured benefit and unchanged output hashes.

### 2.1 - Baseline impact and graph caller evidence

- [x] **File**: `src/symbols/references/caller-evidence.ts:9-47`
- **Source**: `scip-query plan-context callerRowsForSymbol --json`
- **What**: `callerRowsForSymbol`, `crossFileCallerEvidenceMap`, and `callerFileEvidenceMap` feed `diff-impact`, `change-surface`, graph commands, and cleanup supplement paths.
- **Change**: Benchmark representative commands that can run without user-specific symbols: `diff-impact --json`, `change-surface <changed file> --json`, `bottlenecks --json`, and `hotspots --json`. Profile before changing code.
- **Why**: If these are already dominated by SQLite graph reads rather than semantic reference scans, optimization should stop at measurement.

### 2.2 - Add bulk caller-row access only if per-symbol graph loops dominate

- [x] **File**: `src/symbols/graph/call-graph-evidence.ts`
- **Source**: `scip-query plan-context callerRowsForSymbol --json`
- **What**: `callerRowsForSymbol` delegates to `getCallerRowsForSymbol`, and graph commands may call it repeatedly.
- **Change**: If profiles show repeated targeted caller queries dominate, add an internal bulk map that reuses existing `buildCallerRowsMap` behavior instead of calling per symbol.
- **Why**: This is the graph equivalent of the semantic bulk win: turn repeated lookups into one indexed pass.

### 3.1 - Baseline semantic import usage

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts:156-167` and `src/semantic/typescript/ts-morph-provider.ts:466-497`
- **Source**: `scip-query code src:semantic:typescript:ts-morph-provider:TsMorphSemanticProvider:importUsage() -C 8`, `scip-query code valueImportUsageForEntry -C 8`
- **What**: Import usage currently loops imports and calls TypeScript reference lookup per value import entry.
- **Change**: Benchmark `imports --json --full` and `drift --json --full` on Vega_2.0 with profiling. Record how much time is spent in import usage and reference lookup.
- **Why**: This path may benefit from per-file identifier scans, but only if it is actually hot.

### 3.2 - Replace per-import reference lookup with a per-file scan if safe

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts:156-167`
- **Source**: `scip-query plan-context semanticImportUsage --json`
- **What**: The provider already caches import usage by file.
- **Change**: If import usage is hot, compute local import bindings once per source file, scan identifiers in that source file once, compare compiler symbols to imported binding symbols, and preserve existing type-only/value-used classification.
- **Why**: A single per-file scan should be faster than repeated `findReferences()` calls while keeping shadowed identifiers out through symbol equality.

### 4.1 - Investigate precise member-reference fallback

- [x] **File**: `src/semantic/typescript/ts-morph-provider.ts:177-237`
- **Source**: `scip-query code TsMorphSemanticProvider#referencesForDefinitions -C 8`
- **What**: Member definitions are routed to precise reference search to avoid inherited/override/interface false positives.
- **Change**: Profile the member fallback on commands that still use it heavily. Only relax precision for a provably safe subset, such as members whose owning type has no inheritance/interface participation, and prove identical output hashes.
- **Why**: This is the remaining expensive part of cold semantic reference runs, but it is also the accuracy-sensitive part.

### 5.1 - Update benchmark history and scoreboard

- [x] **File**: `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- **Source**: `scip-query files docs/benchmarks`
- **What**: Existing benchmark docs track command timings over this optimization campaign.
- **Change**: Append current before/after timings, output hashes, profile summaries, and rejected trials.
- **Why**: The optimization skill requires durable measurement history, not memory.

### 5.2 - Verify and gate the final diff

- [x] **File**: `src/semantic/shared-primitives.ts:13-317`, `src/semantic/typescript/ts-morph-provider.ts:156-497`, `src/symbols/references/caller-evidence.ts:9-47`
- **Source**: `scip-query change-surface src/semantic/shared-primitives.ts`, `scip-query change-surface src/semantic/typescript/ts-morph-provider.ts`, `scip-query change-surface src/symbols/references/caller-evidence.ts`
- **What**: These are medium-to-high risk internal primitives with broad downstream consumers.
- **Change**: Run formatting, typecheck, focused tests, `scip-query reindex`, `scip-query diff-gate --json`, and `scip-query diff-impact --json`. Fix findings or document accepted support-only warnings.
- **Why**: Performance improvements only count if the tool still produces the same facts.

## Stress-Test Findings

- Understand before touch: The plan first benchmarks and profiles each command before code changes; no path is changed without a hot span.
- Blast radius: Shared semantic changes affect cleanup, impact, navigation, graph, self-audit, and semantic exports according to `scip-query plan-context semanticCallerMap --json`; verification includes targeted tests and diff-impact.
- Valid intermediate states: Each phase is independently deployable because measurement docs can land without behavior changes, and each implementation phase preserves existing public APIs.
- Reversibility: All proposed code changes are internal and reversible. Benchmark ledger changes are append-only evidence.
- Failure design: Cache writes already skip when the provider is unavailable; any new scan path must fall back to existing precise lookup when binding or source lookup fails.
- Concurrency: The CLI work is per-process and per-project DB scoped. Shared state is in per-provider memory caches and SQLite cache tables; no global cross-repo mutable state is introduced.
- Boundaries: Commands remain CLI entry points with existing option parsing; no new external input surface is planned.
- Data integrity: Semantic cache writes must remain additive/rebuildable; output hashes are used to catch data-shape drift.
- Observability: New optimizations must add profile spans around any new bulk pass so slow subprocesses remain visible.
- Human impact: Commands should get faster without new flags or user-facing behavior changes.
- Reuse: The plan extends `semanticCallerMap`, `callerFileEvidenceMap`, and the TypeScript provider rather than adding parallel reference systems.

## Execution Order

1. Baseline cleanup commands.
2. Implement only proven cleanup/shared semantic wins.
3. Baseline graph and impact commands.
4. Implement only proven graph caller wins.
5. Baseline semantic import commands.
6. Implement only proven import usage wins.
7. Investigate precise member fallback.
8. Update ledgers, scoreboard, and verification.

Phases 1, 3, and 5 are measurement-only and can ship independently. Phases 2, 4, and 6 are internal two-way-door changes. Phase 7 is accuracy-sensitive and must ship only with identical output hashes.

## Outcome

Completed in this pass:

- `stale-abstractions --json --full`: 34.863s cold baseline to 7.729s final
  cold and 0.966s warm, byte-identical output.
- `isolated --json --full`: 8.797s cold baseline to 6.327s final cold and
  1.158s warm, byte-identical output.
- `wrapper-candidates --json --full`: 18.857s cold baseline to 7.316s final
  cold and 1.228s warm, byte-identical output.
- `imports` / `unused-imports` sampled on two Vega files: 7.1s-7.8s baselines
  to 3.9s-4.2s final cold, byte-identical output.
- `drift --json --full`: 0.773s to 0.712s, byte-identical output.
- `diff-impact`, `change-surface`, `bottlenecks`, and `hotspots`: measured as
  already fast; no code changes were justified.

Accepted implementation changes are recorded in
`docs/benchmarks/2026-06-28-remaining-semantic-optimization-ledger.md`.

## Ship Order

Ship measurement and profiling first, then shared primitives with focused tests, then import/graph changes if they prove useful. Do not ship a member-reference precision relaxation unless it exactly preserves the Vega outputs and local focused tests.

## Summary

Planned files to modify or create:

- `docs/plans/2026-06-28-remaining-semantic-optimization.md`
- `docs/benchmarks/2026-06-28-remaining-semantic-optimization-ledger.md`
- `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`
- Potentially `src/semantic/shared-primitives.ts`
- Potentially `src/semantic/typescript/ts-morph-provider.ts`
- Potentially `src/symbols/graph/call-graph-evidence.ts`
- Potentially `src/symbols/references/caller-evidence.ts`
