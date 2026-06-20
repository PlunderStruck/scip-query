# Test Directory Organization - 2026-06-20

## Goal

Reduce the flat `tests/` root by grouping test files around the production subsystem they protect, without changing test behavior or published package behavior.

## Current State

- `vitest.config.ts` discovers nested tests with `include: ['tests/**/*.test.ts']`; moving test files into subdirectories preserves test discovery. Source: filesystem read of `vitest.config.ts`.
- `tsconfig.json` excludes `tests`, so test moves do not alter package declaration output. Source: filesystem read of `tsconfig.json`.
- Tests are not indexed as SCIP documents in this repository, so test-file inventories and import rewrites are filesystem-backed; source-side risk was checked with `node dist/cli.js plan-context src/runtime/cli.ts` and `node dist/cli.js plan-context src/queries/impact/diff-gate.ts`.

## Plan

- [ ] Move shared fixture/helper modules into `tests/fixtures/`.
- [ ] Move runtime and CLI tests into `tests/runtime/`.
- [ ] Move reindex tests into `tests/reindex/`.
- [ ] Move query tests into `tests/queries/<family>/`.
- [ ] Move source, symbol, storage, analysis, resolution, and semantic tests into matching folders.
- [ ] Mechanically rewrite relative imports from moved files.
- [ ] Verify with typecheck, full tests, build, reindex, diff-gate, recent-duplicates, and `git diff --check`.
