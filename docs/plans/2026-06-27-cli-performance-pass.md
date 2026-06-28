# CLI Performance Pass — 2026-06-27

## Goal

Make scip-query performance measurable and materially faster on large repositories. Done means a user can run one command to see cold/warm indexing and command runtimes, cheap aggregate commands avoid unnecessary JavaScript-wide scans, and the health command no longer serializes independent detector subprocesses.

## Current State

- `kind-counts` currently calls `kindCounts()` in `src/queries/navigation/by-kind.ts:165-184`, which loops over `loadKindRows()` and resolves each definition in JavaScript. Source: `scip-query code kindCounts -C 12`.
- `loadKindRows()` in `src/queries/navigation/by-kind.ts:196-198` delegates to `getAllDefinitions()`, which uses document iteration and per-file definition loading. Source: `scip-query code loadKindRows -C 12`; `scip-query code getAllDefinitions -C 12`.
- `health` currently calls `runIsolatedHealthReport()` from `handleHealth()` in `src/runtime/commands/command-handlers.ts:180-201`. Source: `scip-query code handleHealth -C 12`.
- `runIsolatedHealthReport()` in `src/runtime/cli-support.ts:87-90` maps `HEALTH_PHASES` through `runHealthPhaseProcess()` sequentially. Source: `scip-query code runIsolatedHealthReport -C 12`.
- Each health phase is independent and read-only from the CLI perspective: `HEALTH_PHASE_RUNNERS` maps phase names to separate functions in `src/queries/health/health.ts:105-117`, and each subprocess opens the readonly SQLite DB through the normal CLI path. Source: `scip-query code HEALTH_PHASE_RUNNERS -C 12`; `scip-query code ScipDatabase -C 12`.
- Command registration lives in `src/runtime/commands/command-descriptors.ts:27-35`, and custom command handlers live in `src/runtime/commands/command-handlers.ts`. Source: `scip-query code commandDescriptors -C 8`; `scip-query plan-context src/runtime/commands/command-handlers.ts`.
- `dead()` in `src/queries/cleanup/dead.ts:82-142` loads candidate definitions, seeds SCIP mention counts, runs AST/source supplementation, then calls `supplementReferencesFromCallerMap()` before summarizing zero-cross-file-reference rows. Source: `scip-query plan-context dead`.
- `supplementReferencesFromCallerMap()` in `src/queries/cleanup/dead.ts:463-487` currently loops over every candidate and calls `callerRowsForSymbol()` one symbol at a time. Source: `scip-query code supplementReferencesFromCallerMap -C 18`.
- `deadRows()` in `src/queries/cleanup/dead.ts:171-175` only keeps rows where `cross_file_refs === 0`. Source: `scip-query code deadRows -C 10`.
- `hasAnyReference()` in `src/queries/internal/reference-counts.ts:53-60` centralizes positive-reference checks for the nested `ReferenceCounts` map. Source: `scip-query code hasAnyReference -C 12`.

Measured baseline:

- scip-query repo cold reindex: 2.8s; warm unchanged reindex: 0.23s; indexed 236 files / 11,568 symbols.
- Vega_2.0 cold reindex: 41.6s; warm unchanged reindex: 0.53s; indexed 1,779 files / 103,981 symbols.
- Vega_2.0 command hotspots from the ad hoc run: `kind-counts` 13.2s, `diff-gate --json` 24.2s, `dead --json --full` 145s.
- scip-query repo `dead --json --full` baseline after Phase 3: 2.878s.

## Reuse Audit

- Reuse `runIsolatedJsonProcess()` and `chunked()` patterns from `src/runtime/isolated-analysis-runner.ts:14-37` for subprocess orchestration concepts, but add a parallel health runner because that helper is synchronous by design. Source: `scip-query code runIsolatedJsonProcess -C 12`.
- Reuse `withDb()`, `printJsonEnvelope()`, command descriptor builders, and existing custom handler conventions instead of inventing a second CLI framework. Sources: `scip-query code withDb -C 12`; `scip-query code printJsonEnvelope -C 8`; `scip-query code commandDescriptors -C 8`.
- Reuse the existing `kind` column in the SQLite schema rather than deriving every kind from symbol strings for the common path. Source: `scip-query code ScipDatabase -C 12`.
- Reuse the existing `ReferenceCounts` helper module for cross-file pruning instead of reaching into the nested evidence map from `dead.ts`. Source: `scip-query code hasAnyReference -C 12`; `scip-query similar hasAnyReference --json`.
- Reuse `mergeSetMaps()` from `src/symbols/references/caller-evidence.ts:50-64` for staged consumer-map merging instead of keeping a new stale-abstraction-local duplicate. Source: `scip-query similar mergeConsumerFileMaps --json --full`; `scip-query code mergeSetMaps -C 20`.
- Reuse the existing doc path token cache and suffix-resolution policy in `src/queries/cleanup/doc-drift.ts:471-492` and `src/queries/cleanup/doc-drift.ts:347-360`; do not introduce a parallel citation parser. Source: `scip-query code docPathCandidates -C 25`; `scip-query code docsCitingFiles -C 35`; `scip-query similar docsCitingFiles --json --full`.
- Reuse the existing file-content-addressed evidence cache contract in `src/storage/evidence-cache.ts:1-29`, the source-facts cache pattern in `src/source/source-facts.ts:67-85`, and the import resolver's indexed-path cache in `src/resolution/import-path-resolver.ts:366-371` for parsed source imports. Source: `scip-query code 'src/storage/evidence-cache.ts:1-80' -C 0`; `scip-query code loadOrBuildSourceFacts -C 80`; `scip-query code getIndexedPaths -C 60`; `scip-query plan-context getSourceImports`.

## Phase 1 — Measurement Surface

### 1.1 — Add a benchmark command

- [x] **File**: `src/runtime/commands/command-descriptors.ts:27-35`
- **Source**: `scip-query code commandDescriptors -C 8`
- **What**: Commands are registered as `CommandDescriptor` objects with custom handlers for maintenance-style commands.
- **Change**: Add `bench` with `--json`, `--cold-index`, `--include-heavy`, `--command <cmd>`, `--timeout-ms <n>`, and `--concurrency <n>` options.
- **Why**: Users need a first-class way to inventory performance across repos without hand-written shell scripts.

### 1.2 — Implement benchmark execution

- [x] **File**: `src/runtime/commands/command-handlers.ts:1-657`
- **Source**: `scip-query plan-context src/runtime/commands/command-handlers.ts`
- **What**: Custom handlers own commands that are not ordinary DB query renderers.
- **Change**: Add `handleBench()` that measures repo file counts, current index stats, optional cold/warm reindex, and a curated command matrix. It should print compact text by default and JSON when requested.
- **Why**: Performance must become a tracked CLI behavior, not an external script.

## Phase 2 — Cheap Aggregate Fast Path

### 2.1 — Replace `kind-counts` JS-wide scan with SQL aggregation

- [x] **File**: `src/queries/navigation/by-kind.ts:165-198`
- **Source**: `scip-query code kindCounts -C 12`; `scip-query code loadKindRows -C 12`
- **What**: `kindCounts()` currently maps every definition into JS and resolves every kind row by row.
- **Change**: Query `global_symbols.kind` joined through `defn_enclosing_ranges` and `documents`, grouped by kind, with scope and path exclusions applied in SQL. Only fall back to row-wise inference if SQL reports no kind rows.
- **Why**: On Vega_2.0, `kind-counts` took 13.2s despite being an aggregate command.

## Phase 3 — Parallel Health Phases

### 3.1 — Run isolated health phases with bounded parallelism

- [x] **File**: `src/runtime/cli-support.ts:87-104`
- **Source**: `scip-query code runIsolatedHealthReport -C 12`
- **What**: `runIsolatedHealthReport()` currently runs each child phase sequentially.
- **Change**: Add a bounded parallel runner using `spawn()` for phase subprocesses, preserving result order and error behavior. Default concurrency should be conservative (`min(4, phaseCount)`), overrideable by `SCIP_QUERY_HEALTH_CONCURRENCY`.
- **Why**: Health phases are independent read-only analyses; serial subprocess orchestration burns wall time on large repos.

## Phase 4 — Verification

- [x] Run `npm run typecheck`.
- [x] Run focused tests for command descriptors, by-kind, health/CLI support, and CLI contract.
- [x] Run `npm run build`.
- [x] Run `scip-query bench --json --command 'kind-counts' --command 'health --json'` on this repo to verify command output.
- [x] Run `scip-query status --capabilities`; reindex only if not fresh.
- [x] Run `scip-query diff-gate --json` and fix findings.

## Phase 5 — Dead Detector Candidate Pruning

Rejected experiment:

- Replacing `supplementReferencesFromCallerMap()` with `crossFileCallerEvidenceMap()` was slower: scip-query repo went from 2.878s to 6.506s, and Vega_2.0 hit the 180s benchmark timeout/SIGTERM versus a 163.467s baseline. Do not keep that path for this pass.

### 5.1 — Add cross-file reference pruning helper

- [x] **File**: `src/queries/internal/reference-counts.ts:53-60`
- **Source**: `scip-query code hasAnyReference -C 12`; `scip-query similar hasAnyReference --json`
- **What**: `hasAnyReference()` answers whether any file has positive evidence for a symbol, but `deadRows()` filters specifically on cross-file evidence.
- **Change**: Add `hasCrossFileReference(referencesBySymbol, symbolId, ownFile)` beside `hasAnyReference()`, returning true only when a positive evidence row belongs to another file.
- **Why**: `dead.ts` can prune symbols that SCIP already proves are cross-file-live without duplicating nested `Map` traversal logic.

### 5.2 — Skip fallback passes for SCIP-proven cross-file-live symbols

- [x] **File**: `src/queries/cleanup/dead.ts:104-141`
- **Source**: `scip-query code 'src/queries/cleanup/dead.ts:104-141' -C 2`; `scip-query code deadRows -C 10`
- **What**: Non-`deadCodeOnly` mode currently sends every definition through AST/source fallback and caller-map supplementation even when SCIP mention counts already include cross-file references.
- **Change**: For normal mode, derive `sourceCandidates` from definitions with no existing cross-file reference, and derive `callerCandidates` from source candidates that still have no cross-file reference after source supplementation.
- **Why**: A SCIP-proven cross-file-live symbol cannot survive `deadRows()`; skipping expensive fallback work for it preserves output while reducing candidate pressure.

### 5.3 — Verify dead output contract and speed

- [x] **File**: `tests/queries/cleanup/dead-output.test.ts:126-139`
- **Source**: `scip-query refs dead`; `scip-query code 'tests/queries/cleanup/dead-output.test.ts:126-139' -C 0`
- **What**: Existing tests assert dead-code/file-internal counts.
- **Change**: Run this test plus navigation command-accuracy tests to ensure cross-file candidate pruning does not change the public dead output contract.
- **Why**: This is a performance refactor of evidence collection, not a semantic change.

## Bench Results After Implementation

- scip-query repo smoke: `kind-counts` 179ms; `health --json` 6.4s.
- Vega_2.0 smoke: `kind-counts` 354ms, down from 13.2s; `health --json` 43.0s on 1,779 indexed files / 103,981 symbols.
- Dead detector pruning smoke: scip-query repo `dead --json --full` 3.05s after warm repeat; Vega_2.0 `dead --json --full` 46.84s, down from the 163.467s same-day baseline.
- Vega_2.0 health phase profile after pruning: wrapper-candidates 20.474s, dead 19.102s, stale-abstractions 17.022s, isolated 14.340s, drift 11.863s, git-evidence 10.827s, cycles 10.351s; total health wall time 38.875s.

