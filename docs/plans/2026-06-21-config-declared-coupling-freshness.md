# Config Declared-Coupling Freshness Plan

Date: 2026-06-21

## Goal

A declared coupling is a project configuration entry that names files which intentionally form one maintenance unit. It exists so history-based hidden-coupling analysis can distinguish accidental coordination from known file groups. Its essential requirement is that the named paths still identify real files; otherwise the declaration silently stops explaining the relationship it was meant to document.

Done means `.scipquery.json` points at current files, `config-validate` warns when declared-coupling paths are stale, and the analyzer ledger records the freshness check.

## Current State

- `node dist/cli.js code 'src/domain/config-types.ts:70-115' --json` showed `DeclaredCouplingConfig.files` is documented as exact relative file paths.
- `node dist/cli.js code 'src/runtime/config.ts:62-133' --json` showed `validateProjectConfig()` checks declared-coupling shape, blank names, blank paths, minimum file count, and blank reasons, but not whether the file paths exist.
- `node dist/cli.js code 'src/runtime/commands/command-handlers.ts:311-326' --json` showed `handleConfigValidate()` already resolves `projectRoot` before calling `validateProjectConfig()`, but does not pass it in.
- `node dist/cli.js code declaredCouplingSets --json` and `node dist/cli.js code hasStructuralLink --json` showed co-change filtering uses declared paths literally. A stale path cannot match a current file pair.
- `node dist/cli.js config-validate --json` currently returns no diagnostics in this repo.
- A filesystem freshness check found 18 stale `.scipquery.json` declared-coupling paths, including moved cleanup, graph, navigation, doc-drift, and runtime command files.
- `node dist/cli.js recent-duplicates --json` returned no findings.

## Reuse Audit

- Reuse `validateProjectConfig()` rather than adding a new command or config parser.
- Reuse the existing `ConfigDiagnostic` warning channel. Missing declared-coupling files should warn rather than error because historical configs may include files intentionally removed during a migration.
- Reuse `handleConfigValidate()`'s existing `projectRoot`; pass it to validation instead of resolving roots again elsewhere.
- Reuse Node `existsSync()` and `join()` already imported in `src/runtime/config.ts`.

## Design

### 1. Validate declared-coupling file freshness

- [x] **File**: `src/runtime/config.ts:62-133`
- **Source**: `node dist/cli.js code 'src/runtime/config.ts:62-133' --json`
- **What**: Declared coupling file paths are checked for blank strings only.
- **Change**: Extend `validateProjectConfig()` options with `projectRoot?: string`. When present, warn for any nonblank declared-coupling file that does not exist at `join(projectRoot, file)`.
- **Why**: Stale declared paths silently disable the structural explanation co-change relies on.

### 2. Pass project root from config-validate

- [x] **File**: `src/runtime/commands/command-handlers.ts:311-326`
- **Source**: `node dist/cli.js code 'src/runtime/commands/command-handlers.ts:311-326' --json`
- **What**: `handleConfigValidate()` resolves `projectRoot` but calls `validateProjectConfig(config)` without it.
- **Change**: Call `validateProjectConfig(config, { projectRoot })`.
- **Why**: Freshness validation needs the project root to resolve relative config paths.

### 3. Refresh this repo's declared-coupling paths

- [x] **File**: `.scipquery.json`
- **Source**: filesystem check of `.scipquery.json` declared-coupling paths; code consumers verified by `node dist/cli.js code declaredCouplingSets --json`
- **What**: 18 declared paths still use pre-folder-move locations.
- **Change**: Update them to the current `src/queries/cleanup`, `src/queries/graph`, `src/queries/navigation`, `src/queries/quality`, `src/runtime/commands`, and `src/queries/cleanup/doc-drift.ts` paths.
- **Why**: Co-change declared-coupling groups should match the current indexed file paths.

### 4. Add regression coverage

- [x] **File**: `tests/runtime/runtime-config.test.ts`
- **Source**: test tree is not SCIP-indexed; existing config validation tests were inspected directly.
- **What**: Existing tests cover declared-coupling shape, not freshness.
- **Change**: Add a test that passes `projectRoot` and confirms missing declared-coupling files warn while existing files do not.
- **Why**: Config freshness should not regress silently.

### 5. Record validation result

- [x] **File**: `docs/validation/2026-06-21-config-declared-coupling-freshness-result.md`
- **Source**: `docs/analyzer-validation-ledger.md` AVL-013.
- **What**: AVL-013 is ready and asks for stale config paths to be fixed, removed, or documented.
- **Change**: Record stale-path count before, config paths after, command output, and verification.
- **Why**: The ledger needs a durable result, not just an edited config file.

## Verification

- `npx vitest run tests/runtime/runtime-config.test.ts`
- `node dist/cli.js config-validate --json`
- Filesystem stale-path check for `.scipquery.json`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

This changes `config-validate` warnings only when callers provide `projectRoot`; ordinary config parsing and co-change behavior stay unchanged. Missing declared-coupling paths are warnings, not errors, so older configs remain readable while users get an actionable freshness signal.

## Result

Completed in `docs/validation/2026-06-21-config-declared-coupling-freshness-result.md`.
