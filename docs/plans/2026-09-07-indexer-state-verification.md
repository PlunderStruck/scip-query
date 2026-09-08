# Incremental indexer state verification

Status: complete. Base: `76329d66`. No agent benchmarks.

## Purpose and guarantees

A history is an ordered sequence of repository edits, indexing requests, reader observations and interruptions. A model is a small independent record of the source files and accepted snapshots that those actions should produce. We will check the real implementation against that record and against a separately rebuilt compiler index.

- After successful processing of stable inputs, incremental indexed facts match a clean rebuild from the same source bytes.
- A reader observes one complete published generation; an existing reader retains its accepted snapshot while new readers can open the next one.
- Failure before the authoritative pointer changes preserves the previous accepted generation. Failure after it changes may expose the complete new generation; stable mirrors need not already match.
- Moving inputs and obsolete work cannot silently publish results as current.
- After interruption, a new process can rediscover edits and recover to current results without manual cache deletion.
- Test failures are reproducible; injected defects must be caught by the same behavioral assertions.

## Existing flow

`reindex` (`src/reindex/index.ts:422`) builds a project input fingerprint, acquires lifecycle/publication locks, upgrades legacy artifacts, checks reuse, and calls `runFreshReindex`. TypeScript incremental materialization (`src/reindex/typescript-incremental-index.ts`) owns affected-file selection, the compiler request, and persisted overlays. `publishFreshReindexArtifacts` (`src/reindex/index.ts:1810`) materializes SQLite, augments relationships, validates coverage and unchanged inputs, then calls `promoteReindexArtifacts` (`src/reindex/sqlite-generation-store.ts:140`). Publication materializes an immutable artifact set, atomically writes `.scipquery-generations/state.json`, then replaces SCIP, database and metadata mirrors. `ScipDatabase` owns a connection and generation reader lease. The reindex finally block releases locks and removes its work directory; a killed process cannot execute that block.

## Comparable features and conventions

- `tests/properties/indexing-compiler.ts` compares real compiler fragments with `tests/fixtures/typescript-oracle.ts`, but supplies all fixture files as affected. Retain it as component coverage.
- `tests/properties/indexing.property.test.ts` checks manifests, affected-set planning and SQLite patches separately, with bounded generators and replay receipts from `support.ts`.
- `tests/reindex/reindex-reliability.test.ts` exercises dispatch/failure paths with mocked producers; new tests must retain actual producers and publication.
- Publication already has explicit handoff stages. Tests can control external filesystem/process boundaries without adding a second publication implementation or test behavior to the product.

## Reuse and ownership

Add test fixtures and indexer history suites under `tests/`. Reuse `reindex`, `ScipDatabase`, compiler oracle and the existing property runner/receipts. Use real temporary repositories and isolated child processes; bound child lifetime and clean up all owned resources. Fault injection belongs only in test processes. Production changes require a demonstrated failing regression.

## Worklist

- [x] Build an actual reindex-to-reader fixture and compare relational facts with clean compiler output; assert incremental publication is really exercised.
- [x] Generate edit histories covering dependency changes, renames/deletion, syntax repair, configuration changes and no-op/revert sequences; check every successful checkpoint.
- [x] Enumerate a stated finite set of short histories completely and record its bounds/count.
- [x] Exercise selected completion schedules: edits before publication, queued competing requests, cancellation, existing/new readers.
- [x] Kill real child processes before/after durable publication boundaries, inject I/O failures, restart using leftover artifacts and verify recovery.
- [x] Inject controlled implementation defects and prove the behavioral checks reject them.
- [x] Run focused/thorough suites and required type/lint/build/API/full tests; review diff impact and record exact results and remaining limits.

## Limits

Finite tests cannot cover arbitrary programs or OS schedules. Clean rebuild comparisons target incremental consistency and still share compiler semantics; independent fixture facts provide additional checks. Process death is not a machine power-loss simulation. Generated case counts, enumerated histories, crash checkpoints and deliberate defects must be reported separately.

