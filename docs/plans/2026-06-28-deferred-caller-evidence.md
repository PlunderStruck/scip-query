# Deferred Caller Evidence Ledger

Date: 2026-06-28

## Gate A - Goal

Trace the remaining Vega_2.0 wrapper/stale health phases and test whether
caller evidence can be made faster without changing wrapper, stale, health, or
diff-gate findings. An accepted change must preserve output hashes and improve
the paired public-command medians.

## Gate B - Current Flow

- `wrapperCandidates()` in `src/queries/cleanup/wrapper-candidates.ts:46-67`
  builds a `ProjectIndex`, computes reverse file fan-in, then calls
  `runCandidateAnalysis()`. Its prepare phase calls
  `consumerMapForWrapperCandidates()`, and evaluation calls
  `wrapperCandidateForSymbol()`. Source:
  `scip-query plan-context wrapperCandidates`.
- `consumerMapForWrapperCandidates()` in
  `src/queries/cleanup/wrapper-candidates.ts:69-99` first calls
  `definitionConsumerFileMap()` with `sourceFallback: false`, then limits
  source fallback to symbols whose current external caller count is at most one.
  Source: `scip-query code consumerMapForWrapperCandidates -C 24 --json`.
- `staleAbstractions()` in
  `src/queries/cleanup/stale-abstractions.ts:98-168` builds type candidates,
  then calls `consumerMapForPossiblyStaleTypeCandidates()` during prepare.
  Source: `scip-query plan-context staleAbstractions`.
- `consumerMapForPossiblyStaleTypeCandidates()` in
  `src/queries/cleanup/stale-abstractions.ts:213-237` first calls
  `consumerMapForTypeCandidates()` with `semantic: false` and
  `sourceFallback: false`, then narrows semantic and source fallback to
  candidates whose real consumer count is at most one. Source:
  `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 30 --json`.
- `definitionConsumerFileMap()` in
  `src/queries/internal/consumer-evidence.ts:41-50` delegates to
  `ProjectIndex.callerFileMap()`. Source:
  `scip-query plan-context definitionConsumerFileMap`.
- `ProjectIndex.callerFileMap()` in `src/core/project-index.ts:54-63`
  delegates to `callerFileEvidenceMap()`, while
  `ProjectIndex.sourceFallbackCallerFiles()` in
  `src/core/project-index.ts:48-52` delegates to
  `sourceFallbackCallerEvidenceMap()`. Source:
  `scip-query code sourceFallbackCallerFiles -C 24 --json`.
- `callerFileEvidenceMap()` in `src/symbols/references/caller-evidence.ts:39-48`
  composes `crossFileCallerEvidenceMap()` with optional
  `sourceFallbackCallerEvidenceMap()`. Source:
  `scip-query code callerFileEvidenceMap -C 24 --json`.
- `buildCrossFileCallerMap()` in
  `src/symbols/references/reference-callers.ts:28-50` unconditionally runs
  AST callsite callers, SCIP chunk mention callers, Rust attribute callers, and
  optional semantic callers for every target definition set. Source:
  `scip-query plan-context buildCrossFileCallerMap`.
- `addAstCallsiteCallers()` in
  `src/symbols/references/reference-callers.ts:55-80` walks every indexed
  document with an AST language, calls `getCallSites()`, then filters callsites
  to `targetSymbolIds`. Source:
  `scip-query code addAstCallsiteCallers -C 30 --json`.
- `getCallSites()` in `src/source/ast/ast-facts.ts:31-37` reads
  `getSourceFacts()`, which may load persisted source facts or parse a
  tree-sitter AST. Source: `scip-query code getCallSites -C 28 --json`;
  `scip-query plan-context getSourceFacts`.

## Gate C - Reuse Audit

- Reuse `buildCrossFileCallerMap()` and its existing caller-evidence stages;
  do not create a parallel caller map implementation. Source:
  `scip-query plan-context buildCrossFileCallerMap`.
- Reuse `definitionConsumerFileMap()` as the detector-facing policy boundary,
  extending its options only if needed. Source:
  `scip-query plan-context definitionConsumerFileMap`.
- Reuse `mergeSetMaps()` from
  `src/symbols/references/caller-evidence.ts:50-64` for merging staged caller
  maps. Source: `scip-query code callerFileEvidenceMap -C 24 --json`.

## Measurements

- Vega_2.0 focused current local CLI medians:
  - `health --json`: 2.893s, SHA-256
    `edfcf02c33ce82792cc728e748b1bda2a28a6b504bfe0df79985eae3eabfaa5d`.
  - `diff-gate --json`: 2.890s, exit 1, SHA-256
    `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6`.
  - `wrapper-candidates --json --full`: 2.177s, SHA-256
    `311a92542c8370fc284d3f01e1d1cd8d6a6432c71dcc1cef639fea31496ccf58`.
  - `stale-abstractions --json --full`: 2.135s, SHA-256
    `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2`.
  - `__health-phase wrapper-candidates`: 2.126s, SHA-256
    `9c61a0f9565f11c9a1b04477549cacd330585a2b2ad0e9fc92dafafe26ea965b`.
  - `__health-phase stale-abstractions`: 2.120s, SHA-256
    `8827e8f0a99315a51d38b6604e096deab5b452421fcd6f984c835cdd879cf322`.
