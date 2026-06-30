# Detector-Specific Policy Knobs Plan

Date: 2026-06-30

## Goal

The user wants every item in the structural optimization register handled in order without damaging the optimization work already done. A detector-specific policy knob is a cleanup-query decision point, visible here as drift pattern-deviation inclusion, recent-duplicate echo orientation, wrapper consumer pruning, and dead-code framework/test skips, whose defining job is to protect one detector's output contract from false positives. Done for this item means we either convert a repeated mechanism into architecture or explicitly accept it as local with evidence. The evidence supports keeping this item local.

## Current State

- The register marks item 13 as **Keep Local For Now** and lists `includePatternDeviations`, recent duplicate echo/twin orientation, wrapper-specific consumer pruning, and dead-code skip rules as examples. Source: `docs/plans/2026-06-30-structural-optimization-inventory.md:328-344`; freshness checked with `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`.
- `drift()` defines `includePatternDeviations` in its own option shape at `src/queries/cleanup/drift.ts:54-71`, defaults it to enabled, and uses it only to decide whether `patternDeviationDrift()` contributes to the drift summary. Source: `node dist/cli.js plan-context drift`; `node dist/cli.js trace includePatternDeviations --json`.
- `orientRecentDuplicate()` at `src/queries/cleanup/recent-duplicates.ts:385-429` uses git add age and the command's `windowCommits` policy to return either `twin`, `echo`, or no finding. Source: `node dist/cli.js plan-context orientRecentDuplicate`; `node dist/cli.js code src/queries/cleanup/recent-duplicates.ts:377-430`.
- `consumerMapForWrapperCandidates()` at `src/queries/cleanup/wrapper-candidates.ts:76-142` already consumes shared consumer evidence, then applies wrapper-only pruning: run semantic evidence only for low-fan-in candidates, find enclosing callers, and use source fallback only for wrappers whose external caller shape is ambiguous. Source: `node dist/cli.js plan-context consumerMapForWrapperCandidates`; `node dist/cli.js code src/queries/cleanup/wrapper-candidates.ts:76-142`.
- `dead()` at `src/queries/cleanup/dead.ts:93-217` owns dead-code options such as `includeTests`, `skipBarrels`, `deadCodeOnly`, and `semantic`; `buildFileExclusionPredicate()` at `src/queries/cleanup/dead-exclusions.ts:12-47` owns framework/test/generated exclusion rules that compensate for callers the SCIP graph cannot see. Source: `node dist/cli.js plan-context dead`; `node dist/cli.js code src/queries/cleanup/dead.ts:93-217`; `node dist/cli.js code src/queries/cleanup/dead-exclusions.ts:1-48`.

## Reuse Audit

- The reusable mechanism these paths need is already in place: wrapper candidates use `consumerEvidenceProduct()` and `consumerFileMapFromEvidence()` before local pruning. Source: `node dist/cli.js plan-context consumerMapForWrapperCandidates`.
- `similar orientRecentDuplicate --json` returned no similar functions. There is no cross-detector orientation helper to reuse.
- `similar buildFileExclusionPredicate --json` returned no similar functions. The framework exclusion predicate is detector-local.
- `similar consumerMapForWrapperCandidates --json` found `consumerMapForTypeCandidates()` and `symbolConsumerFiles()`, but the shared callees are the already-extracted consumer evidence product; the unique wrapper-specific callees are exactly the policy that should remain local. Source: `node dist/cli.js similar consumerMapForWrapperCandidates --json`.
- `similar dead --json` found only broad query option/source-token overlap with unrelated commands such as complexity hotspots, cleanup plan, and similar signatures. Source: `node dist/cli.js similar dead --json`.
- `recent-duplicates --json` currently returns no findings, so this item is not causing active health-score damage. Source: `node dist/cli.js recent-duplicates --json`.

## Design Phases

### 1.1 - Accept detector-specific policy as local

