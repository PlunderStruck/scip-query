# General Vue Rich Symbols And Health Signals

Date: 2026-06-19

## Goal

Build a general Vue analysis layer that can explain real frontend hygiene pressure, not merely report that two `.vue` files share tags. The target outcome is that `scip-query` can inspect a Vue codebase, understand each component as a joined template/script/style unit, find duplicated component structure, find repeated behavior that wants a composable, identify oversized views, and feed those findings into health scoring without artificial caps when the user asks for full health.

This must generalize beyond Stable Management. Stable Management is the validation corpus because it has real large Vue files, external script blocks, repeated setup flows, repeated menus, and large style-heavy views.

## Current Evidence

- `src/source/vue-template.ts:105-113` exposes `getVueTemplateFacts()`, which reads a `.vue` file from the SCIP database and caches template facts.
- `src/source/vue-template.ts:115-125` parses the SFC and returns only an inline template block span.
- `src/source/vue-template.ts:211-217` currently treats static attribute values as expression identifiers. That makes classes, test IDs, icon names, labels, and static strings look like behavior, which inflates similarity.
- `src/source/vue-script.ts:15-42` finds the preferred script block with a source regex and returns one script body. It does not model `<script src="./x.ts">`, does not return both normal script and setup script, and cannot tell consumers whether line numbers belong to the `.vue` file or an external file.
- `src/queries/vue-component-duplicates.ts:36-65` compares template-only profiles through `rankedPairwiseProfileResults()`.
- `src/queries/vue-component-duplicates.ts:67-89` builds a profile from `getVueTemplateFacts()` structural tokens and total source LOC.
- `src/queries/vue-component-duplicates.ts:91-118` reports shared component/prop/event/directive/slot/identifier tokens. It cannot report shared composables, state, effects, request lifecycles, stores, or template-to-script bindings.
- `src/runtime/query-commands/cleanup.ts:340-368` wires `vue-component-duplicates` as a cleanup command with standard limit/full budget behavior.
- `src/queries/health.ts:160-168` builds health through phases, and `src/queries/health.ts:348-370` summarizes Vue component duplicates as a health signal.
- `src/queries/internal/pairwise-profiles.ts:14-45` already implements the right generic pairwise comparison runner for similar profile queries. New Vue profile queries should reuse this instead of inventing another pairwise loop.

Stable Management validation evidence from the previous run:

- Stable Management has 215 Vue files and about 74,869 Vue LOC.
- `SetupInterviewPanel.vue`, `PlansPanel.vue`, `AppSidebar.vue`, and `AvailabilityPanel.vue` are very large SFCs with substantial template, script, and style sections.
- Several Stable Management views use external scripts, for example `MessagesView.vue`, `ServicePlansTemplateView.vue`, `InventoryView.vue`, `FacilityBookingView.vue`, and `TemplateOptionsSetupView.vue`.
- The current template duplicate query correctly finds real structure pairs such as `IncidentCategoriesPanel.vue` with `RecordLabelsPanel.vue`, `HorseProfileFarrierVisitsSection.vue` with `HorseProfileVetRecordsSection.vue`, and `CardActionMenu.vue` with `CardStatusMenu.vue`.
- The current query cannot distinguish a component extraction from a composable extraction because it does not join template structure to script behavior.

## Definitions

A Vue SFC unit is a source unit represented by one `.vue` file, identified by Vue's own block grammar, whose essential characteristic is that template, script, style, and custom blocks cooperate to define one component even when some blocks load their source from another file.

A Vue block source is the text that a Vue block contributes to the component, either inline in the `.vue` file or loaded through a relative `src` attribute, identified by the file path and line coordinate system where that text actually lives.

A template fact is a parsed fact from Vue's template AST that describes rendered structure or template behavior, such as component tags, native tags, directives, bound props, emitted event handlers, slots, and dynamic expressions.

A script fact is a parsed fact from the JavaScript or TypeScript code that supplies component behavior, such as imports, composable calls, reactive state, computed values, watchers, lifecycle hooks, functions, stores, request helpers, props, and emits.

A binding graph is the set of links from template expressions to script names, where the key difference from a raw identifier list is that slot locals, loop aliases, and static attributes are not treated as component state.

A component behavior profile is a comparable summary of one Vue SFC unit that joins template facts, script facts, and binding graph facts so that repeated UI behavior can be compared across files.

