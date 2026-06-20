# Vue Template Rich Internals

## Gate A - Goal

Vue templates are the HTML-like source regions inside `.vue` single-file components that declare rendered UI structure: component tags, native elements, props, events, slots, directives, and expressions that connect the template to script state. Today scip-query can insert `.vue` files and Volar-backed mentions, but health still lacks a reusable source model for template internals. Done means Stable Management's `.vue` files produce structured template facts, a query can report duplicated Vue component structure, and health includes that pressure in its score.

## Gate B - Current Flow

- [x] **File**: `src/source/ast-core.ts:30-60`
  - **Source**: `scip-query code getAst -C 45`.
  - **Current behavior**: `getAst` special-cases `.vue`, extracts the first `<script>` / `<script setup>` block, pads it with newlines to keep source-relative line numbers, and parses it as TypeScript/JavaScript.
  - **Change**: Keep this path, but make the shared source-facts gate able to enter it for `.vue`.
  - **Why**: Vue script internals are already parseable; the richer source-facts callers currently cannot reach that parser.

- [x] **File**: `src/source/source-facts.ts:53-60`
  - **Source**: `scip-query plan-context getSourceFacts`.
  - **Current behavior**: `getSourceFacts` calls `detectAstLanguage(relativePath)` and returns `null` for `.vue`, so callables, call sites, identifiers, and signatures inside Vue script blocks are unavailable to consumers.
  - **Change**: Resolve `.vue` source facts from the extracted script language before returning `null`; continue returning `null` for files without script blocks.
  - **Why**: Health and duplicate detectors rely on source facts, not just raw source text.

- [x] **File**: `src/reindex/augment-vue.ts:337-381`
  - **Source**: `scip-query plan-context augmentVueResolvedReferences`; `scip-query code resolveVueTokenReferences -C 80`.
  - **Current behavior**: Vue augmentation tokenizes identifiers across the SFC and asks Volar for definitions, then inserts mention rows.
  - **Change**: Leave the Volar mention path intact for now; do not make template parsing depend on augmentation being run.
  - **Why**: Template structure should be readable from source during health, while Volar augmentation remains the compiler-resolved reference enrichment path.

- [x] **File**: `src/reindex/augment-vue-runtime.ts:535-558`
  - **Source**: `scip-query code insertOccurrencesWithoutTransaction -C 70`.
  - **Current behavior**: `resolveVueDefinitionSymbolId` maps any definition inside a `.vue` file back to the synthetic file-level component symbol.
  - **Change**: Do not try to fix all internal symbol materialization in this slice; add source-level template facts first and feed duplicate/health detectors from those facts.
  - **Why**: Synthetic DB symbols need a broader schema/persistence design. A source-fact layer is reversible and immediately useful.

- [x] **File**: `src/queries/similar-files.ts:28-69`
  - **Source**: `scip-query plan-context similarFiles`.
  - **Current behavior**: `similarFiles` compares dependency profiles and is exposed as a cleanup command, but it does not parse templates or inspect UI structure.
  - **Change**: Add a separate Vue component duplicate query instead of overloading dependency similarity.
  - **Why**: Template structure is a different referent than import overlap; mixing them would make the evidence hard to explain.

- [x] **File**: `src/queries/health.ts:47-60` and `src/queries/health.ts:192-245`
  - **Source**: `scip-query plan-context healthAnalysesFromPhases`.
  - **Current behavior**: health phases include graph facts, function similarity, extraction candidates, wrappers, passthroughs, stale abstractions, drift, complexity, git evidence, and suppressions.
  - **Change**: Add a `vue-component-duplicates` phase with capped/full-aware count and file evidence.
  - **Why**: Vue duplicate pressure should affect health directly, not require users to remember a side command.

- [x] **File**: `src/queries/health-report.ts:243-384` and `src/queries/health-report.ts:417-574`
  - **Source**: `scip-query plan-context buildHealthReport`; `scip-query plan-context computeHealthScore`; `scip-query code buildHealthActions -C 90`.
  - **Current behavior**: health actions and score deductions do not include Vue component/template duplication.
  - **Change**: Add findings, action text, hygiene deduction, and pressure deduction for duplicated Vue component structure.
  - **Why**: The score should become worse when copied UI structure piles up.

- [x] **File**: `src/runtime/query-commands/cleanup.ts:681-984`
  - **Source**: `scip-query plan-context cleanupQueryCommandDescriptors`; `scip-query code src/runtime/query-commands/cleanup.ts:252-340`; `scip-query code src/runtime/query-commands/cleanup.ts:681-984`.
  - **Current behavior**: cleanup commands expose `similar`, `similar-files`, and `recent-duplicates`, but no Vue template duplicate detector.
  - **Change**: Add a `vue-component-duplicates` command with `--scope`, `--min-similarity`, `--min-tokens`, `--limit`, `--full`, and JSON output.
  - **Why**: Users need a focused command to inspect findings behind the health score.

