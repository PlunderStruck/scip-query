import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { chmodSync, existsSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { isBinaryAvailable, resolveSpawnableExecutable } from './binary.js';
import { fetchVerifiedBinary, resolveScipQueryCachePath } from './verified-binary-fetch.js';

export const SCIP_VERSION = 'v0.8.1';
const SCIP_RELEASE_URL = 'https://github.com/sourcegraph/scip';
const SCIP_GO_PACKAGE = `github.com/sourcegraph/scip/cmd/scip@${SCIP_VERSION}`;
const requireFromHere = createRequire(import.meta.url);

/**
 * SHA-256 digests of the reviewed release archives (the `.sha256` sidecars
 * published with the tagged release). The installer downloads nothing that
 * does not hash to one of these, so the version pin is also a content pin.
 */
export const SCIP_RELEASE_DIGESTS: Readonly<Record<string, string>> = {
  'scip-darwin-amd64.tar.gz': '39f18be957d350bcd9ed5cb12d7781b0e237a5cb2429a107feaf9ce2d1dcd5d5',
  'scip-darwin-arm64.tar.gz': '5b3f4a2fb1dc10c599cb3422ed0406a739060e4ac0b1222c0f43630dd0dd8221',
  'scip-linux-amd64.tar.gz': '16b79ed98f893abd530cfa63f333527f1351008b4a23e02b9e522e34d1da6596',
  'scip-linux-arm64.tar.gz': '876dfb680119dd6e5713077c49b27701102d598bdeba94c809173276d399c7e2',
};

/** Env var that lets a user point directly at a local `scip` binary, bypassing PATH and the download cache. */
export const SCIP_BIN_ENV_VAR = 'SCIP_QUERY_SCIP_BIN';

/**
 * SCIP is converted to SQLite in-process; the external `scip` binary is only
 * consulted when the legacy converter is selected explicitly, so a machine
 * without it indexes normally.
 */
export function externalScipConverterSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['SCIP_QUERY_SQLITE_CONVERTER'] === 'scip-cli';
}

export type ScipBinarySource = 'path' | 'env' | 'sidecar' | 'cache';

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
  /** The reviewed release binary installed by `--install-missing`, when present. */
  resolveCached?: () => string | null;
}

/**
 * Pure resolution matrix for the `scip` CLI binary. Five outcomes:
 * found via `SCIP_QUERY_SCIP_BIN`, the reviewed release installed into the
 * scip-query cache by `--install-missing`, found on PATH, resolved from the
 * npm sidecar package (Windows only — `scip-query-scip-windows`, installed
 * automatically as an os-gated optionalDependency), or not found. The
 * explicit override wins; the reviewed binary outranks an arbitrary PATH
 * binary so that installing it makes the pinned version take effect.
 * All I/O is injected so this is unit-testable without touching the disk.
 */
export function resolveScipBinaryPure(deps: ScipBinaryResolutionDeps): ScipBinaryResolution | null {
  const envPath = deps.env[SCIP_BIN_ENV_VAR];
  if (envPath && deps.fileExists(envPath)) {
    return { source: 'env', path: envPath };
  }

  const cached = deps.resolveCached?.() ?? null;
  if (cached) {
    return { source: 'cache', path: cached };
  }

  if (deps.isOnPath('scip')) {
    return { source: 'path', path: 'scip' };
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
  return resolveScipBinaryWithSource(env)?.path ?? null;
}

export function resolveScipBinaryWithSource(env: NodeJS.ProcessEnv = process.env): ScipBinaryResolution | null {
  const resolution = resolveScipBinaryPure({
    platform: platform(),
    arch: arch(),
    env,
    isOnPath: isBinaryAvailable,
    fileExists: existsSync,
    resolveSidecar: resolveScipSidecarBinary,
    resolveCached: () => resolveCachedScipBinary(env),
  });
  if (resolution?.source === 'path') {
    return { source: 'path', path: resolveSpawnableExecutable('scip') ?? resolution.path };
  }
  return resolution;
}

/** Where `--install-missing` places the reviewed release binary for this platform. */
export function cachedScipBinaryPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveScipQueryCachePath(join('scip', SCIP_VERSION, 'scip'), env);
}

function resolveCachedScipBinary(env: NodeJS.ProcessEnv): string | null {
  const path = cachedScipBinaryPath(env);
  return existsSync(path) ? path : null;
}

