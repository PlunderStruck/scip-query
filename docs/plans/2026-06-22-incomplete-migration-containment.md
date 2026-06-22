# Incomplete Migration Containment Plan

Date: 2026-06-22

## Goal

`incomplete-migration` should keep catching half-finished extractions while rejecting broad old sites that merely contain a tiny fragment of the new helper. Semantic containment is a comparison between a new helper's meaningful callees and an old site's meaningful callees; it is useful only when it shows both that the old site contains the helper pattern and that the helper pattern is a material part of the old site. Helper shape is the call-pattern evidence that says whether a new helper is focused enough to score from callee overlap. Done means findings expose two-sided containment evidence, diff-gate explains it, and a regression proves broad orchestration sites do not become leftover migration sites.

## Current State

- `src/queries/impact/incomplete-migration.ts:9-16` defines `IncompleteMigrationLeftover` with `containment` and `sharedCallees` only. Source: `node dist/cli.js code 'src/queries/impact/incomplete-migration.ts:1-280' --json`.
- `src/queries/impact/incomplete-migration.ts:78-176` finds new callables in changed files, builds helper callee fingerprints, checks references, and calls `collectLeftoversForHelper()` with only helper-callee containment. Source: `node dist/cli.js code incompleteMigration --json`.
- `src/queries/impact/incomplete-migration.ts:201-234` collects leftovers when `containment(helperCallees, candidate.callees)` is above `minContainment`, at least one shared callee is non-ubiquitous, and the candidate is untouched and not already migrated. Source: `node dist/cli.js code collectLeftoversForHelper --json`.
- `src/queries/cleanup/similar.ts:333-379` supplies meaningful callee fingerprints from `ProjectIndex.productionCallableDefinitions()` and `ProjectIndex.calleeMap()`, so this slice should reuse that evidence rather than adding a source parser. Source: `node dist/cli.js code getAllCalleeFingerprints --json`; `node dist/cli.js code buildCalleeFingerprints --json`.
- `src/queries/impact/diff-gate.ts:438-482` turns incomplete-migration rows into gate findings, using the strongest leftover containment as confidence and text that says old sites still contain the helper pattern. Source: `node dist/cli.js code runIncompleteMigrationCheck --json`.
- `src/runtime/query-commands/impact.ts:103-141` renders helper findings and leftover rows from the existing fields. Source: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:90-145' --json`.

## Reuse Audit

- `containment()` is already the project-level set containment helper; reuse it for both directions instead of introducing a second similarity metric. Source: `node dist/cli.js code collectLeftoversForHelper --json`.
- `meaningfulCallees()` and `getAllCalleeFingerprints()` already define the callee universe used by similarity-style analyzers. Source: `node dist/cli.js code getAllCalleeFingerprints --json`.
- `node dist/cli.js similar collectLeftoversForHelper --json` found low-score structural-overlap rows, not an existing two-sided containment implementation.

## Design

### 1.1 - Add two-sided leftover evidence

- [x] **File**: `src/queries/impact/incomplete-migration.ts:9-16`
- **Source**: `node dist/cli.js code 'src/queries/impact/incomplete-migration.ts:1-280' --json`
- **What**: A leftover reports only helper-containment, so a huge old function that happens to contain the helper call set can look equivalent.
- **Change**: Add `siteCoverage` and `uniqueSiteCalleeCount` to `IncompleteMigrationLeftover`. Keep `containment` as the compatibility field for helper containment.
- **Why**: Reviewers and diff-gate can see whether the helper pattern is most of the old site or only a small embedded fragment.

### 1.2 - Gate leftovers by site coverage

- [x] **File**: `src/queries/impact/incomplete-migration.ts:78-176` and `src/queries/impact/incomplete-migration.ts:201-234`
- **Source**: `node dist/cli.js code incompleteMigration --json`; `node dist/cli.js code collectLeftoversForHelper --json`
- **What**: `collectLeftoversForHelper()` admits a candidate from `containment(helperCallees, candidate.callees)` alone.
- **Change**: Add `minSiteCoverage` to `incompleteMigration()` options with a conservative default of `0.4`. In `collectLeftoversForHelper()`, compute `siteCoverage = shared.size / candidate.callees.size`, skip candidates below the threshold, and record unique site callee count for accepted leftovers.
- **Why**: This keeps the original asymmetric extraction detection but rejects broad orchestration sites where the helper is not a meaningful share of the old callable.

