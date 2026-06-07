import { execFileSync } from 'node:child_process';
import { platform, arch } from 'node:os';

const IS_WINDOWS = platform() === 'win32';
const SCIP_VERSION = 'v0.7.0';

function isBinaryAvailable(name: string): boolean {
  const cmd = IS_WINDOWS ? 'where' : 'which';
  try {
    execFileSync(cmd, [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if the `scip` CLI binary is available on PATH.
 */
export function isScipInstalled(): boolean {
  try {
    const cmd = IS_WINDOWS ? 'where' : 'which';
    execFileSync(cmd, ['scip'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the scip CLI version if installed.
 */
// scip-query: ignore-wrapper — exported setup API; callers should not know
// the exact `scip --version` process invocation.
export function getScipVersion(): string | null {
  try {
    const output = execFileSync('scip', ['--version'], { stdio: 'pipe' }).toString().trim();
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
    case 'darwin': osName = 'darwin'; ext = 'tar.gz'; break;
    case 'linux': osName = 'linux'; ext = 'tar.gz'; break;
    case 'win32': osName = 'windows'; ext = 'zip'; break;
    default: return null;
  }

  switch (cpu) {
    case 'arm64': archName = 'arm64'; break;
    case 'x64': archName = 'amd64'; break;
    default: return null;
  }

  const filename = `scip-${osName}-${archName}.${ext}`;
  const url = `https://github.com/sourcegraph/scip/releases/download/${SCIP_VERSION}/${filename}`;
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
  } else {
    console.log('Download from:');
  }

  if (download) {
    console.log(`  ${download.url}\n`);
  } else {
    console.log(`  https://github.com/sourcegraph/scip/releases/tag/${SCIP_VERSION}\n`);
  }

  console.log('After installing, ensure `scip` is on your PATH and run `scip-query reindex`.');
}

/**
 * Attempt to auto-install the `scip` CLI binary.
 * Tries brew (macOS), then go install, then prints manual instructions.
 * Returns true if installation succeeded.
 */
export function tryInstallScipCli(
  onStatus: (msg: string) => void,
): boolean {
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
  onStatus('Install manually from: https://github.com/sourcegraph/scip/releases');
  return false;
}
