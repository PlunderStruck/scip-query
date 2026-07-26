import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { isBinaryAvailable, resolveSpawnableExecutable } from './binary.js';

export const SCIP_VERSION = 'v0.8.1';
const SCIP_RELEASE_URL = 'https://github.com/sourcegraph/scip';
const SCIP_GO_PACKAGE = `github.com/sourcegraph/scip/cmd/scip@${SCIP_VERSION}`;
const requireFromHere = createRequire(import.meta.url);

/** Env var that lets a user point directly at a local `scip` binary, bypassing PATH and the download cache. */
export const SCIP_BIN_ENV_VAR = 'SCIP_QUERY_SCIP_BIN';

export type ScipBinarySource = 'path' | 'env' | 'sidecar';

export interface ScipBinaryResolution {
  source: ScipBinarySource;
  path: string;
}

export interface ScipBinaryResolutionDeps {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  isOnPath: (name: string) => boolean;
  fileExists: (path: string) => boolean;
  resolveSidecar: (arch: string) => string | null;
}

/**
 * Pure resolution matrix for the `scip` CLI binary. Four outcomes:
 * found on PATH, found via `SCIP_QUERY_SCIP_BIN`, resolved from the
 * npm sidecar package (Windows only — `scip-query-scip-windows`, installed
 * automatically as an os-gated optionalDependency), or not found.
 * All I/O is injected so this is unit-testable without touching the disk.
 */
export function resolveScipBinaryPure(deps: ScipBinaryResolutionDeps): ScipBinaryResolution | null {
  if (deps.isOnPath('scip')) {
    return { source: 'path', path: 'scip' };
  }

  const envPath = deps.env[SCIP_BIN_ENV_VAR];
  if (envPath && deps.fileExists(envPath)) {
    return { source: 'env', path: envPath };
  }

  if (deps.platform === 'win32') {
    const sidecar = deps.resolveSidecar(deps.arch);
    if (sidecar && deps.fileExists(sidecar)) {
      return { source: 'sidecar', path: sidecar };
    }
  }

  return null;
}

/**
 * Resolve the Windows scip.exe shipped by the `scip-query-scip-windows`
 * npm sidecar (universal package: both arches; os-gated so only Windows
 * installs pay for it). Falls back to the x64 binary on arm64 (emulation).
 */
export function resolveScipSidecarBinary(archName: string): string | null {
  for (const candidate of archName === 'arm64' ? ['arm64', 'x64'] : [archName]) {
    try {
      return requireFromHere.resolve(`scip-query-scip-windows/scip-win32-${candidate}.exe`);
    } catch {
      // Sidecar not installed (or this arch missing): try the next candidate.
    }
  }
  return null;
}

export function resolveScipBinary(env: NodeJS.ProcessEnv = process.env): string | null {
  const resolution = resolveScipBinaryPure({
    platform: platform(),
    arch: arch(),
    env,
    isOnPath: isBinaryAvailable,
    fileExists: existsSync,
    resolveSidecar: resolveScipSidecarBinary,
  });
  if (resolution?.source === 'path') {
    return resolveSpawnableExecutable('scip') ?? resolution.path;
  }
  return resolution?.path ?? null;
}

/**
 * Check if the `scip` CLI binary is available on PATH or packaged with scip-query.
 */
export function isScipInstalled(): boolean {
  return resolveScipBinary() !== null;
}

/**
 * Get the scip CLI version if installed.
 */
// scip-query: ignore-wrapper — exported setup API; callers should not know
// the exact `scip --version` process invocation.
export function getScipVersion(): string | null {
  const scipBinary = resolveScipBinary();
  if (!scipBinary) {
    return null;
  }

  try {
    const output = execFileSync(scipBinary, ['--version'], {
      stdio: 'pipe',
      timeout: 10_000,
      killSignal: 'SIGKILL',
    })
      .toString()
      .trim();
    return output;
  } catch {
    return null;
  }
}

/**
 * Resolve the download URL for the scip CLI binary for this platform.
 */
