# Bench Subprofiling Plan - 2026-06-28

## Goal

Add a first profiling layer for performance work without rerunning the whole
heavy Vega matrix. Done means `scip-query bench --command "similar --json
--full" --progress --profile --profile-out <file>` streams command progress,
writes incremental JSONL records, and captures internal `similarAll()` spans
that reveal where the long cold run spends time.

## Current State

`handleBench()` creates a `BenchReport`, optionally measures cold/warm indexing,
then loops over `benchCommandMatrix(opts)` and pushes each `runBenchCommand()`
result into `report.commands`. It prints JSON only after all commands finish, so
long runs are opaque until the end. Source: `scip-query plan-context
handleBench`.

`runBenchCommand()` wraps each command in one `spawnSync()` call and records only
total duration, exit status, timeout, and stdout/stderr byte counts. Source:
`scip-query plan-context runBenchCommand`.

`similarAll()` builds a callee fingerprint index, walks the corpus, gathers
candidate pairs from shared callees, compares pairs, and returns sorted top
results. Source: `scip-query trace similarAll`.

`getCalleeFingerprintIndex()` memoizes the index by options, building it from
`getAllCalleeFingerprints()` on cache miss. Source: `scip-query code
getCalleeFingerprintIndex -C 8`.

`buildCalleeFingerprints()` loads production callable definitions, builds a
callee map, converts each definition into a fingerprint, and filters by
`minCallees`. Source: `scip-query code buildCalleeFingerprints -C 8`.

## Reuse Audit

- Reuse `commandOptions()`, `booleanOptionValue()`, `stringOptionValue()`, and
  `numberOptionValue()` for new bench options. Source: `scip-query
plan-context handleBench`; `scip-query code
src/runtime/commands/command-execution.ts:180-204`.
- Reuse `option()` and `parsePositiveInteger` for new descriptor options.
  Source: `scip-query code src/runtime/commands/command-spec-builders.ts:1-80`;
  `scip-query code src/runtime/commands/command-descriptors.ts:100-125`.
- Add a new profiler helper instead of reusing existing `*profile*` source
  files, because `scip-query files profile` found health detector and
  frontend behavior profile modules, not runtime timing instrumentation.

## Design Phases

### 1. Add Runtime Profile Spans

- [x] **File**: `src/instrumentation/profile.ts`
- **Source**: `scip-query files profile`; `scip-query code
src/runtime/commands/command-handlers.ts:1-80`; moved from
`src/runtime/profile.ts` during the 2026-06-30 health cleanup.
- **What**: There is no general runtime span helper; command modules currently
  import Node APIs and local helpers directly.
- **Change**: Add a small env-gated profiler with `profileEnabled()`,
  `profileSpan(name, fn, metadata?)`, `profileSpanAsync(...)`, and
  `writeProfileEvent(...)`. Write JSONL to `SCIP_QUERY_PROFILE_OUT` when set;
  otherwise write compact JSON events to stderr only when profiling is enabled.
- **Why**: Bench child commands need a process-local way to emit stage spans
  without changing normal command stdout.

### 2. Stream Bench Progress And Incremental History

- [x] **File**: `src/runtime/commands/command-handlers.ts:249-423`
- **Source**: `scip-query code
src/runtime/commands/command-handlers.ts:249-423`; `scip-query plan-context
runBenchCommand`
- **What**: Bench records one command duration after `spawnSync()` returns and
  emits the full report at the end.
- **Change**: Extend `BenchCommandRun` with optional `profilePath`. Add bench
  options for `--progress`, `--profile`, and `--profile-out <path>`. Before
  each command, print a progress line to stderr when requested. After each
  command, print completion with duration/exit and append one JSONL command
  record to the output file. When profiling is enabled, pass
  `SCIP_QUERY_PROFILE=1`, `SCIP_QUERY_PROFILE_COMMAND`, and a per-command
  `SCIP_QUERY_PROFILE_OUT` path into the child process.
- **Why**: Long heavy runs need live visibility and durable partial data even
  if the process is interrupted.

