# GPT 5.5 Pro Feedback Follow-Through

Date: 2026-06-13

## Goal

The user wants the external review preserved in the repo and wants work started on the highest-leverage trust gaps. Here, trust means the tool gives users and agents output they can rely on before taking action: structured enough for programs, explicit about evidence, honest about uncertainty, and unwilling to silently ignore invalid project inputs.

Done for this first pass means the feedback is written down, one bounded implementation slice is shipped, and larger slices remain recorded as follow-up work rather than scattered intentions.

## Feedback Register

The review characterized scip-query as compiler-backed codebase understanding plus evidence-ranked cleanup for agents and engineers. Its main claim was that the next gains should improve trust, agent-consumability, onboarding, and safe action, not merely add more detectors.

1. Add stable JSON output for every command, not only `health`.
2. Make every finding carry evidence, location, confidence, severity, and a stable ID.
3. Add `cleanup-apply` or `cleanup-plan --patch` so proven deletion plans can become exact patches.
4. Publish a precise capability matrix by language instead of implying every detector has equal support everywhere.
5. Strengthen cleanup verification labeling so partial proof is never mistaken for whole-batch compiler proof.
6. Detect stale indexes before query commands and optionally enforce freshness for agent workflows.
7. Improve acceptance and suppression workflows with structured finding IDs, required reasons, and optional expiry.
8. Package docs with the npm artifact or convert README doc links to absolute GitHub URLs.
9. Add a CI initializer that writes GitHub Actions or generic CI config for reindex, diff-gate, health baseline, and JSON artifacts.
10. Add stricter config validation so invalid `.scipquery.json` cannot silently disable user settings.

## Current State

`loadProjectConfig` currently reads `.scipquery.json` and returns an empty config on any read or parse error. Source: `scip-query plan-context loadProjectConfig`, definition at `src/runtime/config.ts:20-33`.

The config loader feeds command startup through `resolveCliProjectContext`, direct reindex handling, dependency checks, and watch mode. Source: `scip-query plan-context loadProjectConfig`, references in `src/runtime/cli-context.ts:20`, `src/runtime/command-handlers.ts:61`, `src/runtime/command-handlers.ts:218`, and `src/runtime/command-handlers.ts:276`.

The npm package currently includes built output and bundled skills, but not docs. Source: `package.json`, `files` contains `dist/**/*.js`, `dist/**/*.d.ts`, and `skills/**/SKILL.md`.

## Reuse Audit

No existing config-validation helper exists on the public runtime surface. Source: `scip-query outline src/runtime/config.ts` lists only config loading, watch resolution, cache/index path resolution, config initialization, and directory creation.

No structurally similar config file helper was found. Source: `scip-query similar-files src/runtime/config.ts` returned no similar file pairs. `scip-query similar loadProjectConfig` only found local config initialization and unrelated workspace/package discovery as heuristic matches, neither of which formats project config errors.

The existing command registration path is the right place for friendly thrown-error handling. Source: `scip-query trace registerCommandDescriptors` shows every descriptor-backed command is registered through `src/runtime/command-registry.ts:11-40`.

## Implementation Plan

### 1. Preserve invalid config as a hard error

- [ ] **File**: `src/runtime/config.ts:20-33`
- **Source**: `scip-query plan-context loadProjectConfig`
- **What**: Missing config returns `{}`, but unreadable or invalid config also returns `{}`.
- **Change**: Keep missing config as `{}`. For read or parse failures, throw an error whose message includes `.scipquery.json`, the path, and the original failure message.
- **Why**: Invalid project settings are user input at the CLI boundary. Silently replacing them with defaults makes downstream analysis less trustworthy.

### 2. Render thrown command errors as CLI errors

- [ ] **File**: `src/runtime/command-registry.ts:11-40`
- **Source**: `scip-query trace registerCommandDescriptors`
- **What**: Command actions call handlers directly.
- **Change**: Wrap handler execution in a small `try`/`catch` that prints `error: <message>` and sets `process.exitCode = 1` for thrown errors.
- **Why**: Strict config errors should be readable for all descriptor-backed commands, including query commands that open the database through shared context.

### 3. Package docs

- [ ] **File**: `package.json`
- **Source**: package manifest read during planning.
- **What**: Published package files omit `docs/**/*.md`.
- **Change**: Add `docs/**/*.md` to `files`.
- **Why**: README links to local docs should remain useful after npm installation.

### 4. Test the trust boundary

- [ ] **File**: `tests/runtime-config.test.ts`
- **Source**: existing Vitest style in `tests/reindex-detect.test.ts`.
- **What**: There is no direct test for malformed `.scipquery.json`.
- **Change**: Add tests that missing config returns `{}`, valid config loads, malformed config throws, and unreadable config throws when the platform reports read failure.
- **Why**: The behavior is intentionally stricter and should not regress back to silent defaults.

## Stress Test

The change is reversible because it only alters runtime error handling and package metadata. The main user-visible risk is that a repository with a malformed config now fails immediately instead of limping forward with defaults; that is the intended correction.

The affected runtime path is shallow but broad: `scip-query affected loadProjectConfig` reports command context, reindex, check-deps, watch, status, and database-backed commands through depth five. The central command wrapper keeps the stricter error readable across that surface.

No data migration or persistent state is touched. The package metadata change only expands the published artifact to include docs.

## Verification

- `npm test -- tests/runtime-config.test.ts tests/cli-contract.test.ts`
- `npm run typecheck`
- `scip-query reindex && scip-query diff-gate`

