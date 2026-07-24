import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import type { IndexerConfig } from '../domain/types.js';
import { isBinaryAvailable } from '../platform/binary.js';
import { describeIndexerBinary, resolveIndexerBinary } from '../platform/indexer-toolchain.js';

/**
 * Attempt to auto-install an indexer using its configured install methods.
 * Tries each method in order, checking prerequisites first.
 * Returns true if installation succeeded.
 */
export function tryInstallIndexer(config: IndexerConfig, onStatus: (msg: string) => void): boolean {
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
        // Installer binaries (npm) are .cmd shims on Windows, which execFile
        // refuses without a shell; args here are fixed literals, never input.
        shell: platform() === 'win32',
      });

      const resolvedBinary = resolveIndexerBinary(config);
      if (resolvedBinary) {
        const resolutionNote = resolvedBinary === config.indexerBinary ? '' : ` (using ${resolvedBinary})`;
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
