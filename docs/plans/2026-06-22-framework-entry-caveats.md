# Framework Entry Caveats

Date: 2026-06-22

## Goal

Framework-discovered entrypoints should not be reported as dead or newly-dead just because no indexed file imports them.

A framework-discovered entrypoint is a source-level export whose real caller is a framework runtime or build step that finds it from a conventional file path and export name. Its referents are route handlers such as `GET` in a Next.js `app/**/route.ts` file, data loaders such as `loader` in a Remix route file, and page exports such as a default export in a framework page file. The essential maintenance fact is that local reference counts cannot see the caller, but ordinary helpers in the same file still can be locally dead.

Done means framework handler exports are treated as rooted symbols, ordinary helper symbols in the same file still appear in direct dead-code output, and the validation docs record the closed caveat.

## Current State

- `node dist/cli.js plan-context src/analysis/file-classifier.ts` shows `src/analysis/file-classifier.ts` defines `isRootedSymbol()` at lines 139-158 and is consumed by dead, cleanup-plan, stale-abstractions, health, and diff-gate checks.
- `node dist/cli.js code 'src/analysis/file-classifier.ts:129-158' --json` shows `isEntrySurface()` currently covers structural entry files, workers, and live barrels, while `isRootedSymbol()` covers package surface and explicit `entryRoots`.
- `node dist/cli.js code 'src/queries/cleanup/dead.ts:190-230' --json` shows dead-code output skips entry-surface files and rooted symbols after reference counting.
- `node dist/cli.js plan-context src/analysis/framework-patterns.ts` and `node dist/cli.js code 'src/analysis/framework-patterns.ts:63-120' --json` show an older TS/JS framework exclusion that marks Next/Remix/Vite route-like files as whole-file dead-code exclusions before `isRootedSymbol()` can make a symbol-level decision.
- `node dist/cli.js code 'src/queries/impact/diff-gate.ts:840-875' --json` shows the new-dead diff gate also skips entry-surface and rooted symbols.
- `node dist/cli.js code 'leafName' --json` shows `leafName()` parses a SCIP symbol into its final descriptor name, avoiding substring-only handler matching.
- `node dist/cli.js recent-duplicates --json` returned no findings; `node dist/cli.js similar isStructuralEntryPath --json` found only low-signal structural overlap with existing path-pattern helpers.

## Design

### 1. Add Framework-Discovered Rooted Symbol Policy

- [x] **File**: `src/analysis/file-classifier.ts`
- **Source**: `node dist/cli.js code 'src/analysis/file-classifier.ts:129-158' --json`; `node dist/cli.js code 'leafName' --json`.
- **Change**: Import `leafName()` and add a private helper that recognizes framework-discovered handler exports by pairing the normalized file path with the parsed symbol leaf.
- **Initial conventions**: Next.js app route HTTP methods, Next.js app/page file default and metadata exports, Next.js pages exports, Remix route exports, and SvelteKit `+page` / `+layout` / `+server` exports for TypeScript/JavaScript files.
- **Target behavior**: `isRootedSymbol()` returns true for conventional framework handler exports before consulting explicit `entryRoots`.

### 2. Narrow The Older Framework Exclusion

- [x] **File**: `src/analysis/framework-patterns.ts`
- **Source**: `node dist/cli.js plan-context src/analysis/framework-patterns.ts`; `node dist/cli.js refs getDefinitionExclusions --json`.
- **Change**: Remove the whole-file Next/Remix/Vite route exclusion from `getJsTestExclusions()`.
- **Why**: `getDefinitionExclusions()` feeds `deadCandidateDecision()` before dead summary filtering. A whole-file exclusion prevents ordinary helpers in route modules from ever reaching the direct cleanup analyzer.

### 3. Keep Same-File Helpers Directly Reviewable

- [x] **File**: `src/analysis/file-classifier.ts`
- **Source**: `node dist/cli.js refs isRootedSymbol --json`; `node dist/cli.js refs isEntrySurface --json`.
- **Change**: Do not classify framework route files as whole-file entry surfaces. Only the conventional export names become rooted symbols.
- **Why**: `isEntrySurface()` is consumed by dead, cleanup-plan, health, and diff-gate as a whole-file skip, which would hide ordinary unused helpers in a route module.

### 4. Pin Dead-Code Behavior

- [x] **File**: `tests/queries/cleanup/dead-output.test.ts`
- **Source**: `node dist/cli.js code 'src/queries/cleanup/dead.ts:190-230' --json`.
- **Change**: Extend the fixture with a Next.js app route file containing exported `GET()` and exported `unusedRouteHelper()`.
- **Assertions**: `GET` is not reported, `unusedRouteHelper` is reported, and the existing package-public API exclusion still holds.

### 5. Record The Closed Caveat

- [x] **Files**: `docs/validation/2026-06-22-framework-entry-caveats-result.md`, `docs/analyzer-validation-ledger.md`, `docs/validation/2026-06-21-analyzer-calibration-memo.md`, `docs/validation/2026-06-21-output-schema-quality-finalization-result.md`, `docs/analyzer-validation-protocol.md`, `docs/analyzer-inventory.md`
- **Source**: current validation docs and the completed verification commands from this slice.
- **Change**: Record the verdict, note that package/export caveats and framework-discovered entrypoint caveats are now separate closed public-surface precision slices, and advance the next candidate.

## Verification

- `npx vitest run tests/queries/cleanup/dead-output.test.ts`
- `npx prettier --check src/analysis/file-classifier.ts tests/queries/cleanup/dead-output.test.ts docs/plans/2026-06-22-framework-entry-caveats.md`
- `npm run typecheck`
- `npm run build`
- `node dist/cli.js similar isFrameworkDiscoveredEntrypointSymbol --json`
- `node dist/cli.js recent-duplicates --json`
- `node dist/cli.js unused-params --json`
- `node dist/cli.js dead --only-dead --json`
- `node dist/cli.js health --json`
- `npm test`
- `node dist/cli.js reindex`
- `node dist/cli.js diff-gate --json`
