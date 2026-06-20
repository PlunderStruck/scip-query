# Query Structure And Maintainability Follow-Through - 2026-06-20

## Goal

The user is trying to make `scip-query` easier for maintainers and coding agents to change without breaking command behavior. Done means the query implementation folder is no longer a single flat list, the public `scip-query/queries/<name>` surface stays stable, and the highest-pressure maintainability items from the register are reduced with named mechanisms rather than broad rewrites.

## Current State

- `src/queries/index.ts:1-129` is the public query barrel used by runtime command families including cleanup, core, graph, health, impact, navigation, and planning. Source: `node dist/cli.js plan-context src/queries/index.ts`.
- `src/queries/public-query-entries.ts:13-86` is the single source of truth for published query entries and private query modules. Source: `node dist/cli.js plan-context src/queries/public-query-entries.ts`.
- `src/runtime/query-commands/cleanup.ts:1-1270` imports many query modules directly and is a medium-risk consumer of the query barrel and cleanup/frontend query functions. Source: `node dist/cli.js plan-context src/runtime/query-commands/cleanup.ts`.
- `src/core/project-index.ts:35-194` is a high-risk evidence facade with 25 consumers; `ProjectIndex.productionCallableDefinitions()` at `src/core/project-index.ts:49-88` has 10 consumers. Source: `node dist/cli.js plan-context src/core/project-index.ts`.
- `src/queries/impact/incomplete-migration.ts:74-198`, `src/queries/cleanup/doc-drift.ts:72-181`, and `src/queries/cleanup/recent-duplicates.ts:83-146` are medium-risk detector lifecycle functions that mix input collection, indexing, scoring, and result shaping. Sources: `node dist/cli.js plan-context src/queries/incomplete-migration.ts`, `node dist/cli.js plan-context src/queries/doc-drift.ts`, `node dist/cli.js plan-context src/queries/recent-duplicates.ts`.
- `src/source/vue-script-facts.ts:108-173` builds Vue script facts and finalizes repeated call-category projections in the same function. Source: `node dist/cli.js plan-context src/source/vue-script-facts.ts`.

## Reuse Audit

- Query surface plumbing already exists in `src/queries/public-query-entries.ts:13-86`; extend it with source paths instead of adding a second registry. Source: `node dist/cli.js plan-context src/queries/public-query-entries.ts`.
- Runtime commands already consume the barrel and direct query exports; keep export names stable and rewrite import paths mechanically rather than adding compatibility wrappers. Source: `node dist/cli.js plan-context src/queries/index.ts`.
- `recent-duplicates --full --json` reports no active duplicate findings, so new helpers should be narrow stage names rather than parallel detector implementations. Source: `node dist/cli.js recent-duplicates --full --json`.
- `similar incompleteMigration --json` shows overlap with `diffGate()`, `recentDuplicates()`, and `similar*()` mainly around common query scaffolding terms, not an existing incomplete-migration scan context helper. Source: `node dist/cli.js similar incompleteMigration --json`.
- `similar docDrift --json` shows only low structural overlap with other query runners, not a reusable doc-drift evidence index. Source: `node dist/cli.js similar docDrift --json`.

## Phase 1 - Separate Published Query Names From Source Paths

### 1.1 - Add source-path metadata to the query manifest

- [x] **File**: `src/queries/public-query-entries.ts:13-86`
- **Source**: `node dist/cli.js plan-context src/queries/public-query-entries.ts`
- **What**: The manifest lists public names and private root-level module names, assuming query source files sit directly under `src/queries`.
- **Change**: Add `PUBLIC_QUERY_SOURCE_PATHS` and `PRIVATE_QUERY_SOURCE_PATHS`, keyed by the existing public/private names, so build tooling and tests can resolve implementation files after they move into domain folders.
- **Why**: The published query name is the package contract; the source path is an implementation detail. The current flat-folder assumption package-deals those two concepts.

