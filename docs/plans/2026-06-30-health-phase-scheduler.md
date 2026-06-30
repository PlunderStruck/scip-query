# Health Phase Scheduler — 2026-06-30

## Goal

The user wants the eleventh structural optimization item completed in register order. A health phase scheduler means the runtime mechanism that takes named analysis work units, groups compatible units, chooses bounded concurrency, runs isolated subprocesses when needed, and returns results in the caller's expected order. The real-world referents are the health command's frontend/source/graph phases and diff-impact's changed-file batches; the wider class is a composite command scheduler; the essential distinction is that it owns execution policy while leaving analyzer-specific result policy in the caller.

Done means health and diff-impact share the reusable scheduler mechanics that have a real cross-command boundary: grouped task construction, ordered concurrent execution, and async isolated JSON subprocesses. Health-specific applicability, skipped-result rules, and command-specific adaptive concurrency env keys stay near health CLI support. Command outputs must remain stable once input/index drift is accounted for, and benchmark/timing checks must show no obvious regression from the extraction.

## Current State

- `node dist/cli.js status --capabilities` reported a fresh TypeScript index before planning.
- `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json` returned no findings, so the register entry is still current.
- `node dist/cli.js recent-duplicates --json` returned no findings before this slice.
- `src/queries/health/health.ts:53-75` declares `HEALTH_PHASES` and `HealthPhaseName`; `src/queries/health/health.ts:77-103` declares the phase result and runner shapes; `src/queries/health/health.ts:105-183` maps each phase name to its analyzer. Source: `node dist/cli.js code 'src/queries/health/health.ts:39-120'`, `node dist/cli.js code 'src/queries/health/health.ts:105-193'`.
- `src/queries/health/health.ts:195-200` builds the full health report by running all phases through `withHealthRun()` and `runHealthAnalyses()`. Source: `node dist/cli.js plan-context health`, `node dist/cli.js code runHealthAnalyses -C 8`.
- `src/queries/health/health.ts:202-219` exposes `healthPhase()` and `healthPhases()` for isolated child processes; grouped phases share caches by forcing `releaseCachesBetweenPhases: false`. Source: `node dist/cli.js code healthPhase -C 8`, `node dist/cli.js code healthPhases -C 8`.
- `src/queries/health/health.ts:221-234` computes stats and budget once and clears whole-project evidence caches plus requests garbage collection after the run. Source: `node dist/cli.js code withHealthRun -C 8`.
- `src/queries/health/health.ts:641-653` releases caches after individual phases when the budget requests it. Source: `node dist/cli.js code runHealthPhase -C 8`.
- `src/runtime/cli-support.ts:110-133` runs the CLI health report by computing framework applicability and overview in the parent process, synthesizing skipped frontend phase results, grouping runnable phases, running isolated child processes with bounded concurrency, and reassembling phase results in `HEALTH_PHASES` order. Source: `node dist/cli.js plan-context runIsolatedHealthReport`.
- `src/runtime/cli-support.ts:139-168` contains health-specific applicability and grouping rules: React phases group together, Vue phases group with suppressions, and `similar` groups with `extract-candidates`. Source: `node dist/cli.js code 'src/runtime/cli-support.ts:135-218'`.
- `src/runtime/cli-support.ts:189-218` turns one health task or a grouped health task into a child `__health-phase` JSON subprocess. Source: `node dist/cli.js code 'src/runtime/cli-support.ts:135-218'`.
- `src/runtime/cli-support.ts:229-301` locally owns async isolated JSON process execution and ordered `mapWithConcurrency()`. Source: `node dist/cli.js code 'src/runtime/cli-support.ts:220-309'`.
- `src/runtime/cli-support.ts:305-309` and `src/runtime/cli-support.ts:477-512` locally own adaptive concurrency resolution for health phases and diff-impact batches. Source: `node dist/cli.js code mapWithConcurrency -C 8`, `node dist/cli.js code createAdaptiveConcurrencyResolver -C 8`.
- `src/runtime/cli-support.ts:454-529` uses the same local ordered concurrency and async subprocess runner for diff-impact batches. Source: `node dist/cli.js plan-context runIsolatedDiffImpactReport`, `node dist/cli.js code 'src/runtime/cli-support.ts:454-529'`.
- `src/runtime/isolated-analysis-runner.ts:1-37` already owns the synchronous JSON subprocess handoff and `chunked()` batch slicing; it has two external consumers and is the closest existing runtime execution boundary. Source: `node dist/cli.js code 'src/runtime/isolated-analysis-runner.ts:1-180'`, `node dist/cli.js change-surface src/runtime/isolated-analysis-runner.ts`.
- `tests/runtime/cli-support.test.ts:46-156` currently pins adaptive concurrency, health task grouping, framework phase pruning, skipped frontend result synthesis, and diff-impact concurrency. Tests are not indexed by scip-query; line references were read directly.

