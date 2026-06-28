# scip-query Setup Command Implementation Plan

**Date:** 2026-06-23
**Status:** First slice implemented
**Scope:** First roadmap slice: add the project-scoped `scip-query setup` orchestration surface, report model, descriptor wiring, tests, and command docs. Later roadmap slices will deepen dependency remediation, hook installation, and health dossier generation.

## Goal

Users should be able to run `scip-query setup` in a repository and get an explicit, reliable first-run report: what scip-query detected, what it installed or verified, whether indexing works, whether capabilities are available, what the health score is, which issues need attention, and what remains blocked. This first slice should compose existing readiness, skill install, reindex, capability, setup-agent, and health primitives without introducing CI setup or applying cleanup changes.

Done for this slice means:

- [x] `scip-query setup` is a public descriptor-backed command.
- [x] `scip-query setup --json` emits a stable JSON envelope.
- [x] setup prints the health score and prioritized issue list before any future cleanup automation could run.
- [x] setup does not call `setup-ci`.
- [x] tests cover command registration and the report/order boundary.

## Current State

- `commandDescriptors` is the public command registry consumed by `src/runtime/cli.ts`; the command list is descriptor-backed at `src/runtime/commands/command-descriptors.ts:26`, and maintenance commands such as `check-deps`, `doctor`, `setup-agent`, `setup-ci`, `watch`, and `status` already live there.
  - **Source:** `scip-query plan-context commandDescriptors --full`; `scip-query code 'src/runtime/commands/command-descriptors.ts:1-150'`; `scip-query code 'src/runtime/commands/command-descriptors.ts:150-240'`.
- `command-handlers.ts` owns side-effect lifecycles such as reindex, setup, watch, and install commands; the file comment at `src/runtime/commands/command-handlers.ts:47-49` states that ownership explicitly.
  - **Source:** `scip-query code 'src/runtime/commands/command-handlers.ts:1-120'`.
- `handleReindex()` already resolves project root/config/index paths and calls `reindex()` with language and indexer options, but it exits the process directly on error.
  - **Source:** `scip-query plan-context handleReindex --full`; `scip-query code 'src/runtime/commands/command-handlers.ts:1-120'`.
- `handleCheckDeps()` reports scip CLI, detected languages, indexer readiness, and TypeScript semantic readiness, but it only reports problems; it does not orchestrate setup.
  - **Source:** `scip-query plan-context handleCheckDeps --full`; `scip-query code 'src/runtime/commands/command-handlers.ts:172-421'`.
- `installSkills()` installs bundled skills into user-level Claude Code, Codex, and shared agent roots when those roots exist.
  - **Source:** `scip-query plan-context installSkills --full`.
- `setupAgent()` writes AGENTS.md/CLAUDE.md guidance and optionally a git pre-commit hook; `setupAgent` usually changes with `README.md`.
  - **Source:** `scip-query plan-context setupAgent --full`.
- `handleHealth()` already runs `runIsolatedHealthReport({ full: true })`, prints JSON via `printJsonEnvelope()`, or renders human output.
  - **Source:** `scip-query plan-context handleHealth --full`; `scip-query code 'src/runtime/commands/command-handlers.ts:172-421'`.
- `getProjectReadiness()` returns detected languages, indexer statuses, TypeScript semantic status, checkers, and git availability; `getProjectCapabilities()` is already consumed by `doctor`, `status`, `capabilities`, and `capability-matrix`.
  - **Source:** `scip-query plan-context getProjectReadiness --full`.
- `printJsonEnvelope()` provides the stable JSON wrapper used by other commands.
  - **Source:** `scip-query code printJsonEnvelope -C 5`.
- Existing runtime tests cover skill installation, CLI descriptor contracts, and project readiness; these test files are not present in the SCIP index, so they were discovered with `rg --files`.
  - **Source:** `rg --files | rg '(^|/)(test|tests|__tests__|.*\\.(test|spec)\\.)'`.

## Reuse Audit

- New `runProjectSetup()` orchestration is justified because no similar file pair exists for `src/runtime/setup-ci.ts` or `src/runtime/commands/command-handlers.ts`, and no existing handler composes install-skills, readiness, reindex, capabilities, setup-agent, and health.
  - **Source:** `scip-query similar-files src/runtime/setup-ci.ts --full`; `scip-query similar-files src/runtime/commands/command-handlers.ts --full`.
- Reuse `installSkills()` rather than duplicating skill installation.
  - **Source:** `scip-query plan-context installSkills --full`.
- Reuse `getProjectReadiness()` and `getProjectCapabilities()` rather than creating a second capability model.
  - **Source:** `scip-query plan-context getProjectReadiness --full`.