A composable candidate is a repeated component behavior profile across two or more components where the shared behavior is stateful or effectful enough that a Vue composable could own it without owning the rendered markup.

A component extraction candidate is a repeated template structure profile across two or more components where the shared fact is mostly markup shape, component usage, slots, props, and events rather than shared state/effect code.

Large view pressure is the maintenance pressure created when one Vue SFC unit contains enough template, script, or style source that unrelated reasons to change are forced through one file.

Health scoring is a bounded summary of codebase maintenance risk; its useful job is not to count every smell equally, but to make repeated pressure, high-confidence issues, and broad blast-radius issues reduce the score more than isolated low-confidence findings.

## Design

### Phase 1: Model Vue SFC Units

Add `src/source/vue-sfc.ts`.

The module will parse `.vue` files with `@vue/compiler-sfc`, normalize project-relative paths, and return a `VueSfcUnit` with:

- `relativePath`
- `template`
- `scripts`
- `styles`
- `customBlocks`
- `errors`

Each resolved block will include:

- `kind`
- `ownerPath`
- `sourcePath`
- `external`
- `src`
- `attrs`
- `language`
- `body`
- `startLine`
- `endLine`

Inline blocks will keep `.vue` line numbers. External blocks will use the external file's own line numbers and `sourcePath`. Unresolved external blocks will be represented with an error instead of being silently treated as empty inline code.

`src/source/vue-template.ts` should use this module for database-backed extraction, while keeping a pure `extractVueTemplateBlock(source)` helper for simple tests.

### Phase 2: Replace Regex Script Extraction With Compiler-Backed Blocks

Update `src/source/vue-script.ts` so script extraction is based on compiler SFC blocks, not regex. The compatibility helper can still return a preferred single inline script for existing AST consumers, but new Vue profile code must use all resolved scripts from `VueSfcUnit`.

Rules:

- Prefer `<script setup>` only for compatibility callers that need one script.
- Preserve both normal `<script>` and `<script setup>` in profile analysis.
- Resolve relative external scripts through the owning `.vue` file's directory.
- Keep external script line numbers external-file-relative.
- Treat unsupported non-JavaScript languages as unresolved for behavior profiling, but keep their block metadata for large-view pressure.

### Phase 3: Clean Template Identifier Semantics

Fix `src/source/vue-template.ts` so static attributes create prop facts but do not create expression identifiers or `id:` structural tokens.

Template identifiers should come only from dynamic Vue expressions:

- `:prop="value"`
- `v-bind="object"`
- `@click="handler"`
- `v-on="listeners"`
- `v-if`, `v-else-if`, `v-for`, `v-show`
- `v-model`
- dynamic slots
- directive expressions
- dynamic directive arguments when Vue exposes them as expressions

The binding graph must exclude names introduced by the template itself:

- `v-for` aliases
- slot scope aliases
- destructured slot props

This is the difference between "the component depends on `visibleRows`" and "the local loop item is named `row`."

### Phase 4: Build Vue Script Facts

Add a script facts layer, likely `src/source/vue-script-facts.ts`, that extracts behavior from every resolved script block in a `VueSfcUnit`.

The first implementation should use TypeScript/JavaScript ASTs where the repo already has support, and fall back to conservative source extraction only when AST parsing is unavailable.

Facts to capture:

- imports and imported local names
- component registrations and imported component names
- composable calls, especially `useX(...)`
- store calls, especially `useXStore(...)`
- router/route calls
- `ref`, `shallowRef`, `reactive`, `computed`, `watch`, `watchEffect`
- lifecycle hooks such as `onMounted`, `onUnmounted`, `onBeforeUnmount`
- `defineProps`, `defineEmits`, `defineModel`, `defineExpose`, `withDefaults`
- top-level functions and function-like constants
- request/resource helper calls such as `useResource`, `runRequest`, `fetch`, `axios`, and project-specific wrappers only as generic call names, not Stable-specific semantics
- line spans and source paths for each fact

### Phase 5: Build Component Behavior Profiles

Add `src/source/vue-profile.ts`.

`VueComponentBehaviorProfile` should include:

- file path and total/component block line counts
- template fact summary
- script fact summary
- binding graph summary
- behavior tokens for pairwise comparison
- template tokens for component extraction comparison
- evidence snippets as paths, lines, and fact labels