### 1.2 - Update build, package-surface, and contract checks to use source paths

- [x] **File**: `src/queries/public-query-entries.ts:13-86`
- **Source**: `node dist/cli.js plan-context src/queries/public-query-entries.ts`
- **What**: The indexed manifest is the authoritative query surface. Build/test config files are not indexed by SCIP in this repository, so their exact line references cannot be cited by `scip-query`.
- **Change**: Update the tsup query-entry map to read the manifest source paths. Update package-surface source backtracking for nested query files. Update the CLI contract test to recursively classify query source files against public and private source paths.
- **Why**: The folder split must fail fast if a query file is moved without updating the manifest, and public dist query exports must still map back to the real nested source files.

## Phase 2 - Split `src/queries` By Domain Without Changing Public Names

### 2.1 - Move navigation and graph query implementations

- [x] **File**: `src/queries/index.ts:1-129`
- **Source**: `node dist/cli.js plan-context src/queries/index.ts`
- **What**: The barrel exports navigation, graph, impact, cleanup, frontend, and health queries from one root folder.
- **Change**: Move navigation implementation files under `src/queries/navigation/` and graph implementation files under `src/queries/graph/`; update barrel imports to the new relative paths.
- **Why**: Users and maintainers should see query families by role rather than scanning a long root directory.

### 2.2 - Move cleanup, impact, frontend, and health query implementations

- [x] **File**: `src/queries/index.ts:1-129`
- **Source**: `node dist/cli.js plan-context src/queries/index.ts`
- **What**: Cleanup, diff/impact, frontend, and health commands currently live beside unrelated navigation files.
- **Change**: Move cleanup detectors to `src/queries/cleanup/`, diff/planning checks to `src/queries/impact/`, React/Vue checks to `src/queries/frontend/`, and health scoring files to `src/queries/health/`; update all relative imports mechanically.
- **Why**: This makes command families visible in the filesystem while preserving the public barrel.

### 2.3 - Preserve runtime command behavior

- [x] **File**: `src/runtime/query-commands/cleanup.ts:1-1270`
- **Source**: `node dist/cli.js plan-context src/runtime/query-commands/cleanup.ts`
- **What**: Cleanup command handlers import many query modules and render their existing result shapes.
- **Change**: Rewrite imports to the moved implementation paths, with no handler behavior or option parsing changes.
- **Why**: The refactor is structural; CLI output should remain byte-for-byte equivalent except for source map paths.

## Phase 3 - Reduce The Highest-Pressure Detector Functions

### 3.1 - Extract the production-callable gate behind `ProjectIndex`

- [x] **File**: `src/core/project-index.ts:49-88`
- **Source**: `node dist/cli.js plan-context src/core/project-index.ts`
- **What**: `ProjectIndex.productionCallableDefinitions()` owns the shared production-callable filtering policy inside the broad facade.
- **Change**: Move the filtering predicate into a named helper module while keeping `ProjectIndex.productionCallableDefinitions()` as the stable facade method.
- **Why**: The concept is a production-callable gate: the set of definitions a detector may treat as production behavior because they pass scope, test/generated-file, suppression, callable-mode, and language-specific exclusions.

### 3.2 - Name detector scan stages in lifecycle functions

- [x] **File**: `src/queries/impact/incomplete-migration.ts:74-198`
- **Source**: `node dist/cli.js plan-context src/queries/incomplete-migration.ts`
- **What**: `incompleteMigration()` builds diff context, candidate fingerprints, helper groups, leftovers, scores, and output in one function.
- **Change**: Extract narrow stage helpers for candidate indexing and helper evaluation without changing thresholds or result shapes.
- **Why**: The function becomes a readable scan lifecycle instead of an interleaved policy block.

