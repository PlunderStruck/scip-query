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

function getBinaryCandidates(config: IndexerConfig): string[] {
  return [config.indexerBinary, ...(config.binaryAliases ?? [])];
}

/**
 * Describe the accepted executable names for an indexer.
 */
export function describeIndexerBinary(config: IndexerConfig): string {
  const candidates = getBinaryCandidates(config);
  return candidates.length === 1 ? candidates[0]! : candidates.join(' or ');
}

/**
 * Resolve the first available executable name for an indexer.
 */
export function resolveIndexerBinary(config: IndexerConfig): string | null {
  for (const candidate of getBinaryCandidates(config)) {
    if (isBinaryAvailable(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Check if an indexer's binary is available on PATH.
 */
export function isIndexerInstalled(config: IndexerConfig): boolean {
  return resolveIndexerBinary(config) !== null;
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
  const binaryLabel = describeIndexerBinary(config);
  if (!methods?.length) {
    onStatus(`No auto-install method available for ${binaryLabel}.`);
    if (config.installUrl) {
      onStatus(`Install manually from: ${config.installUrl}`);
    }
    return false;
  }

  for (const method of methods) {
    if (!isBinaryAvailable(method.prerequisite)) {
      continue;
    }

    onStatus(`Installing ${binaryLabel} via ${method.label}...`);
    try {
      execFileSync(method.binary, method.args, {
        stdio: 'inherit',
        timeout: 300_000,
        env: process.env,
      });

      const resolvedBinary = resolveIndexerBinary(config);
      if (resolvedBinary) {
        const resolutionNote = resolvedBinary === config.indexerBinary
          ? ''
          : ` (using ${resolvedBinary})`;
        onStatus(`Successfully installed ${binaryLabel} via ${method.label}${resolutionNote}`);
        return true;
      }
      onStatus(`${method.label} command completed but ${binaryLabel} was not found on PATH`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      onStatus(`${method.label} install failed: ${msg}`);
    }
  }

  onStatus(`Could not auto-install ${binaryLabel}.`);
  if (config.installUrl) {
    onStatus(`Install manually from: ${config.installUrl}`);
  }
  return false;
}