Behavior tokens should be normalized enough to generalize:

- `composable:useResource`
- `composable:useToast`
- `store:useAuthStore`
- `reactivity:computed`
- `reactivity:watch`
- `lifecycle:onMounted`
- `request:runRequest`
- `binding:event:click`
- `binding:state:visible`
- `script-function:open`

Domain nouns should not be fully erased. The comparison can report shared generic behavior separately from domain-specific names so a user can see whether the pair is a true reusable concept or merely two screens doing unrelated business work.

### Phase 6: Improve Template Duplicate Query

Keep `vue-component-duplicates`, but make it consume `VueComponentBehaviorProfile` template tokens rather than building a private one-off template profile.

The command remains a component extraction finder. It should answer: "where are we duplicating rendered structure or component layout?"

Required changes:

- Remove static attribute values from `sharedIdentifiers`.
- Keep default similarity conservative.
- Include block-aware LOC from the Vue SFC unit.
- Preserve current CLI output shape enough that existing users are not surprised.

### Phase 7: Add Composable Candidate Query

Add `src/queries/vue-composable-candidates.ts`.

This query answers: "where are we duplicating state, effects, lifecycle, request handling, or event behavior that could live in a composable?"

Options:

- positional optional file pattern
- `--scope`
- `--min-similarity`
- `--min-shared-behaviors`
- `--limit`
- `--full`
- `--json`

Result fields:

- `fileA`
- `fileB`
- `similarity`
- `sharedComposables`
- `sharedStores`
- `sharedReactivity`
- `sharedLifecycle`
- `sharedRequests`
- `sharedFunctions`
- `sharedBindings`
- `sharedTemplateBindings`
- `uniqueToA`
- `uniqueToB`
- `reason`
- `locA`
- `locB`

Filtering rules:

- Require enough shared behavior tokens to avoid reporting two files that only share `computed`.
- Prefer candidates with at least one shared composable/store/request/lifecycle token or several shared event/state/function tokens.
- Do not require shared template structure; composables often unify behavior across different markup.
- Penalize pairs that only share framework primitives with no shared named behavior.

### Phase 8: Add Large Vue View Pressure Query

Add `src/queries/vue-large-view-pressure.ts`.

This query answers: "which Vue files are so large that they are likely hiding multiple reasons to change?"

Options:

- positional optional file pattern
- `--scope`
- `--min-total-lines`
- `--min-template-lines`
- `--min-script-lines`
- `--min-style-lines`
- `--limit`
- `--full`
- `--json`

Result fields:

- `file`
- `totalLines`
- `templateLines`
- `scriptLines`
- `styleLines`
- `externalScriptLines`
- `externalScriptPaths`
- `customBlockLines`
- `dominantPressure`
- `reasons`

This query must work for inline scripts and external scripts. It should not call every large file a composable candidate; size pressure and repeated behavior are separate facts.

### Phase 9: Feed Vue Signals Into Health

Update:

- `src/queries/health-types.ts`
- `src/queries/health.ts`
- `src/queries/health-report.ts`
- any health action/report rendering affected by new analyses

Health should include:

- `vueComponentDuplicatePairs`
- `vueComposableCandidatePairs`
- `vueLargeViewPressureFiles`

Scoring should treat Vue signals as hygiene pressure. The score impact should grow with count and confidence but should avoid letting one huge category erase the whole score. High-signal repeated behavior should weigh more than a large style block by itself.

### Phase 10: Wire CLI, Public Queries, Docs, And Package Surface

Update:

- `src/queries/index.ts`
- `src/queries/public-query-entries.ts`
- `src/runtime/query-commands/cleanup.ts`
- `src/runtime/query-command-specs.ts`
- `src/runtime/command-descriptors.ts`
- `src/runtime/query-metadata.ts`, if the command list requires it
- `docs/COMMAND_REFERENCE.md`
- `package.json` exports, if new query modules are part of the package surface

Both new commands must reject `--full` with `--limit` through the existing command budget mechanism.

### Phase 11: Verification Against Stable Management

After implementation:

1. Run the local suite:
   - `npm run typecheck`
   - `npm run lint`
   - `npm test`
   - `npm run build`
   - `scip-query reindex`
   - `scip-query diff-gate`

2. Run Stable Management indexing:
   - `scip-query reindex`
   - `scip-query augment-vue --project frontend/tsconfig.scip.json`