## Phase 6 — Health Phase Scheduling Experiment

### 6.1 — Run expensive health phases first while preserving report semantics

- [x] **Rejected**: `src/runtime/cli-support.ts:90-96`
- **Source**: `scip-query code runIsolatedHealthReport -C 26`; `scip-query code mapWithConcurrency -C 20`; `scip-query code healthReportFromPhases -C 20`
- **What**: `runIsolatedHealthReport()` feeds `queries.HEALTH_PHASES` to a bounded worker pool in declaration order. `mapWithConcurrency()` preserves input order, and `healthReportFromPhases()` resolves phases by `phase` name.
- **Attempted Change**: Introduce a health execution priority list with the measured expensive phases first (`wrapper-candidates`, `dead`, `stale-abstractions`, `isolated`, `drift`, `git-evidence`, `cycles`, `complexity-hotspots`), run subprocesses in that order, then pass results back to `healthReportFromPhases()` in canonical `HEALTH_PHASES` order.
- **Result**: Rejected after measurement. scip-query local health was noisy and Vega_2.0 regressed from 38.875s to 44.726s, likely because starting the heaviest phases together increases CPU/IO contention. Keep declaration order and optimize individual detectors instead.

## Phase 7 — Wrapper Candidate Source-Fallback Narrowing

### 7.1 — Run wrapper source fallback only for still-possible wrappers

- [x] **Rejected**: `src/queries/cleanup/wrapper-candidates.ts:45-66`
- **Source**: `scip-query plan-context wrapperCandidates`; `scip-query code wrapperCandidates -C 24`; `scip-query code callerFileEvidenceMap -C 24`; `scip-query code 'src/queries/cleanup/isolated.ts:1-110' -C 0`
- **What**: `wrapperCandidates()` currently prepares `definitionConsumerFileMap(index, symbols, ...)`, which merges indexed caller evidence with source-fallback caller attribution for every candidate before evaluation.
- **Attempted Change**: Prepare indexed caller evidence first with `sourceFallback: false`, classify which symbols still have at most one real external indexed caller, then run `index.sourceFallbackCallerFiles()` only for that subset and merge those fallback caller files back into the map. Keep evaluating with the merged map so final output semantics stay the same.
- **Result**: Rejected after measurement. Vega_2.0 `__health-phase wrapper-candidates --full` regressed from 20.474s to 22.081s; the extra preclassification cost outweighed the narrower fallback set.

### 7.2 — Skip full wrapper evaluation for graph-eliminated candidates

- [x] **Rejected**: `src/queries/cleanup/wrapper-candidates.ts:71-119`
- **Source**: `scip-query code 'src/queries/cleanup/wrapper-candidates.ts:1-260' -C 0`
- **What**: `wrapperCandidateForSymbol()` currently recomputes external caller files for every candidate.
- **Attempted Change**: Carry a `possibleWrapperIds` set from preparation and return `null` immediately for symbols with more than one real indexed caller before source fallback. For possible wrappers, run the existing `externalCallerFiles()`, `mentionChunkForCaller()`, enclosing-caller, fan-in, and boundary-evidence logic unchanged.
- **Result**: Rejected with 7.1 because it was part of the same regressing implementation.

## Phase 8 — Stale-Abstraction Source-Fallback Narrowing

### 8.1 — Stage stale-abstraction consumer evidence

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:96-152`
- **Source**: `scip-query plan-context staleAbstractions`; `scip-query code staleAbstractions -C 28`; `scip-query code 'src/queries/cleanup/stale-abstractions.ts:1-260' -C 0`
- **What**: `staleAbstractions()` prepares a full `consumerFileMap` by merging indexed caller evidence and source fallback for every type candidate before evaluation.
- **Change**: Build indexed consumer evidence first with `sourceFallback: false`, use the existing `staleCandidateRow()` consumer partition logic to select only candidates that still have at most one real indexed consumer, then run `index.sourceFallbackCallerFiles()` only for that subset and merge fallback files into the final consumer map.
- **Reuse note**: The final merge uses the existing generic `mergeSetMaps()` helper from caller evidence rather than a stale-abstraction-local merge helper.
- **Why**: The stale-abstraction rule only reports types with zero or one real cross-file consumer. Source fallback can add missed consumers, but it cannot turn a type that already has more than one real indexed consumer into a stale abstraction.

### 8.2 — Keep singleton and transitive safeguards intact

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:316-338`; `src/queries/cleanup/stale-abstractions.ts:487-512`
- **Source**: `scip-query code 'src/queries/cleanup/stale-abstractions.ts:260-460' -C 0`; `scip-query code 'src/queries/cleanup/stale-abstractions.ts:460-620' -C 0`
- **What**: Singleton-backed class correction and same-file transitive type reachability are accuracy guards.
- **Change**: Keep both guards running against the final merged consumer map; do not remove singleton correction or transitive reachability checks for speed.
- **Why**: These paths prevent false stale reports for class singletons and public container types, so they are not optional under the accuracy constraint.

Result:

- Vega_2.0 `__health-phase stale-abstractions --full`: 19.287s baseline, 15.986s after staged consumer evidence.
- Follow-up verification after formatting/rebuild: scip-query repo `__health-phase stale-abstractions --full` 1.996s and `health --json` 5.730s; Vega_2.0 `__health-phase stale-abstractions --full` 14.491s and `health --json` 37.956s.
- Final-build smoke after reusing `mergeSetMaps()`: scip-query repo `__health-phase stale-abstractions --full` 2.231s; Vega_2.0 `__health-phase stale-abstractions --full` 15.952s.

## Phase 9 — Dead Caller Supplement Narrowing

### 9.1 — Skip redundant SCIP caller rows after dead pruning

- [x] **Rejected**: `src/queries/cleanup/dead.ts:468-493`
- **Source**: `scip-query plan-context dead`; `scip-query code supplementReferencesFromCallerMap -C 35`; `scip-query code loadMentionReferenceCounts -C 80`; `scip-query code semanticCallerMap -C 80`
- **What**: `dead()` already seeds `referencesBySymbol` from SCIP mention counts, then prunes `callerCandidates` to definitions that still have no cross-file reference. `supplementReferencesFromCallerMap()` then calls `callerRowsForSymbol()` per remaining candidate; on large repos that path starts with resolved SCIP reference-site lookup even though the seeded counts already proved there is no useful cross-file SCIP caller for the candidate.
- **Attempted Change**: In the semantic-enabled path, use the existing `semanticCallerMap()` over the pruned candidate set and record only those caller files. Keep the old `callerRowsForSymbol()` path when semantic evidence is disabled.
- **Result**: Rejected after measurement. scip-query repo `dead --json --full` / `__health-phase dead --full` rose to 4.958s / 4.445s, versus the kept implementation's roughly 3s local band. Vega_2.0 `__health-phase dead --full` regressed from 18.579s to 20.661s. The semantic-only shortcut removes redundant SCIP work but pays more in semantic-provider overhead and loses the cheaper caller-row path on this workload.

## Phase 10 — Isolated Candidate Staging

### 10.1 — Build caller evidence only for no-callee candidates

- [x] **Rejected**: `src/queries/cleanup/isolated.ts:42-68`
- **Source**: `scip-query plan-context isolated`; `scip-query code isolated -C 80`; `scip-query code symbolsWithNonSelfCallees -C 50`; `scip-query code crossFileCallerMap -C 45`
- **What**: `isolated()` currently builds cross-file caller evidence for every production callable, then separately removes callables that have non-self callees. A callable with any non-self callee can never be isolated, regardless of caller evidence.
- **Attempted Change**: Compute `symbolsWithNonSelfCallees()` first, filter to `candidatesWithoutCallees`, and run `crossFileCallerMap()` plus framework reference checks only on that smaller set. Keep the existing source fallback and additive callee confirmation for the final possibly-isolated set.
- **Result**: Rejected after measurement. scip-query repo `__health-phase isolated --full` was 1.579s, but Vega_2.0 regressed slightly from 13.955s to 14.385s. The candidate reduction did not overcome the cost/order effects of running callee evidence first.

## Phase 11 — Diff-Gate Doc-Reference Narrowing

### 11.1 — Resolve target path tokens before building citation contexts

- [x] **File**: `src/queries/cleanup/doc-drift.ts:314-338`
- **Source**: `scip-query code docsCitingFiles -C 35`; `scip-query code extractFileReferences -C 25`; `scip-query code docCitationContextWindows -C 25`
- **What**: `docsCitingFiles()` currently walks every living tracked doc through `extractFileReferences()`, which calls `docPathCandidates()` and then builds citation context windows for every path-shaped token before filtering to changed diff-gate targets.
- **Change**: In `docsCitingFiles()`, read cached path candidates first, resolve only candidates that can cite the changed targets, and call `docCitationContextWindows()` only for those candidate spellings. Preserve the same full-path and unique suffix resolution rules, and still report docs with empty `citedClaims` when a target citation has no context.
- **Why**: Vega_2.0 profiling showed `diff-gate --json` at 18.617s and `diff-gate --json --skip doc-reference` at 7.822s, making doc-reference the dominant diff-gate phase. The per-doc context scan is independent and expensive, but target prefiltering removes serial work before worker-thread complexity is justified.

### 11.2 — Reassess concurrency after removing serial waste

- [x] **File**: `src/queries/impact/diff-gate.ts:160-241`
- **Source**: `scip-query code diffGate -C 30`; `scip-query code runIsolatedHealthReport -C 30`; `scip-query affected docsCitingFiles`
- **What**: `diffGate()` runs checks sequentially in one process, while health already uses bounded subprocess concurrency for independent phases.
- **Change**: Benchmark diff-gate after 11.1. Only add worker/subprocess parallelism if doc-reference remains CPU-bound enough to beat process startup, duplicated DB open, and result merge costs.
- **Why**: Multithreading is useful only when the remaining hot work is independent and large enough; otherwise it increases contention and makes the CLI slower.

Result:

- Vega_2.0 `diff-gate --json`: 18.617s before 11.1, 8.889s after 11.1.
- Vega_2.0 `diff-gate --json --skip doc-reference`: 6.770s after 11.1, so the remaining doc-reference overhead is about 2.1s. Do not add worker-thread or subprocess parallelism for this path in this pass; the serial prefiltering win captured the bulk of the benefit without duplicated DB/process work.

## Phase 12 — Persistent Source-Import Cache

### 12.1 — Add a source-imports evidence kind

- [x] **File**: `src/storage/evidence-cache.ts:28-29`
- **Source**: `scip-query code 'src/storage/evidence-cache.ts:1-80' -C 0`; `scip-query change-surface src/storage/evidence-cache.ts`
- **What**: `FileEvidenceKind` currently allows single-file persistent evidence for `source-facts` and `doc-path-tokens`. The evidence cache is explicitly keyed by file content hash and CLI version, so stale reads are structurally impossible for pure single-file analyses.
- **Change**: Add `source-imports` to `FileEvidenceKind`.
- **Why**: Parsed source import entries are also a pure function of one file's contents plus the current parser code/version, and many commands pay to recompute them in every new CLI process.

