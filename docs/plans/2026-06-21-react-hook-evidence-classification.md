# React Hook Evidence Classification Plan

Date: 2026-06-21

## Purpose

A React hook evidence class is the kind of shared behavior that caused two components to be paired: generic workflow scaffolding, an already-shared abstraction, domain-specific behavior, or a mix of those. Its real-world referents are concrete shared tokens such as `useState`, `handleSubmit`, `isSaving`, `useAsyncLoader`, `useAuthStore`, `loadMembers`, and `invoiceId`; its essential role is to keep hook-extraction candidates visible while telling reviewers whether the evidence is a real domain extraction lead or merely common UI workflow shape.

Generic workflow scaffolding is shared state, handlers, and React hooks whose names express common UI mechanics such as submit, save, delete, loading, form, open, close, or selected. These tokens are useful evidence that components have a similar shape, but their essential limitation is that they do not by themselves prove a reusable domain hook exists.

Domain-specific behavior is shared behavior whose names point to product concepts, external requests, stores, or handlers beyond generic UI mechanics. Its essential role is to identify extraction candidates where a shared hook, controller, or feature module may preserve product meaning rather than just factor out mechanical React code.

## Code Anchors

- `node dist/cli.js plan-context reactHookCandidates` resolves `reactHookCandidates()` at `src/queries/frontend/react-hook-candidates.ts:34-69`, `ReactHookCandidateResult` at `src/queries/frontend/react-hook-candidates.ts:6-25`, and consumers in health, recent duplicates, public exports, and the CLI handler.
- `src/queries/health/health.ts` already discounts generic React hook candidates through `reactHookHealthScore()`.
- `src/runtime/query-commands/cleanup/handlers.ts` currently renders React hook candidates without evidence class, tier, or recommendation.
- `docs/validation/2026-06-21-rust-wrapper-react-pressure-review.md` records the Vega finding that generic React hook scaffolding dominates the top samples.

## Steps

1. Extend `ReactHookCandidateResult` additively.
   - Add `evidenceClass`.
   - Add `actionTier: 'signal' | 'support'`.
   - Add `evidenceClassReasons`.
   - Add `recommendation`.

2. Classify shared behavior evidence.
   - `generic-workflow-scaffolding`: only common UI mechanics and React primitives.
   - `shared-abstraction`: an existing shared hook dominates and little concrete domain behavior remains.
   - `domain-behavior`: product-specific state, request, handler, or hook names dominate.
   - `mixed`: generic workflow and domain behavior both matter.

3. Preserve detection and scoring semantics initially.
   - Do not filter rows.
   - Keep health scoring behavior unchanged unless verification shows a mismatch.
   - Print the new class/tier/recommendation in CLI text output.

4. Validate on Vega.
   - Rerun `react-hook-candidates --full --json`.
   - Confirm generic submit/save/delete/load rows are marked support while domain rows remain signal.

## Verification

- `npx vitest run tests/queries/frontend/react-frontend-rich-internals.test.ts`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `node dist/cli.js react-hook-candidates --json --limit 5`
- Vega `react-hook-candidates --full --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Risk

- Classifying names as generic or domain-specific is vocabulary-sensitive. The change should keep rows visible and use softer action tiers rather than deleting uncertain findings.

## Result

Completed in `docs/validation/2026-06-21-frontend-behavior-evidence-classification-result.md`.