- [x] **File**: `src/runtime/query-command-specs.ts:10-66`
  - **Source**: `scip-query plan-context queryCommandDescriptor`; `scip-query code src/runtime/query-command-specs.ts:1-95`.
  - **Current behavior**: every query command descriptor must be present in `queryCommandOrder`.
  - **Change**: Insert `vue-component-duplicates` near `similar-files`.
  - **Why**: The command registry intentionally fails closed when commands are not ordered.

## Gate C - Reuse Audit

- [x] **Source**: `scip-query recent-duplicates --full --json`.
  - **Finding**: No recent duplicate implementation exists for this parser/query path.
  - **Decision**: Write a new Vue template facts module and Vue duplicate query.

- [x] **Source**: `scip-query similar-chains --json`.
  - **Finding**: Similar chains are runtime/domain type import paths, not parser/query flows.
  - **Decision**: No chain-level reusable implementation covers Vue template parsing.

- [x] **Source**: `scip-query similar-files src/language-parsers/javascript-imports.ts --json`.
  - **Finding**: No structurally similar language parser file is close enough to reuse.
  - **Decision**: Reuse source cache/text helpers and command conventions, not parser internals.

- [x] **Source**: `scip-query similar-files src/queries/similar-files.ts --json`.
  - **Finding**: No existing duplicate-query module is structurally similar enough; `similar-files` is dependency-profile based.
  - **Decision**: Write a separate query whose evidence is Vue template/source structure.

## Implementation

1. [x] Add `@vue/compiler-dom` and `@vue/compiler-sfc` as runtime dependencies so SFC and template parsing do not depend on the target project's dependency tree.
2. [x] Add `src/source/vue-template.ts` with:
   - `extractVueTemplateBlock(source)` for source-relative template ranges.
   - `getVueTemplateFacts(db, relativePath)` cached by source text.
   - Structured facts for component tags, native tags, props, events, directives, slots, expression identifiers, and normalized structural tokens.
3. [x] Update `src/source/source-facts.ts` so `.vue` script blocks feed the existing TypeScript/JavaScript source-facts builder.
4. [x] Add `src/queries/vue-component-duplicates.ts`:
   - Build profiles for `.vue` files from `getVueTemplateFacts`.
   - Compare normalized template tokens using Jaccard similarity.
   - Report pair evidence: shared components, props, events, directives, slots, identifiers, and unique structural tokens.
   - Respect `scope`, `limit`, `scanLimit`, `minSimilarity`, and `minTokens`.
5. [x] Export the query from `src/queries/index.ts`.
6. [x] Add the `vue-component-duplicates` CLI command in `src/runtime/query-commands/cleanup.ts` and order it in `src/runtime/query-command-specs.ts`.
7. [x] Extend `HealthAnalyses`, `HEALTH_PHASES`, `healthAnalysesFromPhases`, and `runHealthAnalyses` to include Vue duplicate summaries.
8. [x] Extend `HealthReport` output, actions, evidence quality, score breakdown, and hygiene pressure with Vue component duplicate counts.
9. [x] Add focused tests for:
   - Template fact extraction from component tags, bindings, events, directives, slots, and expression identifiers.
   - Vue script source facts no longer returning `null` for `<script setup lang="ts">`.
   - Vue duplicate query returns expected pairs and evidence.
   - Health report includes the Vue duplicate count and scoring line.
   - CLI contract includes the new command and `--full` / explicit `--limit` conflict behavior.

## Verification

1. [x] Run focused tests for Vue template facts, Vue duplicate query, health, and CLI contract.
2. [x] Run `npm run typecheck`.
3. [x] Run `npm run lint`.
4. [x] Run `npm test`.
5. [x] Run `npm run build`.
6. [x] Run `npm install -g .`.
7. [x] In `/Users/aydansalois/Documents/GitHub/Stable_Management`, run `scip-query reindex`.
8. [x] In Stable Management, run `scip-query augment-vue --project frontend/tsconfig.scip.json`.
9. [x] In Stable Management, run `scip-query vue-component-duplicates --scope frontend/src --full --json` and inspect the count/evidence.
10. [x] In Stable Management, run `scip-query health --full --json` and confirm the report includes Vue component duplicate findings and score pressure.
11. [x] In this repo, run post-change checks: `scip-query similar getVueTemplateFacts`, `scip-query recent-duplicates`, `scip-query unused-params`.
12. [x] Run `scip-query reindex` and `scip-query diff-gate` (2 warnings accepted: source-cache idiom and query descriptor co-change).
13. [x] Run `git diff --check`.
