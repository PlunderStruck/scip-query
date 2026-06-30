# Narrow Text Guards Plan

Date: 2026-06-30

## Goal

The user wants the structural optimization register fully handled without turning local performance guards into brittle architecture. A narrow text guard is a cheap source-text test, visible here as substring checks before AST parsing, target-pruned source echo scans, and identifier-name prefilters, whose defining job is to avoid expensive or noisy analysis only inside the output contract that makes the shortcut correct. Done for this item means we prove whether these guards deserve a shared abstraction or accept them as local.

## Current State

- The register marks item 14 as **Keep Local For Now** and names cheap JS/TS framework guards, target-bound source fallback in diff-gate echo, and source prefilters tied to specific output contracts. Source: `docs/plans/2026-06-30-structural-optimization-inventory.md:345-356`; freshness checked with `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`.
- `mayContainJsExclusion()` at `src/analysis/framework-patterns.ts:194-204` checks for suppression comments, test framework names, and React hook declarations before `getJsTestExclusions()` parses the AST at `src/analysis/framework-patterns.ts:101-192`. Source: `node dist/cli.js plan-context mayContainJsExclusion`; `node dist/cli.js code src/analysis/framework-patterns.ts:101-204`.
- `runEchoCheck()` at `src/queries/impact/diff-gate.ts:365-433` bounds echo detection to new changed callable symbols, skips symbols that existed at base, calls `similar()` with `sourceCandidateMode: 'target-pruned'`, and excludes files already in the diff. Source: `node dist/cli.js plan-context runEchoCheck`; `node dist/cli.js code src/queries/impact/diff-gate.ts:365-450`.
- `source-identifier-prefilter.ts:1-65` already owns the small reusable identifier prefilter. `createCandidateNameMatcher()` prepares candidate-name metadata, and `sourceMayContainCandidateName()` switches between direct includes, exact identifier regexes, and source identifier scanning based on candidate shape and count. Source: `node dist/cli.js plan-context createCandidateNameMatcher`; `node dist/cli.js code src/source/source-identifier-prefilter.ts:1-65`.
- `sourceMayContainCandidateName()` has two production consumers: `src/symbols/identifier-attribution.ts` and `src/symbols/references/source-reference-scan.ts`. Source: `node dist/cli.js refs sourceMayContainCandidateName --json`.

## Reuse Audit

- `similar mayContainJsExclusion --json` found only generic token overlap with `createCandidateNameMatcher()`; the JS guard's unique terms are framework/test/hook-specific. It should stay with framework exclusions.
- `similar runEchoCheck --json` found only broad query/source-token overlap with recent duplicates and source-shape similarity. The `sourceCandidateMode: 'target-pruned'` choice is tied to diff-gate's echo output contract.
- `similar sourceMayContainCandidateName --json` shows overlap with its own matcher and general set math, but that code is already factored as the reusable source prefilter. There is no broader text-guard abstraction to add.
- `files '*prefilter*' --json` found only `src/source/source-identifier-prefilter.ts`, confirming there is one existing prefilter primitive rather than scattered duplicate modules.

## Design Phases

### 1.1 - Accept framework exclusion guards as local

- [x] **File**: `src/analysis/framework-patterns.ts:101-204`
- **Source**: `node dist/cli.js plan-context mayContainJsExclusion`; `node dist/cli.js similar mayContainJsExclusion --json`.
- **What**: The guard is only correct because the downstream AST scan is looking for suppression comments, top-level test framework calls, and React hook declarations.
- **Change**: Do not move `mayContainJsExclusion()` into a generic text-guard module.
- **Why**: Generalizing it would either leak framework policy into source utilities or weaken other analyzers by reusing a guard whose misses are only safe for this output contract.

### 1.2 - Accept diff-gate echo pruning as local

- [x] **File**: `src/queries/impact/diff-gate.ts:365-433`
- **Source**: `node dist/cli.js plan-context runEchoCheck`; `node dist/cli.js similar runEchoCheck --json`.
- **What**: Echo detection is bounded by changed symbols, base-symbol preexistence, changed-file membership, and target-pruned source similarity.
- **Change**: Do not extract a generic "target-pruned scan" policy from `runEchoCheck()`.
- **Why**: The pruning is safe because diff-gate is asking a narrow question: did this diff add a new callable that echoes existing code outside the diff?

### 1.3 - Keep the existing source identifier prefilter as the reuse boundary

- [x] **File**: `src/source/source-identifier-prefilter.ts:1-65`
- **Source**: `node dist/cli.js plan-context createCandidateNameMatcher`; `node dist/cli.js refs sourceMayContainCandidateName --json`; `node dist/cli.js similar sourceMayContainCandidateName --json`.
- **What**: The one reusable identifier prefilter already serves two source-reference consumers.
- **Change**: Make no code change. Future source-reference scans should reuse this module when their correctness depends on candidate-name presence, but detector-specific text shortcuts should remain local.
- **Why**: This preserves one small source-owned primitive without inventing a broad text-guard layer.

## Stress Test

- Understand before touching: these guards are correctness-preserving shortcuts only because the caller defines what false negatives are acceptable.
- Blast radius: `mayContainJsExclusion()` affects framework exclusions consumed by dead-code filtering; `runEchoCheck()` affects diff-gate findings and agent hook stop output; `sourceMayContainCandidateName()` affects source fallback caller/reference scans. Source: `node dist/cli.js plan-context mayContainJsExclusion`; `node dist/cli.js plan-context runEchoCheck`; `node dist/cli.js plan-context createCandidateNameMatcher`.
- Valid intermediate states: no code movement is required.
- Reversibility: the accepted-local decision can be revisited if another guard shares the same caller contract, not just the same string operations.
- Failure design: local guards keep their failure modes beside the analyzer that can explain missed or included findings.
- Concurrency and data integrity: no runtime or storage change.
- Boundaries: CLI and health outputs stay unchanged.
- Reuse: only the source identifier prefilter is shared; framework and diff-gate shortcuts stay local.

## Execution Order

1. Verify register freshness.
2. Map the three examples to current code owners.
3. Run similarity and consumer checks.
4. Accept as local with no production code change.
5. Run formatting and final gate for this plan document.

## Ship Order

Ship as an accepted-local register item. There is no code deployment risk.

## Verification Plan

- `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`
- `node dist/cli.js similar mayContainJsExclusion --json`
- `node dist/cli.js similar runEchoCheck --json`
- `node dist/cli.js similar sourceMayContainCandidateName --json`
- `node dist/cli.js refs sourceMayContainCandidateName --json`
- `node dist/cli.js reindex && node dist/cli.js diff-gate --json`

Verification result:

- Register doc drift check returned no findings.
- Framework guard similarity was only generic token overlap; no extraction target.
- Diff-gate echo similarity was broad query/source-token overlap; no reusable policy target.
- Source identifier prefilter already has two consumers and is the existing reuse boundary.

## Summary

No production code should change for this item. The implementation is an accepted-local plan: broad text-guard architecture is rejected, the existing source identifier prefilter remains the shared primitive, and framework/diff-gate shortcuts stay beside their output contracts.
