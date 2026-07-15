# Navigation Command Latency Implementation Plan — 2026-07-15

## Goal

Reduce the elapsed time of `code`, `outline`, and `refs` while preserving their
complete stdout, JSON, symbol-selection, source-range, outline, and semantic
reference results.

Interactive latency is the wall-clock duration from starting a command process
until its full result is available to the caller. It is a response-time measure
whose essential characteristic is that every synchronous startup, validation,
query, and rendering step delays the user's next action.

The accepted baseline and machine-readable run history are recorded in
[`docs/benchmarks/2026-07-15-navigation-latency-baseline.md`](../benchmarks/2026-07-15-navigation-latency-baseline.md).

## Current State

- `prepareWorktreeIndex` calls `getIndexFreshness`, which computes a full
  project-input fingerprint, and then calls
  `publishFreshLocalGenerationForProject` when the local index is fresh.
  Source: `scip-query code prepareWorktreeIndex` and
  `scip-query code getIndexFreshness`.
- `publishFreshLocalGenerationForProject` computes another full fingerprint
  before `buildSharedGenerationSnapshot` rejects a dirty worktree. Source:
  `scip-query code publishFreshLocalGenerationForProject`.
- The CLI pre-action calls `maybeSweepRepositoryCache` before ensuring the
  watch service, while the watch server also owns a periodic repository-cache
  sweep. Source: `scip-query plan-context src/runtime/cli.ts` and
  `scip-query code maybeSweepRepositoryCache`.
- `code` and `refs` call `findFirstSymbolMatch`, which calls `resolveSymbol`,
  and their presentation helpers call `resolveSymbol` again for the same
  database and query string. Source: `scip-query code resolveSymbol`,
  `scip-query plan-context src/runtime/query-commands/navigation.ts`, and
  `scip-query plan-context src/runtime/query-commands/symbol-resolution.ts`.
- `createPerDbCache` already supplies get-or-compute storage whose lifetime is
  one `ScipDatabase` object and whose no-group mode remains valid for a
  read-only index connection. Source: `scip-query code createPerDbCache` and
  `src/storage/cache-registry.ts:19-27`.

## Reuse Audit

- Reuse `createPerDbCache` for symbol resolutions. A per-database cache is a
  process-local lookup table associated with one open index connection; its
  defining property is that database object identity bounds the validity of
  every cached value. No new general cache abstraction is needed.
- Extend `publishFreshLocalGenerationForProject`'s existing dirty-worktree
  branch by moving it before language detection and fingerprinting. A dirty
  worktree is a checkout whose files do not equal its committed tree; because
  such a checkout cannot name a shareable committed snapshot, publication-only
  hashing cannot change the decision.
- Reuse `maybeSweepRepositoryCache` as the fallback rather than adding another
  lifecycle function. A repository-cache sweep is garbage collection for
  shared generations, leases, locks, and temporary artifacts; its essential
  purpose is bounded disk usage, so moving ownership to the already-running
  watch process preserves its contract.
- `scip-query recent-duplicates` and `scip-query wrapper-candidates` will check
  that no equivalent helper or unnecessary forwarding layer is introduced.

## Design Phases

### 1.1 — Reject dirty publication before fingerprinting

- [x] **File**: `src/reindex/shared-generation-store.ts:413-478`
- **Source**: `scip-query code publishFreshLocalGenerationForProject`;
  `scip-query change-surface src/reindex/shared-generation-store.ts --json`.
- **Change**: After resolving `GitWorktreeContext`, immediately write the same
  managed missed lease and return the same missed action when `context.clean`
  is false. Keep `buildSharedGenerationSnapshot`'s defensive check after the
  fingerprint for clean contexts.
- **Why**: Cleanliness is already known from Git and causally prevents a shared
  generation from existing. Reading and hashing every project file cannot
  alter that fact.
