import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { delimiter, join } from 'node:path';
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
    if (!method.identity || !method.destination) {
      onStatus(
        `Refusing ${method.label} installation for ${binaryLabel}: ` +
          'the installer descriptor lacks an immutable identity or destination.',
      );
      continue;
    }
    if (!isBinaryAvailable(method.prerequisite)) {
      continue;
    }

    const destination = resolveInstallerDestination(method);
    onStatus(
      `Installing immutable ${method.identity} via ${method.label} into ${destination}; ` +
        `expected executable: ${binaryLabel}.`,
    );
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
        onStatus(
          `Successfully installed ${method.identity} via ${method.label}${resolutionNote}; ` +
            `resolved executable: ${resolvedBinary}.`,
        );
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

function resolveInstallerDestination(method: NonNullable<IndexerConfig['installMethods']>[number]): string {
  if (method.binary === 'npm') {
    return probeInstallerOutput('npm', ['root', '-g']) ?? method.destination!;
  }
  if (method.binary === 'go') {
    const goBin = probeInstallerOutput('go', ['env', 'GOBIN']);
    if (goBin) return goBin;
    const goPath = probeInstallerOutput('go', ['env', 'GOPATH']);
    if (goPath) return join(goPath.split(delimiter)[0]!, 'bin');
  }
  if (method.binary === 'dotnet') {
    return join(process.env['DOTNET_CLI_HOME'] ?? homedir(), '.dotnet', 'tools');
  }
  if (method.binary === 'dart') {
    return join(process.env['PUB_CACHE'] ?? join(homedir(), '.pub-cache'), 'bin');
  }
  return method.destination!;
}

function probeInstallerOutput(binary: string, args: string[]): string | null {
  try {
    const output = execFileSync(binary, args, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 10_000,
      killSignal: 'SIGKILL',
      env: process.env,
    }).trim();
    return output || null;
  } catch {
    return null;
  }
}
