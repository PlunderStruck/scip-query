# Diff-Gate Unused-Params File Scope Plan

Date: 2026-06-28

## Goal

Reduce Vega_2.0 `scip-query diff-gate --json` runtime without changing its
findings by making the unused-params diff-gate check load only changed-file
callables.

## Evidence

- `diffGate()` runs serial checks after computing diff impact. Source:
  `scip-query plan-context diffGate`.
- Skip probes on Vega_2.0 showed `unused-params-only` at 0.991s while full
  `diff-gate --json` was 2.082s with the existing 3,089-byte output hash.
- `runUnusedParamsCheck()` passes `files: changedFiles` into `unusedParams()`.
  Source: `scip-query code runUnusedParamsCheck -C 8`.
- `unusedParams()` accepted that file list but still called
  `productionCallableDefinitions()` across the full repo before filtering by
  file. Source: `scip-query plan-context unusedParams`.

## Design

- [x] Add an optional `files` input to `productionCallableDefinitions()` that
  starts from `getDefinitionsForFile()` for those files, while preserving the
  existing callable filters, rooted-symbol filters, test filters, suppression
  checks, and LOC filters.
- [x] Pass `opts.files` from `unusedParams()` into the callable loader and keep
  the TypeScript-family filter unchanged.
- [x] Add a focused test proving file-scoped callable loading and
  file-scoped unused-parameter reporting.
- [x] Verify Vega output hashes for full diff-gate, unused-params-only
  diff-gate, and public `unused-params --json --full`.

## Result

| Command | Before | After | Output |
| --- | ---: | ---: | --- |
| `diff-gate` unused-params-only probe | 0.991s | 0.356s-0.377s | Same 1,202-byte SHA-256 `e02b4859ace33f159476ebaeb8e67c377472d94bbc488ee69ccef0a93f028a41` |
| `diff-gate --json` | 2.082s | 1.976s-1.986s warm band | Same 3,089-byte SHA-256 `4b70b62e26f2398447decacbb0c51b4200b666b78534d2c4cf8ace33a5728cc6` |
| `unused-params --json --full` | 0.863s | 0.806s-0.835s | Same 135-byte SHA-256 `db71d3c18134a2a61734cf0673380426ab2f1999a7f45b6535724b68024880cb` |

## Verification

- `npx vitest run tests/queries/cleanup/unused-params.test.ts`
- `npm run typecheck`
- `npm run build`
- Vega focused timing/hash probes recorded in
  `docs/benchmarks/2026-06-28-diff-gate-ledger.md`.
