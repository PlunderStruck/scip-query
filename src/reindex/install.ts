import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { IndexerConfig } from '../types.js';

const IS_WINDOWS = platform() === 'win32';

/**
 * Check if a binary is available on PATH.
 */
export function isBinaryAvailable(name: string): boolean {
  const cmd = IS_WINDOWS ? 'where' : 'which';
  try {
    execFileSync(cmd, [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an indexer's binary is available on PATH.
 */
export function isIndexerInstalled(config: IndexerConfig): boolean {
  return isBinaryAvailable(config.indexerBinary);
}

/**
 * Attempt to auto-install an indexer using its configured install methods.
 * Tries each method in order, checking prerequisites first.
 * Returns true if installation succeeded.
 */
export function tryInstallIndexer(
  config: IndexerConfig,
  onStatus: (msg: string) => void,
): boolean {
  const methods = config.installMethods;
  if (!methods?.length) {
    onStatus(`No auto-install method available for ${config.indexerBinary}.`);
    if (config.installUrl) {
      onStatus(`Install manually from: ${config.installUrl}`);
    }
    return false;
  }

  for (const method of methods) {
    if (!isBinaryAvailable(method.prerequisite)) {
      continue;
    }

    onStatus(`Installing ${config.indexerBinary} via ${method.label}...`);
    try {
      execFileSync(method.binary, method.args, {
        stdio: 'inherit',
        timeout: 300_000,
        env: process.env,
      });

      if (isIndexerInstalled(config)) {
        onStatus(`Successfully installed ${config.indexerBinary} via ${method.label}`);
        return true;
      }
      onStatus(`${method.label} command completed but ${config.indexerBinary} not found on PATH`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus(`${method.label} install failed: ${msg}`);
    }
  }

  onStatus(`Could not auto-install ${config.indexerBinary}.`);
  if (config.installUrl) {
    onStatus(`Install manually from: ${config.installUrl}`);
  }
  return false;
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
