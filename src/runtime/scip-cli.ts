import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { platform, arch } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBinaryAvailable } from './binary.js';

const SCIP_VERSION = 'v0.8.1';
const SCIP_RELEASE_URL = 'https://github.com/sourcegraph/scip';
const MANAGED_SCIP_BINARY: Partial<Record<NodeJS.Platform, Partial<Record<string, string>>>> = {
  win32: {
    x64: join('vendor', 'scip', 'win32-x64', 'scip.exe'),
    arm64: join('vendor', 'scip', 'win32-arm64', 'scip.exe'),
  },
};

function resolvePackageRoot(): string | null {
  let current = dirname(fileURLToPath(import.meta.url));

  while (true) {
    const packageJsonPath = join(current, 'package.json');
    if (existsSync(packageJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { name?: string };
        if (pkg.name === 'scip-query') {
          return current;
        }
      } catch {
        // Keep walking upward; a malformed parent package should not break setup.
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function resolveManagedScipBinary(): string | null {
  const relativePath = MANAGED_SCIP_BINARY[platform()]?.[arch()];
  if (!relativePath) {
    return null;
  }

  const packageRoot = resolvePackageRoot();
  if (!packageRoot) {
    return null;
  }

  const candidate = join(packageRoot, relativePath);
  return existsSync(candidate) ? candidate : null;
}

export function resolveScipBinary(): string | null {
  if (isBinaryAvailable('scip')) {
    return 'scip';
  }
  return resolveManagedScipBinary();
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
    const output = execFileSync(scipBinary, ['--version'], { stdio: 'pipe' }).toString().trim();
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

  if (platform() === 'darwin') {
    console.log('Install via Homebrew:');
    console.log('  brew install sourcegraph/scip/scip\n');
    console.log('Or download manually:');
  } else if (platform() === 'win32') {
    console.log('Windows installs should include a managed scip.exe in the scip-query package.');
    console.log('Reinstall scip-query, or build the managed binary from source with:');
    console.log('  npm run build:scip-windows\n');
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

/**
 * Attempt to auto-install the `scip` CLI binary.
 * Tries brew (macOS), then go install, then prints manual instructions.
 * Returns true if installation succeeded.
 */
export function tryInstallScipCli(onStatus: (msg: string) => void): boolean {
  const managedBinary = resolveManagedScipBinary();
  if (managedBinary) {
    onStatus(`Using bundled scip CLI at ${managedBinary}`);
    return true;
  }

  // macOS: try Homebrew first
  if (platform() === 'darwin' && isBinaryAvailable('brew')) {
    onStatus('Installing scip CLI via Homebrew...');
    try {
      execFileSync('brew', ['install', 'sourcegraph/scip/scip'], {
        stdio: 'inherit',
        timeout: 300_000,
        env: process.env,
      });
      if (isBinaryAvailable('scip')) {
        onStatus('Successfully installed scip CLI via Homebrew');
        return true;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus(`Homebrew install failed: ${msg}`);
    }
  }

  // Any platform: try go install
  if (isBinaryAvailable('go')) {
    onStatus('Installing scip CLI via go install...');
    try {
      execFileSync('go', ['install', 'github.com/sourcegraph/scip/cmd/scip@latest'], {
        stdio: 'inherit',
        timeout: 300_000,
        env: process.env,
      });
      if (isBinaryAvailable('scip')) {
        onStatus('Successfully installed scip CLI via go install');
        return true;
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
