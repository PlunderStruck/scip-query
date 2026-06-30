# Frontend Behavior Profile Products — 2026-06-30

## Goal

The user wants the seventh promote-now structural optimization completed in order. Frontend behavior facts are observations about React and Vue files: component shape, JSX/template tokens, hooks/composables, requests, lifecycle calls, SFC block sizes, and other UI behavior signals. A frontend behavior profile product is the shared access object that gives duplicate, composable, hook, and large-view analyzers those facts through one capability-shaped boundary instead of each analyzer calling framework-specific builders directly.

Done means React component behavior profiles, Vue component behavior profiles, Vue template facts, and Vue script facts are reachable through one product API; existing builder exports remain source-compatible; frontend analyzers consume the product; and the implementation does not weaken current React persistent caching or hide Vue external-source dependency limits.

## Current State

- `src/source/react-profile.ts:14-40` defines React component/hook profile shapes and scan options. Source: `node dist/cli.js code 'src/source/react-profile.ts:1-240'`.
- `src/source/react-profile.ts:120-172` already has both a process-local source-file cache and a persistent `react-component-behavior-profiles` file evidence product with serialization and deserialization. Source: `node dist/cli.js code 'src/source/react-profile.ts:1-240'`, `node dist/cli.js trace REACT_COMPONENT_BEHAVIOR_PROFILE_PRODUCT`.
- `src/source/react-profile.ts:174-328` builds, clones, serializes, and validates React behavior profiles. Source: `node dist/cli.js code 'src/source/react-profile.ts:1-240'`, `node dist/cli.js code 'src/source/react-profile.ts:230-360'`.
- `src/source/vue/vue-profile.ts:12-37` defines Vue component profile shapes and scan options. Source: `node dist/cli.js code 'src/source/vue/vue-profile.ts:1-220'`.
- `src/source/vue/vue-profile.ts:49-79` builds Vue profiles through a source-file cache only; it has no persistent `createFileEvidenceProduct()` equivalent. Source: `node dist/cli.js code 'src/source/vue/vue-profile.ts:1-220'`.
- `src/source/vue/vue-template.ts:49-63` defines `VueTemplateFacts` and caches them process-locally as `vue-template-facts`. Source: `node dist/cli.js code 'src/source/vue/vue-template.ts:1-220'`.
- `src/source/vue/vue-template.ts:240-246` returns template facts from the cached SFC unit and parsed template block. Source: `node dist/cli.js code 'src/source/vue/vue-template.ts:240-482'`, `node dist/cli.js trace getVueTemplateFacts`.
- `src/source/vue/vue-script-facts.ts:36-50` defines `VueScriptFacts`, and `src/source/vue/vue-script-facts.ts:79-127` builds them from a resolved `VueSfcUnit`. Source: `node dist/cli.js code 'src/source/vue/vue-script-facts.ts:1-240'`, `node dist/cli.js trace buildVueScriptFacts`.
- `src/source/vue/vue-sfc.ts:47-50` caches SFC units by owner `.vue` source text, while `src/source/vue/vue-sfc.ts:125-165` can resolve external `src` blocks by reading other project files. Source: `node dist/cli.js code 'src/source/vue/vue-sfc.ts:1-260'`.
- `src/queries/frontend/react-component-duplicates.ts:32-70`, `react-hook-candidates.ts:49-85`, and `react-large-component-pressure.ts:29-66` call `buildReactComponentBehaviorProfiles()` directly. Source: `node dist/cli.js code 'src/queries/frontend/react-component-duplicates.ts:1-180'`, `node dist/cli.js code 'src/queries/frontend/react-hook-candidates.ts:1-120'`, `node dist/cli.js code 'src/queries/frontend/react-large-component-pressure.ts:1-100'`.
- `src/queries/frontend/vue-component-duplicates.ts:35-72`, `vue-composable-candidates.ts:48-79`, and `vue-large-view-pressure.ts:34-71` call `buildVueComponentBehaviorProfiles()` directly. Source: `node dist/cli.js code 'src/queries/frontend/vue-component-duplicates.ts:1-180'`, `node dist/cli.js code 'src/queries/frontend/vue-composable-candidates.ts:1-120'`, `node dist/cli.js code 'src/queries/frontend/vue-large-view-pressure.ts:1-110'`.
- `src/source/ast.ts:19-22` re-exports Vue and React profile/template builders from the public source facade. Source: `node dist/cli.js code 'src/source/ast.ts:1-80'`.
- `src/storage/evidence-cache.ts:27-38` currently includes `react-component-behavior-profiles` but no Vue profile/template/script file evidence kind. Source: `node dist/cli.js code 'src/storage/evidence-cache.ts:1-120'`.
- The SCIP index is fresh, the structural inventory doc has no doc-drift findings, and recent-duplicates has no current findings. Source: `node dist/cli.js status --capabilities`, `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`, `node dist/cli.js recent-duplicates --json`.