- [x] **File**: `src/queries/cleanup/drift.ts:54-71`, `src/queries/cleanup/recent-duplicates.ts:385-429`, `src/queries/cleanup/wrapper-candidates.ts:76-142`, `src/queries/cleanup/dead.ts:93-217`, `src/queries/cleanup/dead-exclusions.ts:12-47`
- **Source**: `node dist/cli.js plan-context drift`; `node dist/cli.js plan-context orientRecentDuplicate`; `node dist/cli.js plan-context consumerMapForWrapperCandidates`; `node dist/cli.js plan-context dead`.
- **What**: Each policy knob exists to preserve one detector's precision, action tier, or output orientation.
- **Change**: Do not extract a generic detector policy module. Record this as an accepted local item in this plan.
- **Why**: A shared abstraction would couple unrelated detector claims and make false-positive controls less legible.

### 1.2 - Keep the shared evidence layer as the reuse boundary

- [x] **File**: `src/queries/cleanup/wrapper-candidates.ts:82-113`
- **Source**: `node dist/cli.js code src/queries/cleanup/wrapper-candidates.ts:76-142`; `node dist/cli.js similar consumerMapForWrapperCandidates --json`.
- **What**: Wrapper detection already reuses `consumerEvidenceProduct()` and only keeps wrapper-specific candidate pruning locally.
- **Change**: Make no code change; keep future reuse pressure directed at evidence products rather than detector-specific threshold/policy logic.
- **Why**: The architectural optimization has already happened at the evidence boundary, which preserves detector autonomy.

## Stress Test

- Understand before touching: these knobs are not raw computation caches; they decide what a specific detector is allowed to claim.
- Blast radius: `wrapperCandidates()`, `dead()`, `drift()`, and `recentDuplicates()` feed health and CLI output. Moving their policy would affect user-facing findings. Source: `node dist/cli.js plan-context consumerMapForWrapperCandidates`; `node dist/cli.js plan-context dead`; `node dist/cli.js plan-context drift`; `node dist/cli.js plan-context orientRecentDuplicate`.
- Valid intermediate states: no code movement is required; the current state remains valid.
- Reversibility: accepted-local documentation is reversible by changing this plan if a future second detector needs the same policy.
- Failure design: keeping policy near the detector keeps error/false-positive reasoning with the output it protects.
- Concurrency and data integrity: no runtime or storage change.
- Boundaries: command-facing output contracts remain unchanged.
- Observability: existing profile spans remain where they are; no new hidden layer is introduced.
- Reuse: consumer evidence remains shared; detector thresholds stay local.

## Execution Order

1. Verify the register is not stale.
2. Verify each example's current owner and consumers.
3. Run reuse checks for each plausible extraction target.
4. Accept the item as local and make no code change.
5. Run the final project gate because this plan document changes the repo.

## Ship Order

Ship as an accepted-local register item. There is no code deployment risk.

## Verification Plan

- `node dist/cli.js doc-drift docs/plans/2026-06-30-structural-optimization-inventory.md --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js similar orientRecentDuplicate --json`
- `node dist/cli.js similar consumerMapForWrapperCandidates --json`
- `node dist/cli.js similar dead --json`
- `node dist/cli.js similar buildFileExclusionPredicate --json`
- `node dist/cli.js reindex && node dist/cli.js diff-gate --json`

Verification result:

- Register doc drift check returned no findings.
- Recent duplicates returned no findings.
- `orientRecentDuplicate()` and `buildFileExclusionPredicate()` had no similar-function matches.
- Wrapper similarity was limited to shared consumer-evidence calls; the unique wrapper callees are local false-positive control.
- Dead detector similarity was broad source-token overlap, not a reusable policy abstraction.

## Summary

No production code should change for this item. The implementation is an accepted-local plan: detector policy knobs stay beside the detectors whose claims they protect, while shared evidence gathering remains in the evidence product layer.