- [x] **File**: `src/queries/cleanup/doc-drift.ts:72-181`
- **Source**: `node dist/cli.js plan-context src/queries/doc-drift.ts`
- **What**: `docDrift()` builds history indexes, doc reference indexes, subject candidates, and stale findings in one function.
- **Change**: Extract a doc-drift scan index helper that owns tracked-file suffixes, change times, coupling pairs, and history membership.
- **Why**: The doc-drift concept is a living-document mismatch: a doc file names code that has moved or changed more recently than the document.

- [x] **File**: `src/queries/cleanup/recent-duplicates.ts:83-146`
- **Source**: `node dist/cli.js plan-context src/queries/recent-duplicates.ts`
- **What**: `recentDuplicates()` mixes git-window loading, candidate-source collection, orientation, filtering, and sorting.
- **Change**: Extract candidate-source collection and orientation stages.
- **Why**: The detector should read as a pipeline: gather recent additions, gather possible echoes, orient old/new, then rank.

### 3.3 - Finalize Vue script fact categories in a named helper

- [x] **File**: `src/source/vue-script-facts.ts:108-173`
- **Source**: `node dist/cli.js plan-context src/source/vue-script-facts.ts`
- **What**: `buildVueScriptFacts()` collects raw script facts and repeats category filtering for composables, stores, reactivity, lifecycle, requests, and macros.
- **Change**: Extract the category finalization into a helper that derives the six category arrays from collected call facts.
- **Why**: The Vue script facts concept is a source-evidence record for Vue SFC scripts; finalizing categories is distinct from parsing scripts.

## Stress Test

- Understand before touch: Each edited symbol has a `plan-context` citation above.
- Blast radius: `ProjectIndex` is high risk, so its public method remains and delegates; query names remain stable through the manifest.
- Intermediate validity: Phase 1 is valid before moves, Phase 2 is structural with unchanged exports, Phase 3 is internal extraction.
- Reversibility: All phases are code-only and reversible through git; no data or external contract migration.
- Failure/concurrency/data integrity: No new async side effects, persistence, or concurrent state are introduced.
- Boundaries: Published package query names remain the boundary; source paths become private implementation details.
- Observability/human: CLI descriptions, command IDs, and output shapes remain unchanged.
- Reuse: Existing manifest and barrel are extended; no parallel command registry is introduced.

## Verification

- Run `npm test -- --run tests/cli-contract.test.ts`.
- Run `npm run typecheck`.
- Run targeted query commands: `health --full --json`, `recent-duplicates --full --json`, `incomplete-migration --json`, `doc-drift --json`.
- Run `node dist/cli.js reindex`.
- Run `node dist/cli.js diff-gate`.
- Run `git diff --check`.

## Execution Order

1. Phase 1 manifest/build/test plumbing.
2. Phase 2 mechanical query moves and import rewrites.
3. Phase 3 internal helper extractions.
4. Verification and any fix-forward edits.

## Verification Results

- `npm run typecheck`: passed.
- `npm test -- --run`: passed, 61 test files and 298 tests.
- `NODE_OPTIONS=--max-old-space-size=8192 npm run build`: passed. The plain build reached ESM success but DTS generation hit the local worker heap limit.
- `node dist/cli.js reindex`: passed.
- `node dist/cli.js diff-gate`: passed; 75 changed files and 625 changed symbols, no gate findings.
- `node dist/cli.js health --full --json`: passed with score 100, risk 100, hygiene 100, and zero findings across the reported detector categories.
- `node dist/cli.js incomplete-migration --json`: passed with no findings.
- `node dist/cli.js wrapper-candidates --full --json`: passed with no findings.
- `node dist/cli.js passthrough-candidates --full --json`: passed with no findings.
- `node dist/cli.js recent-duplicates --full --json`: passed with no findings.
- `node dist/cli.js unused-params --full --json`: passed with no findings.
- `node dist/cli.js stale-abstractions --include-low-confidence --full --json`: passed with no findings.
- `git diff --check`: passed.

## Ship Order

Ship as one refactor commit if verification stays green. Phase 1 and Phase 2 should not be separated in a release because source-path metadata only earns its keep once files move.
