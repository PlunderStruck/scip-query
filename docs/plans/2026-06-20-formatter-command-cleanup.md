# Formatter And Command Cleanup Plan

Date: 2026-06-20

## Goal

The user is trying to reduce fast-growth roughness without turning a working CLI into a rewrite. Done means the repo has an enforced formatter, command docs stay in sync after package/script changes, and the largest cleanup command module is split into smaller files while preserving the existing command descriptor contract.

A formatter is a development tool that rewrites source text into one consistent layout while leaving program behavior unchanged. A command descriptor is the data record that names a CLI command, its options, its documentation category, and the handler Commander will run. A command adapter is the function that turns CLI arguments and options into query calls and terminal or JSON output. A renderer is the display-side function that turns query results into text users see.

## Current State

`src/runtime/query-commands/cleanup.ts` is both a module and the cleanup command family. It currently contains handlers, render helpers, descriptor helpers, and `cleanupQueryCommandDescriptors` in one file. `scip-query plan-context src/runtime/query-commands/cleanup.ts` reports definitions across `src/runtime/query-commands/cleanup.ts:1-1270`, including `handleDead` at line 34, `renderDeadGroup` at lines 99-132, descriptor helper types at lines 610-616, `cleanupCommand` at lines 618-623, `heuristicCleanupCommand` at lines 625-633, and `cleanupQueryCommandDescriptors` at line 863.

The external command wiring is narrow. `scip-query plan-context cleanupQueryCommandDescriptors` shows the descriptor array is defined at `src/runtime/query-commands/cleanup.ts:863` and referenced only by `src/runtime/commands/query-command-specs.ts:2` and `src/runtime/commands/query-command-specs.ts:78`.

The query command registry is order-sensitive. `scip-query code 'src/runtime/commands/query-command-specs.ts:1-98'` shows `queryCommandOrder` at lines 10-72, `queryCommandFamilies` at lines 74-82, `familyDescriptors` at line 84, `QUERY_COMMANDS_BY_ID` at line 85, and a runtime check at lines 87-90 that throws when a descriptor id is not listed in order.

The existing command helper layer already owns common adapter shapes. `scip-query code 'src/runtime/commands/command-execution.ts:72-180'` shows `dbCommand`, `budgetedDbCommand`, `listCommand`, `tableCommand`, `groupedByFileCommand`, `reportCommand`, `sectionedReportCommand`, and budgeted variants. `scip-query code 'src/runtime/commands/query-command-builders.ts:1-102'` shows `listQueryCommand`, `tableQueryCommand`, `groupedQueryCommand`, `sectionedQueryCommand`, and `budgetedSectionedQueryCommand` wrapping those lower-level helpers.

Command documentation is generated from descriptors. `scip-query plan-context renderCommandReferenceMarkdown` shows `renderCommandReferenceMarkdown` at `src/runtime/commands/command-docs.ts:29-54`, with references from `scripts/render-command-reference.ts:2`, `scripts/render-command-reference.ts:6`, `tests/runtime/cli-contract.test.ts:6`, and `tests/runtime/cli-contract.test.ts:82`.

The docs are already stale against a package-level co-change. `scip-query doc-drift docs/COMMAND_REFERENCE.md --limit 10` reports `docs/COMMAND_REFERENCE.md` as stale because `package.json` changed three times since the doc and is historically coupled to the doc five times.

The cleanup file has medium risk but few external consumers. `scip-query change-surface src/runtime/query-commands/cleanup.ts` reports external consumers 2, with `src:runtime:query-commands:cleanup` at `src/runtime/query-commands/cleanup.ts:1-1270` and `cleanupQueryCommandDescriptors` at `src/runtime/query-commands/cleanup.ts:863` each having one consumer.

Config files and tests are not fully readable through the current SCIP source index. `scip-query files package` finds TypeScript package-surface helpers, not root `package.json`. `scip-query plan-context tests/runtime/cli-contract.test.ts` reports no file or module match. The plan treats package/test line numbers as verification gaps and uses package-manager commands plus test execution for those files instead of pretending SCIP can cite them.

## Reuse Audit

No new command framework should be written. `scip-query surface src/runtime/commands` shows cleanup commands already use `dbCommand`, `budgetedDbCommand`, `budgetedListCommand`, `budgetedReportCommand`, `budgetedGroupedByFileCommand`, `budgetedTableCommand`, `groupedQueryCommand`, `option`, `withJsonOption`, and `doc`. The split should keep using these helpers.

No structurally similar cleanup command file exists to copy. `scip-query similar-files src/runtime/query-commands/cleanup.ts --limit 10 --scope src/runtime` reports no similar file pairs.

