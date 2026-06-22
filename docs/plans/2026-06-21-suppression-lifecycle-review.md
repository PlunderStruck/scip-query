# Suppression Lifecycle Review Plan

Date: 2026-06-21

## Goal

A suppression is a recorded maintainer decision to accept or silence an analyzer finding. In this tool it appears either as a source comment near code, such as `scip-query: ignore-wrapper`, or as a structured `.scipquery.json` entry used by `diff-gate`. Its essential job is to preserve a human judgment that a detector's raw claim is not enough to justify action in that location.

Done means source suppression comments have been inventoried and sampled, structured suppressions validate their lifecycle fields, stale file-scoped structured suppressions produce diagnostics, and the analyzer ledger records how suppression counts should affect detector trust.

## Current State

- `node dist/cli.js plan-context suppressionInventory --full --json` showed `src/analysis/suppressions.ts` owns source suppression inventory and is consumed by `health` and `plan-context`.
- `node dist/cli.js code scanSuppressions --json` showed source suppressions are counted by category and file, but not returned with per-comment details.
- `node dist/cli.js code suppressionCommentCategory --json` and `src/source/source-text.ts` showed the parser only counts directive-shaped comments, not prose examples or strings.
- `node dist/cli.js health --full --json` reported 174 source suppressions: 72 extract, 62 wrapper, 17 stale, 15 similar, 8 passthrough, 0 dead, 0 drift, and 0 uncategorized.
- A filesystem scan with the production directive regex confirmed 174 source suppressions, all with reason text.
- `.scipquery.json` currently has no structured suppressions.
- `node dist/cli.js code validateProjectConfig --json` showed structured suppressions require a reason and an id or check, and already warn after `expiresAt`.
- `node dist/cli.js code applyStructuredSuppressions --json` and `node dist/cli.js code suppressionMatches --json` showed expired structured suppressions do not match diff-gate findings.
- `node dist/cli.js code addFindingSuppression --json` showed new structured suppressions are validated before writing, but validation currently does not check whether an optional suppression file path exists.

## Reuse Audit

- Reuse `validateProjectConfig()` and `ConfigDiagnostic`; stale suppression files should warn just like stale declared-coupling files.
- Reuse `projectRoot` in `handleConfigValidate()` and `addFindingSuppression()` rather than adding a separate suppression-validator command.
- Reuse the existing source suppression inventory for counts; detailed source-comment lifecycle review can be a validation artifact until the product needs a first-class command.
- Reuse the existing expiration behavior in `suppressionMatches()`; no diff-gate behavior change is needed for expired suppressions.

## Design

### 1. Validate structured suppression file freshness

- [x] **File**: `src/runtime/config.ts:62-142`
- **Source**: `node dist/cli.js code validateProjectConfig --json`
- **What**: `FindingSuppression.file` is documented as a relative file path, but validation does not reject blank strings or warn when the file no longer exists.
- **Change**: When a structured suppression includes `file`, error on a blank path. When `projectRoot` is available and the nonblank file does not exist, emit a warning.
- **Why**: A file-scoped suppression that names a moved or deleted file no longer identifies the finding it was meant to accept.

### 2. Use root-aware validation when adding suppressions

- [x] **File**: `src/runtime/config.ts:223-240`
- **Source**: `node dist/cli.js code addFindingSuppression --json`
- **What**: `addFindingSuppression()` validates the next config before writing it, but without `projectRoot`.
- **Change**: Call `validateProjectConfig(next, { projectRoot })` before filtering errors.
- **Why**: Future root-dependent validation errors should apply equally to command-created suppressions and hand-edited configs.

### 3. Add regression coverage

- [x] **File**: `tests/runtime/runtime-config.test.ts`
- **Source**: existing structured suppression and config freshness tests in `tests/runtime/runtime-config.test.ts`.
- **What**: Tests cover missing suppression identity/reason, expiry, and declared-coupling file freshness, but not suppression file freshness.
- **Change**: Add tests for blank structured suppression file paths and missing file warnings.
- **Why**: Suppression lifecycle checks are trust infrastructure; they should not depend on manual config review.

### 4. Review source suppression lifecycle evidence

- [x] **File**: `docs/validation/2026-06-21-suppression-lifecycle-result.md`
- **Source**: `node dist/cli.js health --full --json`, production-regex source scan, and sampled source comments.
- **What**: Health reports only category counts. The ledger needs a judgment about whether source suppressions are justified, stale, expired, or useful precision feedback.
- **Change**: Record category counts, top files, reason coverage, sample verdicts, and detector-trust implications.
- **Why**: Suppressions are not merely ignored warnings; they are evidence about detector false positives, accepted design, and score calibration.

## Verification

- `npx vitest run tests/runtime/runtime-config.test.ts`
- `node dist/cli.js config-validate --json`
- `node dist/cli.js health --full --json`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

The code change is limited to config diagnostics. Missing structured suppression files are warnings, not errors, so old configs remain readable. Source suppression comments are only reviewed and documented in this slice; changing their command surface can wait until the validation result proves a concrete need.

## Result

Completed in `docs/validation/2026-06-21-suppression-lifecycle-result.md`.
