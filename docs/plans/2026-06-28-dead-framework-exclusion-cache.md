# Dead Framework Exclusion Cache Plan

Date: 2026-06-28

## Gate A - Goal

Make `scip-query dead --json --full` faster on large repositories without
changing dead-code findings. Done means Vega_2.0 keeps the same
`dead --json --full` output hash while framework-owned definition exclusions
stop reparsing the same source files across CLI processes.

## Gate B - Current Flow

- `dead()` in `src/queries/cleanup/dead.ts:87-151` loads candidate
  definitions, seeds mention counts, supplements source references, supplements
  caller-map/semantic references, and builds the dead summary. Source:
  `scip-query plan-context dead`; `scip-query code dead -C 16 --json`.
- `deadCandidateDefinitions()` in `src/queries/cleanup/dead.ts:156-172`
  creates one `buildFileExclusionPredicate()` closure, then runs
  `deadCandidateDecision()` over `getScopedDefinitions()`. Source:
  `scip-query code deadCandidateDefinitions -C 16 --json`.
- `buildFileExclusionPredicate()` in
  `src/queries/cleanup/dead-exclusions.ts:12-47` lazily calls
  `getDefinitionExclusions(db, relativePath)` once per file, then checks
  excluded ranges and containers for each definition. Source:
  `scip-query code buildFileExclusionPredicate -C 20 --json`.
- `getDefinitionExclusions()` in `src/analysis/framework-patterns.ts:37-44`
  dispatches JS/TS files to `getJsTestExclusions()` and Rust files to
  `getRustExclusions()`. Source:
  `scip-query plan-context getDefinitionExclusions`;
  `scip-query code getDefinitionExclusions -C 24 --json`.
- `getJsTestExclusions()` in `src/analysis/framework-patterns.ts:69-160`
  reads source, applies `mayContainJsExclusion()`, parses an AST with
  `getAst()`, walks top-level test calls, React custom hooks, and suppression
  comments, then stores results only in `EXCLUSION_CACHE`, a `WeakMap<Tree,
ExclusionEntry[]>`. Source:
  `scip-query code getJsTestExclusions -C 24 --json`.
- `getRustExclusions()` in `src/analysis/framework-patterns.ts:230-270`
  parses an AST with `getAst()`, checks generated Rust files, framework/test
  attributes, suppression comments, and serde module exclusions, then also
  stores results only in `EXCLUSION_CACHE`. Source:
  `scip-query code getRustExclusions -C 24 --json`.
- `readCachedFileEvidence()` and `writeCachedFileEvidence()` in
  `src/storage/evidence-cache.ts:223-257` already provide content-hash-keyed
  file evidence storage with stable `evidence-v1` reads plus compatible legacy
  reads. Source: `scip-query plan-context readCachedFileEvidence`;
  `scip-query code readCachedFileEvidence -C 24 --json`;
  `scip-query code writeCachedFileEvidence -C 24 --json`.

## Gate C - Reuse Audit

- Reuse `fileContentHash()` from `src/storage/evidence-cache.ts:95-97` as the
  canonical per-file content hash. Source:
  `scip-query code fileContentHash -C 16 --json`.
- Reuse `readCachedFileEvidence()` and `writeCachedFileEvidence()` instead of a
  new table or ad hoc JSON file. Source:
  `scip-query similar readCachedFileEvidence --json --full`.
- Reuse the existing `ExclusionEntry` shape. The payload is already plain JSON:
  `{ startLine, endLine, reason, containerName? }`. Source:
  `scip-query code getJsTestExclusions -C 24 --json`;
  `scip-query code getRustExclusions -C 24 --json`.

## Measurements

- Vega_2.0 current warm `dead --json --full`: 2.751s in the latest full matrix,
  3,803,655 stdout bytes, SHA-256
  `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`.
- Vega_2.0 current `__health-phase dead --full`: 2.116s in the focused phase
  probe, SHA-256
  `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`.
- CPU profile for Vega `dead --json --full` shows persistent tree-sitter parse
  self-time and hot JS framework-exclusion regexes, matching the
  `getJsTestExclusions()` / `getRustExclusions()` path above.

## Design Phases

### 1.1 - Add a file-evidence kind for framework exclusions

- [x] **File**: `src/storage/evidence-cache.ts:27-33`
- **Source**: `scip-query code 'src/storage/evidence-cache.ts:17-48' --json`
- **Current**: `FileEvidenceKind` includes source facts, source imports,
  consumer usage, docs, and React profiles, but not framework exclusions.
- **Change**: Add `'definition-exclusions'` to `FileEvidenceKind`.
- **Why**: Framework exclusion results are a pure function of one file's text
  and should use the existing content-hash-keyed file evidence cache.