### 12.2 — Persist parsed imports in `getSourceImports()`

- [x] **File**: `src/language-parsers/index.ts:35-44`
- **Source**: `scip-query plan-context getSourceImports`; `scip-query code getSourceImports -C 60`; `scip-query code ParsedSourceImport -C 40`; `scip-query code getIndexedPaths -C 60`
- **What**: `getSourceImports()` uses an in-process per-DB cache, then calls `getParserForPath()`, `getSourceText()`, and `parser.parseImports()`. Because every CLI command opens a fresh DB, large commands such as `cycles` still cold-parse source imports for every indexed file in every process.
- **Change**: Inside the existing `SOURCE_IMPORT_CACHE`, read the source once, compute its content hash with `fileContentHash()`, compute an indexed-path-set fingerprint from the resolver's cached indexed paths, try `readCachedFileEvidence(db, 'source-imports', normalized, contentHash)`, return parsed JSON only when its fingerprint matches, otherwise parse imports and write `JSON.stringify({ resolutionFingerprint, imports })` back with `writeCachedFileEvidence()`. On corrupt payload or fingerprint drift, fall through to the parser exactly like `source-facts`.
- **Why**: Vega_2.0 fresh-index profiling shows `cycles --json` at 8.438s while the SCIP dependency-edge SQL takes only about 80-100ms. The remaining time is per-file source-import fallback work. Persisting import entries preserves the same output and makes repeat commands share the parse work.

### 12.3 — Fingerprint import resolution state

- [x] **File**: `src/resolution/import-path-resolver.ts:366-371`
- **Source**: `scip-query code getIndexedPaths -C 60`; `scip-query code resolveImportPath -C 80`
- **What**: `resolveImportPath()` uses `getIndexedPaths(db)` and disk existence checks to produce `ParsedSourceImport.sourcePath`. That means resolved imports are not purely a function of the importing file's bytes; adding or removing an indexed target can change `sourcePath` while the importer's content hash stays fixed.
- **Change**: Export `importResolutionFingerprint(db)`, a per-DB cached sha256 digest of the sorted indexed path set, and store/check it in each `source-imports` cache payload.
- **Why**: This keeps the persistent cache sound across reindex/path-set changes while still letting repeat commands in the same indexed project reuse parsed import results.

### 12.4 — Verify import consumers and cycle speed

- [x] **File**: `src/symbols/graph/file-dep-graph.ts:15-35`
- **Source**: `scip-query code buildFileDepGraph -C 60`; `scip-query plan-context cycles`; `scip-query change-surface src/language-parsers/index.ts`
- **What**: `buildFileDepGraph()` uses `getSourceImports()` to add source-import fallback edges after SCIP file-dependency edges. `getSourceImports()` also feeds import navigation, dead-code import checks, drift, redundant re-exports, and leaf-symbol attribution.
- **Change**: Run focused parser/import/cache/graph tests, then benchmark Vega_2.0 `cycles --json` and `__health-phase cycles --full` at least twice to confirm the second run improves without output drift.
- **Why**: The cache must be invisible semantically; only repeated command wall time should change.

Result:

- Vega_2.0 fresh-index `cycles --json`: 8.438s before 12.x.
- Vega_2.0 fingerprinted source-import cache: first `cycles --json` run 9.076s while populating cache, second run 0.436s, and repeated `__health-phase cycles --full` 0.446-0.452s.
- Vega_2.0 warmed import-cache health probes: `__health-phase drift --full` 1.714s, `__health-phase git-evidence --full` 0.957s, `__health-phase cycles --full` 0.456s, and `health --json` 13.228s.
- Verification before full gate: `npm run typecheck`; focused source-facts, evidence-cache, import fallback, command accuracy, drift accuracy, redundant re-export, and path-resolver tests all passed.

## Phase 13 — Adaptive Health-Phase Parallelism

### 13.1 — Raise the default health fan-out on machines that can use it

- [x] **File**: `src/runtime/cli-support.ts:18-207`
- **Source**: Vega_2.0 warmed `health --json` sweep with `SCIP_QUERY_HEALTH_CONCURRENCY=1,2,4,6,8,10,12,16`; `scip-query code runIsolatedHealthReport -C 40`; `scip-query code HEALTH_PHASES -C 90`.
- **What**: `health --json` runs independent detector phases as isolated subprocesses. The old default concurrency was a fixed 4, while the larger Vega_2.0 workload continued improving until about 10 concurrent health phases.
- **Change**: Keep the existing `SCIP_QUERY_HEALTH_CONCURRENCY` override, but make the default adaptive: use available CPU count minus one, preserve the old minimum default of 4, and cap the automatic default at 10.
- **Why**: Health phases are independent readonly analyses. This uses more cores on larger machines without changing detector semantics or forcing unbounded process fan-out.

### 13.2 — Preserve scheduler contract with tests

- [x] **File**: `tests/runtime/cli-support.test.ts:1-48`
- **Source**: `rg "SCIP_QUERY_HEALTH_CONCURRENCY|healthPhaseConcurrency|runIsolatedHealthReport" tests src -g"*.ts"`.
- **What**: The scheduler had no direct test for default concurrency or environment override behavior.
- **Change**: Add focused tests for the adaptive cap, phase-count clamp, explicit override, oversized override, and invalid override fallback.
- **Why**: This keeps the performance choice intentional and prevents future changes from silently returning to a fixed low fan-out.

Result:

- Vega_2.0 warmed `health --json` by health concurrency: 1 -> 35.817s, 2 -> 19.050s, 4 -> 12.034s, 6 -> 10.302s, 8 -> 9.281s, 10 -> 8.110s, 12 -> 8.174s, 16 -> 8.136s.
- The default on this 14-core machine is now 10, with `SCIP_QUERY_HEALTH_CONCURRENCY` still available for manual tuning.

## Phase 14 — Per-File Import Attribution Cache

### 14.1 — Cache local-name import maps per file

- [x] **Rejected**: `src/language-parsers/import-index.ts:9-22`
- **Source**: `scip-query plan-context sourceImportPathsByLocalName`; `scip-query code sourceImportPathsByLocalName -C 120`; `scip-query plan-context findCallerFiles`; `scip-query code findCallerFiles -C 160`.
- **What**: `sourceImportPathsByLocalName()` builds a new `Map<string, Set<string>>` from `getSourceImports(db, file)` on every call. `findCallerFiles()` walks every source file and calls `attributeIdentifier()` for each candidate leaf name present in that file; `attributeIdentifier()` calls `sourceImportPathsByLocalName(db, file)`, so one file can rebuild the same import-local-name map many times during caller attribution.
- **Attempted Change**: Wrapped the existing import-local-name map construction in `createPerDbCache<string, Map<string, Set<string>>>`, keyed by normalized file path with `whole-project` and `source-file` invalidation. Kept the map contents and namespace-member handling unchanged.
- **Why**: This is vectorization in the practical cache sense: repeated per-identifier import-index construction for the same file collapses to one per-file computation per process, while preserving the exact attribution rules.

### 14.2 — Verify caller-attribution consumers and benchmark detector phases

- [x] **Rejected**: `src/symbols/identifier-attribution.ts:54-96`; `src/queries/cleanup/dead.ts:335-341`
- **Source**: `scip-query refs sourceImportPathsByLocalName`; `scip-query change-surface src/language-parsers/import-index.ts`; `scip-query co-change src/language-parsers/import-index.ts --json --full`; `scip-query similar sourceImportPathsByLocalName --json --full`.
- **What**: The import-local-name map feeds strict identifier attribution and the dead-code-only source reference supplement. The reuse audit found no existing cached equivalent; the right reuse target is the existing `createPerDbCache` factory used for per-file source evidence.
- **Attempted Change**: Ran focused import/caller/dead tests, typecheck/build, then compared `wrapper-candidates`, `stale-abstractions`, `dead`, and `health` timings on Vega_2.0.
- **Why**: The change is semantically invisible only if caller attribution and import fallback outputs remain stable; the expected win is reduced repeated import-map construction inside the remaining expensive detector phases.

Result:

- Correctness checks passed before rejection: `npm run typecheck`; focused import fallback, command accuracy, source-backed accuracy, dead output, drift accuracy, redundant re-export, and file-wide caller fallback tests.
- Vega_2.0 baseline immediately before the experiment: `health --json` 8.190s, `__health-phase wrapper-candidates --full` 6.668s, `__health-phase stale-abstractions --full` 6.693s, `__health-phase dead --full` 4.376s, `cleanup-plan --verify --json` 4.557s.
- Vega_2.0 after the cache, two rounds: `health --json` 8.591s / 8.254s, `wrapper-candidates` 6.714s / 6.790s, `stale-abstractions` 6.666s / 6.684s, `dead` 4.543s / 4.521s, `cleanup-plan --verify` 4.359s / 4.364s.
- Rejected because the detector phases stayed flat or slightly regressed; the existing source-import cache already makes `getSourceImports()` cheap enough that this map cache does not pay for itself on Vega_2.0.

## Phase 15 — Source Text Read Fast Path

### 15.1 — Avoid the extra existence syscall for readable source files

- [x] **File**: `src/source/source-text.ts:20-35`
- **Source**: `scip-query plan-context getSourceText`; `scip-query code getSourceText -C 100`; `scip-query change-surface src/source/source-text.ts`.
- **What**: `getSourceText()` normalizes a relative path, then calls `existsSync(fullPath)` before `readFileSync(fullPath, 'utf-8')`. For the common source-scanning path, files exist, so this pays two filesystem calls per cold source read before the per-process source-text cache can help.
- **Change**: Try `readFileSync()` directly and return `''` only for missing-path errors (`ENOENT`/`ENOTDIR`), preserving existing behavior for missing files while still throwing other filesystem failures.
- **Why**: Source text is a hot primitive used by parser caches, source facts, identifier maps, doc/reference scanners, and detector evidence. Removing one syscall from every cold readable source file helps broad command startup without changing output semantics.

### 15.2 — Verify high-fan-in source consumers and benchmark source-heavy commands

- [x] **File**: `src/source/source-text.ts:20-35`; `src/symbols/identifier-index.ts:30-105`; `src/language-parsers/index.ts:35-88`
- **Source**: `scip-query refs getSourceText`; `scip-query code getFileIdentifiers -C 120`; `scip-query code getSourceImports -C 60`.
- **What**: `getSourceText()` has many consumers and feeds source imports, source facts, identifier maps, trace/refs output, and source-backed cleanup detectors.
- **Change**: Run source/import/navigation/caller tests, typecheck/build, then compare Vega_2.0 `wrapper-candidates`, `stale-abstractions`, `dead`, `cleanup-plan --verify`, and `health` timings.
- **Why**: This is a high-fan-in primitive, so correctness and broad benchmark checks matter more than the tiny code delta.

Result:

- Correctness checks passed: `npm run typecheck`; focused source facts, source-backed accuracy, source fileset, import fallback, command accuracy, and file-wide caller fallback tests; `npm run build`.
- Vega_2.0 source-heavy benchmark after the change, two rounds: `health --json` 8.633s / 8.149s, `wrapper-candidates --full` 6.595s / 6.600s, `stale-abstractions --full` 6.581s / 6.684s, `dead --full` 4.334s / 4.384s, `cleanup-plan --verify` 4.423s / 4.402s.
- Kept because the change is behavior-preserving for missing paths, still throws non-missing filesystem failures, and was neutral-to-slightly-better against the large source-heavy workload.

