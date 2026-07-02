# De-Bloat Report: scip-query (Re-Audit)

**Date:** 2026-04-10
**Health Score:** 83/100
**Scope:** whole repository (`63 files | 1704 symbols | 1.0 MB`)

## Summary

- Total high-signal issues: 3
- Estimated recoverable LOC: `0` high-confidence deletion wins; about `58 LOC` only if you intentionally collapse low-value public or same-file-only type abstractions
- Safe deletions: none confirmed after verification
- Largest risk: test reach is only `4%`
- Structural posture: no cycles, no wrapper clutter, no passthrough clutter, no same-logic duplication, no extraction candidates

## Priority 1: The Queries Barrel Is a Real Coupling Hub and It Pollutes Dead-Code Signal

**Commands**

- `scip-query bottlenecks -n 10`
- `scip-query dead --min-loc 5 --skip-barrels`
- `scip-query redundant-reexports`
- `scip-query code 'src/cli.ts:1-140'`
- `scip-query code 'src/queries/index.ts:1-46'`

**Findings**

- `scip-query bottlenecks -n 10` ranks `src:queries:index` as the top pressure point with `score 200`, `fan-in 2`, `fan-out 100`.
- `scip-query code 'src/cli.ts:1-140'` shows the CLI imports `* as queries` from `./queries/index.js` at line 9.
- `scip-query code 'src/queries/index.ts:1-46'` shows that file is a barrel: one module that re-exports almost every query surface.
- Because the CLI routes usage through that barrel, `scip-query dead --min-loc 5 --skip-barrels` reports `81 dead-code symbols` and `8833 LOC`, and `scip-query redundant-reexports` reports `30` redundant re-exports. In this repo, most of that is not safe deletion signal; it is barrel-only usage being hidden behind one import edge.

**Action**

- Either replace the CLI's barrel import with direct imports or teach the dead-code and redundant-reexport analyses to treat `src/queries/index.ts` as an entry surface.
- That change would make future de-bloat audits much sharper and reduce one large hub in the dependency graph.

**Impact / Risk / Effort**

- Impact: medium
- Risk: low
- Effort: medium

## Priority 2: Test Reach Is Too Low To Make Aggressive Cleanup Safe

**Commands**

- `scip-query test-coverage`
- `scip-query complexity-hotspots -n 10`

**Findings**

- `scip-query test-coverage` reports `4%` coverage: `7` covered symbols and `177` uncovered.
- `scip-query complexity-hotspots -n 10` identifies the riskiest places to change without tests:
  - `src:types` (`652 LOC`, score `146.1`)
  - `src:symbol-parser` (`279 LOC`, score `37.9`)
  - `src:query-support` (`227 LOC`, score `29.2`)
  - `src:db` (`128 LOC`, score `24.6`)
  - `src:queries:health` (`325 LOC`, score `8.1`)

**Action**

- Add focused tests around the database layer, symbol parsing, query helpers, and the health report before attempting large refactors.
- From a code-health perspective, this is the biggest real issue in the repo.

**Impact / Risk / Effort**

- Impact: high
- Risk: high if deferred while refactoring
- Effort: high

## Priority 3: Setup Owns a One-Off Install Dependency

**Commands**

- `scip-query drift`
- `scip-query code 'src/setup.ts:1-180'`

**Findings**

- `scip-query drift` reports one pattern deviation:
  - `src/setup.ts` is the only file in `src/` that depends on `src/reindex/install.ts`
- `scip-query code 'src/setup.ts:1-180'` shows that import at line 10: `tryInstallScipCli` comes from `./reindex/install.js`

**Action**

- Decide whether install behavior belongs to setup, reindex, or a small shared install module.
- If the current ownership is intentional, document it. If not, extract a narrower shared install service.

**Impact / Risk / Effort**

- Impact: low
- Risk: low
- Effort: low

## Verified Non-Issues and False Positives

**Commands**

- `scip-query dead --min-loc 5`
- `scip-query isolated --min-loc 3`
- `scip-query stale-abstractions --min-loc 3`
- `scip-query code 'src/queries/slice.ts:1-170'`
- `scip-query code 'src/reindex-worker.ts:1-80'`
- `scip-query code 'src/watch.ts:220-240'`
- `scip-query code 'src/reindex/index.ts:1-80'`
- `scip-query code 'src/types.ts:528-575'`

**Findings**

- `scip-query dead --min-loc 5` mostly finds `file-internal only` helpers, not leaked public surface. For example, `backwardSlice()` and `forwardSlice()` in `src/queries/slice.ts` are only called by the exported `slice()` entry point in the same file, which is normal structure rather than bloat.
- `scip-query isolated --min-loc 3` flags `src/cli.ts`, `src/index.ts`, `src/postinstall.ts`, and `src/reindex-worker.ts`, but these are runtime entry surfaces.
- `scip-query code 'src/reindex-worker.ts:1-80'` and `scip-query code 'src/watch.ts:220-240'` show why the worker looks isolated: it is launched by `fork(new URL('./reindex-worker.js', import.meta.url).pathname, ...)`, a runtime path the reference graph cannot follow.
- `scip-query stale-abstractions --min-loc 3` reports `ReindexOptions` and `InstallMethod`, but `scip-query code 'src/reindex/index.ts:1-80'` and `scip-query code 'src/types.ts:528-575'` show these are public or contract types, not clear delete wins.

**Conclusion**

- After verification, I do not recommend any immediate safe deletions from this run.

## Structural Metrics

- `scip-query cycles`: `0` circular dependencies
- `scip-query deep-chains --min-depth 5`: max observed depth `6`
- `scip-query similar --min-similarity 0.5 --min-callees 3`: no similar logic pairs
- `scip-query similar-chains --min-similarity 0.5`: no similar end-to-end chains
- `scip-query extract-candidates --min-loc 15 --min-callees 5`: no extraction candidates
- `scip-query wrapper-candidates --max-loc 15`: no wrapper candidates
- `scip-query passthrough-candidates --max-loc 15`: no passthrough candidates
- `scip-query similar-signatures --min-loc 5`: no same-shape groups
- `scip-query doc-coverage --min-loc 5`: `100%` documentation coverage

## Note On Tooling Drift

**Command**

- `scip-query drift --help`

**Finding**

- The current CLI exposes `scip-query drift [module]` but does not accept the `--min-deviation` flag used in the de-bloat skill sheet. The repo and the audit instructions are slightly out of sync here.

**Action**

- Update the skill/docs or restore the flag so the advertised workflow matches the shipped interface.