No duplicate helper matching `cleanupCommand` was found. `scip-query similar cleanupCommand --limit 10` reports no similar symbols found. Keep `cleanupCommand` and `heuristicCleanupCommand` as local cleanup descriptor helpers, but move them to the cleanup descriptor module with the descriptor array.

No recent reimplementation should be folded into this plan. `scip-query recent-duplicates --limit 10` reports no recent re-implementations in the last 100 commits.

Broad flow duplication is unrelated to this task. `scip-query similar-chains --limit 10 --scope src/runtime` surfaces runtime/config and cleanup-verify dependency chains, but not an alternate command-family split pattern that should replace this plan.

## Design Phases

### 0.1 - Regenerate command docs after package script changes

- [ ] **File**: `docs/COMMAND_REFERENCE.md` generated block
- **Source**: `scip-query doc-drift docs/COMMAND_REFERENCE.md --limit 10`; `scip-query plan-context renderCommandReferenceMarkdown`
- **What**: The generated command reference is stale because `package.json` moved after the docs. `renderCommandReferenceMarkdown` generates descriptor-owned command syntax and is consumed by `scripts/render-command-reference.ts` and `tests/runtime/cli-contract.test.ts`.
- **Change**: After adding formatter scripts in phase 1, run `npm run docs:commands` and commit any generated change in `docs/COMMAND_REFERENCE.md`.
- **Why**: This closes the stale-doc signal before the command split lands.

### 1.1 - Add formatter package and scripts

- [ ] **File**: `package.json` script and devDependency sections
- **Source**: `scip-query doc-drift docs/COMMAND_REFERENCE.md --limit 10` named `package.json` as the stale co-change partner. Root `package.json` is not currently line-readable by `scip-query`; verify exact JSON line placement with `npm pkg get scripts` and `npm pkg get devDependencies`.
- **What**: The package file owns repo scripts, but `scip-query` cannot provide root JSON line references from the current TypeScript index.
- **Change**: Add `prettier` to `devDependencies`. Add scripts:

  ```json
  "format": "prettier --write \"{src,tests,scripts}/**/*.{ts,tsx,js,mjs,json}\" \"*.{ts,js,json}\"",
  "format:check": "prettier --check \"{src,tests,scripts}/**/*.{ts,tsx,js,mjs,json}\" \"*.{ts,js,json}\"",
  "lint": "npm run format:check && eslint src tests tsup.config.ts"
  ```

- **Why**: Formatting becomes mechanically enforceable without changing runtime behavior.

### 1.2 - Add formatter configuration

- [ ] **File**: create `.prettierrc.json`
- **Source**: Config files are not indexed by `scip-query`; this is a non-code config addition. Reuse the repo's current TypeScript style observed through `scip-query code 'src/runtime/commands/query-command-builders.ts:1-102'`.
- **What**: Current TypeScript uses single quotes, semicolons, and trailing commas in multi-line literals.
- **Change**: Create:

  ```json
  {
    "singleQuote": true,
    "semi": true,
    "trailingComma": "all",
    "printWidth": 120
  }
  ```

- **Why**: These settings minimize churn against the style visible in the indexed code.

### 1.3 - Add formatter ignore rules

- [ ] **File**: create `.prettierignore`
- **Source**: Non-code config addition. The indexed cleanup file depends on generated/runtime artifacts such as `dist` only indirectly; config-file existence is not represented in SCIP.
- **What**: Generated and cache artifacts should not be formatted.
- **Change**: Ignore `dist`, `node_modules`, `coverage`, `.scipquery-cache`, `index.db*`, `index.scip`, and `*.tgz`.
- **Why**: The formatter should operate on source and config, not generated indexes or published bundles.

### 1.4 - Run the mechanical formatting pass

- [ ] **File**: source/config files selected by the new `format` script
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup.ts:940-1270'` shows indentation drift in descriptor options around lines 937-941, 1008-1014, 1123-1130, and 1238-1247.
- **What**: The cleanup descriptors currently contain uneven indentation even though lint passes.
- **Change**: Run `npm run format`. Commit this as a mechanical-only phase.
- **Why**: The command split should not be mixed with formatting churn.

### 2.1 - Move cleanup-specific render helpers

- [ ] **File**: create `src/runtime/query-commands/cleanup/renderers.ts`
- **Source**: `scip-query code renderDeadGroup -C 5`
- **What**: `renderDeadGroup` at `src/runtime/query-commands/cleanup.ts:99-132` prints grouped dead-code rows by file, sorted by total LOC and then start line.
- **Change**: Move `renderDeadGroup` into the new file and export it. Preserve the same ordering and output strings. Adjust imports for `displayRange` and the dead-query row type from the deeper directory.
- **Why**: Display-only code leaves the handler module and becomes easier to test or inspect independently.

### 2.2 - Move cleanup command handlers

