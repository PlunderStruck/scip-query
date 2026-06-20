# Frontend Recent Duplicates Plan

Date: 2026-06-19

## Goal

The user wants the reuse-checking commands to work the same way for React and Vue as they do for TypeScript helpers. In this slice, `recent-duplicates` must report newly added React/Vue component and behavior duplicates, not only generic callable similarity. Done means a user can add a TSX component, JSX component, Vue SFC, hook-like behavior, or composable-like behavior and run one recent-duplicate command that points from the new echo to the established frontend concept when git history supports that direction.

A recent duplicate is a pair of source units whose structure or behavior substantially overlaps, where git add history shows that at least one side was introduced in the configured recent window. The thing that separates it from ordinary duplication is direction: it can say which side is the newer echo and which side is the older concept to reuse or extend.

A frontend component duplicate is a pair of React components or Vue SFC views that share rendered structure such as child components, native tags, props, events, directives, slots, or bindings. The thing that separates it from ordinary callable duplication is that the evidence comes from user interface structure, not from a function call graph.

A frontend behavior duplicate is a pair of React components or Vue SFC views that share state, effects, requests, lifecycle hooks, handlers, reactivity, stores, or composable/hook calls. The thing that separates it from ordinary callable duplication is that the likely extraction target is a hook or composable rather than a generic helper function.

## Evidence

- `recentDuplicates()` currently runs `similarAll()` and then orients pairs with `getFileAddRecords()`. Source: `scip-query code recentDuplicates -C 12`.
- The current CLI renderer only prints similarity, `ECHO`/`TWIN`, file, and symbol names. Source: `scip-query code 'src/runtime/query-commands/cleanup.ts:784-835'`.
- `getFileAddRecords()` returns only files added in the bounded git window; absent files should be treated as established. Source: `scip-query code getFileAddRecords -C 12`.
- React component duplicate results include component names, files, similarity, shared JSX components, tags, props, events, and bindings. Source: `scip-query code ReactComponentDuplicateResult -C 8`.
- React hook candidate results include component names, files, similarity, shared hooks, effects, state, requests, handlers, and handler verbs. Source: `scip-query code ReactHookCandidateResult -C 8`.
- Vue component duplicate results include files, similarity, shared components, props, events, directives, slots, and identifiers. Source: `scip-query code VueComponentDuplicateResult -C 8`.
- Vue composable candidate results include files, similarity, shared composables, stores, reactivity, lifecycle, requests, functions, bindings, and template events. Source: `scip-query code VueComposableCandidateResult -C 8`.

## Plan

### 1. Normalize duplicate candidates

- [x] **File**: `src/queries/recent-duplicates.ts`.
- **Change**: Add an internal `RecentDuplicateDomain` union and a normalized candidate shape that can represent callable, React component, React hook behavior, Vue component, and Vue composable behavior pairs.
- **Why**: `recent-duplicates` needs one orientation and sorting path, while each detector keeps its own domain-specific evidence.

### 2. Add frontend sources to `recent-duplicates`

- [x] **File**: `src/queries/recent-duplicates.ts`.
- **Change**: Keep existing `similarAll()` candidates, then append cross-file candidates from `reactComponentDuplicates()`, `reactHookCandidates()`, `vueComponentDuplicates()`, and `vueComposableCandidates()`.
- **Why**: Generic symbol similarity sees functions. Frontend profile similarity sees JSX and Vue template structure plus hook/composable-like behavior.

### 3. Preserve git-age semantics

- [x] **File**: `src/queries/recent-duplicates.ts`.
- **Change**: Move echo/twin orientation into a helper that operates on normalized candidates and file add records. Keep established files as records absent from the recent add map.
- **Why**: The command's defining behavior is directional git-age evidence, and adding frontend evidence should not change that contract.

### 4. Improve output evidence

- [x] **File**: `src/queries/recent-duplicates.ts`.
- **Change**: Extend `RecentDuplicateFinding` with `domain`, `basis`, and `sharedEvidence`, while keeping `sharedCallees` for compatibility.
- [x] **File**: `src/runtime/query-commands/cleanup.ts`.
- **Change**: Print the domain/basis and a short shared evidence line in text mode.
- **Why**: Users need to know whether the report is about a helper, component structure, hook behavior, or composable behavior.

### 5. Add regression tests

- [x] **File**: `tests/frontend-recent-duplicates.test.ts` new.
- **Change**: Build temp git repos with established and newly added React/Vue files, then assert `recentDuplicates()` reports React component and Vue component findings as recent echoes.
- **Change**: Include a behavior duplicate case if fixture signal remains stable with realistic thresholds.
- **Why**: This verifies the command uses real git add age and frontend-rich internals together.

### 6. Verify the full command family expectation

- [x] Run `npm run typecheck`.
- [x] Run `npm run lint`.
- [x] Run targeted and full tests.
- [x] Run `git diff --check`.
- [x] Run `scip-query reindex && scip-query diff-gate`.
- [x] Run `recent-duplicates --full --json` on frontend fixture coverage with real git history and confirm React/Vue domains are present when matching recent add history exists.

## Boundary

`incomplete-migration` should stay a callable migration-completeness command. It works for extracted hooks, composables, and helpers when those extractions appear as callable definitions and call sites. Pure JSX or Vue template component reuse is not a callable migration; it is a frontend structure reuse problem, so this slice makes `recent-duplicates` report that class directly and keeps the frontend duplicate commands available for repo-wide pressure.