/** Whether a `scip --version` report names the reviewed release. */
export function scipVersionMatchesPin(version: string | null): boolean {
  return version !== null && version.includes(SCIP_VERSION.replace(/^v/, ''));
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

export interface ScipReleaseDownload {
  url: string;
  filename: string;
  sha256: string;
}

/**
 * Resolve the reviewed release archive for this platform: its URL, file
 * name, and pinned digest. Null on platforms without a published archive.
 */
export function resolveScipDownload(
  os: NodeJS.Platform = platform(),
  cpu: string = arch(),
): ScipReleaseDownload | null {
  const download = getScipDownloadUrl(os, cpu);
  if (!download) return null;
  const sha256 = SCIP_RELEASE_DIGESTS[download.filename];
  return sha256 ? { ...download, sha256 } : null;
}

function getScipDownloadUrl(
  os: NodeJS.Platform = platform(),
  cpu: string = arch(),
): { url: string; filename: string } | null {
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
    console.log(`Let scip-query install the reviewed release (${SCIP_VERSION}, digest-verified) into its cache:`);
    console.log('  scip-query setup --install-missing\n');
    console.log('Or install it with Go:');
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

export interface ScipReleaseInstallDeps {
  fetch: typeof fetchVerifiedBinary;
  extract: (archivePath: string, directory: string) => void;
  markExecutable: (path: string) => void;
  probeVersion: (binary: string) => string | null;
  env: NodeJS.ProcessEnv;
}

const DEFAULT_RELEASE_INSTALL_DEPS: ScipReleaseInstallDeps = {
  fetch: fetchVerifiedBinary,
  extract: (archivePath, directory) => {
    execFileSync('tar', ['-xzf', archivePath, '-C', directory, 'scip'], {
      stdio: 'pipe',
      timeout: 120_000,
      killSignal: 'SIGKILL',
    });
  },
  markExecutable: (path) => chmodSync(path, 0o755),
  probeVersion: (binary) => probeScipVersion(binary),
  env: process.env,
};

/**
 * Install the reviewed `scip` release without Go: download the archive whose
 * digest is pinned above into the scip-query cache, extract the binary next
 * to it, and confirm the binary reports the pinned version. The cached
 * binary then outranks any PATH binary for every later resolution. Returns
 * the installed path, or null with the reason reported through `onStatus`.
 */
export async function installScipCliFromRelease(
  onStatus: (msg: string) => void,
  deps: Partial<ScipReleaseInstallDeps> = {},
): Promise<string | null> {
  const runtime: ScipReleaseInstallDeps = { ...DEFAULT_RELEASE_INSTALL_DEPS, ...deps };
  const download = resolveScipDownload();
  if (!download) {
    onStatus(`No reviewed scip ${SCIP_VERSION} release archive is published for ${platform()}/${arch()}.`);
    return null;
  }
  const binaryPath = cachedScipBinaryPath(runtime.env);
  const directory = dirname(binaryPath);
  const archivePath = join(directory, download.filename);
  onStatus(
    `Downloading reviewed scip ${SCIP_VERSION} (${download.filename}, sha256 ${download.sha256.slice(0, 12)}…).`,
  );
  try {
    const fetched = await runtime.fetch({ cachePath: archivePath, url: download.url, expectedSha256: download.sha256 });
    runtime.extract(fetched.path, directory);
    runtime.markExecutable(binaryPath);
  } catch (error) {
    onStatus(`Could not install scip ${SCIP_VERSION}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  const version = runtime.probeVersion(binaryPath);
  if (!scipVersionMatchesPin(version)) {
    onStatus(`Installed scip at ${binaryPath} did not report ${SCIP_VERSION} (reported: ${version ?? 'unavailable'}).`);
    return null;
  }
  onStatus(`Installed reviewed scip ${SCIP_VERSION} at ${binaryPath}.`);
  return binaryPath;
}

function probeScipVersion(binary: string): string | null {
  try {
    return execFileSync(binary, ['--version'], { stdio: 'pipe', timeout: 10_000, killSignal: 'SIGKILL' })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Attempt to auto-install the `scip` CLI binary: the reviewed release archive
 * first (no toolchain required), then `go install` of the immutable module as
 * a fallback for platforms without a published archive. Returns true if a
 * binary reporting the pinned version is now resolvable.
 */
export async function tryInstallScipCli(
  onStatus: (msg: string) => void,
  deps: Partial<ScipReleaseInstallDeps> = {},
): Promise<boolean> {
  if (platform() !== 'win32' && (await installScipCliFromRelease(onStatus, deps)) !== null) {
    return true;
  }

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
  onStatus(`Install manually from: ${SCIP_RELEASE_URL}/releases/tag/${SCIP_VERSION}`);
  return false;
}
