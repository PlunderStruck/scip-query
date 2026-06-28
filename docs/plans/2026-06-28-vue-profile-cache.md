# Vue Behavior Profile Cache Plan - 2026-06-28

## Goal

Speed up Vue-backed detector commands without changing their findings. A Vue behavior profile is the per-file record built from a real `.vue` single-file component: parsed template facts, script facts, token sets, line counts, and component names. A source-aware cache is the existing in-memory, per-database storage class that returns a previously computed value only when the file's current source text is identical. Done means repeated Vue duplicate detectors in one CLI process reuse the same behavior profile objects, command output stays identical, and measured runs on a Vue-heavy repo improve or are reverted.

## Current State

- `buildVueComponentBehaviorProfiles` in `src/source/vue/vue-profile.ts:49-66` lists `.vue` files, applies `scope` and `scanLimit`, builds every file with `buildVueComponentBehaviorProfile`, then filters by `minTemplateTokens` and `minBehaviorTokens`. Source: `scip-query plan-context buildVueComponentBehaviorProfiles`.
- `buildVueComponentBehaviorProfile` in `src/source/vue/vue-profile.ts:68-108` normalizes the path, reads the SFC unit, reads template facts, rebuilds script facts, derives tokens and line counts, and returns a full `VueComponentBehaviorProfile`. Source: `scip-query code buildVueComponentBehaviorProfile -C 15`.
- `vueComponentDuplicates` calls `buildVueComponentBehaviorProfiles` with `minTemplateTokens`; `vueComposableCandidates` calls the same builder with `minBehaviorTokens`. Source: `scip-query code vueComponentDuplicates -C 12` and `scip-query code vueComposableCandidates -C 12`.
- `getVueSfcUnit` and `getVueTemplateFacts` already use source-aware caches, but the assembled behavior profile and `buildVueScriptFacts` are rebuilt by each consumer. Source: `scip-query code getVueSfcUnit -C 8`, `scip-query code getVueTemplateFacts -C 8`, and `scip-query code buildVueScriptFacts -C 8`.
- The affected blast radius is the Vue profile builder and its three frontend consumers: `vue-component-duplicates`, `vue-composable-candidates`, and `vue-large-view-pressure`. Source: `scip-query affected buildVueComponentBehaviorProfile --json`.

## Reuse Audit

- Reuse `createSourceFileCache` from `src/storage/per-db-cache.ts:128-129` instead of adding a new cache mechanism. It keys by database and path and invalidates when source text changes. Source: `scip-query code createSourceFileCache -C 8` and `scip-query code createPerDbSourceCache -C 18`.
- Do not extract the shared file-list/filter shape from Vue and React in this pass. `scip-query similar buildVueComponentBehaviorProfiles --json --full` reports `buildReactComponentBehaviorProfiles` as structurally similar, but the runtime hotspot is duplicated Vue profile construction and React has different per-file cardinality through `flatMap`.
- Do not change caller APIs. `scip-query plan-context buildVueComponentBehaviorProfiles` shows four external consumers, and a public option change would widen risk without being necessary for cache reuse.

## Design

### 1.1 - Cache one Vue behavior profile per source file

- [ ] **File**: `src/source/vue/vue-profile.ts:1-108`
- **Source**: `scip-query code buildVueComponentBehaviorProfile -C 15`; `scip-query code createSourceFileCache -C 8`.
- **What**: The current file imports source helpers but no cache helper. Each call to `buildVueComponentBehaviorProfile` recomputes script facts, behavior tokens, component names, and line counts for the same source text.
- **Change**: Import `createSourceFileCache` and add `const VUE_COMPONENT_BEHAVIOR_PROFILE_CACHE = createSourceFileCache<VueComponentBehaviorProfile>('vue-component-behavior-profiles');`. In `buildVueComponentBehaviorProfile`, normalize the path, read `getSourceText(db, file)`, fetch the cached profile with `VUE_COMPONENT_BEHAVIOR_PROFILE_CACHE.get(db, file, source, () => buildVueComponentBehaviorProfileUncached(db, file, source))`, and return a fresh clone of mutable top-level and script-fact fields.
- **Why**: This reuses the existing source-aware invalidation contract and moves only pure profile assembly behind the cache.

