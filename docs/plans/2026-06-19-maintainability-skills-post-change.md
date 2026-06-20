# Maintainability Skills Post-Change Verification Plan

Date: 2026-06-19

## Goal

The user wants the maintainability skills to cover both halves of frontend/codebase cleanup: first finding extraction, reuse, consolidation, and compression opportunities; then verifying that any implemented extraction is wired into every place that should consume it. Done means the general, Vue, and React maintainability skills tell agents to discover candidates with scip-query and then prove the completed change with the same post-change commands that `diff-gate` compiles.

A maintainability skill is a local instruction package that guides an agent through evidence gathering, implementation choices, and verification for changes that reduce future modification cost. The essential thing that makes it a skill, rather than ordinary documentation, is that it is loaded at the moment of work and constrains the agent's procedure.

Post-change verification is the set of checks run after editing to prove that a claimed refactor, extraction, deletion, or consolidation is actually complete. Its essential characteristic is that it compares the new diff and current graph against the original intent, so it catches half-migrations and fresh duplication instead of only finding candidates.

## Current State

- `skills/scip-maintainability/SKILL.md` exists and has strong discovery/review guidance, but its verification section stops at general structural probes and does not require the full post-change command matrix for implemented smells. Source: direct file read, because `scip-query plan-context skills/scip-maintainability/SKILL.md --json` reported the markdown skill is not indexed.
- `skills/scip-vue-maintainability/SKILL.md` exists and focuses on Vue duplicate/component/composable/large-view discovery, but it does not force `recent-duplicates`, `incomplete-migration`, and other migration-completeness checks after an agent acts on a candidate. Source: direct file read, because `scip-query plan-context skills/scip-vue-maintainability/SKILL.md --json` reported the markdown skill is not indexed.
- `skills/scip-react-maintainability/SKILL.md` was initialized with the skill-creator scaffold and still needs real content. Source: skill-creator scaffold command and direct file read.
- `install-skills` installs entries from `BUILTIN_SKILLS`. `scip-query code 'src/runtime/setup.ts:10-22'` shows the current list includes Vue maintainability but not React maintainability.
- `BUILTIN_SKILLS` affects setup tests and command descriptor text. Source: `scip-query refs BUILTIN_SKILLS --json`; `scip-query code 'tests/setup.test.ts:1-180'`; `scip-query code 'src/runtime/command-descriptors.ts:140-170'`.

## Reuse Audit

- Reuse the existing general `scip-maintainability` workflow and add a post-change matrix instead of creating a separate generic verification skill. Source: direct file read of `skills/scip-maintainability/SKILL.md`.
- Reuse Vue skill wording and command shape as the model for the new React skill, swapping Vue commands for `react-component-duplicates`, `react-hook-candidates`, and `react-large-component-pressure`. Source: direct file read of `skills/scip-vue-maintainability/SKILL.md`.
- Reuse `BUILTIN_SKILLS` installation plumbing; do not write a custom installer. Source: `scip-query code installSkills -C 12`.

## Plan

### 1. Add the React maintainability skill

- [x] **File**: `skills/scip-react-maintainability/SKILL.md`.
- **Source**: skill-creator scaffold; direct file read.
- **Change**: Replace the template with concise React frontend maintainability guidance. Include discovery commands, false-positive checks, implementation guidance, and post-change verification for component extraction, hook extraction, reuse of existing components/hooks, large-component splits, and docs/tests.
- **Why**: React has dedicated detectors now, but agents need a skill that routes them through both candidate discovery and completion proof.

### 2. Update Vue maintainability

- [x] **File**: `skills/scip-vue-maintainability/SKILL.md`.
- **Source**: direct file read.
- **Change**: Add explicit implementation and post-change verification sections covering `recent-duplicates`, `incomplete-migration`, `similar-files`, `vue-*` reruns, `unused-params`, wrapper/pass-through/stale checks, `diff-impact`, and `diff-gate`.
- **Why**: Vue review currently finds reuse opportunities but does not make agents prove migrations are complete.

### 3. Update general maintainability

- [x] **File**: `skills/scip-maintainability/SKILL.md`.
- **Source**: direct file read.
- **Change**: Expand verification from broad probes to a change-type matrix. Make implemented maintainability fixes run the same targeted post-checks that the scip-query router requires.
- **Why**: General maintainability work can introduce the same half-migration failures as frontend work.

### 4. Install the React skill globally through `install-skills`

- [x] **File**: `src/runtime/setup.ts:10-22`.
- **Source**: `scip-query code 'src/runtime/setup.ts:10-22'`.
- **Change**: Add `scip-react-maintainability` to `BUILTIN_SKILLS` near `scip-maintainability` and `scip-vue-maintainability`.
- **Why**: `install-skills` iterates this array to symlink bundled skills into Claude, Codex, and shared agent roots.

### 5. Update tests and generated command reference

- [x] **File**: `tests/setup.test.ts:81-134`.
- **Source**: `scip-query code 'tests/setup.test.ts:1-180'`.
- **Change**: Assert React maintainability installs to Claude, Codex, and Agents.
- [x] **File**: `docs/COMMAND_REFERENCE.md:113-130`.
- **Source**: `scip-query code 'src/runtime/command-descriptors.ts:140-170'`.
- **Change**: Update generated maintenance row for `install-skills` after `BUILTIN_SKILLS` changes.
- **Why**: Existing tests enforce lockstep between `skills/`, installer list, and public command docs.

## Verification

- [x] Validate edited skill folders with `quick_validate.py`.
- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run `npm test -- tests/setup.test.ts tests/cli-contract.test.ts`.
- [x] Run full `npm test`.
- [x] Run `npm run build`.
- [x] Run `npm pack --dry-run --json`.
- [x] Run `npm install -g .` and `scip-query install-skills`.
- [x] Run `git diff --check`.
- [x] Run `scip-query reindex && scip-query diff-gate`.
