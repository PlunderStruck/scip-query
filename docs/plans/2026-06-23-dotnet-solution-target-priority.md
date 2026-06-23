# .NET Solution Target Priority Plan - 2026-06-23

## Goal

Unity and other C# repositories that keep one solution file beside many generated project files need `scip-query reindex` to pass the solution to `scip-dotnet`, not the first alphabetically visible project file. Done means C# target resolution selects `.sln` before `.csproj`, preserving project-file fallback when no solution exists.

## Current State

- `src/reindex/indexers.ts:175-189` builds the C# `scip-dotnet` command as `scip-dotnet index <target> --output <outputPath> --working-directory <projectRoot>`, where `<target>` is `resolveDotnetProject(projectRoot, ['.sln', '.csproj']) ?? projectRoot`. Source: `scip-query code src/reindex/indexers.ts:160-230`.
- `src/reindex/indexers.ts:202-216` builds the VB command the same way with `['.sln', '.vbproj']`. Source: `scip-query code src/reindex/indexers.ts:160-230`.
- `src/reindex/indexers.ts:274-289` currently iterates directory entries first and checks whether any suffix matches, so filesystem entry order decides whether a solution or a generated project wins. Source: `scip-query code resolveDotnetProject -C 12`.
- `resolveDotnetProject()` is private to `src/reindex/indexers.ts` and referenced only by the C# and VB indexer configs. Source: `scip-query trace resolveDotnetProject`.

## Reuse Audit

- `scip-query similar resolveDotnetProject` found no similar symbols.
- `scip-query similar-files src/reindex/indexers.ts` found no similar file pairs.
- `scip-query recent-duplicates` found no recent re-implementations.
- Existing indexer command-shape tests live in `tests/reindex/reindex-indexers.test.ts`; use that file for the regression.

## Design

### 1. Prefer suffix priority over directory order

- [ ] **File**: `src/reindex/indexers.ts:274-289`
- **Source**: `scip-query code resolveDotnetProject -C 12`
- **What**: The resolver scans entries once and returns the first entry whose name ends in any suffix.
- **Change**: Iterate suffixes first and entries second. For `['.sln', '.csproj']`, check every entry for `.sln` before checking any entry for `.csproj`.
- **Why**: The caller already supplies priority order; the helper should preserve that priority instead of letting filesystem order decide.

### 2. Add the Unity-root regression test

- [ ] **File**: `tests/reindex/reindex-indexers.test.ts`
- **Source**: `sed -n '1,260p' tests/reindex/reindex-indexers.test.ts`
- **What**: Tests cover several indexer command shapes and VB project fallback, but not C# solution priority when generated project files coexist with a solution.
- **Change**: Create a temp project with `Assembly-CSharp-Editor.csproj`, another `.csproj`, and `Birds.sln`; assert `getIndexerConfig('csharp').indexArgs(...).args[1]` is `Birds.sln`.
- **Why**: This locks the Unity failure mode directly.

## Verification

- `npm test -- tests/reindex/reindex-indexers.test.ts`
- `npm run typecheck`
- `scip-query reindex`
- `scip-query diff-gate --json`