- [ ] **File**: create `src/runtime/query-commands/cleanup/handlers.ts`
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup.ts:34-140'`; `scip-query code 'src/runtime/query-commands/cleanup.ts:635-861'`; `scip-query plan-context src/runtime/query-commands/cleanup.ts`
- **What**: Lines 34-861 contain cleanup command handlers, including JSON paths, validation errors, cleanup verification, and terminal output for cleanup-plan/apply/doc-drift/recent-duplicates/unused-params.
- **Change**: Move all `handle*` command adapter constants from lines 34-861 into `handlers.ts`. Export each handler used by descriptors. Import `renderDeadGroup` from `./renderers.js`. Rewrite relative imports for the deeper directory:
  - `../../../queries/index.js`
  - `../../../domain/types.js`
  - `../../commands/command-execution.js`
  - `../../commands/query-command-builders.js`
  - `../../cleanup-verify.js`
  - `../../cli-context.js`
  - `../../cli-support.js`
  - `../../render.js`
- **Why**: The behavior-heavy CLI adapters become separate from descriptor declarations.

### 2.3 - Move cleanup descriptor helpers and descriptors

- [ ] **File**: create `src/runtime/query-commands/cleanup/descriptors.ts`
- **Source**: `scip-query code cleanupCommand -C 5`; `scip-query code heuristicCleanupCommand -C 5`; `scip-query code 'src/runtime/query-commands/cleanup.ts:840-940'`; `scip-query code 'src/runtime/query-commands/cleanup.ts:940-1270'`
- **What**: `cleanupCommand` supplies default Cleanup docs. `heuristicCleanupCommand` wraps cleanup descriptors with a heuristic label. `cleanupQueryCommandDescriptors` at lines 863-1269 declares the cleanup command family and binds each descriptor to a handler.
- **Change**: Move `CleanupCommandDescriptor`, `HeuristicCleanupCommandDescriptor`, `cleanupCommand`, `heuristicCleanupCommand`, and `cleanupQueryCommandDescriptors` into `descriptors.ts`. Import exported handlers from `./handlers.js`. Preserve descriptor order exactly.
- **Why**: Descriptor metadata becomes readable without interleaved handler implementations.

### 2.4 - Preserve the public import path

- [ ] **File**: replace `src/runtime/query-commands/cleanup.ts:1-1270`
- **Source**: `scip-query plan-context cleanupQueryCommandDescriptors`; `scip-query code 'src/runtime/commands/query-command-specs.ts:1-98'`
- **What**: `src/runtime/commands/query-command-specs.ts:2` imports `cleanupQueryCommandDescriptors` from `../query-commands/cleanup.js`, and line 78 includes it in `queryCommandFamilies`.
- **Change**: Replace the original file with:

  ```ts
  export { cleanupQueryCommandDescriptors } from './cleanup/index.js';
  ```

  Create `src/runtime/query-commands/cleanup/index.ts` with:

  ```ts
  export { cleanupQueryCommandDescriptors } from './descriptors.js';
  ```

- **Why**: Existing imports keep working while the implementation moves into a directory.

### 2.5 - Keep registry behavior unchanged

- [ ] **File**: `src/runtime/commands/query-command-specs.ts:1-98`
- **Source**: `scip-query code 'src/runtime/commands/query-command-specs.ts:1-98'`
- **What**: The registry imports cleanup descriptors at line 2, combines family descriptor arrays at lines 74-82, and throws at lines 87-90 when a descriptor is missing from `queryCommandOrder`.
- **Change**: Do not edit this file during the split. If typecheck fails because the cleanup barrel path is wrong, fix the barrel, not the registry.
- **Why**: The safest intermediate state preserves the only current consumer unchanged.

### 2.6 - Avoid extending shared command builders in the first split

- [ ] **File**: `src/runtime/commands/query-command-builders.ts:1-102`
- **Source**: `scip-query plan-context src/runtime/commands/query-command-builders.ts`; `scip-query change-surface src/runtime/commands/query-command-builders.ts`
- **What**: `query-command-builders.ts` has 10 external consumers and provides common builder helpers for cleanup, graph, and navigation commands.
- **Change**: Do not add new builder abstractions in the initial split. Only revisit this file in a later patch if post-split duplication remains concrete and measurable.
- **Why**: This keeps phase 2 as a file organization change, not a shared framework change.

### 3.1 - Validate descriptor and generated-doc contracts

- [ ] **File**: `src/runtime/commands/command-docs.ts:29-54`
- **Source**: `scip-query plan-context renderCommandReferenceMarkdown`
- **What**: `renderCommandReferenceMarkdown` generates command syntax from descriptors and is referenced by the docs script and CLI contract tests.
- **Change**: Run `npm run docs:commands`, `npm run lint`, `npm run typecheck`, and `npm test`.
- **Why**: Descriptor order, option flags, command docs, and command behavior must remain unchanged after the split.

