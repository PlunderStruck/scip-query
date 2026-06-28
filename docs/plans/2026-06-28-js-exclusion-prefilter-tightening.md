# JS Exclusion Prefilter Tightening Plan - 2026-06-28

## Goal

Make `dead` and health dead analysis faster on large TypeScript/React
repositories without changing which definitions are excluded from dead-code
analysis.

A prefilter is a cheap test run before an expensive analyzer. Here the
referents are source strings read from JS/TS files before tree-sitter parses
them; the wider class is a guard condition; the distinguishing trait is that it
must only return false when the expensive AST scan cannot find a relevant
framework exclusion.

## Current State

- `getDefinitionExclusions()` in `src/analysis/framework-patterns.ts:37-44`
  routes Rust files to Rust exclusions, TypeScript/TSX/JavaScript files to
  `getJsTestExclusions()`, and returns no exclusions for other languages.
  Source: `scip-query plan-context getDefinitionExclusions`.
- `getJsTestExclusions()` in `src/analysis/framework-patterns.ts:68-159`
  reads source text, skips AST parsing when `mayContainJsExclusion()` is false,
  otherwise parses the AST and looks for top-level test framework calls,
  top-level custom React hook declarations, and suppression comments. Source:
  `scip-query code getDefinitionExclusions -C 130`.
- `mayContainJsExclusion()` in `src/analysis/framework-patterns.ts:161-163`
  currently returns true when the source contains `scip-query`, a test
  framework call, or any `use[A-Z]...` identifier. Source:
  `scip-query code getDefinitionExclusions -C 130`.
- `deadCandidateDefinitions()` in `src/queries/cleanup/dead.ts:156-178`
  calls `buildFileExclusionPredicate()`, loops indexed document paths, loads
  corrected definitions for each file, and runs `deadCandidateDecision()` with
  the exclusion predicate. Source: `scip-query plan-context
  deadCandidateDefinitions`.
- The affected graph is narrow: `getDefinitionExclusions()` affects
  `buildFileExclusionPredicate()`, then `deadCandidateDefinitions()`, then
  `dead()`. Source: `scip-query affected getDefinitionExclusions`.
- Vega opportunity probe: among 1,777 indexed `.ts/.tsx/.js/.jsx` files, the
  current prefilter matched 851 files; a declaration-shaped hook prefilter
  matched 556 files, avoiding 295 AST candidates while preserving test-call and
  suppression markers. Source: local Vega index probe after `scip-query status
  --json` confirmed `/Users/aydansalois/.cache/scip-query/projects/eec2188f862b/index.db`.

## Reuse Audit

- Reuse the existing `mayContainJsExclusion()` hook point rather than adding a
  new scanner. Source: `scip-query refs mayContainJsExclusion`.
- Reuse the existing AST authority in `getJsTestExclusions()` for exact line
  ranges and top-level checks. Source: `scip-query code getDefinitionExclusions
  -C 130`.
- No new public helper is planned. `scip-query similar mayContainJsExclusion
  --json --full` returned no similar helpers to merge with.

## Design

### 1. Tighten the source prefilter

- [ ] **File**: `src/analysis/framework-patterns.ts:64-66`
- **Source**: `scip-query code getDefinitionExclusions -C 130`.
- **What**: `REACT_HOOK_NAME_RE` matches any `use[A-Z]...` identifier, including
  ordinary hook calls such as `useState`, even though the AST exclusion only
  records top-level custom hook declarations.
- **Change**: Replace `REACT_HOOK_NAME_RE` with a declaration-shaped regex that
  matches only likely top-level custom hook declarations:
  `function useThing`, `export function useThing`, `const useThing = (...) =>`,
  and `const useThing = function`.
- **Why**: Files that merely call hooks should not pay the AST exclusion scan
  when no test marker or suppression marker is present.

### 2. Preserve the existing AST contract

- [ ] **File**: `src/analysis/framework-patterns.ts:68-159`
- **Source**: `scip-query code getDefinitionExclusions -C 130`.
- **What**: The AST path owns exact top-level classification and line ranges for
  test files, custom hooks, and suppression comments.
- **Change**: Leave the AST traversal unchanged; only narrow the cheap
  source-text gate that decides whether to enter it.
- **Why**: Output accuracy comes from the existing AST path, not the regex.

### 3. Add regression coverage

- [ ] **File**: `tests/analysis/framework-patterns.test.ts`
- **Source**: `scip-query plan-context getDefinitionExclusions` identifies
  `src/analysis/framework-patterns.ts` as the target; focused Vitest validation
  covers its framework-pattern behavior.
- **What**: Existing tests cover plain files, test files, React custom hook
  exclusions, and suppression comments.
- **Change**: Add a case where a normal React component imports/calls
  `useState` but declares no custom hook; it must return no definition
  exclusions.
- **Why**: This proves the narrower prefilter does not force ordinary hook-call
  files into the exclusion path.

### 4. Record benchmark decision

- [ ] **File**: `docs/benchmarks/2026-06-28-dead-full-ledger.md`
- **Source**: `scip-query plan-context deadCandidateDefinitions` and the Vega
  opportunity probe.
- **What**: The dead ledger already records candidate discovery and source
  fallback as remaining targets.
- **Change**: Add the hypothesis, the Vega prefilter count, the output-hash
  check, and before/after timings. Keep the change only if Vega output hashes
  match and timings improve or are at least neutral with reduced AST work.
- **Why**: Hyper-optimization changes must be accepted or rejected by measured
  workload evidence.

## Stress Test

- Understand before touching: the regex is not the authority; it is only a
  guard before the AST pass. Source: `scip-query code getDefinitionExclusions
  -C 130`.
- Blast radius: direct impact is limited to `buildFileExclusionPredicate()`,
  `deadCandidateDefinitions()`, and `dead()`. Source: `scip-query affected
  getDefinitionExclusions`.
- Reversibility: the change is a single internal regex/test/doc patch and can
  be reverted without data migration.
- Failure mode: an overly narrow regex could skip a custom hook exclusion. The
  AST path remains unchanged, and tests must cover function declarations,
  variable hook declarations, suppression comments, test files, and ordinary
  hook calls.
- Co-change: history links `framework-patterns.ts` with `project-index.ts`,
  `ast.ts`, `source-facts.ts`, and `definition-catalog.ts`, but this patch does
  not change AST fact extraction or definition correction. Source:
  `scip-query co-change src/analysis/framework-patterns.ts --json --full`.

## Verification

1. `npx vitest run tests/analysis/framework-patterns.test.ts`
2. `npm run typecheck`
3. `npm run build`
4. On Vega_2.0, compare hashes and timings for:
   - `scip-query dead --json --full`
   - `scip-query __health-phase dead --full`
   - `scip-query health --json`
5. Update `docs/benchmarks/2026-06-28-dead-full-ledger.md` and
   `docs/benchmarks/2026-06-28-vega-current-scoreboard.md`.
6. If kept, run `scip-query status --capabilities`, reindex only if stale, then
   `scip-query diff-gate --json`.