Non-obvious invariants to preserve:

- React profile reads must return clones because profile objects contain mutable `Set` fields and arrays. Source: `node dist/cli.js code 'src/source/react-profile.ts:148-228'`.
- Vue profile reads must also return clones because profiles include mutable `Set`, array, SFC, template, and script fact structures. Source: `node dist/cli.js code 'src/source/vue/vue-profile.ts:72-155'`.
- Vue external `<script src>` / template/style/custom blocks can make facts depend on files beyond the owner `.vue` file. Until a cross-file dependency digest exists for Vue profiles, the product should not claim a fully single-file persistent key for those external-source cases. Source: `node dist/cli.js code 'src/source/vue/vue-sfc.ts:125-165'`.
- Frontend command policy belongs in the analyzer modules; the product owns fact loading, not thresholds such as min token counts, min similarity, or large-view pressure cutoffs. Source: `node dist/cli.js code 'src/queries/frontend/react-component-duplicates.ts:32-70'`, `node dist/cli.js code 'src/queries/frontend/vue-component-duplicates.ts:35-72'`.

## Reuse Audit

- New product facade: create a small owner in `src/source/frontend-behavior-products.ts`, reusing `buildReactComponentBehaviorProfiles()`, `buildReactComponentBehaviorProfilesForFile()`, `buildVueComponentBehaviorProfiles()`, `buildVueComponentBehaviorProfile()`, `getVueTemplateFacts()`, and `buildVueScriptFacts()` instead of moving parser logic. Source: `node dist/cli.js trace buildReactComponentBehaviorProfiles`, `node dist/cli.js trace buildVueComponentBehaviorProfiles`, `node dist/cli.js trace getVueTemplateFacts`, `node dist/cli.js trace buildVueScriptFacts`.
- React profile product: reuse the existing persistent `REACT_COMPONENT_BEHAVIOR_PROFILE_PRODUCT`; do not create a second React cache. Source: `node dist/cli.js trace REACT_COMPONENT_BEHAVIOR_PROFILE_PRODUCT`.
- Vue component profile product: start with a product facade over existing Vue profile caching and explicit capability metadata. Because Vue external-source blocks can affect a profile, persistence is deferred for external-source cases until a digest exists; the product still gives analyzers one access contract. Source: `node dist/cli.js code 'src/source/vue/vue-sfc.ts:125-165'`.
- Shared list scanning: `similar buildVueComponentBehaviorProfiles` and `similar buildReactComponentBehaviorProfiles` show identical list-scope/scan-limit scaffolding, so the facade should centralize access rather than extract a generic parser. Source: `node dist/cli.js similar buildVueComponentBehaviorProfiles`, `node dist/cli.js similar buildReactComponentBehaviorProfiles`.
- No similar whole-file product owner exists for React or Vue profiles. Source: `node dist/cli.js similar-files src/source/react-profile.ts`, `node dist/cli.js similar-files src/source/vue/vue-profile.ts`.

## Design Phases

### 1.1 — Add frontend behavior product facade

- [x] **File**: `src/source/frontend-behavior-products.ts:1-78`
- **Source**: `node dist/cli.js trace buildReactComponentBehaviorProfiles`, `node dist/cli.js trace buildVueComponentBehaviorProfiles`, `node dist/cli.js trace getVueTemplateFacts`, `node dist/cli.js trace buildVueScriptFacts`
- **What**: Frontend analyzers call framework-specific builders directly.
- **Change**: Add `FrontendBehaviorProduct`, `FrontendBehaviorSlot`, and `FrontendBehaviorCapability`. The product exposes `reactProfiles(opts)`, `reactProfilesForFile(file)`, `vueProfiles(opts)`, `vueProfileForFile(file)`, `vueTemplateFacts(file)`, and `vueScriptFacts(file)`. Capability slots are `react-component-behavior-profiles`, `vue-component-behavior-profiles`, `vue-template-facts`, and `vue-script-facts`.
- **Why**: All frontend analyzers should read frontend behavior facts through one product boundary.

### 1.2 — Preserve builders as product-backed compatibility wrappers

- [x] **File**: `src/source/react-profile.ts:129-174`
- **Source**: `node dist/cli.js code 'src/source/react-profile.ts:1-240'`
- **What**: React builders own profile list/file access directly and already persist file profiles.
- **Change**: Keep the current implementation, route the product through the existing builder, and add an `ignore-wrapper` comment to the per-file cache helper because `wrapper-candidates` classifies this optimized cache boundary as wrapper-shaped after the facade migration. The facade should call the existing builders rather than making React depend back on the facade.
- **Why**: Avoid circular imports and preserve the proven React persistent cache.