## Phase 16 — Parallel Diff-Impact Batches

### 16.1 — Run existing diff-impact batch workers concurrently

- [x] **File**: `src/runtime/cli-support.ts:359-411`; `src/runtime/commands/command-handlers.ts:182-195`
- **Source**: `scip-query plan-context runIsolatedDiffImpactReport`; `scip-query code runIsolatedDiffImpactReport -C 120`; `scip-query plan-context handleDiffImpact`; `rg "runIsolatedDiffImpactReport|DIFF_IMPACT|diff-impact" tests/runtime tests/queries/impact`.
- **What**: `diff-impact` already splits changed files into isolated subprocess batches of 10, but the parent ran those batches serially. Each batch is a readonly analysis over a disjoint changed-file subset, and the merge step already preserves global output shape.
- **Change**: Make `runIsolatedDiffImpactReport()` async, run batches through the existing bounded `mapWithConcurrency()` helper, and expose `SCIP_QUERY_DIFF_IMPACT_CONCURRENCY` for tuning. The adaptive default uses available CPUs, preserves a conservative minimum of 4, and caps automatic fan-out at 8.
- **Why**: This uses the safe parallelism boundary that already exists: subprocesses open their own readonly DB handles, produce the same partial result contract, and the parent merges partials in batch order.

### 16.2 — Preserve CLI contract and benchmark serial vs parallel batches

- [x] **File**: `tests/runtime/cli-support.test.ts:1-73`; `src/runtime/commands/command-registry.ts:37-43`
- **Source**: `scip-query plan-context handleDiffImpact`; `sed -n '1,110p' src/runtime/commands/command-registry.ts`; `sed -n '1,260p' tests/runtime/cli-support.test.ts`.
- **What**: The command registry already awaits async handlers, and `health` already uses an async custom handler. `diff-impact` can follow the same command contract without changing its public options or JSON shape.
- **Change**: Convert `handleDiffImpact()` to await the report, and add focused tests for the diff-impact concurrency default, batch-count clamp, explicit override, oversized override, and invalid override fallback.
- **Why**: The scheduler choice is now intentional and covered without adding slow subprocess integration tests.

Result:

- Correctness checks passed: `npm run typecheck`; `npx vitest run tests/runtime/cli-support.test.ts tests/runtime/cli-contract.test.ts tests/queries/impact/diff-impact-accuracy.test.ts`; `npm run build`.
- Current scip-query dirty-worktree benchmark with 28 changed files and 219 changed symbols: serial batches (`SCIP_QUERY_DIFF_IMPACT_CONCURRENCY=1`) 1.001s / 0.963s / 1.007s; default parallel batches 0.527s / 0.515s / 0.517s. Counts were identical in every run.

## Phase 17 — Narrow Semantic Work Before Threads

### 17.1 — Filter `isolated --full` candidates before semantic caller/callee passes

- [x] **File**: `src/queries/cleanup/isolated.ts:42-80`
- **Source**: `scip-query code isolated -C 130`; `scip-query change-surface src/queries/cleanup/isolated.ts --json`; local baseline `node dist/cli.js isolated --json --full` hash/timing.
- **What**: `isolated()` currently calls `index.crossFileCallerMap(candidates, { semantic: includeSemantic })` and `index.symbolsWithNonSelfCallees(candidates, { semantic: includeSemantic })` before the cheap "possibly isolated" filter. In full semantic mode, this asks the TypeScript provider about every candidate even though SCIP/AST/chunk evidence can already prove many candidates are not isolated.
- **Change**: Run the first caller and callee passes with `semantic: false`, keep framework reference evidence unchanged, filter down to candidates with no cheap callers/callees, then run semantic caller and callee evidence only on that smaller candidate set. Recompute `possiblyIsolated` after the semantic pass before source fallback and additive callee checks.
- **Why**: This preserves accuracy because any candidate removed by the cheap pass is already proven non-isolated by existing graph evidence. Semantic evidence is still consulted for the only candidates where it can change the final isolated result.

### 17.2 — Keep additive precision and reject thread/vector work for this pass

- [x] **File**: `src/core/project-index.ts:89-105`; `src/semantic/provider-cache.ts:19-30`; `src/semantic/typescript/ts-morph-provider.ts:120-136`
- **Source**: `scip-query code ProjectIndex:symbolsWithNonSelfCallees -C 80`; `scip-query code getSemanticProvider -C 100`; `scip-query code referencesFor -C 120`; `scip-query code calleesFor -C 120`.
- **What**: `symbolsWithNonSelfCallees()` is the facade used by `isolated()` for strict and additive callee evidence. The semantic provider is cached per process/database, and `TsMorphSemanticProvider` caches references/callees internally after constructing a ts-morph project.
- **Change**: Leave the additive callee pass semantic-capable, but run it only on candidates that survived caller/source checks. Do not introduce a `worker_threads` pool around ts-morph in this phase; separate workers would construct separate TypeScript project state and duplicate memory before proving a wall-time win. Do not introduce SIMD/vectorization; these hot paths are graph/set/source/semantic workloads, not dense numeric array math.
- **Why**: The safe performance move is to avoid unnecessary semantic work first. Worker or vector changes should come only after the remaining hot path is measured and still CPU-bound after this narrowing.

### 17.3 — Verify output stability and measure local plus Vega impact

- [x] **File**: `src/queries/cleanup/isolated.ts:22-100`
- **Source**: `scip-query refs isolated --json`; `scip-query code isolated -C 130`.
- **What**: `isolated()` feeds health summaries, health baselines, query exports, and the public cleanup command. The local pre-change output hash for `isolated --json --full` is `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702`, 130 bytes, 3382ms.
- **Change**: Run focused isolated/health/command tests, rebuild, compare the local full-mode output hash, and benchmark `isolated --json --full` in this repo and Vega_2.0.
- **Why**: This is a behavior-preserving optimization; output drift is a failure unless explained by a pre-existing nondeterminism.

Result:

- Correctness checks passed: `npm run typecheck`; `npx vitest run tests/queries/cleanup/isolated-query.test.ts tests/queries/health/health-full.test.ts tests/queries/navigation/command-accuracy.test.ts`; `npm run build`.
- Local `isolated --json --full`: 3382ms before; 1617ms / 1577ms after. Output stayed 130 bytes with unchanged sha256 `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702`.
- Vega_2.0 `isolated --json --full`: 107.905s before; 13.051s after. Output stayed 130 bytes with sha256 `04e17adcb38811e37d69fc5abbaadb8b2d79cdf7a9992a30c27648e520acb702`.
- Kept because the speedup comes from skipping semantic work only after existing graph evidence proves a candidate is not isolated; semantic evidence still runs for candidates where it can affect the final result.

## Phase 18 — Persistent Semantic Caller References

### 18.1 — Cache semantic references with whole-project fingerprint invalidation

- [x] **File**: `src/storage/evidence-cache.ts:31-362`
- **Source**: `scip-query plan-context src/storage/evidence-cache.ts`; `scip-query code fingerprintProjectFiles -C 100`; `scip-query plan-context getIndexFreshness`.
- **What**: `evidence-cache.ts` already persists file evidence and semantic callees in `evidence.db`, while `fingerprintProjectFiles()` builds the sorted content-hash fingerprint that `getIndexFreshness()` uses to prove the current source bytes match the index metadata.
- **Change**: Add a `semantic_references` evidence table plus read/write batch helpers. Key reference rows by `(relativePath, symbol)` and require a matching project fingerprint and CLI version on read. Derive the project fingerprint from the sibling `meta.json` reindex metadata; if metadata is missing or unreadable, return cache misses rather than using stale data.
- **Why**: A symbol's references can change when any caller file changes, so the safe persistent cache key is the whole indexed project fingerprint, not the definition file hash.

### 18.2 — Route `semanticCallerMap()` through the persistent reference cache

- [x] **File**: `src/semantic/shared-primitives.ts:13-72`
- **Source**: `scip-query plan-context semanticCallerMap`; `scip-query code semanticReferencesForNode -C 140`; `scip-query code buildCrossFileCallerMap -C 120`.
- **What**: `semanticCallerMap()` currently loops over definitions and calls `semanticReferences()`, which calls the TypeScript provider's `referencesFor()` path. `buildCrossFileCallerMap()` merges this semantic caller map into the AST/chunk caller map whenever semantic evidence is enabled, including public `complexity-hotspots --full`.
- **Change**: Keep the public `semanticReferences()` function behavior unchanged, but make `semanticCallerMap()` first look for cached references for each definition under the current project fingerprint. On misses, compute the exact existing `semanticReferences()` result, write the JSON payload in one batch when the semantic provider is available, then build the same caller-file map as today.
- **Why**: This preserves semantic accuracy and output contracts while making repeated full semantic commands avoid thousands of `findReferences()` calls.

### 18.3 — Verify output stability and warm-run speed on local plus Vega

- [x] **File**: `src/queries/quality/complexity-hotspots.ts:31-55`; `src/semantic/shared-primitives.ts:19-72`; `src/storage/evidence-cache.ts:89-362`
- **Source**: `scip-query plan-context complexityHotspots`; current benchmarks: local `complexity-hotspots --json --full` 4281ms, 418709 bytes, sha256 `f79aa9b2db0fc2f32212dc4dafc7a2b5683988d94349742367437635993142ed`; Vega_2.0 `complexity-hotspots --json --full` 120.443s, 2160117 bytes, sha256 `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f`.
- **What**: `complexityHotspots()` must still compute the same fan-in, fan-out, callee count, and score because full output includes every candidate, not only the top limited slice.
- **Change**: Run focused semantic/evidence/complexity tests, typecheck/build/full tests, compare before/after output hashes, then benchmark the second warm run locally and on Vega_2.0. Run `scip-query co-change src/storage/evidence-cache.ts --json --full`, `scip-query co-change src/semantic/shared-primitives.ts --json --full`, `scip-query self-audit`, and final `scip-query reindex && scip-query diff-gate --json`.
- **Why**: This change is only worth keeping if repeat full semantic commands are much faster and the JSON hash stays stable.

Result:

- Correctness checks passed before full-gate verification: `npm run typecheck`; `npx vitest run tests/storage/evidence-cache.test.ts tests/semantic/typescript/typescript-semantic-provider.test.ts tests/queries/navigation/command-accuracy.test.ts`; `npm run build`.
- Local `complexity-hotspots --json --full`: current cold populate 4128ms; warm repeat 361ms. Output stayed 418710 bytes with unchanged post-change sha256 `fbb993610e24e3d0052e4329ac31a4f9fda71252bcc9aab9c92dc3bb7ef92f05`.
- Vega_2.0 `complexity-hotspots --json --full`: 120.443s before; cold populate 118.294s; warm repeat 1.719s. Output stayed 2160117 bytes with unchanged sha256 `77edc0f3482e8ccd5520c5b178383d3ab3f1aef586888a4e2054551b6c14765f`.
- Kept because cache reads require the current project fingerprint and CLI version, stale metadata degrades to misses, and the command output hash stayed identical on the unchanged Vega target.

## Phase 19 — Stale-Abstraction Semantic Narrowing