### 3.2 - Reindex and gate the diff

- [ ] **File**: repository index and changed files
- **Source**: `scip-query plan-context src/runtime/query-commands/cleanup.ts`; `scip-query change-surface src/runtime/query-commands/cleanup.ts`
- **What**: The cleanup module has medium risk because its descriptor export has a consumer.
- **Change**: Run `scip-query reindex`, then `scip-query diff-impact`, then `scip-query diff-gate`.
- **Why**: The repo's own code intelligence should confirm the split did not create an incomplete migration, missing command docs, or fresh duplicate logic.

## Stress-Test Findings

1. Understand before touching: The cleanup file combines command adapters, rendering, descriptor helpers, and descriptor data. Sources: `scip-query plan-context src/runtime/query-commands/cleanup.ts`; `scip-query code 'src/runtime/query-commands/cleanup.ts:34-140'`; `scip-query code 'src/runtime/query-commands/cleanup.ts:635-861'`.

2. Blast radius: `cleanupQueryCommandDescriptors` has only the registry consumer. Sources: `scip-query plan-context cleanupQueryCommandDescriptors`; `scip-query rdeps src/runtime/query-commands/cleanup.ts`; `scip-query change-surface src/runtime/query-commands/cleanup.ts`.

3. Intermediate validity: Phase 1 is formatter-only. Phase 2 preserves `../query-commands/cleanup.js` through a barrel. Source: `scip-query code 'src/runtime/commands/query-command-specs.ts:1-98'`.

4. Reversibility: Formatter config and the cleanup split are two-way doors. Rollback is removing formatter scripts/config or restoring the original `cleanup.ts` file. No data, schema, or public CLI behavior changes.

5. Failure design: The split preserves existing error paths such as `cleanup-plan --patch requires --verify` at `src/runtime/query-commands/cleanup.ts:646-650`, `cleanup-apply requires --verified` at lines 738-742, and invalid batch selection at lines 760-765. Source: `scip-query code 'src/runtime/query-commands/cleanup.ts:635-861'`.

6. Concurrency: No shared mutable runtime state is introduced. The only new state is static module boundaries. Cleanup apply still mutates files through existing verification paths. Source: `scip-query code 'src/runtime/query-commands/cleanup.ts:737-781'`.

7. Boundaries: CLI boundaries stay in existing command descriptors and command execution helpers. Source: `scip-query code 'src/runtime/commands/command-execution.ts:72-180'`.

8. Data integrity: No database schema or data files are changed. Formatter ignore rules explicitly exclude index artifacts.

9. Observability: Existing console output and error messages are preserved by moving code without changing strings. Source: `scip-query code renderDeadGroup -C 5`; `scip-query code 'src/runtime/query-commands/cleanup.ts:635-861'`.

10. Human impact: Users should see no command behavior change. They gain predictable formatting failures in lint. Generated docs are refreshed to avoid stale command syntax. Source: `scip-query plan-context renderCommandReferenceMarkdown`.

11. Reuse over reimplementation: The plan reuses existing command helpers and descriptor helpers. Sources: `scip-query surface src/runtime/commands`; `scip-query similar-files src/runtime/query-commands/cleanup.ts --limit 10 --scope src/runtime`; `scip-query similar cleanupCommand --limit 10`.

## Execution Order

1. Phase 0 must happen before or with Phase 1 because docs are already stale against package changes.
2. Phase 1 can ship independently. It changes tooling and mechanical formatting only.
3. Phase 2 depends on Phase 1 only to keep formatting churn out of the organization diff.
4. Phase 3 depends on all previous phases.

## Ship Order

Ship as two commits:

1. `chore: add formatting enforcement` - package scripts, Prettier config, ignore file, generated command docs, mechanical format.
2. `refactor: split cleanup query commands` - cleanup command subdirectory, compatibility barrel, tests/verification only.

No phase is a one-way door.

## Summary

Files to modify:

- `package.json` - add formatter scripts and Prettier dev dependency.
- `docs/COMMAND_REFERENCE.md` - regenerate generated command reference if scripts/docs change it.
- `src/runtime/query-commands/cleanup.ts` - replace with compatibility barrel.

Files to create:

- `.prettierrc.json`
- `.prettierignore`
- `src/runtime/query-commands/cleanup/index.ts`
- `src/runtime/query-commands/cleanup/renderers.ts`
- `src/runtime/query-commands/cleanup/handlers.ts`
- `src/runtime/query-commands/cleanup/descriptors.ts`

Files intentionally not modified in the split:

- `src/runtime/commands/query-command-specs.ts`
- `src/runtime/commands/query-command-builders.ts`
- `src/runtime/commands/command-execution.ts`

Expected net code delta: small positive from new module headers/imports and formatter config; no behavioral logic added.