- [x] **File**: `src/source/vue/vue-profile.ts:53-126`
- **Source**: `node dist/cli.js code 'src/source/vue/vue-profile.ts:1-220'`
- **What**: Vue builders own list/file access through a process-local source cache.
- **Change**: Keep the current implementation as the product's provider for Vue profile facts and add an `ignore-wrapper` comment to the per-file cache helper because `wrapper-candidates` classifies this optimized cache boundary as wrapper-shaped after the facade migration. Do not add a persistent Vue profile product in this slice because external `src` blocks can make owner-file content hashes incomplete.
- **Why**: Product access is structural; persistence should wait for a correct Vue dependency digest.

### 1.3 — Migrate frontend analyzers to the product

- [x] **File**: `src/queries/frontend/react-component-duplicates.ts:1-120`
- **Source**: `node dist/cli.js code 'src/queries/frontend/react-component-duplicates.ts:1-180'`
- **What**: The analyzer imports `buildReactComponentBehaviorProfiles()` directly.
- **Change**: Import `frontendBehaviorProduct` plus `ReactComponentBehaviorProfile` type, then call `frontendBehaviorProduct(db).reactProfiles({ scope, minJsxTokens, scanLimit })`.
- **Why**: React duplicate detection should consume the product while retaining all threshold policy locally.

- [x] **File**: `src/queries/frontend/react-hook-candidates.ts:1-298`
- **Source**: `node dist/cli.js code 'src/queries/frontend/react-hook-candidates.ts:1-120'`
- **What**: Hook candidates import `buildReactComponentBehaviorProfiles()` directly.
- **Change**: Call `frontendBehaviorProduct(db).reactProfiles({ scope, minBehaviorTokens, scanLimit })`.
- **Why**: Hook behavior evidence should share the frontend product boundary.

- [x] **File**: `src/queries/frontend/react-large-component-pressure.ts:1-257`
- **Source**: `node dist/cli.js code 'src/queries/frontend/react-large-component-pressure.ts:1-100'`
- **What**: Large component pressure imports `buildReactComponentBehaviorProfiles()` directly.
- **Change**: Call `frontendBehaviorProduct(db).reactProfiles({ scope, scanLimit })`.
- **Why**: Large React component pressure should share the same profile access path.

- [x] **File**: `src/queries/frontend/vue-component-duplicates.ts:1-124`
- **Source**: `node dist/cli.js code 'src/queries/frontend/vue-component-duplicates.ts:1-180'`
- **What**: Vue component duplicates import `buildVueComponentBehaviorProfiles()` directly.
- **Change**: Call `frontendBehaviorProduct(db).vueProfiles({ scope, minTemplateTokens, scanLimit })`.
- **Why**: Vue template structure evidence should flow through the product.

- [x] **File**: `src/queries/frontend/vue-composable-candidates.ts:1-304`
- **Source**: `node dist/cli.js code 'src/queries/frontend/vue-composable-candidates.ts:1-120'`
- **What**: Vue composable candidates import `buildVueComponentBehaviorProfiles()` directly.
- **Change**: Call `frontendBehaviorProduct(db).vueProfiles({ scope, minBehaviorTokens, scanLimit })`.
- **Why**: Vue behavior evidence should share the product.

- [x] **File**: `src/queries/frontend/vue-large-view-pressure.ts:1-213`
- **Source**: `node dist/cli.js code 'src/queries/frontend/vue-large-view-pressure.ts:1-110'`
- **What**: Vue large-view pressure imports `buildVueComponentBehaviorProfiles()` directly.
- **Change**: Call `frontendBehaviorProduct(db).vueProfiles({ scope, scanLimit })`.
- **Why**: Vue size pressure should use the same fact boundary as other Vue analyzers.

### 1.4 — Export the product through the source facade and test it

- [x] **File**: `src/source/ast.ts:8-52`
- **Source**: `node dist/cli.js code 'src/source/ast.ts:1-80'`
- **What**: The source facade exports individual React/Vue builders and types, but not a frontend behavior product.
- **Change**: Export `frontendBehaviorProduct` and the new product/capability types.
- **Why**: Consumers that use the stable source facade can discover the product without importing framework files directly.