- Reuse `reindex()` directly inside the orchestration instead of shelling out to `scip-query reindex`, because `handleReindex()` already demonstrates the project-root/config/path argument shape.
  - **Source:** `scip-query plan-context handleReindex --full`.
- Reuse `runIsolatedHealthReport()` for the first health score/report slice instead of adding a new detector pass yet.
  - **Source:** `scip-query plan-context handleHealth --full`.
- Reuse `setupAgent()` for project-local guidance and explicitly avoid `setupCiWorkflow()`.
  - **Source:** `scip-query plan-context setupAgent --full`; `scip-query code 'src/runtime/commands/command-handlers.ts:172-421'`.

## Design

### 1.1 - Add a project setup orchestration module

- [x] **File:** `src/runtime/project-setup.ts`
- **Source:** `scip-query plan-context handleReindex --full`; `scip-query plan-context handleCheckDeps --full`; `scip-query plan-context installSkills --full`; `scip-query plan-context setupAgent --full`; `scip-query plan-context handleHealth --full`; `scip-query plan-context getProjectReadiness --full`.
- **What:** Setup behavior is currently split across separate commands; no single project setup report exists.
- **Change:** Create `runProjectSetup(opts)` that:
  - resolves project root, config, and index paths;
  - installs skills;
  - reads readiness and capabilities;
  - reindexes when detected languages exist;
  - reruns readiness/freshness after indexing;
  - runs health when an index exists;
  - computes a first-pass health score and prioritized issue list from health output;
  - runs `setupAgent(projectRoot, { gitHook })`;
  - returns a structured `ProjectSetupReport` with steps, installed skills, readiness, capabilities, index result, health summary, files written, and final verdict.
- **Why:** This gives the CLI a stable internal API for `setup`, JSON output, tests, and future remediation/dossier work.

### 1.2 - Add a descriptor-backed `setup` command

- [x] **File:** `src/runtime/commands/command-descriptors.ts:174-192`
- [x] **File:** `src/runtime/commands/command-handlers.ts:412-421`
- **Source:** `scip-query code 'src/runtime/commands/command-descriptors.ts:150-240'`; `scip-query code 'src/runtime/commands/command-handlers.ts:172-421'`; `scip-query code printJsonEnvelope -C 5`.
- **What:** `setup-agent` exists, but there is no project-scoped `setup` command.
- **Change:** Add `handleSetup(rawOpts)` that calls `runProjectSetup()`, prints JSON with `printJsonEnvelope('setup', [], opts, report)` for `--json`, and renders human output with health score and issue list before detailed step output. Add a `setup` descriptor near `doctor`/`setup-agent` with `--json` and `--git-hook`.
- **Why:** The setup flow must be discoverable from help, documented through descriptors, and consumable by agents.

### 1.3 - Add targeted runtime tests

- [x] **File:** `tests/runtime/project-setup.test.ts`
- [x] **File:** `tests/runtime/cli-contract.test.ts`
- **Source:** production code references from `scip-query plan-context commandDescriptors --full`, `scip-query plan-context handleCheckDeps --full`, and `scip-query plan-context handleHealth --full`; test harness discovered with `rg --files`.
- **What:** Existing tests cover setup skill links and descriptor registration, but not project setup orchestration.
- **Change:** Add unit tests for setup report generation using mocks for install, reindex, readiness, capabilities, health, and setup-agent. Extend CLI contract expectations so `setup` has `--json` and appears in generated docs.
- **Why:** The first slice changes a public CLI surface and must protect the score-before-cleanup boundary.

### 1.4 - Update generated command docs

- [x] **File:** `docs/COMMAND_REFERENCE.md`
- **Source:** `scip-query plan-context installSkills --full` notes setup documentation co-change pressure through `docs/COMMAND_REFERENCE.md`; CLI contract test enforces generated command reference syntax.
- **What:** Command reference is descriptor-generated and will drift when a public descriptor is added.
- **Change:** Run the existing `npm run docs:commands` script after the descriptor is added.
- **Why:** The docs contract test requires public command reference output to match descriptors.

## Stress-Test Findings