### 1.2 - Cache `getDefinitionExclusions()` by content hash

- [x] **File**: `src/analysis/framework-patterns.ts:37-44`
- **Source**: `scip-query code getDefinitionExclusions -C 24 --json`
- **Current**: `getDefinitionExclusions()` dispatches directly to JS/Rust
  analyzers every process; the only cache is `EXCLUSION_CACHE`, keyed by
  in-process parsed `Tree`.
- **Change**: Read source text and compute `fileContentHash()` before dispatch.
  Try the existing file-evidence read path for the `definition-exclusions`
  kind, parse it as `ExclusionEntry[]`, and return it on success. Otherwise
  compute with existing JS/Rust analyzers and write the JSON payload.
- **Why**: The exact same exclusion rows are needed by `dead` and health phase
  child processes, and the content hash proves cache validity.

### 1.3 - Preserve current analyzer semantics and fallback behavior

- [x] **File**: `src/analysis/framework-patterns.ts:69-270`
- **Source**:
  `scip-query code getJsTestExclusions -C 24 --json`;
  `scip-query code getRustExclusions -C 24 --json`
- **Current**: JS/TS and Rust analyzers own their language-specific AST logic.
- **Change**: Leave `getJsTestExclusions()` and `getRustExclusions()` output
  logic unchanged. If cache payload parsing fails, ignore the payload and
  recompute.
- **Why**: Corrupt or old cache rows must never suppress findings or change
  analyzer accuracy.

### 1.4 - Verify output contracts and gates

- [x] **Commands**:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`
  - Vega paired hash probes for `dead --json --full`,
    `__health-phase dead --full`, and `health --json`
  - `scip-query reindex && scip-query diff-gate --json`
- **Source**:
  `scip-query change-surface src/analysis/framework-patterns.ts --json --full`;
  `scip-query change-surface src/storage/evidence-cache.ts --json --full`
- **Why**: `framework-patterns.ts` feeds dead candidate filtering, and
  `evidence-cache.ts` is shared storage infrastructure.

## Stress-Test Findings

- **Understand before touching**: Framework exclusions are not dead-code
  findings; they are false-positive guards for framework-owned definitions.
- **Blast radius**: `getDefinitionExclusions()` has one direct consumer,
  `buildFileExclusionPredicate()`, and reaches `dead()` through
  `deadCandidateDefinitions()`. Source:
  `scip-query plan-context getDefinitionExclusions`.
- **Intermediate validity**: Adding a new `FileEvidenceKind` is backward
  compatible because missing rows recompute and write.
- **Reversibility**: Removing the cache wrapper restores direct analyzer calls.
- **Failure design**: Bad JSON payloads fall back to recomputation.
- **Concurrency**: Existing evidence-cache connection handles concurrent CLI
  processes with WAL and a busy timeout. Source:
  `scip-query code connectionFor -C 24 --json`.
- **Data integrity**: Cache rows are rebuildable; they do not alter the SCIP
  index.
- **Observability**: Benchmark ledger and scoreboard will record before/after
  timings and hashes.
- **Reuse**: Uses existing evidence-cache storage and content hashing.

## Execution Order

1. Add the `definition-exclusions` file evidence kind.
2. Wrap `getDefinitionExclusions()` with cache read/write and JSON validation.
3. Format, test, build, and run Vega hash/timing probes.
4. Update the dead/health benchmark ledger and scoreboard.
5. Run scip gates, commit, and push without a version bump if accepted.

## Execution Notes

- Implemented `definition-exclusions` as a content-hash-keyed file evidence
  kind in `src/storage/evidence-cache.ts`.
- Wrapped `getDefinitionExclusions()` with a persistent cache read/write path
  and JSON validation. Invalid cache payloads are ignored and recomputed.
- Preserved the existing JS/TS and Rust analyzer logic; the cache stores only
  the analyzer output.
- Paired Vega_2.0 probes against the previous commit preserved output hashes:
  - `dead --json --full`: 2.742s baseline median to 1.968s current median,
    3,803,655 stdout bytes, SHA-256
    `28a0c54730e98c9e7758278020eb72f4a4b8fb82c114c3bce05c293ead24b1b1`.
  - `__health-phase dead --full`: 2.053s baseline median to 1.265s current
    median, 189 stdout bytes, SHA-256
    `648c7b6d6251e1d8761b0000e7663ae5f9971554db6cd0acd771dc9bb36db4ab`.
  - `health --json`: 2.931s baseline median to 2.961s current median,
    15,342 stdout bytes, SHA-256
    `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`.
- The composite health command is neutral because the dead phase is no longer
  the sole critical path; wrapper/stale/source-fallback phases now dominate the
  remaining wall time.