- Vega wrapper candidate count: 3,310 symbols, 2,901 unique leaves.
  Source: TS microbench using `ProjectIndex.productionCallableDefinitions()`.
- Vega approximate stale type candidate count: 2,568 symbols, 2,421 unique
  leaves. Source: TS microbench using `ProjectIndex.scopedDefinitions()` and
  `definitionLoc()` filters from `staleTypeCandidates()`.
- Fresh-process Vega `getCallSites()` across 1,779 indexed docs took 163.5ms.
  A stale-leaf text prefilter matched 1,318 docs and skipped 461 docs; wrapper
  leaves matched 1,767 docs and skipped only 12. Source: TS microbench using
  `getSourceFiles()`, `getSourceText()`, `sourceMayContainCandidateName()`, and
  `getCallSites()`.
- Vega chunk-mention SQL with the current 750 parameter batch takes about
  28.6ms for wrapper IDs and 13.2ms for stale-like IDs; one larger batch at
  8,000 parameters takes about 17.0ms and 12.6ms respectively. Source: TS
  microbench of the same `mentionReferenceChunkRows()` SQL.

## Execution Result

The broad caller-evidence staging experiment was rejected. It preserved hashes,
but the public commands were flat to slower on Vega_2.0:

| Command                                        | Before | Staged experiment | Output |
| ---------------------------------------------- | -----: | ----------------: | ------ |
| `wrapper-candidates --json --full`             | 2.177s |            2.193s | same   |
| `stale-abstractions --json --full`             | 2.135s |            2.130s | same   |
| `__health-phase wrapper-candidates`            | 2.126s |            2.107s | same   |
| `__health-phase stale-abstractions`            | 2.120s |            2.090s | same   |
| `health --json`                                | 2.893s |            2.930s | same   |
| `diff-gate --json`                             | 2.890s |            2.999s | same   |

The SQLite mention batch-size experiment was also rejected after a paired
baseline/current run against commit `d2e6f52`. Every output hash matched, but
the aggregate commands did not improve:

| Command                                        | Baseline | Batch 8,000 | Delta |
| ---------------------------------------------- | -------: | ----------: | ----: |
| `wrapper-candidates --json --full`             |   2.139s |      2.162s | +22ms |
| `stale-abstractions --json --full`             |   2.125s |      2.116s | -10ms |
| `__health-phase wrapper-candidates`            |   2.103s |      2.107s |  +4ms |
| `__health-phase stale-abstractions`            |   2.109s |      2.120s | +11ms |
| `health --json`                                |   2.916s |      2.937s | +21ms |
| `diff-gate --json`                             |   3.027s |      3.045s | +18ms |

The source code stays at the prior 750-parameter batch size. The useful outcome
is the trace: the next meaningful win is unlikely to come from caller-map
staging or larger mention batches, and should instead target the repeated
source-facts/source-fallback and health orchestration cost directly.

## Design Phases

### 1.1 - Add staged caller evidence options

- [x] **Files**:
      `src/symbols/references/reference-callers.ts:28-50`,
      `src/symbols/references/caller-evidence.ts:20-48`,
      `src/core/project-index.ts:36-63`,
      `src/queries/internal/consumer-evidence.ts:41-50`.
- **Source**:
  `scip-query plan-context buildCrossFileCallerMap`;
  `scip-query code callerFileEvidenceMap -C 24 --json`;
  `scip-query code sourceFallbackCallerFiles -C 24 --json`;
  `scip-query plan-context definitionConsumerFileMap`.
- **Current**: `sourceFallback: false` prevents inverse source attribution, but
  `buildCrossFileCallerMap()` still always pays AST callsite and Rust attribute
  source-facts work.
- **Change**: Add an internal option such as `sourceCallsites?: boolean` that
  defaults to true. When false, `buildCrossFileCallerMap()` skips
  `addAstCallsiteCallers()` and `addRustAttrCallers()` while preserving chunk
  mention and semantic evidence.
- **Why**: Chunk mention plus semantic evidence is cheaper and monotonic for
  wrapper/stale pruning: later source evidence can add caller files, not remove
  them.
- **Result**: Rejected after benchmark. The option preserved output but did not
  improve the paired public-command medians, so the source change was reverted.

### 1.2 - Defer source-callsite evidence in wrapper candidates

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts:69-99`
- **Source**: `scip-query code consumerMapForWrapperCandidates -C 24 --json`.
- **Current**: The first consumer map includes AST/Rust source-callsite evidence
  for all 3,310 Vega wrapper candidates before pruning to the candidates that
  still need source fallback.
- **Change**: Build the first map with `sourceCallsites: false`. Keep candidates
  with at most one external caller file, then merge in a full caller map plus
  source fallback for that narrowed set.
- **Why**: If chunk/semantic evidence already shows more than one real external
  caller, adding AST/Rust/source fallback cannot make the symbol a wrapper
  finding.
- **Result**: Rejected with the staged caller evidence option. The standalone
  command was slightly slower despite matching output.

### 1.3 - Defer source-callsite evidence in stale abstractions

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:213-237`
- **Source**:
  `scip-query code consumerMapForPossiblyStaleTypeCandidates -C 30 --json`.
