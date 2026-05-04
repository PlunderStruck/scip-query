# Concrete plan — Identifier-attribution module

Step 4 of the architecture-deepening plan. Unifies four reimplementations of "given a textual identifier hit in file F, which SCIP symbol(s) does it refer to?" into one deep module: `src/identifier-attribution.ts`.

## Source map

Verified via `scip-query symbols src/query-support.ts` (run after `scip-query reindex`):

| Function | Location | Role |
|---|---|---|
| `getSourceReferenceSites` | `src/query-support.ts:556-577` | Inverse view — for one symbol, return all `(file, line)` references |
| `sourceCandidateLines` | `src/query-support.ts:579-599` | Forward unique-leaf fast path |
| `importAttributedCandidateLines` | `src/query-support.ts:610-651` | Forward import-disambiguated path |
| `getResolvedReferenceSites` | `src/query-support.ts:671-678` | SCIP-mention-based reference inverse (different code path; NOT being unified) |
| `buildSourceFallbackCallerFiles` | `src/query-support.ts:1734-1829` | Bulk inverse — for many symbols, return per-symbol caller files |
| `hasUniqueLeafDefinition` | `src/query-support.ts:1831-1854` | Boolean gate used before the fast path |
| `getGlobalLeafIndex` | `src/query-support.ts:1593-1633` | Already-cached leaf → candidate-symbols map (consumed by both forward paths) |
| `dead.ts:resolveLeaf` (closure) | `src/queries/dead.ts:103-149` (approx) | Per-file-line attribution used by the AST scan loop |
| `dead.ts:leafToSymbolGlobal` | `src/queries/dead.ts:76-100` (approx) | Local rebuild of the leaf index that `getGlobalLeafIndex` already provides |

Source: `scip-query code 'src/query-support.ts:556-651'`, `scip-query code 'src/query-support.ts:1734-1854'`, `scip-query code 'src/queries/dead.ts:76-150'`.