### 19.1 — Run semantic caller evidence only for still-stale candidates

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:202-226`
- **Source**: `scip-query plan-context staleAbstractions`; `scip-query code staleAbstractions -C 180`; `scip-query code callerFileEvidenceMap -C 80`; `scip-query code buildCrossFileCallerMap -C 70`; `scip-query code semanticCallerMap -C 60`.
- **What**: `consumerMapForPossiblyStaleTypeCandidates()` already narrows source fallback to candidates that still have at most one real consumer, but its first pass still calls `consumerMapForTypeCandidates(... semantic: opts.semantic, sourceFallback: false)`. In full mode, that invokes semantic references for every type candidate before the stale threshold can eliminate most of them.
- **Change**: Build the first consumer map with `semantic: false` and `sourceFallback: false`, select candidates whose existing `staleCandidateRow()` has at most one real indexed consumer, and only then add `semanticCallerMap()` evidence for that narrowed set when semantic mode is enabled. Exclude type-only contract/model-file candidates that already have a real indexed consumer because the detector's existing `isTrueStaleAbstraction()` policy can never report them after additional callers are added. After semantic evidence is merged, re-run the same threshold before source fallback, then merge source fallback only for candidates still possible. This keeps the evidence union identical for reportable candidates without re-running AST/chunk/Rust caller passes for the narrowed semantic set.
- **Why**: The stale-abstraction detector reports only zero- or one-real-consumer types. Semantic caller evidence and source fallback add caller files; they do not remove indexed real consumers. A candidate with more than one real indexed consumer cannot become stale after adding more evidence, so skipping expensive semantic/reference work for that candidate preserves accuracy while reducing cold populate cost.

### 19.2 — Keep singleton correction accurate while avoiding unnecessary semantic work

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:125-137`; `src/queries/cleanup/stale-abstractions.ts:351-374`
- **Source**: `scip-query code getSingletonBackedClassIds -C 80`; `scip-query change-surface src/queries/cleanup/stale-abstractions.ts --json`.
- **What**: Singleton-backed class correction exists to avoid false stale reports for exported `const singleton = new Class()` patterns.
- **Change**: Keep the correction, but feed it the narrowed stale candidate set rather than the original full type-candidate list if the final consumer evidence and `isTrueStaleAbstraction()` policy already prove a class is not reportable. The singleton check still uses `definitionConsumerFileMap()` with semantic evidence for the singleton vars it must classify.
- **Why**: A class that cannot be reported does not need singleton correction. The correction must remain for still-reportable class candidates because singleton usage can be the evidence that prevents a false positive.

### 19.3 — Verify output hashes and cold/warm timings

- [x] **File**: `src/queries/cleanup/stale-abstractions.ts:96-226`
- **Source**: Current Vega_2.0 cold semantic-cache baseline `stale-abstractions --json --full`: 88.739s, 83,654 bytes, sha256 `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2`; warm baseline: 7.619s, same bytes/hash. Current scip-query warm baseline: 1.266s, 922 bytes, sha256 `78cc3acfe2753194c946d1516b461bf9c08d87634fee5fa6a87614fe27c37213`.
- **What**: This is a behavior-preserving performance change, so JSON output drift is a failure unless a separate pre-existing nondeterminism is proven.
- **Change**: Run focused stale/health tests, typecheck/build, compare local and Vega output hashes, measure cold semantic-cache and warm timings, then run `scip-query co-change src/queries/cleanup/stale-abstractions.ts --json --full`, `scip-query self-audit`, and final `scip-query reindex && scip-query diff-gate --json`.
- **Why**: The intended win is lower cold semantic populate cost with unchanged warm behavior and unchanged detector answers.

Result:

- Correctness checks passed before full-gate verification: `npm run typecheck`; `npx vitest run tests/queries/cleanup/stale-abstractions-accuracy.test.ts tests/queries/navigation/command-accuracy.test.ts tests/queries/health/health-full.test.ts`; `npm run build`.
- scip-query repo warm `stale-abstractions --json --full`: 1.266s baseline; 1.469s after. Output stayed 922 bytes with sha256 `78cc3acfe2753194c946d1516b461bf9c08d87634fee5fa6a87614fe27c37213`.
- Vega_2.0 warm `stale-abstractions --json --full`: 7.619s baseline; 8.733s after. Output stayed 83,654 bytes with sha256 `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2`.
- Vega_2.0 semantic-cache-cold `stale-abstractions --json --full`: 88.739s baseline; 73.461s after. Output stayed 83,654 bytes with the same sha256 `f8e0a9c7c5a4e16cc445f75ee183d8baa474e90ac7c5a481a0fb170fd3802ee2`.
- Kept because the cold first-run path improved by about 17% with identical output. The warm path is slightly slower in the measured run, so the next stale-abstraction work should target semantic-provider/reference lookup cost directly rather than adding more prefilters.

## Phase 20 — Dead Semantic Caller Cache Routing

### 20.1 — Split dead caller supplementation into targeted cheap callers plus cached semantic callers

- [x] **File**: `src/queries/cleanup/dead.ts:468-492`
- **Source**: `scip-query plan-context dead`; `scip-query code dead -C 220`; `scip-query code supplementReferencesFromCallerMap -C 80`; `scip-query code callerRowsForSymbol -C 80`; `scip-query code semanticCallerMap -C 80`; `scip-query affected supplementReferencesFromCallerMap`.
- **What**: `dead()` narrows to `callerCandidates` after indexed mention and AST/source fallback evidence. `supplementReferencesFromCallerMap()` then loops each remaining candidate and calls `callerRowsForSymbol(... semantic: true)`. For large indexes, `getCallerRowsForSymbol()` uses the targeted path, where `targetedCallerRowsForSymbol()` combines `getResolvedReferenceSites()` with direct `semanticReferences()` calls. Direct `semanticReferences()` bypasses the persistent semantic-reference cache that `semanticCallerMap()` already uses.
- **Change**: In `supplementReferencesFromCallerMap()`, always run the targeted caller-row pass with `semantic: false` so resolved SCIP/reference-site evidence remains intact. When `opts.includeSemantic !== false`, add semantic caller files with `semanticCallerMap(db, definitions)` and record those files with the same inactive-barrel, ignored-file, and test-file filters. Change the helper's internal definition parameter type to `readonly IndexedDefinition[]`, matching the actual `dead()` pipeline input and the `semanticCallerMap()` contract.
- **Why**: `dead` only records whether a candidate has a caller file; it does not use the caller symbol or semantic-reference provenance. A semantic reference from file `F` produces the same `recordReferenceAtLeast(..., F, 1, 'caller-map')` effect whether it arrives through per-symbol `callerRowsForSymbol()` or bulk `semanticCallerMap()`. The bulk route reuses the existing persistent semantic-reference cache and batched writes, instead of recomputing semantic references for every candidate on every full run.

### 20.2 — Verify dead output hashes and large-repo timing

- [x] **File**: `src/queries/cleanup/dead.ts:83-147`; `src/queries/cleanup/dead.ts:468-492`
- **Source**: Current targeted benchmark sweep: local `dead --json --full` 1.213s, 675,443 bytes, sha256 prefix `c699d3b861c904a7`; Vega_2.0 `dead --json --full` 26.902s then 28.144s, 3,803,655 bytes, sha256 prefix `28a0c54730e98c9e`; `dead --json` bounded Vega 6.271s, 957,573 bytes, sha256 prefix `bfd5f18d24329c6e`.
- **What**: `dead` feeds cleanup-plan seeds, health dead summaries, health baselines, query exports, and the public CLI. Output drift is a failure unless explained by pre-existing nondeterminism.
- **Change**: Capture local and Vega `dead --json --full` hashes after the edit, compare against the pre-change hashes above, benchmark warm repeat timing, then run focused dead/health/cleanup-plan tests plus full typecheck/build. Use `scip-query similar supplementReferencesFromCallerMap --json --full` and `scip-query co-change src/queries/cleanup/dead.ts --json --full` as postchecks before final `scip-query reindex && scip-query diff-gate --json`.
- **Why**: This is an output-preserving performance route change; the command is worth keeping only if the same JSON is faster on the large repo or materially improves subsequent warm runs.

Result:

- Corrected after clean rebuild and fresh Vega_2.0 reindex. The earlier rejection mixed build/cache states; with the current build, output hashes stayed identical and the large-repo warm path improved materially.
- Local `dead --json --full`: current run 2.452s cold-ish, then 1.330s / 1.417s warm, 675,443 bytes, sha256 prefix `c67aebe5d2a827db`. This was slightly slower than the 1.213s local targeted baseline, so the route became adaptive for small candidate sets.
- Vega_2.0 `dead --json --full` after fresh 49.0s reindex: 35.552s first post-reindex cache fill, then 7.867s / 7.338s warm, same 3,803,655 bytes and sha256 prefix `28a0c54730e98c9e`. Warm targeted baseline was 26.902s / 28.144s, so the large-repo warm path is about 3.6x faster with unchanged output.
- Vega_2.0 `health --json` after fresh reindex and warmed detector evidence: 8.268s / 8.776s, 15,342 bytes, sha256 prefix `d7a262f7be1231e1`.
- Adaptive follow-up: gate bulk semantic callers behind both a pruned-candidate threshold and an indexed-file-count threshold. After rebuild and local reindex, scip-query repo `dead --json --full` measured 2.579s first run, then 1.362s / 1.365s warm, 678,979 bytes, sha256 prefix `df848a9796d4e9e6`. Vega_2.0 stayed on the large-repo path at 8.841s first run, then 7.433s / 7.244s warm, same 3,803,655 bytes and sha256 prefix `28a0c54730e98c9e`.
- Keep the adaptive split: small repos use the existing targeted semantic caller path; large repos use targeted cheap caller evidence plus the persistent-cache-backed bulk semantic caller map.

## Phase 21 — Persistent Consumer File Usage Evidence

### 21.1 — Add a persistent file-evidence kind for consumer import/usage leaves

- [x] **File**: `src/storage/evidence-cache.ts:29`; `src/queries/internal/consumer-evidence.ts:71-113`
- **Source**: `scip-query plan-context isImportOnlyConsumer`; `scip-query code isImportOnlyConsumer -C 120`; `scip-query code computeFileLeafUsage -C 120`; `scip-query code getSourceFacts -C 160`; `scip-query change-surface src/storage/evidence-cache.ts --json`.
- **What**: `isImportOnlyConsumer()` classifies whether a consumer file merely imports a symbol leaf without using it. It uses an in-process `FILE_USAGE_CACHE`, but `computeFileLeafUsage()` calls `getAst()` and walks tree-sitter nodes to produce `{ importedLeaves, usedLeaves }` on every new CLI process. `getSourceFacts()` already demonstrates the persistent file-evidence pattern for pure per-file AST facts: content hash + CLI version + JSON payload in `file_evidence`.
- **Change**: Extend `FileEvidenceKind` with `consumer-file-usage`. In `consumer-evidence.ts`, read `getSourceText()`, compute `fileContentHash()`, try `readCachedFileEvidence(db, 'consumer-file-usage', file, contentHash)`, and deserialize imported/used leaves into sets. On cache miss or corrupt payload, run the existing AST walk unchanged and write `{ importedLeaves: string[], usedLeaves: string[] }` through `writeCachedFileEvidence()`. Keep the existing in-process `FILE_USAGE_CACHE` as the first-level cache.
- **Why**: The value is a pure function of one file's bytes plus parser/version, exactly like `source-facts` and `source-imports`. Persisting it avoids reparsing the same consumer files in wrapper, stale-abstraction, singleton, and health subprocesses while preserving the same import-only classification.

