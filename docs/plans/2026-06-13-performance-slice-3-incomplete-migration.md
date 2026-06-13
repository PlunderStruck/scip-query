# Performance Slice 3 Plan: Incomplete Migration Reuse and Candidate Index

Date: 2026-06-13

This plan covers feedback items 6 and 7 from `docs/plans/2026-06-13-performance-feedback.md`: reuse the diff plan in `incomplete-migration`, and avoid scoring candidate fingerprints that share no helper callees.

## Goal

Reduce repeated Git/DB work inside `diff-gate` and reduce the detector's candidate comparison count without changing findings. The existing detector only reports candidates whose callee set contains enough of the helper's callee set; a candidate with zero shared helper callees cannot pass that containment test.

## Current Flow

- Source: `scip-query code diffGate -C 10`
  - `diffGate()` computes `const impact = diffImpact(db, { base })` at `src/queries/diff-gate.ts:120`.
  - It derives `changedFiles` and `changed` from that impact at `src/queries/diff-gate.ts:121-122`.
  - It calls `runIncompleteMigrationCheck(db, base, maxHelpers, result)` at `src/queries/diff-gate.ts:143`.

- Source: `scip-query code 'src/queries/diff-gate.ts:228-273'`
  - `runIncompleteMigrationCheck()` calls `incompleteMigration(db, { base, maxHelpers })` at `src/queries/diff-gate.ts:234`.

- Source: `scip-query code incompleteMigration -C 10`
  - `incompleteMigration()` recomputes `diffImpactPlan(db, { base })` at `src/queries/incomplete-migration.ts:92`.
  - It builds `changed` from `plan.changedFiles` at `src/queries/incomplete-migration.ts:103-104`.
  - It builds all candidate fingerprints with `getAllCalleeFingerprints()` at `src/queries/incomplete-migration.ts:113`.
  - It compares every helper fingerprint against every candidate at `src/queries/incomplete-migration.ts:146-162`.

- Source: `scip-query trace diffImpactPlan`
  - `diffImpactPlan()` is already exported from `src/queries/diff-impact.ts:77-102` and referenced by `diffImpact()`, `incompleteMigration()`, query exports, CLI batch handling, and isolated diff-impact reporting.

- Source: `scip-query trace getAllCalleeFingerprints`
  - `getAllCalleeFingerprints()` is exported from `src/queries/similar.ts:283-299` and referenced by `similar`, `similarAll`, and `incompleteMigration()`.

## Plan

1. Allow callers to supply an existing diff plan to `diffImpact()`.
   - Source: `scip-query trace diffImpactPlan`
   - Extend `diffImpact(db, opts)` in `src/queries/diff-impact.ts` so `opts` can include `plan?: DiffImpactPlan`.
   - Use the supplied plan instead of recomputing `diffImpactPlan(db, opts)`.
   - Preserve current behavior when no plan is supplied.

2. Allow callers to supply an existing diff plan to `incompleteMigration()`.
   - Source: `scip-query code incompleteMigration -C 10`
   - Extend `incompleteMigration()` options in `src/queries/incomplete-migration.ts:72-81` with `diffPlan?: DiffImpactPlan`.
   - Replace the unconditional `diffImpactPlan(db, { base })` call at `src/queries/incomplete-migration.ts:92` with `opts.diffPlan ?? diffImpactPlan(db, { base })`.
   - Preserve `base` in the result because `fileContentAtBase()` still needs the requested base ref for new-helper detection.

3. Reuse one diff plan inside `diffGate()`.
   - Source: `scip-query code diffGate -C 10`
   - In `src/queries/diff-gate.ts:120-143`, compute `const impactPlan = diffImpactPlan(db, { base })`, pass it to `diffImpact(db, { base, plan: impactPlan })`, and pass it through `runIncompleteMigrationCheck()`.
   - Source: `scip-query code 'src/queries/diff-gate.ts:228-273'`
   - Update `runIncompleteMigrationCheck()` to accept `diffPlan: DiffImpactPlan` and call `incompleteMigration(db, { base, maxHelpers, diffPlan })`.

4. Add an inverted candidate index in `incompleteMigration()`.
   - Source: `scip-query code incompleteMigration -C 10`
   - After `docFreq` is built at `src/queries/incomplete-migration.ts:121-123`, build `candidatesByCallee: Map<string, SymbolFingerprint[]>` from each candidate's meaningful callee set.
   - In the helper loop at `src/queries/incomplete-migration.ts:146-162`, replace the full `for (const candidate of candidates)` scan with a deduped candidate list collected from the helper's callees.
   - Keep all existing filters unchanged: skip the helper itself, skip changed files, skip already-migrated candidates, compute containment, require a non-ubiquitous shared callee, then sort leftovers.

5. Tests and verification.
   - Source: `scip-query plan-context incompleteMigration`
   - `incompleteMigration()` has downstream impact through `runIncompleteMigrationCheck()` and then `diffGate()`.
   - Add a focused test that supplies a precomputed diff plan to `incompleteMigration()` and expects the same finding shape as the default path.
   - Keep existing `diff-gate` incomplete-migration tests running to prove the reused plan still surfaces findings.
   - Run `npm test -- tests/incomplete-migration.test.ts tests/cli-contract.test.ts`, `npm run typecheck`, `npm run build`, `node dist/cli.js reindex`, and `node dist/cli.js diff-gate --json`.

## Co-Change Partners

- Source: `scip-query plan-context incompleteMigration`
  - History reports co-change with `docs/COMMAND_REFERENCE.md`, `package.json`, `src/queries/diff-gate.ts`, `src/queries/diff-impact.ts`, and `src/queries/index.ts`.
  - This slice intentionally updates `src/queries/diff-gate.ts` and `src/queries/diff-impact.ts` because the diff plan must be shared across those boundaries.
  - `src/queries/index.ts` does not need a change because it already exports the query modules; no new top-level query is added.
  - `docs/COMMAND_REFERENCE.md` and `package.json` do not need changes because there is no user-facing CLI option or dependency change.

## Accuracy Boundary

Plan reuse is accuracy-preserving because the supplied `DiffImpactPlan` is produced by the same `diffImpactPlan()` function for the same base ref. The inverted candidate index is accuracy-preserving because candidates with zero shared helper callees produce `containment(callees, candidate.callees) === 0` and cannot reach the existing `minContainment` threshold.
