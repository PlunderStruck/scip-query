# Analyzer Implementation Parity

Date: 2026-06-21

## Goal

Check whether the analyzer documentation matches the implementation path users and package consumers actually exercise: command descriptors, handlers, public query exports, package subpaths, and health summaries. Done means any mismatch is either fixed or recorded as an intentional alias/action boundary.

## Current State

- `scip-query plan-context queryCommandDescriptor --full` shows `queryCommandDescriptor()` in `src/runtime/commands/query-command-specs.ts:93-97`, and `src/runtime/commands/command-descriptors.ts:48-95` consumes that lookup for descriptor-backed query commands.
- `scip-query code src/runtime/commands/command-descriptors.ts:1-220` shows descriptor-backed CLI commands, separately registered composite/maintenance commands, and the `health` command descriptor.
- `scip-query plan-context public-query-entries --full` shows `src/queries/public-query-entries.ts:15-170` as the package query subpath manifest, with `package.json` expected to stay in lockstep through `tests/runtime/cli-contract.test.ts`.
- `scip-query plan-context runHealthAnalyses --full` shows health summaries are built from `HEALTH_PHASES` through `HEALTH_PHASE_RUNNERS`, not from every standalone command.

## Reuse Audit

No new helper is needed. Existing CLI contract tests already check descriptor order, generated command docs, package query subpaths, and public/private query source classification. The fix should extend that contract instead of adding a separate parity test harness.

## Design

### 1. Fix Public Query Manifest Parity

- [x] **File**: `src/queries/public-query-entries.ts:15-139`
- **Source**: `scip-query code src/queries/public-query-entries.ts:15-139`
- **What**: `unusedImports()` is exported from `src/queries/index.ts:12` and wired to the `unused-imports` CLI handler, but `PUBLIC_QUERY_ENTRIES` omitted `unused-imports`.
- **Change**: Add `unused-imports` to `PUBLIC_QUERY_ENTRIES` and point its source path at `src/queries/navigation/imports.ts`.
- **Why**: The CLI command and root query export should have a matching package query subpath.

### 2. Export the Package Subpath

- [x] **File**: `package.json`
- **Source**: `scip-query plan-context public-query-entries --full` history notes show public query entries usually co-change with `package.json`.
- **What**: `package.json` exports every `PUBLIC_QUERY_ENTRIES` subpath.
- **Change**: Add `./queries/unused-imports`, pointing at the generated `dist/queries/unused-imports.js` and `.d.ts`.
- **Why**: `unused-imports` is a public subpath generated from the imports source module.

### 3. Lock Alias Parity in Tests

- [x] **File**: `tests/runtime/cli-contract.test.ts`
- **Source**: existing CLI contract tests around descriptor-backed commands and package subpath lockstep.
- **What**: Tests caught package/manifest drift, but not command-level query aliases such as `unused-imports`.
- **Change**: Add an alias contract for `fan-in`, `fan-out`, `imported-by`, `kind-counts`, and `unused-imports`; update source classification to compare unique source paths because aliases can share a module.
- **Why**: Future command aliases should not disappear from package query exports.

### 4. Record the Result

- [x] **File**: `docs/validation/2026-06-21-analyzer-implementation-parity-result.md`
- **Source**: implementation parity review commands above.
- **What**: Need a durable AVL-005 verdict.
- **Change**: Record the mismatch, the fix, and intentional boundaries.
- **Why**: The validation ledger can move on to budget/performance behavior.

## Stress Test

- The package subpath is additive and reversible.
- No query logic changes; `unused-imports` continues to use `unusedImports()` from `src/queries/navigation/imports.ts`.
- The unique-source test preserves the invariant that every query source file is classified while allowing multiple public subpaths to share one module.

## Verification

- Focused: `npx vitest run tests/runtime/cli-contract.test.ts`
- Standard: `npm run typecheck`, `npm run build`, `npm test`, `./dist/cli.js reindex`, `./dist/cli.js diff-gate`