### 21.2 — Verify wrapper/stale output and warm plus cold-ish timings

- [x] **File**: `src/queries/internal/consumer-evidence.ts:48-77`; `src/queries/cleanup/wrapper-candidates.ts:45-66`; `src/queries/cleanup/stale-abstractions.ts:96-226`
- **Source**: `scip-query refs isImportOnlyConsumer --json`; `scip-query change-surface src/queries/internal/consumer-evidence.ts --json`; current Vega steady timings: `wrapper-candidates --json --full` 7.998s / 7.931s, 78,437 bytes, sha256 prefix `311a92542c8370fc`; `stale-abstractions --json --full` 7.939s / 7.955s, 83,654 bytes, sha256 prefix `f8e0a9c7c5a4e16c`; `health --json` 11.409s / 11.000s.
- **What**: `isImportOnlyConsumer()` feeds `partitionDefinitionConsumers()` for wrapper and stale detectors and `singletonHasRealConsumer()` for stale singleton correction.
- **Change**: Run focused consumer-evidence, wrapper/stale/health tests, typecheck/build, compare local and Vega output hashes for wrapper/stale/dead, and benchmark Vega warm repeats. For a cold-ish cache check, temporarily move only Vega's `evidence.db` aside and compare first-run timing/output for wrapper or stale, then restore the evidence DB. Run `scip-query similar computeFileLeafUsage --json --full`, `scip-query co-change src/queries/internal/consumer-evidence.ts --json --full`, `scip-query co-change src/storage/evidence-cache.ts --json --full`, `scip-query self-audit`, and final `scip-query reindex && scip-query diff-gate --json`.
- **Why**: This cache should improve repeated source-heavy detector commands and health subprocesses without changing detector semantics. It must be rejected if JSON hashes drift or if persistent read/write overhead outweighs avoided parsing on real workloads.

Result:

- Local current build: `wrapper-candidates --json --full` 0.917s / 0.723s, 158 bytes, sha256 prefix `f8554cd33ec065cf`; `stale-abstractions --json --full` 0.628s / 0.649s, 922 bytes, sha256 prefix `78cc3acfe2753194`; `health --json` 2.037s / 1.922s.
- Vega_2.0 after fresh 49.0s reindex: `wrapper-candidates --json --full` 80.236s first post-reindex cache fill, then 3.344s warm, same 78,437 bytes and sha256 prefix `311a92542c8370fc`. Warm baseline was 7.998s / 7.931s, so the warm path is about 2.4x faster with unchanged output.
- Vega_2.0 after fresh reindex: `stale-abstractions --json --full` 51.123s first post-reindex cache fill, then 2.778s warm, same 83,654 bytes and sha256 prefix `f8e0a9c7c5a4e16c`. Warm baseline was 7.939s / 7.955s, so the warm path is about 2.9x faster with unchanged output.
- The first post-reindex run is still expensive because it fills persistent single-file evidence. The next performance target is moving safe cache population into indexing or batching file-evidence writes so the first detector after reindex does not pay the whole parse/write bill.

## Phase 22 — TypeScript Semantic Callee Cold-Fill Memoization

### 22.1 — Memoize semantic target-symbol resolution inside the TypeScript provider

- [x] **Rejected**: `src/semantic/typescript/ts-morph-provider.ts:74-393`
- **Source**: `scip-query plan-context semanticCalleeMap`; `scip-query code 'src/semantic/typescript/ts-morph-provider.ts:296-430' -C 0`; `scip-query code findIndexedDefinitionNear -C 120`; `scip-query change-surface src/semantic/typescript/ts-morph-provider.ts --json --full`.
- **What**: `complexityHotspots()` calls `ProjectIndex.calleeMap()`, which reaches `buildCalleeMap()` and then `cachedSemanticCalleeMap()` for full semantic callee evidence. On a cold Vega_2.0 semantic-callee cache, `complexity-hotspots --json --full` took 81.963s and then 2.230s warm with identical output, proving the first run is semantic-callee cache population. `TsMorphSemanticProvider.calleeMapForFile()` scans every call/new expression and calls `semanticCalleeForCallNode()`, which resolves the TypeScript symbol back to an indexed definition through `definitionFromSymbol()`. `definitionFromSymbol()` currently walks symbol declarations and calls `findIndexedDefinitionNear()` on every invocation.
- **Attempted Change**: Add provider-local memoization for `definitionFromSymbol()`: first by ts-morph `Symbol` wrapper identity, and then by a declaration-key built from declaration source path and text positions. Keep the existing declaration loop and `findIndexedDefinitionNear()` matching policy unchanged for cache misses.
- **Why**: A large file graph repeatedly calls the same imported or local functions. Resolving those targets is pure within one provider instance and one index snapshot, so memoization avoids repeated ts-morph declaration walks and indexed-definition lookups without changing semantic output.

### 22.2 — Verify cold and warm semantic-callee behavior

- [x] **Rejected**: `src/semantic/typescript/ts-morph-provider.ts:128-393`; `src/symbols/graph/call-graph-evidence.ts:224-326`; `src/queries/quality/complexity-hotspots.ts:31-55`
- **Source**: `scip-query plan-context complexityHotspots`; `scip-query code buildCalleeMap -C 120`; `scip-query code semanticCalleeMap -C 100`.
- **What**: Semantic callee evidence feeds full `complexity-hotspots`, `similar`, callee map consumers, and `self-audit`. Output drift is a failure unless explained by pre-existing nondeterminism.
- **Change**: Clear only Vega_2.0 `semantic_callees` cache rows, run `complexity-hotspots --json --full` once to measure cold-fill time and output hash, then run it again for warm timing/hash. Compare against the pre-change cold/warm hashes and run TypeScript semantic provider tests plus command-accuracy/health tests. Because the change is a new internal cache, run `scip-query similar definitionFromSymbol --json --full`, `scip-query co-change src/semantic/typescript/ts-morph-provider.ts --json --full`, `scip-query self-audit --json`, and final `scip-query reindex && scip-query diff-gate --json`.
- **Why**: This pass is only worth keeping if it reduces the cold semantic fill or at least does not regress it, while keeping warm output and tests unchanged.

Result:

- Rejected after measurement. The object-identity cache variant passed typecheck and focused semantic/health/navigation tests, but a true cold Vega_2.0 semantic-callee fill aborted with `SIGABRT` after about 84s and wrote no output, likely because retaining ts-morph `Symbol` wrappers amplified memory retention during full-corpus semantic analysis.
- A reduced declaration-key-only variant also passed typecheck and focused tests, but exceeded the previous 81.963s cold baseline before completion and was interrupted. The source was restored to the pre-phase behavior, and Vega_2.0's `semantic_callees` cache was restored from backup to 6,693 rows.
- Keep the existing provider implementation for now. The next semantic-callee optimization should avoid retaining ts-morph wrapper objects and should target either provider algorithm cost directly or an explicit/background warmup path rather than adding per-symbol object caches.

## Phase 23 — Dead-Code-Only Targeted Caller Skip

### 23.1 — Skip redundant targeted caller evidence for dead-code-only large repos

- [x] **Rejected**: `src/queries/cleanup/dead.ts:117-149`; `src/symbols/graph/call-graph-evidence.ts:71-84`; `src/symbols/references/caller-evidence.ts:1-16`
- **Source**: `scip-query code dead -C 180`; `scip-query code loadMentionReferencedSymbolIds -C 50`; `scip-query code getResolvedReferenceSites -C 90`; `scip-query code callerRowsForSymbol -C 80`; `scip-query code supplementReferencesFromCallerMap -C 80`; current storage SQL in `src/storage/scip-mentions.ts:37-78`.
- **What**: In `deadCodeOnly` mode, `dead()` first calls `loadMentionReferencedSymbolIds()` and removes every candidate with any non-definition SCIP mention. It then runs source fallback on the remaining candidates and, for candidates that still have no references, calls `supplementReferencesFromCallerMap(... includeSemantic: false)`. On large repos, `callerRowsForSymbol(... semantic: false)` uses the targeted caller path, and that path only asks `getResolvedReferenceSites()` for SCIP mention chunks because semantic references are disabled.
- **Change**: Expose the caller subsystem's targeted-vs-bulk lookup decision through the caller-evidence facade. In `dead()`, skip `supplementReferencesFromCallerMap()` only when `deadCodeOnly` is true and caller rows would use the targeted lookup. Keep the caller supplement for normal `dead` runs and for small-repo bulk caller rows, because the bulk caller map can still add AST/chunk/semantic-derived evidence that is not equivalent to the earlier mentioned-symbol set.
- **Why**: For the targeted, semantic-disabled path, the caller pass can only revisit mention evidence whose presence already disqualified a symbol from the dead-code-only candidate set. Skipping it should preserve output while avoiding one per-candidate caller lookup over large repositories.

### 23.2 — Verify output hashes and cleanup-plan timing

- [x] **Rejected**: `src/queries/cleanup/dead.ts:117-149`; `src/queries/cleanup/cleanup-plan.ts:125-149`
- **Source**: Pre-change hashes: scip-query `dead --json --only-dead --skip-barrels --full` 331,987 bytes, sha256 prefix `cdd9fbfb5d131d9c`; Vega_2.0 same command 1,862,630 bytes, sha256 prefix `18bc03c64402dd22`.
- **What**: This is an output-preserving performance change for dead-code-only and cleanup-plan seed detection.
- **Change**: Compare local and Vega output hashes after rebuild, benchmark `dead --only-dead --skip-barrels --full` and `cleanup-plan --json` repeats, then run focused dead/cleanup/health tests, typecheck, build, and scip-query postchecks.
- **Why**: The change is worth keeping only if JSON output stays identical and large-repo dead-code-only or cleanup-plan seed timing improves.

Result:

- Rejected after measurement. Typecheck, focused dead/cleanup/health tests, and build passed, and Vega_2.0 output stayed identical for `dead --json --only-dead --skip-barrels --full` at 1,862,630 bytes with sha256 prefix `18bc03c64402dd22`.
- Timing did not improve clearly: Vega_2.0 measured 8.950s first run, then 7.097s / 7.280s warm for `dead --json --only-dead --skip-barrels --full`, versus the current baseline range around 6.334s-7.175s. `cleanup-plan --json` measured 5.894s / 5.800s / 5.843s, which is within the existing noisy range rather than a proven win.
- The source change was reverted. The caller-map supplement is not the dominant cleanup-plan bottleneck; the next pass should profile `supplementDeadCodeOnlySourceReferences()` and source reference scanning directly.

## Phase 24 — Dead Candidate Cache Retention

### 24.1 — Retain source evidence between candidate loading and source fallback