### 1.2 - Keep the profile computation pure and local

- [ ] **File**: `src/source/vue/vue-profile.ts:68-108`
- **Source**: `scip-query code buildVueComponentBehaviorProfile -C 15`.
- **What**: `buildVueComponentBehaviorProfile` both normalizes/cache-eligible input and computes the profile body.
- **Change**: Move the current profile body into a private `buildVueComponentBehaviorProfileUncached(db, file, source)` helper. Use `source ? source.split('\n').length : 0` for `sfcLines`, matching `getSourceLines` exactly while avoiding a second source-line cache lookup for the same file.
- **Why**: The exported function keeps its contract while the uncached helper gives tests and maintainers a clean boundary between cache lookup and profile assembly.

### 1.3 - Add a cache regression test

- [ ] **File**: `tests/source/vue-profile.test.ts`
- **Source**: `scip-query files vue-profile`; `scip-query affected buildVueComponentBehaviorProfile --json`.
- **What**: Existing source tests cover filesets and frontend detector output, but no test proves repeated profile requests return source-identical behavior through the cache.
- **Change**: Add a focused test that opens a fixture DB, writes a `.vue` file, mutates the first returned profile, calls `buildVueComponentBehaviorProfile` again, and asserts the second call does not inherit the caller mutation. Then edit the file source, clear source-file caches, and assert the next call returns updated source-derived data and line counts.
- **Why**: The test proves both the fast path and the source-change invalidation path without coupling to wall-clock timing.

## Stress Test Findings

- Understand before touching: this path exists because Vue template and script behavior are invisible to plain SCIP call graphs; the cache must not remove template/script evidence. Source: `scip-query code buildVueComponentBehaviorProfile -C 15`.
- Blast radius: all downstream consumers are detector/read-only commands, and no public CLI option changes are planned. Source: `scip-query affected buildVueComponentBehaviorProfile --json`.
- Intermediate validity: the exported function signature is unchanged, so each step remains buildable after the test and implementation move together.
- Reversibility: this is a two-way internal cache; reverting removes the import, constant, and wrapper.
- Failure and concurrency: the cache is process-local and per `ScipDatabase` WeakMap state; concurrent CLI processes keep independent caches. Source: `scip-query code createPerDbSourceCache -C 18`.
- Data integrity: no persistent data or index schema changes.
- Observability and human impact: no output text changes; verification compares JSON output before and after.

## Verification

- Compare Stable `recent-duplicates --json` output before and after.
- Benchmark Stable `recent-duplicates --json` before and after with warm repeated runs.
- Run `npm run typecheck`, focused Vue/profile tests, and full test/build if focused checks pass.
- Run scip postchecks for a new helper/cache: `scip-query similar buildVueComponentBehaviorProfileUncached --json --full`, `scip-query recent-duplicates --json --full`, `scip-query incomplete-migration --json --full`, `scip-query unused-params --json --full`, then `scip-query status --capabilities`, reindex only if stale, and `scip-query diff-gate --json`.

## Execution Order

1. Implement cache wrapper and private uncached helper.
2. Add cache regression test.
3. Build and run focused tests.
4. Rebuild CLI and compare Stable output/timing.
5. Run scip verification and gate.

## Summary

- Files to modify: `src/source/vue/vue-profile.ts`, `tests/source/vue-profile.test.ts`.
- Files to add: this plan.
- Expected net effect: lower repeated Vue detector CPU work in one process, unchanged detector output.

## Addendum - Verification Cleanup

- `scip-query stale-abstractions --json --full` reported `SourceFrameworkApplicability` from the prior framework-pruning speed pass as a one-use exported shape. Remove that interface from `src/source/source-fileset.ts` and use the inferred return type in `src/runtime/cli-support.ts` so the previous optimization does not leave an avoidable type-level abstraction signal.
- Subagent review flagged that caching and returning the exact same `VueComponentBehaviorProfile` object would make mutable `Set` and array fields sticky across public calls. Keep the cache, but clone mutable top-level and `scriptFacts` fields before returning so detector output stays fast and caller-visible object freshness remains safe.