- **Understand before touch:** The existing side-effect lifecycle belongs in `command-handlers.ts`; orchestration should live in a new runtime module to keep the handler thin.
- **Blast radius:** `commandDescriptors` is consumed by CLI registration, docs, and tests. `command-handlers.ts` exports are consumed by descriptors. `project-readiness.ts`, `setup.ts`, and `agent-setup.ts` are reused, not structurally changed in this slice.
- **Valid intermediate state:** Adding `project-setup.ts` first is safe; adding handler and descriptor after it makes the command public only after the implementation exists.
- **Reversibility:** This is a two-way internal CLI feature. Removing the descriptor and new module reverts it without data migration.
- **Failure design:** `runProjectSetup()` should record failed steps in the report and return `blocked` or `partial` instead of crashing for recoverable setup failures; truly unexpected handler errors still set process exit code.
- **Concurrency:** Setup writes AGENTS/CLAUDE guidance and can reindex; no shared daemon state is introduced. File writes are idempotent through existing `setupAgent()`.
- **Boundaries:** CLI options are decoded at the handler boundary via `commandOptions()` and boolean option helpers.
- **Data integrity:** No application data is modified. Generated project guidance is written by the existing managed-block writer.
- **Observability:** The report must include each step status and error/recovery text.
- **Human experience:** Human output must show health score and issue list first, before any future cleanup section.
- **Reuse:** Existing readiness, capability, reindex, health, skill install, JSON envelope, and setup-agent primitives are reused.

## Execution Order

1. Add `src/runtime/project-setup.ts` with report types and orchestration.
2. Add `handleSetup()` and descriptor wiring.
3. Add targeted tests.
4. Regenerate command docs.
5. Run targeted tests, typecheck, `scip-query reindex`, and `scip-query diff-gate`.

## Ship Order

This first slice can ship independently. It exposes setup/reporting without automatic dependency installation, user-level hook install, health dossier files, or cleanup application. Those remain later roadmap items and will build on the report model.

## Summary

Planned files:

- Add `src/runtime/project-setup.ts`.
- Modify `src/runtime/commands/command-handlers.ts`.
- Modify `src/runtime/commands/command-descriptors.ts`.
- Add `tests/runtime/project-setup.test.ts`.
- Modify `tests/runtime/cli-contract.test.ts`.
- Regenerate `docs/COMMAND_REFERENCE.md`.

## Slice 2 Addendum - Indexer Remediation Reporting

**Status:** Implemented

### Goal

Setup should not bury indexer repair inside the later reindex step. It should inspect every detected language, attempt the configured safe install method for missing indexers, record what happened, recheck readiness, and tell the user exactly which languages remain blocked before it tries to index.

### Current State

- `getIndexerDependencyStatus()` returns installed/runnable state, resolved binary, note, and install URL for one configured indexer.
  - **Source:** `scip-query plan-context getIndexerDependencyStatus --full`.
- `tryInstallIndexer()` attempts configured install methods in order, checking each prerequisite binary first, and prints manual install guidance when no method succeeds.
  - **Source:** `scip-query code tryInstallIndexer -C 8`.
- `prepareIndexerRun()` already uses `tryInstallIndexer()` when reindex finds a missing indexer, but the setup report cannot currently separate "preflight repair attempted" from "indexing skipped this language."
  - **Source:** `scip-query code prepareIndexerRun -C 8`.
- `INDEXER_CONFIGS` declares which languages have automatic install methods and which only have manual release URLs.
  - **Source:** `scip-query code 'src/reindex/indexers.ts:12-272'`.

### Reuse Audit

- Reuse `tryInstallIndexer()` for automatic remediation instead of shelling out in setup.
  - **Source:** `scip-query code tryInstallIndexer -C 8`.
- Reuse `getIndexerDependencyStatus()` after each attempt to prove whether remediation actually made the indexer runnable.
  - **Source:** `scip-query plan-context getIndexerDependencyStatus --full`.
- Reuse `getIndexerConfig()` to map detected languages to configured install methods and manual URLs.
  - **Source:** `scip-query plan-context getIndexerConfig --full`.

### Design

#### 2.1 - Add remediation results to project setup

- [x] **File:** `src/runtime/project-setup.ts`
- **Source:** `scip-query plan-context getIndexerDependencyStatus --full`; `scip-query code tryInstallIndexer -C 8`; `scip-query plan-context getIndexerConfig --full`.
- **What:** Setup currently records readiness and lets `reindex()` attempt indexer installation later.
- **Change:** Add `ProjectSetupIndexerRemediation` entries that record language, binary label, status before, whether install was attempted, captured install messages, status after, and manual recovery URL/reason when still blocked. Use configured install methods only; do not invent new package-manager behavior.
- **Why:** Users need to see exactly which indexer/toolchain paths were repaired and which remain their responsibility.

#### 2.2 - Recheck readiness before indexing