Non-obvious invariants to preserve:

- Health report assembly must retain `HEALTH_PHASES` order even though child processes finish concurrently. Source: `node dist/cli.js plan-context runIsolatedHealthReport`.
- The overview phase must stay parent-process work because it supplies the parent health report's stable stats and warnings before isolated child phases run. Source: `node dist/cli.js code runIsolatedHealthReport -C 8`.
- Grouped health phases must use `healthPhases()` rather than multiple `healthPhase()` calls so compatible phases can share caches inside one child process. Source: `node dist/cli.js code healthPhases -C 8`, `node dist/cli.js code 'src/runtime/cli-support.ts:189-218'`.
- Health-specific skipped-result synthesis must stay health-specific because only frontend phases can be omitted safely. Source: `node dist/cli.js code 'src/runtime/cli-support.ts:170-187'`.
- Diff-impact batching must preserve changed-file order before merging partials. Source: `node dist/cli.js plan-context runIsolatedDiffImpactReport`.
- Child process failures must surface stderr in the parent error and invalid JSON must become a labeled error, matching the current `runIsolatedJsonProcessAsync()` behavior. Source: `node dist/cli.js code 'src/runtime/cli-support.ts:220-309'`.

## Reuse Audit

- Reuse and extend `src/runtime/isolated-analysis-runner.ts` instead of adding a second subprocess/scheduler module. It already owns `runIsolatedJsonProcess()` and `chunked()` as the runtime isolation boundary. Source: `node dist/cli.js code 'src/runtime/isolated-analysis-runner.ts:1-180'`, `node dist/cli.js surface src/runtime`.
- Move the local `mapWithConcurrency()` behavior into that scheduler owner as `runAnalysisTasks()`. `node dist/cli.js refs mapWithConcurrency` showed two consumers: health phases and diff-impact batches.
- Keep the tiny `createAdaptiveConcurrencyResolver()` factory private in `src/runtime/cli-support.ts`. The first implementation exported it from `isolated-analysis-runner.ts`, but `node dist/cli.js wrapper-candidates --json` correctly flagged it as a single-module wrapper. The final design treats adaptive env-key selection as command policy until another runtime module needs it.
- Move the local `runIsolatedJsonProcessAsync()` behavior into that scheduler owner. `node dist/cli.js similar runIsolatedJsonProcessAsync --json` found no existing duplicate; the sync runner in `isolated-analysis-runner.ts` is the reuse target, but async child-process streaming is still needed for concurrent health/diff-impact work.
- Add a generic grouped-task helper in `isolated-analysis-runner.ts` and use it from `healthPhaseTasks()`. The grouping algorithm is currently health-local at `src/runtime/cli-support.ts:148-168`; the health-owned phase sets remain in `cli-support.ts` so scheduler code does not learn React/Vue policy.
- `node dist/cli.js similar runIsolatedHealthReport --json` found `runIsolatedDiffImpactReport()` as the nearest similar flow, with mixed access/query scaffolding. That supports extracting the scheduler mechanics while leaving each command's planning/result merge logic separate.
- `node dist/cli.js similar-files src/runtime/cli-support.ts --json` and `node dist/cli.js similar-files src/runtime/isolated-analysis-runner.ts --json` found no structurally similar file to reuse wholesale.

## Baseline Hashes And Timings

These hashes were captured before item 11 edits. The two grouped health-phase hashes are the strongest byte-for-byte scheduler-contract checks because they exercise grouped child-process execution without top-level health overview/index-stat drift:

- `health --json`: `baf5d53e67db328c81d1b7348879916e7566aefdc26c2668200c8bddb5cbbe8c`
- `health --full --json`: `a01988d577fb395fc1b7bcd375cb8f39ba3732631aa35c7bf32ae7620ad4ed1e`
- `diff-impact --json`: `6af430d44fa0a812b15289260007d0556286bbc4c34209dca939f3d6a0142a6e`
- `__health-phase similar,extract-candidates --full`: `7f4b4b3250fb2f1d2c230104b26ba98c7572651c5d017810e9290aca9c343f14`
- `__health-phase react-component-duplicates,react-hook-candidates,react-large-component-pressure --full`: `7017edc402e5ec28f9905e7444b549bd006d139367c6d3537fbe712e92be81d6`

Three-run timing sample before extraction:

- `health --json`: `1122,1564,1019`, average `1235ms`
- `diff-impact --json`: `682,680,676`, average `679ms`
- `__health-phase similar,extract-candidates --full`: `342,344,341`, average `342ms`

## Design Phases

### 1.1 — Promote runtime scheduler mechanics

- [x] **File**: `src/runtime/isolated-analysis-runner.ts:1-132`
- **Source**: `node dist/cli.js code 'src/runtime/isolated-analysis-runner.ts:1-180'`, `node dist/cli.js change-surface src/runtime/isolated-analysis-runner.ts`
- **What**: The module only exposes synchronous JSON subprocess execution and `chunked()` batch slicing.
- **Change**: Add async JSON subprocess execution, ordered concurrent task execution, and generic grouped-task construction. Keep the same stderr, buffer-limit, and invalid-JSON failure messages as `src/runtime/cli-support.ts:229-301`. Leave adaptive concurrency resolver creation in `cli-support.ts` after the wrapper check proved it is still command-local policy.
- **Why**: Scheduler mechanics become a reusable runtime primitive while preserving the existing subprocess boundary.

### 1.2 — Route health and diff-impact through the scheduler

- [x] **File**: `src/runtime/cli-support.ts:1-59`
- **Source**: `node dist/cli.js code 'src/runtime/cli-support.ts:1-100'`
- **What**: `cli-support.ts` imports `spawn` and `availableParallelism`, defines scheduler-only types, and imports only `chunked()` from `isolated-analysis-runner.ts`.
- **Change**: Remove direct `spawn` import. Import `groupAnalysisTasks`, `runAnalysisTasks`, and `runIsolatedJsonProcessAsync` from `isolated-analysis-runner.ts`. Keep `availableParallelism`, `HEALTH_PHASE_COMMAND`, `DIFF_IMPACT_BATCH_COMMAND`, health phase sets, adaptive concurrency resolver creation, and CLI option types in this file.
- **Why**: CLI support should retain command policy, not own generic scheduling machinery.

- [x] **File**: `src/runtime/cli-support.ts:113-151`
- **Source**: `node dist/cli.js plan-context runIsolatedHealthReport`, `node dist/cli.js code 'src/runtime/cli-support.ts:135-218'`
- **What**: Health computes runnable tasks locally and uses `mapWithConcurrency()` to run them.
- **Change**: Keep applicability, skipped results, and health phase sets in this file. Change `healthPhaseTasks()` to delegate grouping mechanics to `groupAnalysisTasks()`. Change `runIsolatedHealthReport()` to call `runAnalysisTasks(runnableTasks, healthPhaseConcurrency(runnableTasks.length), task => runHealthPhaseTaskProcess(task, opts))`.
- **Why**: The reusable scheduler owns ordering/concurrency; health still owns which phases are runnable and which phases can be grouped.

- [x] **File**: `src/runtime/cli-support.ts:172-205`
- **Source**: `node dist/cli.js code 'src/runtime/cli-support.ts:189-309'`
- **What**: Health child-process launch uses local async subprocess code; local `mapWithConcurrency()` follows it.
- **Change**: Keep `runHealthPhaseTaskProcess()` and `runHealthPhaseProcess()` because their labels, command names, and arguments are health-specific. Delete local `AsyncIsolatedJsonProcessOptions`, `runIsolatedJsonProcessAsync()`, and `mapWithConcurrency()`.
- **Why**: This removes the command-local scheduler implementation without changing health child-process payloads.

- [x] **File**: `src/runtime/cli-support.ts:354-429`
- **Source**: `node dist/cli.js plan-context runIsolatedDiffImpactReport`, `node dist/cli.js code 'src/runtime/cli-support.ts:454-529'`
- **What**: Diff-impact uses the same local `mapWithConcurrency()`, local adaptive resolver factory, and local async subprocess helper.
- **Change**: Use `runAnalysisTasks()` for batches; keep `chunked()`, `diffImpactBatchConcurrency`, `createAdaptiveConcurrencyResolver()`, `adaptiveConcurrency()`, `defaultAdaptiveConcurrency()`, and `runDiffImpactBatchProcess()` as CLI/diff-impact policy.
- **Why**: Diff-impact becomes the second scheduler consumer, proving the extraction is structural rather than health-only.