### 3. Add Bench CLI Options

- [x] **File**: `src/runtime/commands/command-descriptors.ts:108-121`
- **Source**: `scip-query code
src/runtime/commands/command-descriptors.ts:100-125`
- **What**: `bench` exposes `--json`, `--cold-index`, `--include-heavy`,
  repeated `--command`, and `--timeout-ms`.
- **Change**: Add `--progress`, `--profile`, and `--profile-out <path>` to the
  bench descriptor.
- **Why**: Users need to request profiling/progress without changing default
  behavior.

### 4. Instrument Similar First

- [x] **File**: `src/queries/cleanup/similar.ts:205-535`
- **Source**: `scip-query trace similarAll`; `scip-query code
getCalleeFingerprintIndex -C 8`; `scip-query code buildCalleeFingerprints -C
8`; `scip-query code buildCalleeFingerprintIndex -C 8`
- **What**: The long `similar --json --full` command currently has no internal
  timing breakdown around corpus/index build or pair scoring.
- **Change**: Wrap `similarAll()` phases in spans: callee fingerprint index,
  pair search/compare loop, final sort/project. Wrap `buildCalleeFingerprints()`
  substeps: production callable candidates, callee map, fingerprint shaping.
  Wrap `buildCalleeFingerprintIndex()` substeps: document frequency/IDF,
  weighted magnitudes, candidate index, median/return assembly.
- **Why**: The first targeted run should explain the 322s cold-heavy
  `similar --full` time without running the full matrix.

## Stress Test

- Understand before touching: the implementation only adds optional
  observability; normal stdout and command results remain unchanged.
- Blast radius: `command-handlers.ts` has one descriptor consumer, while
  `similarAll()` has health, baseline, recent-duplicates, and CLI consumers.
  Source: `scip-query plan-context handleBench`; `scip-query plan-context
similarAll`.
- Intermediate validity: each phase is additive and env/flag-gated.
- Failure design: profile JSONL write errors should not corrupt command output;
  emit a warning to stderr and continue.
- Boundaries: only explicit CLI flags/env vars enable profiling.
- Data integrity: profile files are append-only JSONL outside the index DB.
- Observability: progress lines and JSONL events include command, duration,
  exit status, and span metadata.
- Human experience: default bench output is unchanged; progress goes to stderr
  so `--json` stdout stays machine-readable.
- Reuse: option parsing and command descriptor helpers follow existing
  patterns cited above.

## Verification

1. `npm run build`
2. `npm run typecheck`
3. Targeted tests for bench option parsing/report shape and profile helper
4. `node dist/cli.js bench --json --command "similar --json --full" --profile
--profile-out /tmp/scip-query-similar-profile.jsonl --timeout-ms 600000` on
   Vega_2.0
5. Confirm stdout JSON remains valid and profile JSONL contains command and
   `similar.*` span records.
6. `scip-query reindex`
7. `scip-query diff-impact --json`
8. `scip-query diff-gate --json`

## Result

The first profiled cold Vega run proved that profiling overhead was not the
root problem: cold profiled `similar --json --full` took 291.197s, while the
cold unprofiled control took 298.781s. Both emitted 88,859 bytes.

The accepted follow-up optimization kept the same output size, SHA-256
`59463f5501cf8870e8a8d02d55edf02f065bd42709c183d799b5e3ebd51241bf`,
`corpusSize: 922`, and `insertedResults: 42`, while cutting the cold unprofiled
run to 12.047s and the cold profiled run to 13.628s.

The profile identified repeated TypeScript checker access as the decisive
pre-fix bottleneck: `checkerLookupMs` consumed 188.862s in the path-indexed
diagnostic run. The accepted fix preloads indexed source files before checker
creation, caches the raw TypeScript checker per project, batches semantic
callee extraction by provider, and uses raw compiler AST traversal for call
nodes.

The syntactic `minCallees` prefilter was rejected because it changed the
observable result: corpus 922 -> 912 and output 88,859 -> 88,858 bytes.
