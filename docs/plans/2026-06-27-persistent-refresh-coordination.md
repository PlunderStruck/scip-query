# Persistent Refresh Coordination

Date: 2026-06-27

## Goal

Make scip-query refresh behavior persistent, project-scoped, and agent-friendly. A refresh is the act of rebuilding or reusing the compiler-resolved index for one repository; its essential job is to make later code queries describe the current source tree instead of an older one. Done means agents can read `.scipquery.json`, check whether the index is fresh, avoid unnecessary `reindex` work, and coordinate manual and watcher refreshes so only one refresh owns a project cache at a time.

## Current State

- `WatchConfig` already persists `enabled`, `debounceMs`, `cooldownMs`, `gitPollMs`, and `ignore` in project JSON config. Source: `scip-query code WatchConfig -C 6`.
- `initProjectConfig()` already writes a `.scipquery.json` with a `watch` object and default timings when no config exists. Source: `scip-query code initProjectConfig -C 8`.
- `Watcher` already debounces source changes, preserves a single in-process refresh, polls Git state, and passes refresh trigger metadata to the worker. Source: `scip-query plan-context Watcher --full --json`.
- `getIndexFreshness()` already returns `fresh`, `stale`, `missing`, or `unknown` by comparing current source fingerprints with persisted reindex metadata. Source: `scip-query code getIndexFreshness -C 8`.
- `reindex()` already uses a per-project lock at `<cacheDir>/index.lock`, because the lock path is derived from the resolved output database directory. Source: `scip-query code reindex --full --json`; `scip-query code acquireReindexLock -C 8`.
- Agent hooks already install project-local SessionStart, UserPromptSubmit, and Stop hooks through `installProjectAgentHooks()` and `scipHookGroup()`. Source: `scip-query plan-context installProjectAgentHooks --full --json`; `scip-query code scipHookGroup -C 8`.
- `runProjectSetup()` already installs skills, validates config, refreshes the index, installs hooks, computes freshness, writes the health dossier, and emits smoke tests. Source: `scip-query plan-context runProjectSetup --full --json`.

Non-obvious invariant: project independence already follows from cache paths. The refresh lock sits beside the project-specific database, so two different repositories use different lock files and can refresh independently. Source: `scip-query code reindex --full --json`; `scip-query code acquireReindexLock -C 8`.

## Reuse Audit

- Reuse `WatchConfig` and `resolveWatchConfig()` for persistent refresh policy rather than adding a new config namespace. Source: `scip-query code WatchConfig -C 6`; `scip-query code resolveWatchConfig -C 8`.
- Reuse `getIndexFreshness()` for stale checks instead of inventing a new freshness signal. Source: `scip-query code getIndexFreshness -C 8`.
- Extend `acquireReindexLock()` because it is already the per-project serialization point. Source: `scip-query code acquireReindexLock -C 8`; `scip-query similar acquireReindexLock --json --full`.
- Reuse project agent hooks for no-terminal automatic refresh checks. Source: `scip-query code scipHookGroup -C 8`; `scip-query plan-context installProjectAgentHooks --full --json`.
- Reuse `reindex()` trigger metadata for lock ownership and status. Source: `scip-query code ReindexOptions -C 5`; `scip-query code reindex --full --json`.

## Phase 1 - Refresh Coordination

### 1.1 - Record lock ownership

- [ ] **File**: `src/reindex/index.ts:123-192`, `src/reindex/index.ts:625-652`
- **Source**: `scip-query code reindex --full --json`; `scip-query code acquireReindexLock -C 8`.
- **What**: `reindex()` creates `index.lock` with only `pid` and `startedAt`; an existing lock always fails the new refresh.
- **Change**: Add lock metadata for `projectRoot`, trigger kind/detail, and whether the owner is watcher-originated. Preserve the per-project lock path.
- **Why**: Manual refresh can only preempt watcher refresh safely if the lock tells it who owns the refresh.

### 1.2 - Let manual refresh preempt watcher refresh

- [ ] **File**: `src/reindex/index.ts:123-192`, `src/reindex/index.ts:625-652`
- **Source**: `scip-query code reindex --full --json`; `scip-query code acquireReindexLock -C 8`.
- **What**: a manual `scip-query reindex` fails if a watcher worker already owns the lock.
- **Change**: When the requester trigger is `manual-cli` and the existing lock trigger is one of the watcher trigger kinds, terminate the watcher-owned process group, remove a dead/stale lock after verifying the PID is gone, and retry lock acquisition. Do not preempt setup or another manual refresh.
- **Why**: manual work should be authoritative while preserving project-local serialization.

### 1.3 - Make watcher workers killable as a unit

- [ ] **File**: `src/runtime/watch.ts:245-274`
- **Source**: `scip-query code Watcher -C 6`; `scip-query code runPreparedIndexer -C 8`.
- **What**: watcher refreshes run in a child worker; indexers may spawn further child processes through `execFile`.
- **Change**: fork the watcher reindex worker as its own process group so a later manual refresh can terminate the worker group rather than leaving detached indexer children behind.
- **Why**: preemption must cancel the actual in-flight index work, not just the parent bookkeeping process.

