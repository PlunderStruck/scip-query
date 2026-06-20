# React Frontend Health and Migration Coverage Plan

Date: 2026-06-19

## Goal

The user wants the same kind of frontend hygiene pressure for React that now exists for Vue: find duplicated JSX component structure, repeated hook/state/effect behavior, and large components in TSX/JSX projects, then feed those counts into health. Done means agents can run React-specific commands on Vega 2.0 and see where components or hooks should be reused or extracted, while `diff-gate` still catches half-wired helper/hook extractions through `incomplete-migration`.

`incomplete-migration` is the existing migration-completeness command. It identifies new callables in the diff, confirms they are referenced somewhere, then reports unchanged established callables that still contain the new helper's callee fingerprint without calling the helper. Source: `scip-query code incompleteMigration -C 8`.

A React component is a TypeScript or JavaScript callable whose defining runtime job is to produce JSX or React elements from props, state, hooks, and child components. A React hook candidate is a repeated behavior profile over state, effects, requests, memoized derivations, callbacks, or custom `use*` calls that could be owned by a shared hook.

## Current State

- TSX is already parsed as a first-class AST language. `.tsx` maps to `tsx`; the parser loads the Tree-sitter TSX grammar. Source: `scip-query code detectAstLanguage -C 8`; `scip-query code getAst -C 8`.
- Generic TS/JS callable and call-site facts already include TSX. Source: `scip-query code getSourceFacts -C 8`; `scip-query code getCallSites -C 8`.
- `diffGate()` already runs `runIncompleteMigrationCheck()` after the echo check. Source: `scip-query code diffGate -C 8`.
- `incompleteMigration()` is callee-fingerprint based. It works best for extracted functions/hooks/composables with at least three meaningful callees, and it skips tiny wrappers or unreferenced new helpers. Source: `scip-query code incompleteMigration -C 8`.
- Vue frontend pressure exists as three commands wired into health: component duplicates, composable candidates, and large view pressure. Source: `scip-query plan-context src/queries/vue-component-duplicates.ts --json`; `scip-query plan-context src/queries/vue-composable-candidates.ts --json`; `scip-query code summarizeVueComponentDuplicates -C 8`.
- Command registration lives in cleanup command descriptors and query command order. Source: `scip-query code 'src/runtime/query-commands/cleanup.ts:900-980'`; `scip-query code 'src/runtime/query-command-specs.ts:1-76'`.
- Public query exports live in `src/queries/index.ts`; adding query modules usually co-changes with `package.json`, `src/queries/public-query-entries.ts`, and docs. Source: `scip-query plan-context src/queries/index.ts --json`; `scip-query plan-context src/queries/public-query-entries.ts --json`.
- Health analyses require type fields in `HealthAnalyses`, phase runners in `health.ts`, actions/scoring in `health-report.ts`, and count summaries. Source: `scip-query plan-context src/queries/health-types.ts --json`; `scip-query plan-context src/queries/health.ts --json`; `scip-query plan-context src/queries/health-report.ts --json`.

## Reuse Audit

- Reuse `rankedPairwiseProfileResults()` for React pairwise component/hook comparisons instead of writing a new pair-ranking loop. Source: `scip-query code rankedPairwiseProfileResults -C 8`.
- Reuse Vue's profile split as the model: one source profile module plus small query wrappers for structure, behavior, and size pressure. Source: `scip-query code buildVueComponentBehaviorProfile -C 8`; `scip-query code vueComposableCandidates -C 8`.
- Reuse `getAst()`, `getSourceFacts()`, `getSourceLines()`, and `detectAstLanguage()` for TSX/JSX discovery instead of adding an augmentation phase. Source: `scip-query code getAst -C 8`; `scip-query code getSourceFacts -C 8`.
- Reuse cleanup command descriptor patterns and `definedLimitOption()` so `--full` remains uncapped unless the user explicitly passes `--limit`. Source: `scip-query code 'src/runtime/query-commands/cleanup.ts:900-980'`.
- Do not extend `incomplete-migration` in this slice. Its job is callable migration completeness, and React hook/composable extractions fit that model. Pure JSX component extraction needs React component duplicate pressure, not a callee-only migration detector. Source: `scip-query code incompleteMigration -C 8`.

## Design Phases

### 1. Add React component profiles

- [x] **File**: `src/source/react-profile.ts` new.
- **Source**: `scip-query code getAst -C 8`; `scip-query code getSourceFacts -C 8`; `scip-query code buildVueComponentBehaviorProfile -C 8`.
- **What**: TSX ASTs are available, but there is no React-aware profile that understands JSX elements, props, event handlers, custom components, hooks, effects, or component LOC.
- **Change**: Add a React profile builder that scans `.tsx`/`.jsx`/React-looking `.ts`/`.js` files, extracts function declarations and arrow-function components/hooks, creates structure tokens from JSX tags/props/events/spread/conditional/list shapes, creates behavior tokens from `use*`, `useState`, `useEffect`, `useMemo`, `useCallback`, request calls, and handler/function names, and tracks LOC.
- **Why**: Generic source-token similarity cannot distinguish duplicated rendered structure from duplicated behavior.

### 2. Add React duplicate and hook queries

- [x] **File**: `src/queries/react-component-duplicates.ts` new.
- **Source**: `scip-query code vueComposableCandidates -C 8`; `scip-query code rankedPairwiseProfileResults -C 8`.
- **What**: Vue has a structure duplicate query; React does not.
- **Change**: Compare React profiles by JSX structure tokens and report shared components, props, events, JSX identifiers, and LOC.
- **Why**: This catches agents duplicating React components instead of reusing a shared component.