### 1.3 - Add helper-shape evidence

- [x] **File**: `src/queries/impact/incomplete-migration.ts:18-26` and `src/queries/impact/incomplete-migration.ts:78-176`
- **Source**: `node dist/cli.js code incompleteMigration --json`
- **What**: Findings do not expose how many helper callees are specific versus project-wide infrastructure.
- **Change**: Add `helperCalleeCount`, `specificHelperCalleeCount`, and `helperShape` to `IncompleteMigrationFinding`. Mark helpers with at least one non-ubiquitous callee as `specific-callee-cluster`; otherwise skip them with an explicit reason.
- **Why**: The detector should explain that the helper had a focused enough shape to score, not just that it had enough calls.

### 2.1 - Render the new evidence

- [x] **File**: `src/queries/impact/diff-gate.ts:438-482`
- **Source**: `node dist/cli.js code runIncompleteMigrationCheck --json`
- **What**: Diff-gate says sites contain the helper pattern but not how much of the site is that pattern.
- **Change**: Include helper/site containment details in the sites string and add a why line for helper shape.
- **Why**: Reviewers can tell direct incomplete migration from a weak embedded-fragment signal.

### 2.2 - Update CLI output

- [x] **File**: `src/runtime/query-commands/impact.ts:103-141`
- **Source**: `node dist/cli.js code 'src/runtime/query-commands/impact.ts:90-145' --json`
- **What**: CLI text prints leftover containment and shared calls only.
- **Change**: Print helper shape and site coverage for each leftover.
- **Why**: The standalone command should show the same judgment basis as diff-gate.

### 2.3 - Add regression coverage

- [x] **File**: `tests/queries/impact/incomplete-migration.test.ts`
- **Source**: Production behavior anchored by `node dist/cli.js code incompleteMigration --json` and `node dist/cli.js code collectLeftoversForHelper --json`; the test file itself is not indexed by scip-query.
- **What**: The existing fixture proves `site-b` and `site-c` are leftovers, but it does not prove a broad site that contains the same helper calls is rejected.
- **Change**: Add a broad unchanged `site-f` fixture with the helper calls plus many extra callees, assert it is not reported, and assert accepted leftovers carry `siteCoverage` and helper-shape metadata.
- **Why**: This protects the precision fix against regressing to one-sided containment.

## Stress Test

- Understand before touching: the detector is intentionally asymmetric because old sites can contain the extracted helper plus surrounding logic. The new coverage gate should narrow broad false positives without requiring symmetric equality.
- Blast radius: `incompleteMigration()` feeds the query index, CLI, and diff-gate. Additive fields keep existing consumers compatible.
- Intermediate validity: Add fields and defaults first, then renderer/tests. Existing `containment` stays in place.
- Reversibility: This is an internal threshold and metadata change; rollback removes `minSiteCoverage` and new output fields.
- Failure design: Empty git history, no changed files, no helper refs, and tiny helpers keep current skip behavior.
- Concurrency: No shared mutable state; only local sets and arrays.
- Boundaries: CLI input remains unchanged unless callers explicitly pass the new option.
- Data integrity: No persisted schema or config change.
- Observability: Findings will show helper containment, site coverage, unique site calls, and helper shape.
- Human impact: Agents should stop treating a broad old function as an unfinished migration when the helper is only a small fragment.
- Reuse: Reuse `containment()`, `meaningfulCallees()`, and the existing candidate index.

## Execution Order

1. Add leftover and finding metadata fields plus `minSiteCoverage`.
2. Apply the site-coverage gate in `collectLeftoversForHelper()`.
3. Add helper-shape evidence and skip reason.
4. Update diff-gate and CLI text.
5. Extend the existing fixture and assertions.
6. Update validation docs and run focused tests, typecheck, build, analyzer post-checks, full tests, reindex, and diff-gate.

## Ship Order

This is one backward-compatible precision slice. It tightens which leftover sites qualify but preserves the core incomplete-migration contract and existing `containment` field.