### 1.3 — Test the scheduler contract

- [x] **File**: `tests/runtime/isolated-analysis-runner.test.ts:1-78` (new test file; tests are not indexed by scip-query)
- **Source**: `node dist/cli.js change-surface src/runtime/isolated-analysis-runner.ts`, `node dist/cli.js code 'src/runtime/isolated-analysis-runner.ts:1-180'`
- **What**: There is no direct unit coverage for the scheduler owner today.
- **Change**: Add tests for `runAnalysisTasks()` preserving input order under out-of-order completion, `groupAnalysisTasks()` preserving first-seen group order and singleton tasks, and `runIsolatedJsonProcessAsync()` parsing JSON from a small temporary child script. Keep adaptive concurrency coverage in `tests/runtime/cli-support.test.ts`.
- **Why**: The extracted scheduler is a shared runtime contract; direct tests make future composite commands safer.

- [x] **File**: `tests/runtime/cli-support.test.ts:46-156`
- **Source**: direct test-file read; source behavior traced with `node dist/cli.js code 'src/runtime/cli-support.ts:135-218'` and `node dist/cli.js code createAdaptiveConcurrencyResolver -C 8`
- **What**: Existing tests cover health and diff-impact concurrency through `cli-support.ts`, plus health grouping and skipped frontend results.
- **Change**: Keep these tests passing without changing expected results. Add a narrow assertion only if the generic grouping helper changes the observable grouping contract.
- **Why**: Existing tests pin the command-specific policy that should remain in `cli-support.ts`.

### 1.4 — Verify outputs and benchmark extraction cost

- [x] **File**: command output fixtures in `/tmp` (verification artifact)
- **Source**: baseline hashes listed above; affected entry points from `node dist/cli.js plan-context runIsolatedHealthReport`, `node dist/cli.js plan-context runIsolatedDiffImpactReport`
- **What**: The affected user-facing commands are health, diff-impact, and internal grouped health-phase subprocesses.
- **Change**: Rerun the five baseline hash commands after migration. Require exact hash matches for grouped internal phase payloads. For top-level `health` and `diff-impact`, record expected input drift when the indexed codebase or changed-file set changes during the item.
- **Why**: Scheduler extraction must not change the reports or child-process JSON payloads.

- [x] **File**: timing fixtures in `/tmp` (verification artifact)
- **Source**: register item 11 says previous health scheduler variants were rejected despite output preservation.
- **What**: The baseline timing sample is roughly `1235ms` for `health --json`, `679ms` for `diff-impact --json`, and `342ms` for the grouped similar/extract phase.
- **Change**: Rerun the same three-command timing sample after migration. Treat a large slowdown as a regression even if hashes match.
- **Why**: This item exists because scheduler generalization can become framework tax; timing protects against that failure mode.

## Stress-Test Findings

1. Understand before touch: health has two execution paths: in-process query functions and CLI-isolated phase execution. Source: `node dist/cli.js plan-context health`, `node dist/cli.js plan-context runIsolatedHealthReport`.
2. Blast radius: `runIsolatedHealthReport()` affects `handleHealth()`, setup health, and setup; `runIsolatedDiffImpactReport()` affects `handleDiffImpact()`. Source: `node dist/cli.js affected runIsolatedHealthReport`, `node dist/cli.js affected runIsolatedDiffImpactReport`.
3. Valid intermediate states: adding scheduler functions to `isolated-analysis-runner.ts` is additive; routing health and diff-impact can happen after the exports exist.
4. Reversibility: this is an internal refactor. Rollback means moving the scheduler functions back to `cli-support.ts` and restoring the old imports.
5. Failure design: the async subprocess helper must preserve current stderr, stdout/stderr buffer, process error, and invalid JSON behavior. Source: `node dist/cli.js code 'src/runtime/cli-support.ts:220-309'`.
6. Concurrency: ordered result slots are the key shared mutable state. `runAnalysisTasks()` must write each result at its original index, matching current `mapWithConcurrency()`. Source: `node dist/cli.js code mapWithConcurrency -C 8`.
7. Boundaries: no CLI command names, hidden command names, JSON shapes, or query exports change. Source: `node dist/cli.js code 'src/runtime/commands/command-handlers.ts:203-260'`, `node dist/cli.js code 'src/queries/index.ts:1-90'`.
8. Data integrity: no persistent data or schema changes.
9. Observability: child-process labels remain health/diff-impact-specific, so failures still name the specific phase or batch.
10. Human impact: health and diff-impact output must remain byte-identical; users should only see the same reports.
11. Reuse: the extraction extends `isolated-analysis-runner.ts` and uses both health and diff-impact as consumers; it does not invent scheduler policy inside a detector.