3. Run Stable Management Vue queries:
   - `scip-query vue-component-duplicates --scope frontend/src --full --json`
   - `scip-query vue-composable-candidates --scope frontend/src --full --json`
   - `scip-query vue-large-view-pressure --scope frontend/src --full --json`
   - `scip-query health --full --json`

4. Manually inspect known Stable Management cases:
   - `IncidentCategoriesPanel.vue` with `RecordLabelsPanel.vue` should report repeated setup/resource/request behavior, not only template similarity.
   - `CardActionMenu.vue` with `CardStatusMenu.vue` should report repeated menu/dropdown behavior.
   - `HorseProfileFarrierVisitsSection.vue` with `HorseProfileVetRecordsSection.vue` should remain a component/template extraction candidate and should not be overclaimed as a strong composable candidate unless their script behavior truly matches.
   - External-script views such as `InventoryView.vue` and `FacilityBookingView.vue` should show external script line counts and script behavior sourced from their `.script.ts` files.
   - Large mostly-style files should appear in large-view pressure but not automatically in composable candidates.

## Tests To Add

- Vue SFC unit tests:
  - inline template/script/style
  - `<script setup>`
  - normal `<script>` plus `<script setup>`
  - relative `<script src="./x.ts">`
  - unresolved external script
  - non-TS language block metadata

- Template fact tests:
  - static attributes do not become expression identifiers
  - dynamic props/events/directives do become expression identifiers
  - `v-for` aliases are not treated as script state
  - slot scope aliases are not treated as script state
  - dynamic component tags remain component-like facts

- Script fact tests:
  - composables
  - stores
  - refs/reactives/computeds/watchers
  - lifecycle hooks
  - defineProps/defineEmits
  - external script source paths and line numbers

- Query tests:
  - `vue-component-duplicates` still catches shared template structure
  - `vue-composable-candidates` catches shared state/effect behavior without requiring shared markup
  - `vue-composable-candidates` ignores pairs with only generic framework primitives
  - `vue-large-view-pressure` accounts for template, script, style, and external script lines

- CLI tests:
  - both new commands support JSON
  - both new commands support `--full`
  - both new commands reject `--full --limit`
  - command descriptors and public query entries remain complete

- Health tests:
  - new Vue counts appear in full JSON
  - score breakdown includes the new Vue health pressure
  - capped health and full health both remain internally consistent

## Stress Test

1. Does this create a second source model? No. It creates a Vue SFC unit source model and makes template/script/profile consumers use it.
2. Does this generalize beyond Stable Management? Yes. It relies on Vue compiler blocks, JS/TS facts, and generic behavior token families, not Stable-specific component names.
3. Does it handle external scripts? Yes. External block sources are first-class source paths with their own line coordinates.
4. Does it confuse strings with behavior? The plan explicitly removes static attribute values from expression identifiers.
5. Does it overclaim composables? The composable query requires shared behavior evidence and separates it from template/component extraction.
6. Does it hide large-file pressure? No. Large-view pressure is a separate query and health signal.
7. Does it break existing users? `vue-component-duplicates` keeps its role and output shape while improving evidence quality.
8. Does it respect existing CLI budget semantics? Yes. New commands use the existing report/budget command helpers.
9. Does it respect health scoring? Yes. Vue signals become hygiene pressure with bounded score impact.
10. Does it expose enough evidence? Yes. Results include shared behavior buckets, unique tokens, line-aware block stats, and source paths.
11. Does it have a ruthless validation loop? Yes. Local tests, diff gate, Stable Management query runs, and manual inspection of known cases are required before declaring success.

## Acceptance Criteria

- Vue analysis uses compiler-backed SFC parsing for `.vue` block structure.
- External script blocks are resolved and included in Vue behavior profiles.
- Static attribute values no longer count as template expression identifiers.
- `vue-component-duplicates` remains available and produces cleaner template-structure results.
- `vue-composable-candidates` exists and reports repeated state/effect/request/lifecycle behavior.
- `vue-large-view-pressure` exists and reports large SFC pressure with block breakdown.
- `health --full --json` includes the new Vue counts and score breakdown entries.
- Stable Management validation shows that known external-script views are analyzed, known duplicated setup flows are found, and known template-only duplication is not overclaimed as composable reuse.