## Findings during implementation

1. **Confirmed production defect, fixed:** delete an imported owner, publish that deletion, then restore the owner. `planTypeScriptIncrementalAffectedSet` previously scheduled only the added document, leaving importer/reexport references unresolved. The old graph cannot enumerate consumers whose imports were unresolved. Additions now require a project refresh through the existing incremental compiler service. The all-kinds history failed at `restore(7)` before the fix and passed after it. Existing unit expectations that blessed added-file-only work were corrected.
2. **Fixture lifecycle correction:** a synchronous stop loop in the same process that spawned the daemon can observe its unreaped child as alive. The fixture now sends SIGTERM, yields while its owned child exits, then calls the existing stop cleanup. This is a harness lifetime issue in this test; no production daemon-stop guarantee is inferred from it.
3. **Fault checks exercised:** actual SIGKILL before/after pointer publication and during stable mirror replacement; ENOSPC before pointer and before database mirror; input mutation while conversion is paused; cancellation before conversion. All initial checks passed. These do not simulate machine power loss.
4. **Negative controls exercised:** deliberately removing dependent files from the production affected plan, and deliberately retaining old SQLite rows in the candidate, both cause the normal clean-build assertion to fail. These defects are injected only in the isolated test runtime and restored in finally blocks.


## Validation progress

- 30 generated system histories passed (seed `20260908`, 166.9 seconds); each contains a required real incremental dependency-identity change plus 3–12 generated actions.
- Exhaustive alphabet `{function, constant, delete}` through length three: 39 histories, 102 edit checkpoints, passed in 94.0 seconds.
- Five SIGKILL checkpoints, two ENOSPC checkpoints, moving-input rejection, cancellation, automatic watcher catch-up and watcher retry after lock contention passed.
- Both deliberate defects were caught by the same compiler-fact comparison used by ordinary histories.
- Full lint/build/API checks and TypeScript checks passed. Source review: 568/568 eligible files, 13,568 functions, zero findings/problems. CRAP is unavailable without source-matched coverage.
- Final full repository suite: **3,363 tests / 387 files passed**, 262.68 seconds, against the fresh build. Log: `/tmp/scip-query-indexer-full-tests-final.log`. Final changed test fixtures also passed focused lint, formatting and property type checks.
- [Machine-readable results](2026-09-07-indexer-state-results.json) retain the property seed/replay receipt and separate enumeration/fault counts.

5. **Fixture scheduling correction:** the first full run passed 3,362 tests and failed the new competing-writer test. Reindex acquires an outer lifecycle lock that waits before reaching the inner lock's rejection branch. Awaiting that competing call in the parent prevented the test from releasing its paused writer. The corrected test uses two real child writers: both fingerprint their inputs, the successor waits, the older moving-input build rejects, then the successor publishes current results. This is a test assumption failure, not another production defect.


## Final assessment

The new verification found and fixed one production indexing defect. Thirty generated histories and all 39 bounded short histories passed; five real writer-death checkpoints, two I/O failures, cancellation, serialized competing writers, automatic filesystem refresh and watcher retry are exercised by the normal suite. Both deliberate mutations are detected. The public API remains `b74137d6c422ca9c` across 66 paths. No thresholds, suppressions or skills changed. Newly added TypeScript source files require more compiler work because the prior resolved graph cannot prove which formerly unresolved imports they affect; ordinary edits retain the narrower dependency-based path.

Coverage remains bounded: this does not prove all TypeScript programs, configurations, providers, daemon/worker crash timings, OS schedules or power-loss behavior. The real process-death checks target the reindex writer; service restart checks terminate the daemon normally. Full lifecycle histories, enumeration and fault checks are reported separately from the earlier 1.6-million component-case run. Hosted CI, VM installation and agent benchmarks were not run for this change.