## Phase 2 - Configured Automatic Freshening

### 2.1 - Persist agent auto-refresh policy

- [ ] **File**: `src/domain/config-types.ts:159-170`, `src/runtime/config.ts:9-15`, `src/runtime/config.ts:252-270`
- **Source**: `scip-query code WatchConfig -C 6`; `scip-query code DEFAULT_WATCH -C 8`; `scip-query code initProjectConfig -C 8`.
- **What**: `watch.enabled` exists but only the explicit `scip-query watch` command consumes it as a live watcher policy.
- **Change**: Add `watch.autoRefresh?: boolean` with a default of `true` when `watch.enabled` is true, and scaffold it into new configs.
- **Why**: a persisted setting should let project hooks refresh stale indexes without requiring a separate terminal command.

### 2.2 - Refresh stale indexes from project hooks

- [ ] **File**: `src/runtime/agent-hooks.ts:339-446`, `src/runtime/agent-hooks.ts:519-572`
- **Source**: `scip-query code scipHookGroup -C 8`; `scip-query code getIndexFreshness -C 8`; `scip-query plan-context handleAgentHookStop --full --json`.
- **What**: hook context reports freshness but does not rebuild stale indexes before giving agents code-intelligence guidance.
- **Change**: On SessionStart/UserPromptSubmit hook context, resolve the workspace, check `getIndexFreshness()`, and run `reindex({ skipIfUnchanged: true, trigger: { kind: 'manual-cli', detail: 'agent hook auto-refresh' } })` only when `watch.autoRefresh !== false` and freshness is not `fresh`.
- **Why**: agents get current indexes without running a manual terminal command, while fresh repositories skip work.

### 2.3 - Increase hook timeout for stale refresh path

- [ ] **File**: `src/runtime/agent-hooks.ts:299-337`
- **Source**: `scip-query code scipHookGroup -C 8`.
- **What**: context hooks currently have a 5 second timeout, which is too short for a real stale-index refresh.
- **Change**: raise context hook timeout to a bounded value that can cover a typical reuse/reindex path, while retaining a clear status message.
- **Why**: hook auto-refresh should be reliable enough to avoid terminal commands.

## Phase 3 - Setup And Skill Guidance

### 3.1 - Make setup configure and report refresh policy

- [ ] **File**: `src/runtime/project-setup.ts:107-323`, `src/runtime/project-setup.ts:378-520`
- **Source**: `scip-query plan-context runProjectSetup --full --json`.
- **What**: setup validates config, refreshes once, installs hooks, and reports freshness; it does not explicitly report the persisted watch/auto-refresh policy.
- **Change**: add a setup step/smoke-test line that says whether project hooks will auto-refresh stale indexes based on `.scipquery.json`.
- **Why**: setup should leave future agents with a durable refresh contract.

### 3.2 - Update skills from "always reindex first" to "check freshness first"

- [ ] **File**: `skills/scip-query/SKILL.md`, `skills/concrete-plan/SKILL.md`, `skills/scip-verify/SKILL.md`, `skills/scip-query-setup/SKILL.md`, and other local scip skills that explicitly say to reindex before work.
- **Source**: `scip-query files skills --json`; text search after implementation for `scip-query reindex`.
- **What**: multiple skills currently instruct agents to run `scip-query reindex` before certain tasks, even when `status` already reports a fresh index.
- **Change**: replace unconditional wording with: check `scip-query status --json` or `scip-query status --capabilities`; if freshness is `fresh`, continue; if stale/missing/unknown, run `scip-query reindex`; if a watcher refresh is in progress, the manual reindex will preempt the watcher.
- **Why**: agents should rely on the freshness signal and avoid redundant work.

## Phase 4 - Diff-Gate Cleanup And Verification

### 4.1 - Resolve existing doc-reference findings

- [ ] **File**: validation docs listed by `scip-query diff-gate --json`
- **Source**: `scip-query diff-gate --json`.
- **What**: diff-gate currently reports doc-reference warnings because historical validation records cite changed implementation files.
- **Change**: add dated citation-refresh notes to the cited docs after rechecking the implementation targets.
- **Why**: the final diff-gate should be clean, not merely accepted.

### 4.2 - Verify

- [ ] **Commands**: `npm run typecheck`, targeted tests for reindex/watch/hooks/config/setup, `npm test`, `npm run docs:commands`, `scip-query reindex`, `scip-query diff-gate --json`.
- **Source**: `scip-query-setup` and `scip-verify` skills.
- **Why**: this touches runtime config, process coordination, agent hooks, setup docs, command docs, and skill instructions.

## Execution Order

1. Implement lock metadata and manual preemption.
2. Make watcher workers process-group killable.
3. Add `watch.autoRefresh` and hook-driven stale refresh.
4. Update setup reporting and command docs.
5. Update skills.
6. Resolve doc-reference drift and run verification.

## Ship Order

This can ship in one change. The only one-way-ish behavior is process preemption, so it must only target watcher-owned locks and must leave setup/manual locks untouched.