function getScipDownloadUrl(): { url: string; filename: string } | null {
  const os = platform();
  const cpu = arch();

  let osName: string;
  let archName: string;
  let ext: string;

  switch (os) {
    case 'darwin':
      osName = 'darwin';
      ext = 'tar.gz';
      break;
    case 'linux':
      osName = 'linux';
      ext = 'tar.gz';
      break;
    default:
      return null;
  }

  switch (cpu) {
    case 'arm64':
      archName = 'arm64';
      break;
    case 'x64':
      archName = 'amd64';
      break;
    default:
      return null;
  }

  const filename = `scip-${osName}-${archName}.${ext}`;
  const url = `${SCIP_RELEASE_URL}/releases/download/${SCIP_VERSION}/${filename}`;
  return { url, filename };
}

/**
 * Print instructions for installing the scip CLI binary.
 */
export function printScipInstallInstructions(): void {
  const download = getScipDownloadUrl();

  console.log('\nThe `scip` CLI is required but not found on PATH.\n');

  if (platform() === 'darwin' || platform() === 'linux') {
    console.log('Install the reviewed version with Go:');
    console.log(`  go install ${SCIP_GO_PACKAGE}\n`);
    console.log('Or download that exact release manually:');
  } else if (platform() === 'win32') {
    const sidecarIdentity = windowsSidecarIdentity();
    console.log('On Windows the scip binary ships via the npm sidecar package scip-query-scip-windows,');
    console.log('installed automatically with scip-query. If it is missing:');
    console.log(`  npm install -g ${sidecarIdentity}`);
    console.log(`Or set ${SCIP_BIN_ENV_VAR} to a local scip.exe path.
`);
    console.log('Upstream release page:');
  } else {
    console.log('Download from:');
  }

  if (download) {
    console.log(`  ${download.url}\n`);
  } else {
    console.log(`  ${SCIP_RELEASE_URL}/releases/tag/${SCIP_VERSION}\n`);
  }

  console.log('After installing, ensure `scip` is on your PATH and run `scip-query reindex`.');
}

function windowsSidecarIdentity(): string {
  const packageJson = requireFromHere('../../package.json') as {
    optionalDependencies?: Record<string, string>;
  };
  const version = packageJson.optionalDependencies?.['scip-query-scip-windows'];
  if (!version || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('scip-query package metadata does not declare an exact Windows sidecar version.');
  }
  return `scip-query-scip-windows@${version}`;
}

/**
 * Attempt to auto-install the `scip` CLI binary.
 * Uses an immutable Go module identity, then prints versioned manual instructions.
 * Returns true if installation succeeded.
 */
export function tryInstallScipCli(onStatus: (msg: string) => void): boolean {
  // Any supported Go platform: request the reviewed immutable module version.
  if (isBinaryAvailable('go')) {
    onStatus(
      `Installing immutable ${SCIP_GO_PACKAGE} via go install into ` +
        'the Go bin directory (GOBIN or GOPATH/bin); expected executable: scip.',
    );
    try {
      execFileSync('go', ['install', SCIP_GO_PACKAGE], {
        stdio: 'inherit',
        timeout: 300_000,
        env: process.env,
      });
      if (isBinaryAvailable('scip')) {
        const resolvedBinary = resolveScipBinary();
        const installedVersion = getScipVersion();
        if (resolvedBinary && installedVersion && installedVersion.includes(SCIP_VERSION)) {
          onStatus(
            `Successfully installed ${SCIP_GO_PACKAGE}; resolved executable: ${resolvedBinary}; ` +
              `reported version: ${installedVersion}.`,
          );
          return true;
        }
        onStatus(
          `go install completed, but the resolved scip executable did not report ${SCIP_VERSION} ` +
            `(executable: ${resolvedBinary ?? 'unresolved'}; version: ${installedVersion ?? 'unavailable'}).`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus(`go install failed: ${msg}`);
    }
  }

  onStatus('Could not auto-install scip CLI.');
  onStatus(`Install manually from: ${SCIP_RELEASE_URL}/releases`);
  return false;
}
