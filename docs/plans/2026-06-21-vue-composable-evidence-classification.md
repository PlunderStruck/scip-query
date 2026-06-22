# Vue Composable Evidence Classification Plan

Date: 2026-06-21

## Purpose

A Vue composable evidence class is the kind of shared behavior that caused two Vue files to be paired: generic workflow scaffolding, an existing composable/store abstraction, domain-specific behavior, or a mix. Its real-world referents are shared tokens such as composables, stores, lifecycle hooks, request helpers, functions, function verbs, template bindings, and template events; its essential role is to tell reviewers whether a composable extraction candidate is a domain behavior lead or only common UI mechanics.

## Code Anchors

- `node dist/cli.js plan-context vueComposableCandidates` resolves `vueComposableCandidates()` at `src/queries/frontend/vue-composable-candidates.ts:33-62`, `VueComposableCandidateResult` at `src/queries/frontend/vue-composable-candidates.ts:6-25`, and consumers in health, recent duplicates, public exports, and the CLI handler.
- `src/queries/health/health.ts` already discounts generic Vue composable candidates through `vueComposableHealthScore()`.
- `src/runtime/query-commands/cleanup/handlers.ts` renders Vue composable candidates without evidence class, tier, or recommendation.
- Diff-gate flagged the React behavior classifier as intentionally parallel to Vue; this slice keeps the frontend behavior analyzers in sync.

## Steps

1. Extend `VueComposableCandidateResult` additively.
   - Add `evidenceClass`.
   - Add `actionTier: 'signal' | 'support'`.
   - Add `evidenceClassReasons`.
   - Add `recommendation`.

2. Classify shared behavior evidence.
   - `generic-workflow-scaffolding`: common UI mechanics and framework primitives.
   - `shared-abstraction`: existing composables/stores dominate and little concrete domain behavior remains.
   - `domain-behavior`: product-specific request, function, binding, event, composable, or store names dominate.
   - `mixed`: generic workflow and domain behavior both matter.

3. Preserve detection and scoring semantics initially.
   - Do not filter rows.
   - Keep health scoring behavior unchanged unless verification shows a mismatch.
   - Print the new class/tier/recommendation in CLI text output.

## Verification

- `npx vitest run tests/queries/frontend/vue-template-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js vue-composable-candidates --json --limit 5`
- Stable_Management `vue-composable-candidates --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- Classification is vocabulary-sensitive. The fields should explain the evidence and soften action tier for generic rows without suppressing uncertain findings.

## Result

Completed in `docs/validation/2026-06-21-frontend-behavior-evidence-classification-result.md`.