- **Test seam**: Add a focused shared-generation-store test using a fresh local
  index and a dirty Git checkout. Assert the unchanged action and lease state;
  benchmark the source path to verify the removed fingerprint pass.

### 1.2 — Give the watch service ownership of routine sweeping

- [x] **File**: `src/runtime/cli.ts:21-55`
- **Source**: `scip-query plan-context src/runtime/cli.ts`;
  `scip-query code ensureWatchServiceForCommand`;
  `scip-query code maybeSweepRepositoryCache`.
- **Change**: Ensure the watch service before sweeping. Skip the foreground
  sweep when the service starts or is reused; retain the current throttled
  sweep when the service is skipped or fails.
- **Why**: A live watch server performs the same periodic collection. Running
  it again in every interactive process reconstructs Git context without
  strengthening cache validity or disk bounds.
- **Test seam**: Extract only the decision predicate if needed for a focused
  unit test. Cover `started`, `reused`, `skipped`, and `failed` results.

### 1.3 — Resolve each symbol once per database and pattern

- [x] **File**: `src/symbols/symbol-lookup.ts:38-62`
- **Source**: `scip-query code resolveSymbol`; `scip-query refs resolveSymbol`;
  `scip-query code createPerDbCache`.
- **Change**: Add a no-clear-group `createPerDbCache<string,
  SymbolResolution>`. Make `resolveSymbol` use the exact input pattern as its
  key and move its existing resolution pipeline into the cache computation.
- **Why**: The SQLite index and ignore configuration do not mutate during one
  `ScipDatabase` lifetime. Query execution and output rendering can therefore
  share the same resolution without changing candidate ordering or choice.
- **Test seam**: Extend symbol-resolution tests to prove repeated identical
  lookups return the cached result while distinct patterns remain independent.
  Existing command-accuracy tests remain the observable output oracle.

## Testability Design

| Boundary | Input | Observable result | Failure proved |
| --- | --- | --- | --- |
| Dirty publication | dirty Git context with fresh local index | same `missed` action and managed lease reason | publication hashes or publishes a non-committed snapshot |
| Sweep ownership | every watch auto-ensure result variant | sweep only for `skipped` and `failed` | cleanup disappears when no watcher owns it, or runs twice when one does |
| Symbol resolution cache | database identity plus query string | same resolution object and unchanged candidates | repeated lookup recomputes, or cache keys alias different queries/databases |
| Navigation output | representative `code`, `outline`, and `refs` commands | byte-identical stdout and equal structured hashes | performance change alters user-visible evidence |

## Stress Test Findings

- Accuracy: The dirty fast return uses Git's already-resolved cleanliness only
  for shared-generation publication; index freshness continues to use the full
  fingerprint. Symbol resolution retains every exact, file-line,
  path-qualified, and fuzzy branch.
- Blast radius: `publishFreshLocalGenerationForProject` has one production
  caller, `resolveSymbol` has four direct production consumers, and `cli.ts`
  has no exported lifecycle helper. Source: their respective `scip-query refs`
  and `scip-query change-surface --json` results.
- Reversibility: Each phase is an isolated branch relocation, call-order
  change, or bounded cache insertion and can be reverted independently.
- Concurrency: The cache uses a `WeakMap` keyed by database object through the
  existing abstraction. No mutable value is shared between processes.
- Human impact: Outputs must remain identical. Only time spent waiting and
  redundant file/Git work may change.

## Verification

- [x] Focused Vitest suites for shared generation, watch lifecycle, symbol
  resolution, and navigation command accuracy.
- [x] `npm run typecheck`
- [x] `npm run build`
- [x] Before/after benchmark samples for clean, stable-dirty, and warmed-service
  scenarios, with stdout hashes recorded in the optimization ledger.
- [x] `scip-query unused-params`
- [x] `scip-query recent-duplicates`
- [x] `scip-query wrapper-candidates`
- [x] `scip-query reindex && scip-query diff-gate`