- [x] **Rejected**: `src/queries/cleanup/dead.ts:99-177`; `src/queries/internal/cache-invalidation.ts:27-35`; `src/source/source-facts.ts:50-84`; `src/source/ast/ast-core.ts:30-42`
- **Source**: `scip-query code deadCandidateDefinitions -C 120`; `scip-query code clearSourceFileEvidenceCaches -C 100`; `scip-query code getSourceFacts -C 100`; `scip-query code scanSourceReferences -C 100`; Vega_2.0 source CPU profile of direct `dead(... deadCodeOnly: true, skipBarrels: true, semantic: false)`.
- **What**: `deadCandidateDefinitions()` calls `getDefinitionsForFile()`, which uses source text, `getSourceFacts()`, and `getAst()` to correct definition ranges. It then clears `source-file` and `definition-catalog` caches for the file in a `finally` block. The next dead-code phase immediately needs source-backed evidence again through `supplementDeadCodeOnlySourceReferences()` or `supplementReferencesFromAst()`. The source CPU profile shows candidate loading and framework exclusion work paying tree-sitter parse/deserialization cost before source scanning.
- **Change**: Add a candidate-loading option that retains source and definition caches for commands that immediately run a source fallback phase. Pass that option from `dead()`, then rely on the existing `afterPath` clear in source-reference scanning to release source-file caches after they are consumed.
- **Why**: The cached values are keyed by the same `ScipDatabase` and file source, and the command runs against one index/source snapshot. Retaining them within the command avoids duplicate AST/source-facts loading without changing candidate policy or reference evidence.

### 24.2 — Verify output hashes, memory, and timing

- [x] **Rejected**: `src/queries/cleanup/dead.ts:99-177`
- **Source**: Pre-change Vega_2.0 baselines after rejected Phase 23 revert: `cleanup-plan --json` 5.860s / 5.684s / 5.946s, 217 bytes, sha256 prefix `efb8724a80c1fe25`; `dead --json --full` 7.235s / 7.218s / 7.228s, 3,803,655 bytes, sha256 prefix `28a0c54730e98c9e`.
- **What**: This is an in-process cache lifetime change. JSON output must be identical; memory must not grow enough to destabilize large-repo runs.
- **Change**: Compare local and Vega hashes for `cleanup-plan --json` and `dead --json --full`, benchmark repeats, run focused dead/cleanup/health tests, typecheck, build, and full test suite if the timing win is worth keeping.
- **Why**: Keep only if it reduces real cleanup/dead timings with stable output and no memory failure.

Result:

- Rejected after measurement. Focused dead/cleanup/health/navigation tests, typecheck, and build passed. Vega_2.0 JSON output stayed identical for `cleanup-plan --json` at 217 bytes with sha256 prefix `efb8724a80c1fe25`, `dead --json --full` at 3,803,655 bytes with sha256 prefix `28a0c54730e98c9e`, and `health --json` at 15,342 bytes with sha256 prefix `d7a262f7be1231e1`.
- Timings did not improve: `cleanup-plan --json` measured 7.341s first run, then 6.075s / 5.753s / 5.741s against a 5.684s-5.946s baseline; `dead --json --full` measured 7.191s / 7.320s / 7.065s / 7.004s against a 7.218s-7.235s baseline; `health --json` measured 8.952s / 9.470s / 9.023s / 9.975s against the current 8.1s-8.8s band.
- The source change was reverted. The duplicate-cache hypothesis was plausible from the profile, but retaining source evidence increases process work/memory enough that it does not produce a real workload win.

## Phase 25 — TS/JS Framework Exclusion Source Prefilter

### 25.1 — Skip TS/JS exclusion AST parsing when no exclusion marker exists

- [x] **File**: `src/analysis/framework-patterns.ts:36-152`; `src/source/source-text.ts:20-31`
- **Source**: `scip-query plan-context getDefinitionExclusions`; `scip-query code getJsTestExclusions -C 130`; `scip-query code getSourceText -C 80`; `scip-query refs getDefinitionExclusions --json`.
- **What**: `getDefinitionExclusions()` routes TypeScript, TSX, and JavaScript files to `getJsTestExclusions()`. `getJsTestExclusions()` currently calls `getAst()` before checking whether a file contains any construct that can produce an exclusion: a top-level test framework call, a top-level React custom hook named `use[A-Z]...`, or a `scip-query` suppression comment.
- **Change**: Import `getSourceText()` and add a cheap source-text prefilter at the start of `getJsTestExclusions()`. If the source is empty, or if it contains none of the possible markers (`scip-query`, any known test framework call name followed by `(`, or a `use[A-Z]` identifier), return `[]` without calling `getAst()`. Preserve the existing AST path for all marker-positive files so line ranges and top-level checks stay authoritative.
- **Why**: The prefilter only skips files where no existing AST branch can produce an exclusion. Vega_2.0 currently has 1,777 indexed JS/TS-family files, and 926 have none of those markers, so this avoids unnecessary tree-sitter parsing in the dead-code candidate gate while preserving the same exclusion semantics.

### 25.2 — Verify hashes and large-repo timing

- [x] **File**: `src/analysis/framework-patterns.ts:64-152`; `tests/analysis/framework-patterns.test.ts`
- **Source**: Current Vega_2.0 baselines before the change: `cleanup-plan --json` 6.178s / 5.755s, 217 bytes, sha256 prefix `efb8724a80c1fe25`; `dead --json --full` 7.373s / 7.274s, 3,803,655 bytes, sha256 prefix `28a0c54730e98c9e`; `health --json` 9.165s / 8.535s, 15,342 bytes, sha256 prefix `d7a262f7be1231e1`.
- **What**: This is an output-preserving fast path for dead-code framework exclusions. Output drift is a failure unless it reveals a pre-existing false positive that is separately explained and accepted.
- **Change**: Run focused framework/dead/cleanup/health tests, typecheck, build, compare local and Vega hashes for `cleanup-plan --json`, `dead --json --full`, and `health --json`, then benchmark repeats. If kept, run `scip-query co-change src/analysis/framework-patterns.ts --json --full`, `scip-query self-audit --json`, and final freshness/diff-gate checks.
- **Why**: Keep only if the same detector answers are faster on real Vega-scale workloads.

Result:

- Kept after measurement. Added `mayContainJsExclusion()` as a source-text gate before TS/JS AST parsing in `getJsTestExclusions()`. Marker-positive files still use the existing AST path, so top-level test-call detection, React hook ranges, and suppression comment ranges remain authoritative.
- Large-repo coverage: Vega_2.0 has 1,777 indexed JS/TS-family files; 926 have no possible exclusion marker and now skip tree-sitter parsing in the dead-code candidate gate.
- Vega_2.0 output stayed identical: `cleanup-plan --json` remained 217 bytes with sha256 prefix `efb8724a80c1fe25`; `dead --json --full` remained 3,803,655 bytes with sha256 prefix `28a0c54730e98c9e`; `health --json` remained 15,342 bytes with sha256 prefix `d7a262f7be1231e1`.
- Vega_2.0 timings improved: `cleanup-plan --json` moved from 6.178s / 5.755s to 3.447s / 3.507s warm after a 4.936s first run; `dead --json --full` moved from 7.373s / 7.274s to 5.087s / 5.188s / 4.966s; `health --json` moved from 9.165s / 8.535s to 6.633s / 6.426s / 6.685s.
- Local timings improved after warm-up: `cleanup-plan --json` measured 1.255s / 1.158s; `dead --json --full` measured 1.169s / 1.212s / 1.152s; `health --json` measured 2.149s / 1.831s / 1.985s.
- Verification passed: `npm run typecheck`; focused framework/dead/cleanup/health/navigation/source-facts tests; `npm test` with 386 tests; `npm run build`; post-change focused `tests/analysis/framework-patterns.test.ts`; `scip-query similar mayContainJsExclusion --json --full`; `scip-query recent-duplicates --json --full`; `scip-query co-change src/analysis/framework-patterns.ts --json --full`; `scip-query self-audit --json`; final `scip-query status --json` fresh; and final `scip-query diff-gate --json` with zero findings.

## Phase 26 — Batched File Evidence Cache Writes for Consumer Classification

### 26.1 — Wrap wrapper/stale detector cache fill in a file-evidence transaction

- [x] **Rejected**: `src/storage/evidence-cache.ts:232-246`; `src/queries/internal/candidate-scan.ts:18-32`; `src/queries/cleanup/wrapper-candidates.ts:45-65`; `src/queries/cleanup/stale-abstractions.ts:98-167`
- **Source**: `scip-query plan-context writeCachedFileEvidence`; `scip-query refs writeCachedFileEvidence --json`; `scip-query code wrapperCandidates -C 80`; `scip-query code staleAbstractions -C 90`; `scip-query similar writeCachedSemanticCalleesBatch --json --full`; `scip-query similar writeCachedFileEvidence --json --full`.
- **What**: `writeCachedFileEvidence()` currently writes one `file_evidence` row per cache miss. The semantic cache already has batched transaction writers, but the file-evidence path used by `consumer-file-usage` writes one row at a time. `wrapperCandidates()` and `staleAbstractions()` both reach `partitionDefinitionConsumers()`, which reaches `isImportOnlyConsumer()` and then `computeFileLeafUsage()` for each consumer file.
- **Change**: Add a storage helper that runs a synchronous callback inside one SQLite transaction for rebuildable file-evidence writes. Use it at the `wrapperCandidates()` and `staleAbstractions()` command entry points so cold `consumer-file-usage` fills commit as one batch while the existing per-file read, deserialize, compute, and write semantics remain unchanged.
- **Why**: A transaction changes only cache write grouping, not candidate selection or scoring. The cache is content-addressed and rebuildable; if rows are missing or a cache operation is disabled, commands already recompute from source. This targets the measured cold-cache gap without changing detector answers.

### 26.2 — Verify cold-cache timing and unchanged detector output

- [x] **Rejected**: `src/storage/evidence-cache.ts:211-360`; `src/queries/internal/consumer-evidence.ts:79-106`; `src/queries/cleanup/wrapper-candidates.ts:137-158`; `src/queries/cleanup/stale-abstractions.ts:255-267`
- **Source**: Local cold-cache reproduction: after deleting only `consumer-file-usage` rows, `wrapper-candidates --json --full` measured 1.664s cold then 0.758s warm with sha256 prefix `f8554cd33ec065cf`; `stale-abstractions --json --full` measured 1.434s cold then 0.632s warm with sha256 prefix `78cc3acfe2753194`.
- **What**: Output drift is a failure. The expected improvement is lower first-run time when `consumer-file-usage` rows are absent; warm timings must not regress enough to erase the gain.
- **Change**: Build, delete only local `consumer-file-usage` rows, compare wrapper/stale cold and warm hashes/timings before and after the transaction helper, then repeat on Vega_2.0 if the local result is promising. Run focused evidence-cache/wrapper/stale/health tests, typecheck, full test suite if kept, `scip-query similar withFileEvidenceTransaction --json --full`, `scip-query co-change src/storage/evidence-cache.ts --json --full`, `scip-query co-change src/queries/internal/consumer-evidence.ts --json --full`, `scip-query self-audit --json`, and final freshness/diff-gate.
- **Why**: This phase is worth keeping only if it reduces real cold-fill latency with identical output hashes and preserves the cache's fail-open contract.

Result:

- Rejected after measurement. The attempted implementation added a storage-level `withFileEvidenceTransaction()` helper, an optional `evaluateBatch` hook in `runCandidateAnalysis()`, and wrapper/stale opt-ins so scoring-time `consumer-file-usage` cache writes would commit as one transaction.
- Typecheck, focused storage/health tests, and build passed, and output hashes stayed identical: wrapper remained sha256 prefix `f8554cd33ec065cf`; stale remained sha256 prefix `78cc3acfe2753194`.
- Timing regressed locally after clearing only `consumer-file-usage` rows: `wrapper-candidates --json --full` moved from the pre-change 1.664s cold / 0.758s warm reproduction to 4.207s cold / 0.672s warm; `stale-abstractions --json --full` moved from 1.434s cold / 0.632s warm to 2.744s cold / 0.643s warm.
- The source and test changes were reverted. Holding the transaction around the evaluation loop appears to cost more than the per-row commit savings on this workload, likely because the loop still performs substantial source/scoring work while the evidence DB transaction is open. Do not reattempt this shape; the next cold-fill pass should target cheaper per-file usage computation or precomputed source-derived leaf indexes instead.

## Phase 27 — Import-Only Consumer Leaf Absence Prefilter

### 27.1 — Skip file-usage AST/cache work when the tested leaf is absent from source

- [x] **Rejected**: `src/queries/internal/consumer-evidence.ts:79-106`; `src/source/source-text.ts:20-31`
- **Source**: `scip-query plan-context isImportOnlyConsumer`; `scip-query code getSourceText -C 60`; `scip-query similar isImportOnlyConsumer --json --full`; `scip-query refs isImportOnlyConsumer --json`.
- **What**: `isImportOnlyConsumer()` currently detects the language and loads full per-file leaf usage for every `(consumerFile, leaf)` pair before checking whether the file imported the leaf and never used it outside imports. If the source text does not contain the leaf at all, the existing `importedLeaves.has(leaf) && !usedLeaves.has(leaf)` expression must be false.
- **Change**: Read source text before computing full file usage, and return `false` when the source is empty or does not contain the tested leaf. Keep `computeFileLeafUsage()` unchanged for files that do contain the leaf so import-vs-use classification remains AST-backed.
- **Why**: This avoids tree-sitter parsing and cache writes for consumer-file candidates that came from broader graph/source evidence but cannot possibly be import-only consumers for the specific leaf under test. It is an output-preserving fast path because it only skips cases where neither the imported nor used leaf set can contain the leaf.

### 27.2 — Verify cold-cache timing and downstream detector hashes

- [x] **Rejected**: `src/queries/internal/consumer-evidence.ts:56-85`; `src/queries/cleanup/wrapper-candidates.ts:137-158`; `src/queries/cleanup/stale-abstractions.ts:255-267`
- **Source**: Current local post-revert reproduction after deleting only `consumer-file-usage` rows: `wrapper-candidates --json --full` 1.703s cold / 0.728s warm, sha256 prefix `f8554cd33ec065cf`; `stale-abstractions --json --full` 1.326s cold / 0.625s warm, sha256 prefix `78cc3acfe2753194`.
- **What**: Output drift is a failure. The expected improvement is lower cold first-run time and/or fewer `consumer-file-usage` rows written, with no meaningful warm regression.
- **Change**: Build, delete only local `consumer-file-usage` rows, compare wrapper/stale cold and warm hashes/timings before and after the prefilter, then repeat on Vega_2.0 if local results are promising. Run focused consumer/storage/health tests, typecheck, `scip-query similar isImportOnlyConsumer --json --full`, `scip-query recent-duplicates --json --full`, `scip-query co-change src/queries/internal/consumer-evidence.ts --json --full`, `scip-query self-audit --json`, and final freshness/diff-gate.
- **Why**: Keep only if the detector answers stay identical and the prefilter removes measurable cold-cache work.

Result:

- Rejected after measurement. Typecheck, direct consumer-evidence tests, storage/health focused tests, and build passed, and wrapper/stale output hashes stayed identical.
- The first probe immediately after reindex measured `wrapper-candidates --json --full` at 4.361s cold / 0.711s warm and `stale-abstractions --json --full` at 2.873s cold / 0.612s warm, but a repeat after surrounding caches were warm showed that spike was post-reindex warmup noise rather than the leaf prefilter itself.
- The repeated cold-cache comparison did not improve: wrapper measured 1.662s cold / 0.728s warm with 164 `consumer-file-usage` rows, and stale measured 1.409s cold / 0.634s warm with 118 rows. The prefilter wrote the same number of rows and stayed in the previous noise band, so it was reverted.

## Phase 28 — Batched Base-File Reads for Diff Gate

### 28.1 — Add a shared base-content reader backed by `git cat-file --batch`

- [x] **File**: `src/queries/impact/diff-impact.ts:258-314`
- **Source**: `scip-query plan-context fileContentAtBase`; `scip-query code 'src/queries/impact/diff-impact.ts:258-420' -C 0`; CPU profile of `diff-gate --json` showing ~1.090s self time in synchronous child-process waits; direct timing of 32 individual `git show HEAD:./<file>` calls totaling 490ms versus `git cat-file --batch` fetching the same 32 files in 18-24ms.
- **What**: `fileContentAtBase()` shells out to `git show` for one file. `detectRenamedFiles()`, `symbolPreexistenceChecker()`, and `incompleteMigration()` use it to compare changed symbols against base content. In a dirty diff with 32 indexed changed files, per-file `git show` overhead dominates a large fraction of `diff-gate`.
- **Change**: Add a `createBaseContentReader(projectRoot, base, preloadPaths)` helper next to `fileContentAtBase()`. It should prefetch unique paths through `git cat-file --batch`, parse blob payloads by size, record `null` for missing paths, and fall back to the existing `fileContentAtBase()` behavior on batch failure or for paths not in the preload set.
- **Why**: The observable answer is still "content of `<base>:./<relativePath>` or null"; only the transport changes from many git processes to one git process. Keeping `fileContentAtBase()` as the fallback preserves compatibility for existing callers and failure cases.

### 28.2 — Reuse the same reader across diff-gate and incomplete-migration

- [x] **File**: `src/queries/impact/diff-gate.ts:160-241`; `src/queries/impact/diff-gate.ts:776-793`; `src/queries/impact/incomplete-migration.ts:90-130`; `src/queries/impact/incomplete-migration.ts:383-400`
- **Source**: `scip-query plan-context diffGate`; `scip-query plan-context incompleteMigration`; `scip-query refs fileContentAtBase --json`; `scip-query refs diffImpactPlan --json`.
- **What**: `diffGate()` builds one `symbolPreexistenceChecker()` cache for echo/new-dead, while `incompleteMigration()` builds a separate `baseContent` cache inside `newCallablesInDiff()`. Both answer the same question for the same base and changed files.
- **Change**: In `diffGate()`, create one base-content reader after `impactPlan` is known, preloading indexed changed files and rename sources. Pass it into `symbolPreexistenceChecker()` through an optional parameter and into `incompleteMigration()` through an optional `baseContentAt` option. Keep direct `incompleteMigration()` CLI/API calls working by defaulting to the existing per-file `fileContentAtBase()` path when no reader is supplied.
- **Why**: This removes duplicated base-content git work inside `diff-gate` without changing direct `incomplete-migration` semantics. The helper is a two-way internal optimization: callers can omit it and get the old behavior.

### 28.3 — Verify diff-gate output, timings, and fallback behavior

- [x] **File**: `src/queries/impact/diff-impact.ts:258-314`; `src/queries/impact/diff-gate.ts:188-235`; `src/queries/impact/incomplete-migration.ts:115-130`
- **Source**: Current local warm timings: `diff-impact --json` 0.789-0.815s; `diff-gate --json` 2.168-2.231s with 0 findings and checks `echo`, `incomplete-migration`, `co-change-partner`, `doc-reference`, `unused-params`, `new-dead`.
- **What**: Output drift is a failure. `git cat-file --batch` parsing must correctly handle missing paths and file contents that include arbitrary newlines.
- **Change**: Add or extend tests around base-content reading and incomplete-migration/diff-gate behavior, run typecheck/build, compare `diff-gate --json` hashes before/after, benchmark repeated `diff-gate --json`, run `scip-query similar createBaseContentReader --json --full`, `scip-query recent-duplicates --json --full`, `scip-query co-change src/queries/impact/diff-impact.ts --json --full`, `scip-query co-change src/queries/impact/diff-gate.ts --json --full`, `scip-query self-audit --json`, then final freshness and `scip-query diff-gate --json`.
- **Why**: Keep only if dirty-diff `diff-gate` gets measurably faster with identical JSON and the direct migration APIs remain compatible.
- **Result**: Accepted after measurement. `npm run typecheck`, focused impact tests, and `npm run build` passed. Rebuilt CLI `diff-gate --json` returned 0 findings with the same six default checks and measured 2.644s on the first post-build run, then 0.991s / 0.988s warm, 5,213 bytes, sha256 prefix `d84f0cc47bae8923`. The pre-change warm baseline for the same dirty-worktree class was 2.168-2.231s, so the shared `git cat-file --batch` reader cuts warm diff-gate time by roughly 54% while preserving the gate result shape.

## Phase 29 — Read-Optimized SQLite Connections

### 29.1 — Apply read-heavy SQLite PRAGMAs to `ScipDatabase`

- [x] **File**: `src/storage/db.ts:37-49`
- **Source**: `scip-query plan-context ScipDatabase`; external comparison with `flesler/scip-cli` commit `3d6678631f18e2057565016f3f17816d5ce182ef`, where `scip_cli/sql.py` configures read connections with `query_only`, memory temp store, larger cache, and mmap.
- **What**: `ScipDatabase` opens the better-sqlite3 connection readonly and only sets `busy_timeout = 5000`. Every CLI query process goes through this constructor, so read connection setup is a central performance lever.
- **Change**: Add `query_only = ON`, `temp_store = MEMORY`, `cache_size = -64000`, and `mmap_size = 268435456` immediately after the existing busy timeout. This mirrors the safe read-only subset from `flesler/scip-cli` without adopting its destructive index-column trimming.
- **Why**: These settings let SQLite keep temporary query work in memory, use a larger page cache, and memory-map the index file. They preserve query results and do not remove schema fields that scip-query uses for signatures, hierarchy, language detection, and source snippets.
- **Result**: Accepted after measurement. The PRAGMAs apply cleanly to the current readonly SQLite index. `npm run typecheck`, focused storage/CLI/impact tests, and `npm run build` passed. Median rebuilt CLI timings over five runs: `health --json` 1.964s, `dead --json --full` 1.168s, `diff-gate --json` 1.097s, `wrapper-candidates --json --full` 0.713s. Output hashes stayed stable within each command. The gain is modest, but it is broad, low-risk read-path tuning and keeps the richer scip-query schema intact.

## Stress Test

- **Understand**: The plan targets measured hot paths rather than speculative micro-optimizations.
- **Blast radius**: Command registration and health orchestration are medium-risk CLI surfaces; query semantics for `kind-counts` must be checked by existing tests and a direct command comparison.
- **Intermediate validity**: Each phase is independently buildable: bench command, kind-counts fast path, health parallelization.
- **Failure**: Benchmark subprocesses must record nonzero exits and timeouts without crashing the whole report unless the benchmark command itself cannot run.
- **Concurrency**: Parallel health uses readonly DB access; concurrency is bounded to avoid overwhelming large repos.
- **Observability**: `bench --json` exposes durations, exit codes, output sizes, indexed files, repo files, and index freshness.
