# Incomplete Migration Second-Corpus Scope Validation

Date: 2026-06-22

## Goal

Validate the remaining `incomplete-migration` scope-heuristic caveat on a clean second corpus. Done means the ledger records whether the same-scope/subtype hints work outside the local fixture, and whether code changes are needed.

An incomplete migration is a diff-time review finding where a new helper is already wired into at least one changed file, while unchanged files still contain the helper's callee pattern. The practical maintenance fact is that this often means an extraction was started but not finished.

A migration-scope hint is a review label on each unchanged leftover site. It compares path and symbol-name words from the helper, migrated files, and leftover site so a maintainer can see whether the site probably belongs to the same rollout or may be a related variant.

## Current State

- `IncompleteMigrationLeftover` already carries `migrationScope` and `migrationScopeReasons`. Source: `node dist/cli.js plan-context incomplete-migration`.
- `collectLeftoversForHelper()` skips changed files, scores unchanged candidate sites by helper-callee containment and site coverage, then attaches scope hints. Source: `node dist/cli.js code collectLeftoversForHelper -C 12`.
- `incompleteMigration()` is diff-driven: clean Vega reported `changedFiles: []`, `helpersChecked: 0`, and no findings. Source: `/tmp/scip-query-validation/2026-06-22-score-weight-confirmation/Vega_2.0/incomplete-migration-current-clean.json`.
- The prior local fixture covers both `same-scope` and `possible-subtype` labels without suppressing either. Source: `docs/validation/2026-06-22-incomplete-migration-scope-hints-result.md`.

## Reuse Audit

- Reuse the existing `incomplete-migration` command and diff-gate; no new code or helper is planned.
- Reuse Vega as the second corpus by applying a temporary, reversible diff to tracked files, reindexing, running the analyzers, then removing the diff and reindexing back to clean.
- Cross-file target discovery used `similar --cross-file-only` and selected the create/edit assistant tool pair because they share a real callee cluster across different files.

## Validation Design

### 1. Establish Clean Baseline

- [x] **Corpus**: `/Users/aydansalois/Documents/GitHub/Vega_2.0`
- **Source**: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js incomplete-migration --json`.
- **What**: Clean Vega has no changed files, so the analyzer has no helper diff to evaluate.
- **Result**: Baseline output is saved as `incomplete-migration-current-clean.json`.

### 2. Try Same-File Probe And Reject It

- [x] **File**: `apps/api/src/scripts/diagnostics/live-api-fuzz.ts`
- **Source**: `node /Users/aydansalois/Documents/GitHub/scip-query/dist/cli.js similar --min-similarity 0.8 --limit 30 --json`.
- **What**: Three same-file diagnostic functions share the same request/assert/status/snippet callees.
- **Result**: A temporary helper was checked, but no finding was expected after reading `collectLeftoversForHelper()` because changed files are skipped as the active edit set.
- **Why**: This confirmed the second-corpus probe must be cross-file.

### 3. Run Cross-File Probe

- [x] **File**: `apps/api/src/modules/vega-assistant/tools/edit-issue-tool.ts`
- **Unchanged leftover**: `apps/api/src/modules/vega-assistant/tools/create-issue-tool.ts`
- **Source**: `similar --cross-file-only --min-similarity 0.55 --limit 80 --json`; `similar prepareEditIssueMigrationProbe --json`.
- **What**: A temporary helper in the edit tool used the shared assistant issue-tool callee cluster and was referenced from the changed edit file. The create tool stayed unchanged.
- **Result**: `incomplete-migration` reported the unchanged create tool as a leftover with `migrationScope: "same-scope"`.

### 4. Restore Corpus

- [x] **Corpus**: Vega
- **Source**: `git status --short`; `git diff --stat`; restore reindex output.
- **What**: Remove the temporary patch and reindex Vega back to the clean state.
- **Result**: Vega status and diff were clean before the restore reindex, and the restore reindex completed.

### 5. Record Verdict

- [x] **Files**: validation result, protocol, output-schema result, ledger, calibration memo.
- **Change**: Close the incomplete-migration second-corpus scope validation caveat. No product code change is needed.

## Verification Plan

- Record raw Vega outputs:
  - `incomplete-migration-current-clean.json`
  - `incomplete-migration-live-api-fuzz-synthetic.json`
  - `diff-gate-live-api-fuzz-synthetic.json`
  - `incomplete-migration-edit-create-tool-synthetic.json`
  - `diff-gate-edit-create-tool-synthetic.json`
  - `similar-edit-create-tool-synthetic.json`
- Confirm Vega is clean and reindexed after temporary probes.
- Format touched docs.
- Run local `node dist/cli.js reindex && node dist/cli.js diff-gate --json` before closing the slice.