- [x] **File:** `src/runtime/project-setup.ts`
- **Source:** `scip-query plan-context getProjectReadiness --full`; `scip-query plan-context handleReindex --full`.
- **What:** Setup currently computes readiness once before reindex and once after.
- **Change:** Run remediation after the first readiness check, then recompute readiness and use that post-remediation readiness for reindex. Add a setup step that summarizes remediation as OK, WARN, SKIPPED, or FAILED.
- **Why:** The reindex step should act on the best available state and the report should not claim a missing indexer remained unchecked.

#### 2.3 - Test remediation reporting

- [x] **File:** `tests/runtime/project-setup.test.ts`
- **Source:** production code references from the commands above; test harness discovered with `rg --files`.
- **What:** Current project setup tests do not cover non-runnable indexers.
- **Change:** Mock one missing indexer that becomes runnable after `tryInstallIndexer()` and one language with no auto-install path that remains blocked. Verify the report records attempted installs, messages, final readiness, and partial verdict.
- **Why:** Remediation is a product-trust boundary: setup must not say "ready" when an indexer is still unusable.

## Slice 3 Addendum - Setup Smoke-Test Reporting

**Status:** Implemented

### Goal

After setup finishes the install, index, readiness, capability, health, and agent-guidance steps, the report should include a smoke-test section that tells the user which command families are proven and which are unavailable. This first smoke-test implementation should be bounded to the artifacts setup already produced; later roadmap work can deepen it into direct per-command execution across every analyzer family.

### Current State

- `runProjectSetup()` already returns reindex result, readiness, capabilities, freshness, health, and setup-agent results.
  - **Source:** `scip-query diff-impact` after Slice 1 and `scip-query plan-context handleReindex --full`; `scip-query plan-context getProjectReadiness --full`; `scip-query plan-context handleHealth --full`; `scip-query plan-context setupAgent --full`.
- `stats()` and `files()` show low-cost query APIs are available for later direct command smoke tests.
  - **Source:** `scip-query code stats -C 5`; `scip-query code files -C 5`.
- `withDb()` opens the active project database and closes it safely; direct query smoke tests can use this later when the setup command has a richer test fixture.
  - **Source:** `scip-query code withDb -C 5`.

### Design

#### 3.1 - Add smoke-test results to setup reports

- [x] **File:** `src/runtime/project-setup.ts`
- **Source:** `scip-query plan-context handleReindex --full`; `scip-query plan-context getProjectReadiness --full`; `scip-query plan-context handleHealth --full`; `scip-query plan-context setupAgent --full`.
- **What:** Setup steps currently show what ran, but there is no explicit "these command families are now proven" section.
- **Change:** Add `ProjectSetupSmokeTest` results for representative command families:
  - `scip-query reindex`
  - `scip-query status`
  - `scip-query capabilities`
  - `scip-query health`
  - `scip-query setup-agent`
- Each result should be `pass`, `unavailable`, or `fail` with evidence text.
- **Why:** Users should leave setup knowing which parts of the CLI are proven in this repository.

#### 3.2 - Render and test smoke-test reporting

- [x] **File:** `src/runtime/project-setup.ts`
- [x] **File:** `tests/runtime/project-setup.test.ts`
- **Source:** same as 3.1; test harness discovered with `rg --files`.
- **What:** The human setup output currently shows score, issues, and steps.
- **Change:** Render smoke tests after setup steps. Add tests for passing health/capability smoke tests and unavailable smoke tests when no database exists.
- **Why:** Smoke status is part of the first-run trust contract, and unavailable is different from clean.

## Slice 4 Addendum - Health Dossier Files

**Status:** Implemented

### Goal

Setup should write the health score, issue queue, blocked checks, smoke tests, setup steps, and indexer remediation results into durable Markdown and JSON files under `docs/scip-query/`.

### Current State

- `setupAgent()` uses project-root-scoped managed file writes and preserves user content.
  - **Source:** `scip-query code writeInstructionsBlock -C 8`; `scip-query code upsertManagedBlock -C 8`.
- `runProjectSetup()` now has the setup report fields needed to render a dossier.
  - **Source:** `scip-query change-surface src/runtime/project-setup.ts`.

### Completed Changes

- [x] **File:** `src/runtime/health-dossier.ts`
  - Added `writeProjectHealthDossier()` to write `docs/scip-query/health-dossier.md` and `docs/scip-query/health-dossier.json`.
- [x] **File:** `src/runtime/project-setup.ts`
  - Wired dossier writing into setup and included the dossier path in human and JSON output.
- [x] **File:** `tests/runtime/health-dossier.test.ts`
  - Verified Markdown and JSON contain score, issues, unavailable checks, blocked indexers, and dossier metadata.
- [x] **File:** `tests/runtime/project-setup.test.ts`
  - Verified setup records dossier paths and written files.