- [x] **File**: frontend tests (test files are not indexed by scip-query; production behavior sources are cited above)
- **Source**: `node dist/cli.js trace buildReactComponentBehaviorProfiles`, `node dist/cli.js trace buildVueComponentBehaviorProfiles`
- **What**: Existing rich-internal tests assert analyzer outputs, not the product boundary.
- **Change**: Extend focused frontend tests to assert product capability and equality with existing React/Vue builder results on the fixture DB.
- **Why**: The product contract needs direct coverage while preserving analyzer output tests.

## Stress-Test Findings

1. Understand before touch: frontend profiles are pure source-derived facts used by React duplicate/hook/large-component and Vue duplicate/composable/large-view analyzers. Source: `node dist/cli.js plan-context src/source/react-profile.ts`, `node dist/cli.js plan-context src/source/vue/vue-profile.ts`.
2. Blast radius: React and Vue profile owners each have 13 external consumers; the plan keeps existing builder exports and migrates command consumers only. Source: `node dist/cli.js plan-context src/source/react-profile.ts`, `node dist/cli.js plan-context src/source/vue/vue-profile.ts`.
3. Valid intermediate states: adding the product is additive; each analyzer can migrate after the product exists; compatibility builders remain.
4. Reversibility: changes are internal TypeScript refactors with no schema changes and no removal of existing exports.
5. Failure design: product capability reports unsupported file/framework cases; existing builder fallbacks and empty results remain unchanged.
6. Concurrency: no new shared mutable state beyond existing source-file caches and React persistent product.
7. Boundaries: no CLI input boundaries change; analyzer option validation stays in analyzer functions.
8. Data integrity: no new persistent Vue payload is added until a cross-file Vue dependency digest is available; React persistence keeps its existing kind and validator.
9. Observability: verification will use frontend command smokes and the evidence-product benchmark; no new logs are needed.
10. Human impact: frontend command outputs should remain unchanged because result shaping and thresholds stay in analyzer modules.
11. Reuse: the product reuses current React/Vue builders and caches, avoiding a generic framework parser extraction. Source: `node dist/cli.js similar buildVueComponentBehaviorProfiles`, `node dist/cli.js similar buildReactComponentBehaviorProfiles`.

## Execution Order

1. Add `src/source/frontend-behavior-products.ts`.
2. Export the product from `src/source/ast.ts`.
3. Migrate React frontend analyzers.
4. Migrate Vue frontend analyzers.
5. Extend focused frontend tests with product assertions.
6. Run focused frontend tests, typecheck, build, frontend command smokes, structural checks, full tests, benchmark, reindex, and diff-gate.

## Ship Order

Ship as one internal refactor. There are no one-way doors: no schema changes, no cache-kind changes, no CLI output changes, and existing builders remain.

## Verification Progress

- [x] Focused frontend tests passed: `npm test -- tests/queries/frontend/react-frontend-rich-internals.test.ts tests/queries/frontend/vue-template-rich-internals.test.ts tests/source/vue-profile.test.ts tests/queries/frontend/frontend-recent-duplicates.test.ts`.
- [x] Typecheck passed: `npm run typecheck`.
- [x] Build passed: `npm run build`.
- [x] Frontend command smokes passed for `react-component-duplicates`, `react-hook-candidates`, `react-large-component-pressure`, `vue-component-duplicates`, `vue-composable-candidates`, and `vue-large-view-pressure`.
- [x] Reindex passed: `node dist/cli.js reindex`.
- [x] Structural checks are clean: `wrapper-candidates --json`, `incomplete-migration --json`, `recent-duplicates --json`, and `unused-params --json`.
- [x] Full test suite passed: `npm test` (83 files, 463 tests).
- [x] Evidence-product benchmark passed: `npm run bench:evidence-products -- --warm-iterations 0 --no-clear --out /tmp/frontend-behavior-products.jsonl` with 0 failed commands.
- [x] Diff impact completed: `node dist/cli.js diff-impact --json`.
- [x] Health check completed: `node dist/cli.js health --full` reported 99/100.
- [x] Final gate passed: `node dist/cli.js reindex && node dist/cli.js diff-gate --json`.

## Summary

Files modified/created:

- `src/source/frontend-behavior-products.ts`
- `src/source/ast.ts`
- `src/source/react-profile.ts`
- `src/source/vue/vue-profile.ts`
- `src/queries/frontend/react-component-duplicates.ts`
- `src/queries/frontend/react-hook-candidates.ts`
- `src/queries/frontend/react-large-component-pressure.ts`
- `src/queries/frontend/vue-component-duplicates.ts`
- `src/queries/frontend/vue-composable-candidates.ts`
- `src/queries/frontend/vue-large-view-pressure.ts`
- Focused frontend tests

Expected net effect: frontend analyzers use one product boundary for React and Vue behavior facts, current caches and outputs stay intact, and Vue persistence remains correctly deferred until cross-file digesting exists.