- **Current**: The first stale map includes AST/Rust source-callsite evidence
  before the stale pipeline identifies the low-consumer candidates that need
  semantic/source fallback.
- **Change**: Build the first map with `sourceCallsites: false`; after semantic
  candidates are chosen, merge a full caller map for those candidates before the
  existing source-fallback narrowing.
- **Why**: A type candidate with more than one real consumer in cheap evidence
  cannot become stale after adding more source-callsite caller files.
- **Result**: Rejected with the staged caller evidence option. The standalone
  command was flat, but full health and diff-gate did not improve.

### 1.4 - Raise SQLite mention batch size if benchmarks confirm it

- [x] **File**: `src/storage/scip-mentions.ts:3`
- **Source**: `scip-query code SQLITE_PARAM_BATCH_SIZE -C 18 --json`;
  `scip-query code mentionReferenceChunkRows -C 28 --json`.
- **Current**: `SQLITE_PARAM_BATCH_SIZE` is 750, so Vega wrapper IDs use five
  `IN (...)` chunk-mention queries.
- **Change**: Raise the internal batch size to 8,000 if tests and focused
  benchmark hashes stay stable.
- **Why**: The local SQLite compile option reports `MAX_VARIABLE_NUMBER=32766`;
  8,000 keeps substantial headroom while reducing query count for large
  candidate sets.
- **Result**: Rejected. The focused SQL microbench improved, but the paired CLI
  medians were neutral to slower, so the batch size remains 750.

### 1.5 - Verify output contracts and gates

- [ ] **Commands**:
  - `npm test`
  - `npm run typecheck`
  - `npm run build`
  - Vega paired probes for `wrapper-candidates --json --full`,
    `stale-abstractions --json --full`, `__health-phase wrapper-candidates`,
    `__health-phase stale-abstractions`, `health --json`, and
    `diff-gate --json`
  - `node dist/cli.js reindex`
  - `node dist/cli.js diff-impact --json`
  - `node dist/cli.js recent-duplicates --json --full`
  - `node dist/cli.js unused-params --json --full`
  - `node dist/cli.js wrapper-candidates --json --full`
  - `node dist/cli.js stale-abstractions --json --full`
  - `node dist/cli.js self-audit --json`
  - `node dist/cli.js diff-gate --json`
- **Source**:
  `scip-query change-surface src/symbols/references/reference-callers.ts --json --full`;
  `scip-query change-surface src/queries/cleanup/wrapper-candidates.ts --json --full`;
  `scip-query change-surface src/queries/cleanup/stale-abstractions.ts --json --full`.
- **Why**: Caller evidence feeds multiple cleanup detectors and health/diff-gate
  summaries, so unchanged hashes and broad gates are mandatory.

## Stress-Test Findings

- **Understand before touching**: Caller evidence is a file-set proof that a
  definition is used from another file. Wrapper/stale detectors use low caller
  counts as a cleanup signal, so missing callers creates false positives.
- **Blast radius**: `buildCrossFileCallerMap()` reaches
  `ProjectIndex.callerFileMap()`, then cleanup detectors and health. Source:
  `scip-query plan-context buildCrossFileCallerMap`.
- **Intermediate validity**: New options default to current behavior; existing
  callers remain unchanged unless wrapper/stale explicitly opt into staged
  evidence.
- **Reversibility**: Removing the option and reverting wrapper/stale map calls
  restores eager source-callsite evidence.
- **Failure design**: If staged maps miss a cheap caller, the full map is still
  merged for low-consumer candidates before reporting. High-consumer candidates
  are only skipped because the criterion is already impossible to satisfy.
- **Concurrency**: The change adds no shared mutable state; it changes per-run
  query composition only.
- **Boundary**: Public CLI output is the boundary. No option is exposed to CLI
  users.
- **Data integrity**: The SCIP index and evidence cache are read-only for this
  change.
- **Observability**: Benchmark ledger and scoreboard will record before/after
  medians and hashes.
- **Human impact**: Users should see the same findings faster.
- **Reuse**: Reuses existing caller-evidence map builders and merge utilities.

## Execution Order

1. Add the internal `sourceCallsites` caller-evidence option with default
   current behavior.
2. Defer wrapper source-callsite evidence and merge full evidence for narrowed
   candidates.
3. Defer stale source-callsite evidence and merge full evidence for narrowed
   candidates.
4. Raise the SQLite mention batch size only if the combined benchmark remains
   stable.
5. Format, test, benchmark, update docs, run scip gates, then commit and push
   without a version bump if accepted.
