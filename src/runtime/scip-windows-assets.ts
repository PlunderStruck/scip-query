export type ScipWindowsArch = 'x64' | 'arm64';

export interface ScipWindowsAsset {
  url: string;
  sha256: string;
}

/**
 * Pinned Windows `scip.exe` release assets, keyed by Node's `os.arch()`
 * value. `scip-cli.ts` downloads and checksum-verifies these on first
 * `reindex` when `scip` is not found on PATH or via `SCIP_QUERY_SCIP_BIN`.
 *
 * The publisher MUST update `url` + `sha256` here, in the same commit that
 * bumps `package.json`'s version, after building and uploading
 * `scip-win32-<arch>.exe` as GitHub release assets via
 * `npm run build:scip-windows`. `scripts/check-scip-windows-assets.ts`
 * (wired into `prepublishOnly`) fails the release until both entries name
 * the current version and carry a real (non-placeholder) sha256 — see
 * docs/plans/2026-07-02-release-readiness.md Phase 22.
 */
export const SCIP_WINDOWS_ASSETS: Partial<Record<ScipWindowsArch, ScipWindowsAsset>> = {
  x64: {
    url: 'https://github.com/PlunderStruck/scip-query/releases/download/v0.10.12/scip-win32-x64.exe',
    sha256: '',
  },
  arm64: {
    url: 'https://github.com/PlunderStruck/scip-query/releases/download/v0.10.12/scip-win32-arm64.exe',
    sha256: '',
  },
};