- [x] **File**: `src/queries/react-hook-candidates.ts` new.
- **Source**: `scip-query code vueComposableCandidates -C 8`; `scip-query code rankedPairwiseProfileResults -C 8`.
- **What**: Vue has behavior/composable candidates; React does not.
- **Change**: Compare React behavior tokens and report shared hooks, effects, state, requests, handlers, and function verbs.
- **Why**: This catches repeated state/effect/request behavior that should become or reuse a hook.

- [x] **File**: `src/queries/react-large-component-pressure.ts` new.
- **Source**: `scip-query plan-context src/queries/health.ts --json`.
- **What**: Vue has large view pressure; React does not.
- **Change**: Report large React components by function LOC and file LOC thresholds.
- **Why**: Large JSX components concentrate unrelated reasons to change.

### 3. Wire commands, exports, docs, and package surface

- [x] **File**: `src/runtime/query-commands/cleanup.ts:900-980`.
- **Source**: `scip-query code 'src/runtime/query-commands/cleanup.ts:900-980'`.
- **Change**: Add command descriptors and handlers for `react-component-duplicates`, `react-hook-candidates`, and `react-large-component-pressure` using full-aware limits and JSON/list rendering.

- [x] **File**: `src/runtime/query-command-specs.ts:38-43`.
- **Source**: `scip-query code 'src/runtime/query-command-specs.ts:1-76'`.
- **Change**: Add the three React command IDs next to the Vue frontend commands.

- [x] **File**: `src/queries/index.ts:24-96`, `src/queries/public-query-entries.ts:12-82`, `package.json`.
- **Source**: `scip-query plan-context src/queries/index.ts --json`; `scip-query plan-context src/queries/public-query-entries.ts --json`.
- **Change**: Export React queries and types, add public query entries, and add package subpath exports.

- [x] **File**: `docs/COMMAND_REFERENCE.md` and `README.md`.
- **Source**: `scip-query plan-context src/runtime/query-command-specs.ts --json`.
- **Change**: Document the new commands and clarify that `incomplete-migration` remains the direct extraction-completeness command.

### 4. Wire health scoring

- [x] **File**: `src/queries/health-types.ts:14-33`.
- **Source**: `scip-query plan-context src/queries/health-types.ts --json`.
- **Change**: Add `reactComponentDuplicates`, `reactHookCandidates`, and `reactLargeComponentPressure` count summaries.

- [x] **File**: `src/queries/health.ts:49-128`, `src/queries/health.ts:369-412`.
- **Source**: `scip-query plan-context src/queries/health.ts --json`; `scip-query code summarizeVueComponentDuplicates -C 8`.
- **Change**: Add health phases and summary functions for React structure, hook behavior, and large components.

- [x] **File**: `src/queries/health-report.ts:254-666`.
- **Source**: `scip-query plan-context src/queries/health-report.ts --json`.
- **Change**: Add actions, score deductions, and pressure entries for React findings, mirroring Vue but naming React-specific referents.

### 5. Test on synthetic fixtures and Vega 2.0

- [x] **File**: `tests/react-frontend-rich-internals.test.ts` new.
- **Source**: `scip-query files '*.test.ts' --json` returned no indexed tests; use the existing Vitest fixture style after implementation.
- **Change**: Add fixtures for duplicated JSX structure, repeated hook/effect/request behavior, large component pressure, health integration, and `--full` behavior.

- [x] **Target**: `/Users/aydansalois/Documents/GitHub/Vega_2.0`.
- **Source**: local repository discovery found this path.
- **Change**: Run the built CLI against Vega 2.0: `scip-query reindex`, then the React commands with `--scope` and `--full --json`; inspect top findings against real source before trusting thresholds.

Final Vega 2.0 validation on `apps/web/src`: 31 React component duplicate pairs, 111 React hook candidate pairs, 274 large React component results across 204 files. `health --full --json` reported the same React counts and a score split of 89 risk / 53 hygiene.

## Verification

1. `npm run typecheck`
2. `npm run lint`
3. `npm test`
4. `npm run build`
5. `git diff --check`
6. `scip-query reindex`
7. `scip-query diff-gate`
8. In Vega 2.0, run `scip-query reindex`, `react-component-duplicates --full --json`, `react-hook-candidates --full --json`, `react-large-component-pressure --full --json`, and `health --full --json`.

## Stress Test

- Understand before touching: React is not a new indexer problem; TSX AST support exists. The missing concept is React-specific frontend profiles.
- Blast radius: command addition touches query exports, command descriptors, docs, package exports, health types, health phases, and health scoring.
- Intermediate states: implement source profiles first, then queries, then command wiring, then health.
- Reversibility: all changes are additive internal heuristics and CLI commands.
- Failure design: commands must return empty result sets when no React/TSX code exists, not throw.
- Concurrency: analysis is read-only over the SQLite index and source text.
- Boundaries: CLI options use existing command parsing helpers.
- Data integrity: no database writes are introduced.
- Observability: JSON output exposes exact shared tokens and file pairs.
- Human impact: reports must distinguish component extraction from hook extraction instead of telling users to make the wrong abstraction.
- Reuse: pairwise ranking, full-aware limits, Vue query layout, source facts, and health summaries are reused.
