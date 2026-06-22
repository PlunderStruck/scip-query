# Support Analysis Accuracy Plan

Date: 2026-06-21

## Goal

A support analysis is a command that reports facts a maintainer or another analyzer uses to decide what to do. It does not itself name code as bad. Its essential obligation is referential accuracy: the files, symbols, callers, diagnostics, and capability boundaries it reports must agree with the source, the index, and the canonical validator.

Done means the support commands under review have been checked against known source facts, any discovered wiring mismatch is fixed, and AVL-004 records the accuracy verdict and remaining unsupported cases.

## Current State

- `node dist/cli.js plan-context validateProjectConfig --full --json` showed `plan-context` finds the right definition in `src/runtime/config.ts`, the right callers, the call graph, complexity, affected symbols, change surface, dependencies, reverse dependencies, and suppression count for the file.
- `node dist/cli.js refs validateProjectConfig --json` reported five source references.
- `rg -n "validateProjectConfig|addFindingSuppression|loadProjectConfig" src tests` confirmed the production references to `validateProjectConfig()` are the import in `command-handlers.ts`, the command handler call, two diagnostic-report type/value uses, and the internal `addFindingSuppression()` call.
- `node dist/cli.js affected validateProjectConfig --json` reported first-order affected symbols `handleConfigValidate()`, `buildProjectDiagnosticReport()`, and `addFindingSuppression()`, then second-order command handlers that consume those functions.
- `node dist/cli.js change-surface src/runtime/config.ts --json` reported the expected exported config helpers and external consumers.
- `node dist/cli.js self-audit --samples 60 --json` reported reference precision 1.0, reference recall 0.853, callee recall 1.0, and cheap-only callee disagreements for Vue/source fallback and semantic-provider internals.
- The review surfaced one support-output mismatch: `handleConfigValidate()` passes `{ projectRoot }` to `validateProjectConfig()`, but `buildProjectDiagnosticReport()` still calls `validateProjectConfig(config)` without the root, so `status` and `doctor` can miss stale config path warnings.

## Reuse Audit

- Reuse `buildProjectDiagnosticReport()` rather than duplicating diagnostic logic in `status` or `doctor`.
- Reuse `validateProjectConfig(config, { projectRoot })`; it is already the canonical config validator for root-aware path checks.
- Reuse `handleStatus()` for regression coverage. Its JSON output exposes `configDiagnostics`, so the test can exercise the real support command path without exporting private helpers.
- Reuse existing evidence-provider commands for validation notes instead of adding new command surface.

## Design

### 1. Make project diagnostic reports root-aware

- [x] **File**: `src/runtime/commands/command-handlers.ts:367-409`
- **Source**: `node dist/cli.js code buildProjectDiagnosticReport --json`
- **What**: `buildProjectDiagnosticReport()` resolves `projectRoot` but does not pass it to `validateProjectConfig()`.
- **Change**: Call `validateProjectConfig(config, { projectRoot })`.
- **Why**: `status` and `doctor` are support commands; their config diagnostics must agree with `config-validate`.

### 2. Add support-command regression coverage

- [x] **File**: `tests/runtime/runtime-config.test.ts`
- **Source**: `handleStatus()` JSON output includes `configDiagnostics`.
- **What**: Existing tests cover `validateProjectConfig()` directly, but not the support command path.
- **Change**: In a temp project selected through `SCIP_QUERY_PROJECT_ROOT`, call `handleStatus({ json: true })` and assert a stale declared-coupling file warning appears in the JSON envelope.
- **Why**: The bug was not in the validator; it was in a support command failing to use the validator with enough context.

### 3. Record support-analysis accuracy verdict

- [x] **File**: `docs/validation/2026-06-21-support-analysis-accuracy-result.md`
- **Source**: AVL-004 and the command outputs above.
- **What**: Support commands need referential-accuracy notes and known unsupported cases.
- **Change**: Record `refs`, `affected`, `change-surface`, `plan-context`, and `self-audit` verdicts against the `validateProjectConfig()` target.
- **Why**: The ledger needs to distinguish "support facts are accurate" from "support facts are complete for every language and dynamic call pattern."

## Verification

- `npx vitest run tests/runtime/runtime-config.test.ts`
- `node dist/cli.js status --json`
- `node dist/cli.js refs validateProjectConfig --json`
- `node dist/cli.js affected validateProjectConfig --json`
- `node dist/cli.js change-surface src/runtime/config.ts --json`
- `node dist/cli.js plan-context validateProjectConfig --full --json`
- `node dist/cli.js self-audit --samples 60 --json`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

This changes only support-command diagnostics. It may surface warnings in `status` and `doctor` that were already visible through `config-validate`; that is desired because support commands should not hide canonical configuration problems.

## Result

Completed in `docs/validation/2026-06-21-support-analysis-accuracy-result.md`.
