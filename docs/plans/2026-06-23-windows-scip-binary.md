# Windows SCIP Binary Plan - 2026-06-23

## Goal

Windows users installing `scip-query` need `scip-query reindex` to work without Go, WSL, or a manually installed upstream `scip`. The missing unit is the SCIP converter CLI: a command-line executable that turns language indexers' `.scip` protobuf output into the SQLite database `scip-query` reads. Done means a Windows npm install can include a managed `scip.exe`, `reindex` resolves that executable, and conversion shells out to that concrete path.

## Current State

- `reindex()` calls `ensureScipCliAvailable()` before fresh indexing, so a missing converter stops the whole workflow before language indexers run. Source: `scip-query code src/reindex/index.ts:118-169`.
- `ensureScipCliAvailable()` only checks PATH with `isBinaryAvailable('scip')`; on failure it calls `tryInstallScipCli()` and throws if that returns false. Source: `scip-query code ensureScipCliAvailable -C 8`.
- SQLite conversion shells out to the literal command name `scip` at `src/reindex/index.ts:570`, so even a package-managed executable would not be used today. Source: `scip-query code convertScipToSqlite -C 8`.
- `tryInstallScipCli()` only tries Homebrew on macOS and `go install` when Go exists. Source: `scip-query code tryInstallScipCli -C 8`.
- `postinstall()` uses the same `isScipInstalled()` / `tryInstallScipCli()` helpers, so fixing the shared helper fixes first install and later reindex. Source: `scip-query code postinstall -C 10`.
- `package.json` currently publishes `dist`, docs, and skills, but no binary payload path. Source: `sed -n '1,260p' package.json`.
- Upstream `scip-code/scip` v0.8.1 publishes only darwin/linux release assets, while a source checkout cross-compiles `GOOS=windows GOARCH=amd64|arm64 go build ./cmd/scip` successfully. Source: GitHub API query for `https://api.github.com/repos/scip-code/scip/releases/tags/v0.8.1`; local build probes.

## Reuse Audit

- `scip-query similar-files src/runtime/scip-cli.ts` found no similar files, so there is no existing managed-binary resolver to reuse.
- `scip-query similar tryInstallScipCli` found only status/probe-adjacent candidates: `ensureScipCliAvailable()`, `tryInstallIndexer()`, and `resolveIndexerBinary()`. Reuse the existing status-callback style and `isBinaryAvailable()` helper, but keep `scip` converter resolution in `src/runtime/scip-cli.ts`.
- `scip-query recent-duplicates` found no recent re-implementations.
- Existing tests in `tests/runtime/scip-cli.test.ts` already mock `node:os` and `execFileSync`; extend that harness instead of adding a new test fixture system. Source: `sed -n '1,260p' tests/runtime/scip-cli.test.ts`.

## Design Phases

### 1. Resolve a Managed SCIP Binary

- [ ] **File**: `src/runtime/scip-cli.ts:1-145`
- **Source**: `scip-query plan-context src/runtime/scip-cli.ts`; `scip-query trace tryInstallScipCli`; `scip-query trace getScipVersion`.
- **What**: The module can check PATH and print an upstream download URL, but it cannot resolve a package-managed binary and it prints a nonexistent Windows release URL shape.
- **Change**: Add `resolveScipBinary()` that returns PATH `scip` first, then a packaged Windows binary at `vendor/scip/win32-x64/scip.exe` or `vendor/scip/win32-arm64/scip.exe`. Use a package-root search from `import.meta.url` so the same code works from `src` in tests and bundled `dist` chunks after build.
- **Why**: A packaged binary only helps if every helper uses the same concrete executable path.

### 2. Use the Resolved Binary During Reindex

- [ ] **File**: `src/reindex/index.ts:15-16`, `src/reindex/index.ts:386-405`, `src/reindex/index.ts:551-578`
- **Source**: `scip-query code ensureScipCliAvailable -C 8`; `scip-query code convertScipToSqlite -C 8`; `scip-query affected tryInstallScipCli`.
- **What**: `ensureScipCliAvailable()` and `convertScipToSqlite()` only understand PATH `scip`.
- **Change**: Import `resolveScipBinary()`, have `ensureScipCliAvailable()` accept the managed binary, and have `convertScipToSqlite()` execute the resolved path instead of the literal `scip` command.
- **Why**: This closes the exact failure point reported by the Windows tester.

### 3. Add a Publish-Time Binary Builder

- [ ] **File**: `package.json:1-320`; new `scripts/build-scip-windows.mjs`
- **Source**: `sed -n '260,520p' package.json`; local `GOOS=windows GOARCH=amd64|arm64 go build` probes.
- **What**: The package has no binary asset path and no release script that creates Windows `scip.exe`.
- **Change**: Add `vendor/scip/**/*` and `scripts/build-scip-windows.mjs` to `files`, add `build:scip-windows`, and include it in `prepublishOnly` after `npm run build`. The script clones `scip-code/scip` at the pinned version, copies the upstream license/manifest, and builds x64 and arm64 Windows executables into `vendor/scip/win32-*/scip.exe`.
- **Why**: The user installation should not need Go; only the scip-query publisher needs Go during release packaging.

### 4. Cover Windows Behavior

- [ ] **File**: `tests/runtime/scip-cli.test.ts:1-158`; `tests/reindex/reindex-reliability.test.ts:240-247`
- **Source**: `sed -n '1,260p' tests/runtime/scip-cli.test.ts`; `scip-query trace isScipInstalled`; `scip-query trace printScipInstallInstructions`.
- **What**: Tests cover PATH, Homebrew/Go fallback, and manual fallback, but not packaged Windows resolution.
- **Change**: Extend the loader to mock `node:fs`, add a Windows x64 test that sees a managed `scip.exe`, verifies `getScipVersion()` shells out to that path, add a Windows fallback test that does not print nonexistent upstream Windows downloads, and update the reindex reliability fixture's `scip-cli` mock to expose `resolveScipBinary()`.
- **Why**: This catches the regression without requiring a Windows runner.

## Stress Test

- Understand before touching: the converter dependency is distinct from language indexers; `src/reindex/indexers.ts:9-10` says all languages require `scip` for protobuf-to-SQLite conversion. Source: `scip-query code src/reindex/indexers.ts:1-260`.
- Blast radius: `tryInstallScipCli()` affects only `ensureScipCliAvailable()`, `postinstall()`, and transitively `reindex()`. Source: `scip-query affected tryInstallScipCli`.
- Intermediate state: runtime resolver changes are backward compatible because PATH `scip` remains first; publishing changes only add assets.
- Reversibility: removing `vendor/scip/**/*` and the resolver fallback restores the old PATH-only behavior.
- Failure design: if the managed binary is absent, status messages fall through to existing Homebrew/Go/manual paths; Windows manual text no longer points at a nonexistent upstream asset.
- Concurrency: no shared mutable state is introduced; the release script writes deterministic output paths in a temp checkout and final vendor directories.
- Boundary: the only external fetch is publish-time cloning from a pinned tag, not runtime download on user machines.
- Observability: `tryInstallScipCli()` reports when it uses a managed package binary or when no auto-install path exists.
- Human impact: Windows users get a working install; macOS/Linux behavior stays familiar.
- Reuse: reuse `isBinaryAvailable()` and existing installer status callbacks; no second installer framework.

## Verification

- `npm test -- tests/runtime/scip-cli.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm run build:scip-windows`
- `scip-query reindex`
- `scip-query diff-gate --json`
