# Public Surface Caveats

Date: 2026-06-22

## Goal

Direct cleanup analyzers should not treat published package API as private code just because the current index has no consumers.

A package public surface is the set of files a JavaScript or TypeScript package declares as externally importable through `package.json` fields such as `exports`, `main`, `types`, and `bin`. Its referents are real files outside consumers may import even when no local file does. For cleanup analyzers, the essential maintenance fact is that local zero-consumer evidence is incomplete for those files.

Done means `redundant-reexports` emits a visible signal-tier caveat for package-public barrels, dead-code filtering has a regression for package-exported symbols, and the validation docs record the judgment.

## Current State

- `node dist/cli.js plan-context redundant-reexports --json` captured `src/queries/cleanup/redundant-reexports.ts` as the target analyzer context.
- `node dist/cli.js code 'src/queries/cleanup/redundant-reexports.ts:1-260' --json` shows rows currently expose `barrelFile`, symbol identity, original file, and consumer counts, but no action tier, surface evidence, or recommendation.
- `node dist/cli.js code 'src/analysis/package-surface.ts:1-180' --json` shows `derivePackageSurface()` already derives externally importable files from `package.json`.
- `node dist/cli.js code 'src/analysis/file-classifier.ts:123-158' --json` shows `isRootedSymbol()` already treats package-surface files as externally live.
- `node dist/cli.js code 'src/queries/cleanup/dead.ts:190-230' --json` shows dead-code output skips entry surfaces and rooted symbols, but the package-surface behavior needs a focused regression.

## Design

### 1. Add Surface Caveat Fields To Redundant Re-Exports

- [x] **File**: `src/queries/cleanup/redundant-reexports.ts`
- **Change**: Add `actionTier: 'direct' | 'signal'`, `surfaceEvidence: string[]`, and `recommendation` to `RedundantReexport`.
- **Rule**: A row is `signal` when the barrel file is on the package public surface; otherwise it remains `direct`.
- **Why**: A package-public barrel may have external consumers the local index cannot see.

### 2. Render The Caveat In CLI Output

- [x] **File**: `src/runtime/query-commands/cleanup/descriptors.ts`
- **Change**: Include tier, recommendation, and surface evidence in the grouped redundant-reexports text output.
- **Why**: Plain text should not imply direct removal when the row is package-public.

### 3. Pin Package-Surface Behavior In Tests

- [x] **File**: `tests/queries/cleanup/redundant-reexports-fallback.test.ts`
- **Change**: Add a fixture package manifest that exports a barrel and assert the row is `signal` with package-surface evidence.
- [x] **File**: `tests/queries/cleanup/dead-output.test.ts` and `tests/analysis/package-surface.test.ts`
- **Change**: Add a package-exported source file and assert dead-code output does not report its exported symbol.
- **Why**: The direct-cleanup caveat belongs to both the re-export analyzer and the dead-code deletion gate.

## Verification

- `npx vitest run tests/queries/cleanup/redundant-reexports-fallback.test.ts tests/queries/cleanup/dead-output.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`

## Result

Completed in `docs/validation/2026-06-22-public-surface-caveats-result.md`.
