# Concrete Plan: Improve Audit Signal, Test Reach, and Install Ownership

**Date:** 2026-04-10
**Scope:** `scip-query`

## Goal

Make the repository easier to change without breaking users by fixing noisy de-bloat signals, raising coverage around the riskiest analysis paths, reducing unnecessary coupling in the CLI, and giving the `scip` binary logic one clear home.

## Working Definitions

- An **entry surface** is a source file the runtime or an outside caller can reach even when no repo-local import points at it. In this repository, [src/cli.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts), [src/index.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/index.ts), [src/postinstall.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/postinstall.ts), and the worker launched from [src/watch.ts:231](/Users/aydansalois/Documents/GitHub/scip-query/src/watch.ts#L231) are examples.
- A **barrel** is an index module that forwards many exports through one file. [src/queries/index.ts:1-45](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/index.ts#L1) is the barrel for the query layer.
- A **blast radius** is the set of files and symbols that move when one symbol changes. `scip-query affected` and `scip-query change-surface` reveal that moving set.

## Problem Statement

- `scip-query bottlenecks -n 10` ranks `src:queries:index` as the top coupling point, and `scip-query surface queries` shows only [src/cli.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts) and [src/index.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/index.ts) consume that barrel.
- [src/cli.ts:1-11](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L1) imports `* as queries` from [src/queries/index.ts:1-45](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/index.ts#L1), so one file carries nearly the whole query layer into the CLI.
- [src/queries/dead.ts:37-76](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/dead.ts#L37), [src/queries/redundant-reexports.ts:26-169](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/redundant-reexports.ts#L26), and [src/queries/health.ts:48-93](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts#L48) all reason about liveness, but they do not share one definition of what counts as a live entry surface.
- `scip-query change-surface src/queries/dead.ts`, `scip-query change-surface src/queries/redundant-reexports.ts`, and `scip-query change-surface src/queries/health.ts` all report `0%` test coverage for the symbols we need to trust most.
- [src/setup.ts:93-180](/Users/aydansalois/Documents/GitHub/scip-query/src/setup.ts#L93) owns `scip` binary detection and messaging, while [src/reindex/install.ts:76-125](/Users/aydansalois/Documents/GitHub/scip-query/src/reindex/install.ts#L76) owns `tryInstallScipCli()`. `scip-query call-graph tryInstallScipCli` shows those two modules are the only callers, so the concern is split across two homes.

## Conventions To Preserve

- Query modules are pure analysis units that accept a database handle plus options and return typed data. [src/queries/dead.ts:10-122](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/dead.ts#L10), [src/queries/redundant-reexports.ts:18-169](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/redundant-reexports.ts#L18), and [src/queries/health.ts:26-324](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts#L26) all follow that shape.
- The CLI is only an adapter around query results. [src/cli.ts:262-304](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L262), [src/cli.ts:922-942](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L922), [src/cli.ts:977-1003](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L977), [src/cli.ts:1095-1143](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L1095), and [src/cli.ts:1313-1338](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L1313) translate data into text but do not own the analysis logic.
- Shared query helpers already live in [src/query-support.ts:21-221](/Users/aydansalois/Documents/GitHub/scip-query/src/query-support.ts#L21), but `scip-query change-surface src/query-support.ts` reports `54` external consumers. New liveness logic should go in a small dedicated helper file instead of making this broad dependency hub even broader.
- Root exports must stay stable. [src/index.ts:3-11](/Users/aydansalois/Documents/GitHub/scip-query/src/index.ts#L3) is the public programmatic surface, and [src/postinstall.ts:1-8](/Users/aydansalois/Documents/GitHub/scip-query/src/postinstall.ts#L1) is the install-time runtime surface.

## Execution Order

1. Phase 1 can ship by itself. It improves signal without changing the CLI contract.
2. Phase 2 depends on Phase 1 because `health()` should reuse the same liveness rules.
3. Phase 3 can ship after Phase 1. It changes internal wiring in the CLI without changing public commands.
4. Phase 4 can ship independently after Phase 3. It preserves public export names while simplifying ownership.
5. Phase 5 can start after Phase 1’s synthetic test index exists.
6. Phase 6 lands last so the docs describe the code that actually shipped.

## Phase 1 — Centralize Live Entry-Surface Detection

### 1.1 — Add a dedicated liveness helper module

- [ ] **File**: `src/entry-surfaces.ts` (new file)
- **Source**: `scip-query code 'src/queries/health.ts:48-93'`; `scip-query code 'src/watch.ts:220-260'`; `scip-query code 'src/index.ts:1-12'`; `scip-query code 'src/postinstall.ts:1-9'`; `scip-query change-surface src/query-support.ts`
- **What**: [src/queries/health.ts:50-53](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts#L50) keeps a local `entryPointPatterns` list. The worker path only appears in [src/watch.ts:231-245](/Users/aydansalois/Documents/GitHub/scip-query/src/watch.ts#L231). The root API and postinstall entry surfaces live in [src/index.ts:3-11](/Users/aydansalois/Documents/GitHub/scip-query/src/index.ts#L3) and [src/postinstall.ts:6-8](/Users/aydansalois/Documents/GitHub/scip-query/src/postinstall.ts#L6).
- **Change**: Create a small helper module that owns one conservative definition of liveness:
  - `isStructuralEntrySurface(path: string): boolean`
  - `isWorkerEntrySurface(path: string): boolean`
  - `isLiveBarrel(db: ScipDatabase, path: string): boolean`
  Use explicit path patterns for structural entry surfaces and a file-dependency walk for live barrels.
- **Why**: Dead-code, redundant-reexport, and health logic need the same answer to the same question.

### 1.2 — Teach `dead()` to ignore only truly ignorable barrel references

- [ ] **File**: [src/queries/dead.ts:37-76](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/dead.ts#L37)
- **Source**: `scip-query code 'src/queries/dead.ts:37-76'`; `scip-query affected dead`; `scip-query change-surface src/queries/dead.ts`; `scip-query code 'src/cli.ts:262-304'`
- **What**: `skipBarrels` currently drops every reference that comes from a barrel file, regardless of whether that barrel is itself reachable from a live entry surface.
- **Change**: Replace the raw `relative_path NOT LIKE '%/index.ts'` exclusion with logic that ignores a barrel reference only when the barrel is not a live barrel. Keep the returned `DeadSummary` shape and the CLI output in [src/cli.ts:262-304](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L262) unchanged.
- **Why**: The option should still expose hidden dead code, but it should stop treating live public surfaces as if they were dead.

### 1.3 — Teach `redundantReexports()` about live barrels

- [ ] **File**: [src/queries/redundant-reexports.ts:26-169](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/redundant-reexports.ts#L26)
- **Source**: `scip-query code 'src/queries/redundant-reexports.ts:26-169'`; `scip-query affected redundantReexports`; `scip-query change-surface src/queries/redundant-reexports.ts`; `scip-query code 'src/cli.ts:1313-1338'`; `scip-query surface queries`
- **What**: The current implementation already knows namespace imports are invisible to SCIP, but it still reports a re-export when both `barrelConsumers` and `directConsumers` are `0`, even if the barrel itself is a live entry surface consumed by [src/cli.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts) or re-exported from [src/index.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/index.ts).
- **Change**: Before reporting a redundant re-export, check whether the barrel is reachable from a live entry surface. If it is, suppress the finding. Keep the command name and text layout in [src/cli.ts:1313-1338](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L1313) stable.
- **Why**: The command should only report re-exports that are truly dead weight, not re-exports hidden behind a live barrel boundary.

### 1.4 — Add regression tests for live entry surfaces

- [ ] **File**: `tests/debloat-entry-surfaces.test.ts` (new file)
- **Source**: `scip-query change-surface src/queries/dead.ts`; `scip-query change-surface src/queries/redundant-reexports.ts`; `scip-query code 'src/watch.ts:220-260'`; `scip-query code 'src/index.ts:1-12'`; `scip-query code 'src/postinstall.ts:1-9'`
- **What**: The changed analysis functions have external consumers and `0%` test coverage.
- **Change**: Build a small synthetic SQLite index for tests that includes:
  - a live barrel chain: `src/index.ts -> src/queries/index.ts -> query module`
  - a CLI consumer of the queries barrel
  - a runtime worker edge that mirrors [src/watch.ts:231-245](/Users/aydansalois/Documents/GitHub/scip-query/src/watch.ts#L231)
  Assert that `dead()` and `redundantReexports()` no longer flag those paths as dead.
- **Why**: This phase changes core signal logic. It needs fast regression protection before anything else builds on it.

## Phase 2 — Make `health()` Reuse The Same Liveness Rules

### 2.1 — Replace local entry-point filtering with the shared helper

- [ ] **File**: [src/queries/health.ts:32-99](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts#L32)
- **Source**: `scip-query code 'src/queries/health.ts:32-99'`; `scip-query call-graph health`; `scip-query affected health`; `scip-query change-surface src/queries/health.ts`
- **What**: `health()` runs `dead()`, `isolated()`, and other analyses, but it applies its own local entry-surface filter in [src/queries/health.ts:50-89](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/health.ts#L50).
- **Change**: Import the Phase 1 helper and replace the inline `entryPointPatterns` / `isEntryPoint` logic with the shared functions. Keep the current `HealthReport` shape and CLI rendering in [src/cli.ts:1095-1143](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L1095) stable in this pass.
- **Why**: The top-level health report should never disagree with the lower-level queries it is summarizing.

### 2.2 — Add a health-specific regression suite

- [ ] **File**: `tests/health.test.ts` (new file)
- **Source**: `scip-query change-surface src/queries/health.ts`; `scip-query code 'src/cli.ts:1095-1143'`; `scip-query code 'src/queries/health.ts:101-323'`
- **What**: `health()` is externally consumed and currently has `0%` test coverage.
- **Change**: Add assertions that the health report:
  - does not count live entry surfaces as dead or isolated
  - still reports test coverage and prioritized actions
  - preserves the current score and action ordering rules for unchanged fixture inputs
- **Why**: Users experience de-bloat quality through `health`, not through the raw query modules alone.

## Phase 3 — Decouple The CLI From The Queries Barrel

### 3.1 — Replace the namespace barrel import with direct imports

- [ ] **File**: [src/cli.ts:1-11](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L1)
- **Source**: `scip-query code 'src/cli.ts:1-11'`; `scip-query deps src/cli.ts`; `scip-query rdeps src/queries/index.ts`; `scip-query surface queries`
- **What**: The CLI imports `* as queries` from [src/queries/index.ts](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/index.ts), and `src/cli.ts` plus `src/index.ts` are the only in-repo consumers of that barrel.
- **Change**: Replace the namespace import with direct imports from the concrete query modules the CLI calls. Leave [src/queries/index.ts:1-45](/Users/aydansalois/Documents/GitHub/scip-query/src/queries/index.ts#L1) unchanged so the public package API still works.
- **Why**: This removes the largest internal coupling hub without breaking the public root exports.

### 3.2 — Update command handlers without changing the CLI contract

- [ ] **File**: [src/cli.ts:89-1143](/Users/aydansalois/Documents/GitHub/scip-query/src/cli.ts#L89)
- **Source**: `scip-query code 'src/cli.ts:262-304'`; `scip-query code 'src/cli.ts:922-942'`; `scip-query code 'src/cli.ts:977-1003'`; `scip-query code 'src/cli.ts:1095-1143'`; `scip-query code 'src/cli.ts:1313-1338'`
- **What**: Command handlers currently call `queries.<name>` throughout the file.
- **Change**: Rewrite handlers to call the direct imports introduced in Step 3.1. Preserve:
  - command names
  - options
  - output text
  - `openDb()`, `withDb()`, and `runQuery()` helper flow
- **Why**: Users should see the same commands while the internal dependency graph becomes flatter.

### 3.3 — Add CLI smoke coverage around the touched commands

- [ ] **File**: `tests/cli-contract.test.ts` (new file)
- **Source**: `scip-query code 'src/cli.ts:262-304'`; `scip-query code 'src/cli.ts:922-942'`; `scip-query code 'src/cli.ts:977-1003'`; `scip-query code 'src/cli.ts:1095-1143'`; `scip-query code 'src/cli.ts:1313-1338'`; `scip-query change-surface src/cli.ts`
- **What**: The CLI file has `0%` test coverage, and this phase changes internal command wiring across many commands.
- **Change**: Add lightweight help / execution smoke tests for `dead`, `change-surface`, `drift`, `health`, and `redundant-reexports` so their parse surface and headline output remain stable.
- **Why**: This is the user-facing trust boundary. Refactoring it without a contract test would make rollback harder.

## Phase 4 — Give `scip` Binary Logic One Home

### 4.1 — Extract a shared `scip` binary module

- [ ] **File**: `src/scip-cli.ts` (new file)
- **Source**: `scip-query code 'src/setup.ts:93-171'`; `scip-query code 'src/reindex/install.ts:76-125'`; `scip-query code 'src/reindex/index.ts:61-76'`; `scip-query call-graph tryInstallScipCli`; `scip-query affected tryInstallScipCli`
- **What**: `setup.ts` owns `isScipInstalled()`, `getScipVersion()`, and `printScipInstallInstructions()`, while `reindex/install.ts` owns `tryInstallScipCli()`. Both paths operate on the same real-world thing: the `scip` binary on the user’s machine.
- **Change**: Create a shared module for `scip`-specific concerns:
  - detect whether `scip` exists
  - read its version
  - attempt installation
  - print install instructions
- **Why**: One concern should have one home so setup and reindex can import the same behavior instead of each owning half of it.

### 4.2 — Narrow `setup.ts` to first-run orchestration

- [ ] **File**: [src/setup.ts:93-202](/Users/aydansalois/Documents/GitHub/scip-query/src/setup.ts#L93)
- **Source**: `scip-query code 'src/setup.ts:93-202'`; `scip-query change-surface src/setup.ts`
- **What**: `setup.ts` currently mixes skill installation, `scip` binary detection, install instruction rendering, and postinstall orchestration.
- **Change**: Keep `installSkills()` and `postinstall()` in `setup.ts`, but import `scip` binary helpers from the new shared module instead of defining them locally.
- **Why**: Setup becomes an orchestrator rather than a mixed concern module.

### 4.3 — Narrow `reindex/install.ts` to generic installer utilities

- [ ] **File**: [src/reindex/install.ts:7-125](/Users/aydansalois/Documents/GitHub/scip-query/src/reindex/install.ts#L7)
- **Source**: `scip-query code 'src/reindex/install.ts:7-125'`; `scip-query change-surface src/reindex/install.ts`; `scip-query code 'src/reindex/index.ts:61-102'`
- **What**: The file currently mixes generic binary/indexer helpers with the special-case `scip` installer.
- **Change**: Leave `isBinaryAvailable()`, `isIndexerInstalled()`, and `tryInstallIndexer()` here. Move `tryInstallScipCli()` into the shared module and update [src/reindex/index.ts:61-102](/Users/aydansalois/Documents/GitHub/scip-query/src/reindex/index.ts#L61) to import it from there.
- **Why**: Generic indexer install and `scip` bootstrap are different responsibilities.

### 4.4 — Preserve the root public API while modules move underneath it

- [ ] **File**: [src/index.ts:3-10](/Users/aydansalois/Documents/GitHub/scip-query/src/index.ts#L3)
- **Source**: `scip-query code 'src/index.ts:3-10'`; `scip-query code 'src/reindex/index.ts:1-25'`
- **What**: The root module currently exports `tryInstallScipCli` through `./reindex/index.js` and the setup helpers through `./setup.js`.
- **Change**: Re-export the moved `scip` helpers from the root module so outside callers keep the same root import names after the internal split.
- **Why**: This phase should be a two-way door: simpler internals without a breaking public API.

### 4.5 — Add tests for the shared `scip` binary behavior

- [ ] **File**: `tests/scip-cli.test.ts` (new file)
- **Source**: `scip-query change-surface src/setup.ts`; `scip-query change-surface src/reindex/install.ts`; `scip-query code 'src/setup.ts:97-171'`; `scip-query code 'src/reindex/install.ts:80-124'`
- **What**: Both modules have `0%` test coverage and multiple external consumers.
- **Change**: Add mocked tests for:
  - successful `scip` detection
  - failed detection
  - install attempt fallbacks
  - unchanged user-facing error / instruction text
- **Why**: This is the part of the tool that runs on the user’s machine and touches their environment.

## Phase 5 — Raise Coverage For The Advanced Query Surface

### 5.1 — Add one richer synthetic index test suite for advanced queries

- [ ] **File**: `tests/queries-advanced.test.ts` (new file)
- **Source**: `scip-query code 'src/queries/index.ts:21-45'`; `scip-query code 'src/queries/drift.ts:21-136'`; `scip-query code 'src/queries/dataflow.ts:18-127'`; `scip-query code 'src/queries/slice.ts:18-153'`; `scip-query code 'src/queries/stale-abstractions.ts:13-81'`; `scip-query code 'src/queries/complexity-hotspots.ts:15-119'`; `scip-query system queries`
- **What**: The public queries surface exposes many advanced analyses beyond the basic queries already exercised by the repository, but the repo-wide `scip-query test-coverage` result is still `4%`.
- **Change**: Build one richer synthetic SQLite index and add assertions for:
  - `drift()`
  - `dataflow()`
  - `slice()` in both directions
  - `staleAbstractions()`
  - `complexityHotspots()`
  - at least one of `similarFiles()` or `similarChains()` with deterministic fixture data
- **Why**: These are the riskiest analysis paths to change later, and they currently lack a safety net.

## Phase 6 — Align The Human-Facing Docs With The Shipped CLI

### 6.1 — Update the repository command reference

- [ ] **File**: `README.md` (manual line verification required; Markdown is outside the current SCIP index)
- **Source**: `scip-query code 'src/cli.ts:922-975'`; `scip-query code 'src/cli.ts:977-1003'`; `scip-query code 'src/cli.ts:1095-1143'`; `scip-query code 'src/cli.ts:1313-1338'`
- **What**: The shipped CLI defines `change-surface <file>`, `diff-impact`, `drift [module]`, `health`, and `redundant-reexports` with the behavior shown in those command handlers.
- **Change**: Update the README examples and command reference so they describe the current CLI surface and do not advertise removed flags or older behavior.
- **Why**: The docs are the user’s map of the tool. A map that names commands the binary does not support is false guidance.

### 6.2 — Update the agent-facing guide after the code phases ship

- [ ] **File**: [docs/AGENT_GUIDE.md](/Users/aydansalois/Documents/GitHub/scip-query/docs/AGENT_GUIDE.md) (manual line verification required; Markdown is outside the current SCIP index)
- **Source**: `scip-query code 'src/cli.ts:262-304'`; `scip-query code 'src/cli.ts:977-1003'`; `scip-query code 'src/cli.ts:1095-1143'`; `scip-query code 'src/cli.ts:1313-1338'`
- **What**: Agent workflows should match the actual command surface the binary exposes.
- **Change**: Update the guide so examples use the shipped command names and so de-bloat guidance explains the live-entry-surface fix once Phases 1 and 2 land.
- **Why**: The guide should teach the same behavior the code enforces.

## Stress Test Against The 11 Principles

1. **Understand before you touch**
   Source: `scip-query call-graph health`; `scip-query call-graph tryInstallScipCli`; `scip-query system queries`
   Finding: `health()` is an orchestrator over many analyses, and `tryInstallScipCli()` is shared by setup and reindex. The plan keeps those responsibilities visible instead of collapsing them blindly.

2. **Map the blast radius**
   Source: `scip-query affected dead`; `scip-query affected redundantReexports`; `scip-query affected health`; `scip-query affected tryInstallScipCli`; `scip-query change-surface src/query-support.ts`
   Finding: shared helpers can widen blast radius quickly, so the plan uses a new dedicated helper file instead of growing `src/query-support.ts`.

3. **Every intermediate state must be valid**
   Source: `scip-query deps src/cli.ts`; `scip-query rdeps src/queries/index.ts`
   Finding: each phase is deployable on its own and preserves either the CLI contract or the root export contract while internal structure changes underneath.

4. **Reversibility determines rigor**
   Source: `scip-query code 'src/index.ts:3-10'`; `scip-query code 'src/cli.ts:262-304'`; `scip-query code 'src/cli.ts:977-1003'`
   Finding: the plan avoids irreversible API breaks by keeping root exports and CLI command names stable.

5. **Design for failure, not success**
   Source: `scip-query code 'src/reindex/index.ts:61-124'`; `scip-query code 'src/setup.ts:152-171'`
   Finding: the install refactor keeps the existing failure messages and fallback flows intact while changing ownership.

6. **Assume concurrency**
   Source: `scip-query code 'src/watch.ts:223-267'`; `scip-query change-surface src/watch.ts`
   Finding: no phase changes watcher concurrency or atomic swap behavior. The worker path is only modeled so analysis treats it as live.

7. **Defend the boundaries**
   Source: `scip-query code 'src/cli.ts:262-304'`; `scip-query code 'src/cli.ts:922-975'`; `scip-query code 'src/cli.ts:977-1003'`; `scip-query code 'src/cli.ts:1095-1143'`
   Finding: the CLI is the user boundary, so the plan adds smoke tests exactly where public command contracts are touched.

8. **Protect data integrity**
   Source: `scip-query code 'src/queries/dead.ts:45-87'`; `scip-query code 'src/queries/redundant-reexports.ts:97-169'`
   Finding: Phases 1 and 2 only change read-only SQLite analysis queries. No schema or persisted project data changes are involved.

9. **Make it observable**
   Source: `scip-query code 'src/setup.ts:152-171'`; `scip-query code 'src/reindex/install.ts:50-73'`
   Finding: the install refactor keeps the current console guidance and status messages instead of hiding them behind a new abstraction.

10. **Consider the human**
    Source: `scip-query code 'src/cli.ts:1095-1143'`; `scip-query code 'src/cli.ts:1313-1338'`
    Finding: users care about credible output. Better liveness rules plus doc alignment improve trust more than a silent internal refactor would.

11. **Match the existing system**
    Source: `scip-query code 'src/queries/dead.ts:10-122'`; `scip-query code 'src/queries/redundant-reexports.ts:18-169'`; `scip-query code 'src/queries/health.ts:26-324'`; `scip-query code 'src/query-support.ts:21-221'`
    Finding: new analysis logic should stay in small pure functions that work with `ScipDatabase` and return typed data, just like the surrounding query modules.

## Verification Checklist

- [ ] Re-run `scip-query reindex` after each code phase.
- [ ] Run `scip-query change-surface` on every modified source file and confirm the predicted consumers still match the plan.
- [ ] Run `scip-query affected` for `dead`, `redundantReexports`, `health`, and `tryInstallScipCli` after the corresponding phases.
- [ ] Run `scip-query diff-impact` before merge and confirm the touched symbols match the intended phase.
- [ ] Run the Vitest suite after each phase and add a targeted test any time a behavior-changing step lacks one.
- [ ] Run the TypeScript typecheck before merge so the direct-import CLI refactor and shared install split do not drift out of sync.

## Current Verification Baseline

- `scip-query diff-impact` currently reports `0` changed files and `0` changed symbols, so the repository starts from a clean code-change baseline for this plan.