The four forward implementations (`sourceCandidateLines`, `importAttributedCandidateLines`, `buildSourceFallbackCallerFiles`'s inner loop, `dead.ts:resolveLeaf`) all encode the same disambiguation policy:

1. Same-file: if the consumer file is the candidate's defining file, that candidate wins.
2. Direct import: if the consumer imports the leaf by name from a path that resolves to a candidate's defining file, return all candidates from that file (handles interface + impls in the same file).
3. Indirect dispatch (factory pattern): if the consumer imports anything from a file where ALL the leaf's candidates live, return all (handles `processor.method()` after `getProcessor()`).
4. Otherwise: empty.

The four implementations have drifted slightly. `dead.ts:resolveLeaf` returns multiple candidates (added in the interface-dispatch fix); the others return at most one. Unifying ensures every consumer benefits from each refinement.

## Conventions to match

Verified via `scip-query symbols src/per-db-cache.ts` and existing top-level modules:

- Top-level module placement (`src/identifier-attribution.ts`) — same convention as `symbol-parser.ts`, `source-fileset.ts`, `file-classifier.ts`.
- Per-DB caching via `createPerDbCache` / `createPerDbValue` from `src/per-db-cache.ts`.
- File set via `getSourceFiles(db)` from `src/source-fileset.ts` (no manual SCIP+disk union).
- Source-text reads via `getSourceText(db, path)` from `src/source-text.ts`.
- Identifier line lookup via `findIdentifierLines(db, path, identifier)` and `getFileIdentifiers(db, path)` from `src/source-analysis.ts`.
- Imports per file via `getSourceImports(db, path)` from `src/source-analysis.ts`.
- Path comparison via `pathsResolveSame` (currently inline in `query-support.ts:608` — extract or inline).

## Interface (locked from grilling)

```ts
// src/identifier-attribution.ts

export interface SymbolRef {
  symbolId: number;
  symbol: string;
  relativePath: string;  // where the symbol is defined
}

/**
 * Forward: "what symbol(s) does identifier `name` in file F refer to?"
 * Returns the symbols this textual hit reasonably resolves to. May
 * return >1 entry for interface-dispatch patterns. Returns [] when
 * the leaf is ambiguous and no disambiguation signal applies.
 */
export function attributeIdentifier(
  db: ScipDatabase,
  file: string,
  identifier: string,
): SymbolRef[];

/** Inverse: "where is symbol S referenced (via source-text scan)?" */
export function findReferences(
  db: ScipDatabase,
  symbol: SymbolLocation,
): ReferenceSite[];

/** Bulk inverse: "for each symbol in `candidates`, which files reference it?" */
export function findCallerFiles(
  db: ScipDatabase,
  candidates: ReadonlyArray<IndexedDefinition>,
): Map<number, Set<string>>;
```

## Phase 1 — Build the module

### 1.1 — Create `src/identifier-attribution.ts`

- [ ] **File**: `src/identifier-attribution.ts` (new)
- **Source**: derived from existing implementations above.
- **What**: New module with the three exports listed in the interface block. Internal helpers:
  - `disambiguate(db, refFile, identifier, bucket)` — returns `SymbolRef[]` after applying the four-tier policy
  - `pathsResolveSame(a, b)` — moved from `query-support.ts:608`
  - `LEAF_INDEX_CACHE` — same shape as `query-support.ts:GLOBAL_LEAF_INDEX_CACHE`; uses `createPerDbValue`
- **Why**: One owner of the leaf-resolution policy. Future changes touch one site.

### 1.2 — Implement `attributeIdentifier(db, file, identifier)`

- [ ] **Source**: synthesized from `dead.ts:resolveLeaf` (most general — already returns plural) and `importAttributedCandidateLines:632-660`.
- **What**: Reads the leaf index, applies the four-tier disambiguation, returns `SymbolRef[]`.
- **Why**: The forward call. Every consumer either calls this directly (dead's per-file loop) or uses one of the inverse wrappers.

### 1.3 — Implement `findReferences(db, symbol)`

- [ ] **Source**: combines `getSourceReferenceSites:556-577` (the inverse-view shape) with `sourceCandidateLines` + `importAttributedCandidateLines` (the underlying scans).
- **What**: For each file in `getSourceFiles(db)`, call `attributeIdentifier(db, file, leaf)`. If any returned ref equals the target symbol, run `findIdentifierLines(db, file, leaf)` and build a `ReferenceSite[]`.
- **Why**: One implementation behind the existing `getSourceReferenceSites` API. Replaces the dual unique-leaf-fast-path / ambiguous-leaf-slow-path branches.

### 1.4 — Implement `findCallerFiles(db, candidates)`

- [ ] **Source**: replaces `buildSourceFallbackCallerFiles:1734-1829`.
- **What**: For each file in `getSourceFiles(db)`, get its identifier set via `getFileIdentifiers(db, file)`; for each identifier in the file that's also a candidate-leaf, call `attributeIdentifier(db, file, identifier)` to pick the right candidate(s); credit those candidates' symbolIds with `file`.
- **Why**: Bulk inverse. Same disambiguation as the forward call — no separate ambiguous-leaf branch.

## Phase 2 — Migrate consumers

### 2.1 — Replace `getSourceReferenceSites` body

- [ ] **File**: `src/query-support.ts:556-577`
- **Source**: `scip-query refs getSourceReferenceSites`.
- **Change**: Re-export from `identifier-attribution.ts` (renamed to `findReferences`) — keep the old export name as an alias to avoid touching every caller this commit. Or update callers in the same commit. Either way, the body becomes a one-line forwarder.
- **Verify**: every existing caller of `getSourceReferenceSites` (`refs.ts`, `dataflow.ts`, `trace.ts`) still produces the same output on the test fixtures.

### 2.2 — Delete `sourceCandidateLines`, `importAttributedCandidateLines`, `hasUniqueLeafDefinition`

- [ ] **File**: `src/query-support.ts:579-599`, `:610-651`, `:1831-1854`
- **Change**: After 2.1 lands and compiles, remove these three functions. They had no other callers.

### 2.3 — Replace `buildSourceFallbackCallerFiles`

- [ ] **File**: `src/query-support.ts:1734-1829`
- **Change**: Re-export from `identifier-attribution.ts` as `findCallerFiles` with a deprecated alias for the old name. Verify `dead.ts` still imports it.

### 2.4 — Simplify `dead.ts:resolveLeaf` + drop `leafToSymbolGlobal`

- [ ] **File**: `src/queries/dead.ts:76-150`
- **Source**: `scip-query code 'src/queries/dead.ts:76-225'`
- **Change**: Replace the local `leafToSymbolGlobal` index + `resolveLeaf` closure with calls to `attributeIdentifier(db, doc.relative_path, name)`. The `for (const target of targets)` loop body stays the same since `attributeIdentifier` returns the same `SymbolRef[]` shape.
- **Verify**: `scip-query dead` on `Stable_Management` produces the same row count + classification as before this commit.

### 2.5 — Delete the leaf index `getGlobalLeafIndex`

- [ ] **File**: `src/query-support.ts:1593-1633`
- **Change**: After 2.4 lands, this is unused. Delete; the new module has its own cache.

## Phase 3 — Tests

### 3.1 — Unit tests for `attributeIdentifier`

- [ ] **File**: `tests/identifier-attribution.test.ts` (new)
- Cases pinning each tier of the four-tier policy:
  - Unique leaf → returns single
  - Same-file def wins over imports
  - Direct import attributes to the imported file's candidates only
  - All-candidates-in-imported-file (interface dispatch) attributes to all
  - Truly ambiguous (candidates in multiple files, no import signal) → returns []

### 3.2 — Verify CLI surface unchanged

- [ ] Run `npm test` — all 119 tests pass.
- [ ] Run `scip-query refs` / `dead` on `Stable_Management` and `VegaAssistant`. Output must match pre-refactor (golden snapshot byte-equal).

## 11-Principles stress test

### 1. Understand before you touch ✓
Each existing implementation was read end-to-end (`scip-query code` cited above). The four-tier policy was derived from the union of their behaviors.

### 2. Map the blast radius ✓
- `getSourceReferenceSites` consumers: `refs.ts`, `dataflow.ts`, `trace.ts` (per `scip-query refs getSourceReferenceSites`)
- `buildSourceFallbackCallerFiles` consumers: `dead.ts`, `isolated.ts`, `wrapper-candidates.ts` (per `scip-query refs buildSourceFallbackCallerFiles`)
- `hasUniqueLeafDefinition` consumers: only `getSourceReferenceSites` itself.

### 3. Every intermediate state must be valid ✓
Phase 1 (build module) → Phase 2 (migrate one site at a time, each compiling + tests passing) → Phase 3 (delete dead helpers). Each commit ships independently.

### 4. Reversibility ✓
Pure code-level refactor. No persisted-data changes. Two-way doors throughout.

### 5. Design for failure ✓
No new async paths. The pure forward call has the same failure modes as today's reads (DB query failure, file-read failure — all caught upstream).

### 6. Concurrency ✓
No new shared state beyond the leaf-index cache, which is already managed by `createPerDbValue` (same pattern as 17 other caches).

### 7. Defend the boundaries ✓
No new entry points; CLI surface unchanged.

### 8. Data integrity ✓
No persisted data modified.

### 9. Observable ✓
Same logging behavior (none — these are pure compute paths). The `name` argument to `createPerDbValue` lets future cache observability surface this module's cache by name.

### 10. Consider the human ✓
CLI output for every command must remain byte-identical for the same input. Golden-snapshot diff verifies.

### 11. Match the existing system ✓
- Top-level module — matches `symbol-parser.ts`, `source-fileset.ts`, `file-classifier.ts`.
- Per-DB cache via `createPerDbCache` / `createPerDbValue` — matches all 17 other caches.
- File set via `getSourceFiles(db)` — matches the new convention from step 2.
- Output types reuse `SymbolRef`-style shape close to existing `SymbolMatch` / `IndexedDefinition`.

## Ship order

1. Land Phase 1 (build module + add unit tests). Existing query-support helpers untouched.
2. Land Phase 2.1-2.3 in one commit (replace `getSourceReferenceSites` and `buildSourceFallbackCallerFiles` bodies; delete the three orphan helpers).
3. Land Phase 2.4-2.5 in one commit (dead.ts uses `attributeIdentifier` directly; delete the local index + `getGlobalLeafIndex`).
4. Phase 3 verification runs after each Phase 2 commit.

## Files modified / created / deleted

### Created
- `src/identifier-attribution.ts` (~150 LOC)
- `tests/identifier-attribution.test.ts`

### Modified
- `src/query-support.ts` (delete 6 helpers; ~250 LOC removed)
- `src/queries/dead.ts` (replace `leafToSymbolGlobal` + `resolveLeaf` with calls; ~80 LOC removed)
- `src/queries/refs.ts`, `src/queries/dataflow.ts`, `src/queries/trace.ts` (only if we rename — otherwise no change since `getSourceReferenceSites` keeps its name as a re-export)

### Deleted
None permanently — query-support.ts shrinks but stays.