## Verification

- Focused tests: `npx vitest run tests/runtime/isolated-analysis-runner.test.ts tests/runtime/cli-support.test.ts` passed, 2 files and 13 tests.
- Typecheck: `npm run typecheck` passed.
- Build: `npm run build` passed.
- Item-specific format check: `npx prettier --check src/runtime/isolated-analysis-runner.ts src/runtime/cli-support.ts tests/runtime/isolated-analysis-runner.test.ts tests/runtime/cli-support.test.ts docs/plans/2026-06-30-health-phase-scheduler.md` passed.
- Output hashes before reindex: `health --json`, `health --full --json`, `__health-phase similar,extract-candidates --full`, and the grouped React health phase hash matched the pre-change baselines. `diff-impact --json` changed because item 11 itself added/modified files, so the command's changed-file input changed.
- Output hashes after reindex: the two grouped health-phase payload hashes still matched exactly:
  - `__health-phase similar,extract-candidates --full`: `7f4b4b3250fb2f1d2c230104b26ba98c7572651c5d017810e9290aca9c343f14`
  - `__health-phase react-component-duplicates,react-hook-candidates,react-large-component-pressure --full`: `7017edc402e5ec28f9905e7444b549bd006d139367c6d3537fbe712e92be81d6`
- Top-level `health` hashes changed after reindex because the indexed codebase changed during the item; the health report still returned `score: 99`, `riskScore: 100`, `hygieneScore: 99`, wrappers `0`, and wrapper score count `0`.
- Timing sample after extraction:
  - `health --json`: `1096,1249,1101`, average `1149ms` versus baseline `1235ms`
  - `diff-impact --json`: `742,703,736`, average `727ms` versus baseline `679ms`
  - `__health-phase similar,extract-candidates --full`: `346,357,340`, average `348ms` versus baseline `342ms`
- Structural checks after reindex: `wrapper-candidates --json`, `recent-duplicates --json`, and `unused-params --json` returned no findings. `incomplete-migration --json` returned no findings. `stale-abstractions --json` stayed at the known five accepted stale entries: `FileEvidenceKind`, `ReactComponentProfileOptions`, `VueComponentProfileOptions`, `SemanticReferenceCacheEntry`, and `FileAddRecord`.
- Full tests: `npm test` passed, 87 files and 477 tests. Vitest printed the existing git-diff usage warning from a test path, but the suite exited 0.
- Final gate: `node dist/cli.js reindex && node dist/cli.js diff-gate --json` passed; diff-gate exit code was `0` with no findings.

## Execution Order

1. Extend `src/runtime/isolated-analysis-runner.ts` with the scheduler primitives.
2. Update `src/runtime/cli-support.ts` to consume the scheduler primitives and delete local scheduler code.
3. Add scheduler unit tests and keep existing CLI support tests unchanged unless expectations prove stale.
4. Run focused tests, typecheck, build, output hash checks, timing sample, structural checks, full tests, health, reindex, and diff-gate.

## Ship Order

Ship as one internal runtime refactor. Public commands and query exports remain stable, and the change is a two-way door because it moves pure execution helpers without changing persistent state.

## Summary

Files to modify/create:

- `src/runtime/isolated-analysis-runner.ts`
- `src/runtime/cli-support.ts`
- `tests/runtime/isolated-analysis-runner.test.ts`
- `tests/runtime/cli-support.test.ts` only if existing expectations require a tiny import/expectation adjustment

Expected net effect: health and diff-impact share one scheduler primitive for ordered concurrency, adaptive caps, grouped tasks, and async isolated JSON subprocesses, while health-specific phase policy remains in health CLI support.
