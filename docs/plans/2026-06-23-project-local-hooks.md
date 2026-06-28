# Project-Local Hook Setup

## Goal

Make scip-query hooks opt-in per repository. Installing the npm package should
not add global Codex or Claude Code hooks, because not every project supports
scip-query and global hook behavior is surprising. Running setup inside a repo
should configure that repo's `.codex/` and `.claude/` hook files.

## Current State

- `scip-query plan-context src/runtime/agent-hooks.ts --full` shows
  `installUserAgentHooks()` writes hook config through
  `src/runtime/agent-hooks.ts` and is consumed by setup command handlers and
  package setup.
- `scip-query code src/runtime/setup.ts:120-143` shows `postinstall()` installs
  hooks after skill installation, which makes the hook global at package
  install time.
- `scip-query code src/runtime/commands/command-handlers.ts:244-263` shows
  `setup-hooks` currently calls `installUserAgentHooks()`.
- `scip-query plan-context runProjectSetup --full` shows the robust setup flow
  already has the project root at `runProjectSetup()` and is the right place to
  configure project-local artifacts.

## Reuse Audit

- Reuse `mergeScipHookConfig()`, `pruneScipHookGroups()`, and
  `scipHookGroup()` from `src/runtime/agent-hooks.ts` instead of inventing a
  second hook schema writer. Source: `scip-query code src/runtime/agent-hooks.ts:137-205`.
- Reuse `setup-hooks` as the public command, but change its target to the
  current project root. Source: `scip-query code src/runtime/commands/command-handlers.ts:244-263`.
- Reuse `runProjectSetup()` orchestration so `scip-query setup --json`
  configures hooks during adoption. Source: `scip-query plan-context runProjectSetup --full`.

## Design

### 1. Make hook installation target-aware

- [ ] **File**: `src/runtime/agent-hooks.ts:69-140`
- **Source**: `scip-query plan-context src/runtime/agent-hooks.ts --full`
- **What**: `installUserAgentHooks()` assumes `~/.codex/hooks.json` and
  `~/.claude/settings.json`; `installProviderHooks()` skips missing provider
  roots.
- **Change**: Add `installProjectAgentHooks(projectRoot)` that writes
  `.codex/hooks.json` and `.claude/settings.json` under the repository,
  creating those directories when missing. Keep the user-level helper only for
  migration/removal.
- **Why**: Project setup should be opt-in and repo-local.

### 2. Remove package-install hook side effects

- [ ] **File**: `src/runtime/setup.ts:120-143`
- **Source**: `scip-query code src/runtime/setup.ts:120-143`
- **What**: `postinstall()` installs agent hooks globally.
- **Change**: Remove the hook install block from `postinstall()`; keep skills
  and SCIP binary checks.
- **Why**: Package install must not change global agent behavior.

### 3. Route setup-hooks and setup through project-local hooks

- [ ] **File**: `src/runtime/commands/command-handlers.ts:244-263`
- **Source**: `scip-query code src/runtime/commands/command-handlers.ts:244-263`
- **What**: `setup-hooks` currently calls the user-level hook installer.
- **Change**: Resolve the current project root and call
  `installProjectAgentHooks(projectRoot)`.
- **Why**: The command should configure the repo where setup is running.

- [ ] **File**: `src/runtime/project-setup.ts:117-240`
- **Source**: `scip-query plan-context runProjectSetup --full`
- **What**: setup installs skills, indexes, checks health, and writes agent
  guidance, but hook config is not a project setup step.
- **Change**: Add a "Project agent hooks" setup step and include the hook result
  in the setup report.
- **Why**: A robust setup pass should leave this repository ready for Codex and
  Claude Code without requiring global hooks.

### 4. Document and test the new default

- [ ] **Files**:
  - `tests/runtime/setup.test.ts`
  - `tests/runtime/project-setup.test.ts`
  - `tests/runtime/cli-contract.test.ts`
  - `README.md`
  - `docs/AGENT_GUIDE.md`
  - `docs/AI_FAILURE_MODES.md`
  - `skills/scip-query-setup/SKILL.md`
  - `skills/scip-adoption/SKILL.md`
  - `skills/scip-query/SKILL.md`
- **Source**: `rg "setup-hooks|user-level lifecycle hooks|hooks.json" README.md docs skills src tests`
- **Change**: Update tests and docs from user-level hooks to project-local
  hooks. Keep `SCIP_QUERY_SKIP_HOOK_INSTALL=1` as an opt-out for setup.
- **Why**: Agents and users need the setup workflow to match actual behavior.

## Verification

- `npx vitest run tests/runtime/setup.test.ts tests/runtime/project-setup.test.ts tests/runtime/agent-hooks.test.ts tests/runtime/cli-contract.test.ts`
- `npm run docs:commands`
- `npm run lint`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
