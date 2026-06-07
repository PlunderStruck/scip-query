import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { IndexerConfig } from '../domain/types.js';
import { isBinaryAvailable } from '../runtime/binary.js';

const requireFromHere = createRequire(import.meta.url);

export { isBinaryAvailable };

export interface IndexerDependencyStatus {
  language: IndexerConfig['language'];
  binaryLabel: string;
  installed: boolean;
  runnable: boolean;
  resolvedBinary: string | null;
  installUrl?: string;
  note?: string;
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
 *
 * Falls back to the indexer's bundled npm package bin when it is installed
 * alongside scip-query. Returning the concrete bin path keeps indexing stable
 * even when the target project is not itself an npm project.
 */
export function resolveIndexerBinary(config: IndexerConfig): string | null {
  for (const candidate of getBinaryCandidates(config)) {
    if (isBinaryAvailable(candidate)) {
      return candidate;
    }
  }
  return resolveBundledNpmBinary(config);
}

/**
 * Check if an indexer's binary is available on PATH.
 */
export function isIndexerInstalled(config: IndexerConfig): boolean {
  return resolveIndexerBinary(config) !== null || isBundledNpmPackageInstalled(config);
}

/**
 * Check whether the indexer's bundled npm package (an optionalDependency of
 * scip-query) was successfully installed alongside scip-query.
 */
function isBundledNpmPackageInstalled(config: IndexerConfig): boolean {
  return resolveBundledNpmPackageJson(config) !== null;
}

function resolveBundledNpmBinary(config: IndexerConfig): string | null {
  const packageJsonPath = resolveBundledNpmPackageJson(config);
  if (!packageJsonPath) return null;

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = pkg.bin;
  if (!bin) return null;

  if (typeof bin === 'string') {
    return join(dirname(packageJsonPath), bin);
  }

  for (const candidate of getBinaryCandidates(config)) {
    const relativeBinPath = bin[candidate];
    if (relativeBinPath) return join(dirname(packageJsonPath), relativeBinPath);
  }

  return null;
}

function resolveBundledNpmPackageJson(config: IndexerConfig): string | null {
  if (!config.bundledNpmPackage) return null;
  try {
    return requireFromHere.resolve(`${config.bundledNpmPackage}/package.json`);
  } catch {
    return null;
  }
}

/**
 * Resolve a project-local indexer binary when the project vendors its own executable.
 */
export function resolveProjectLocalIndexerBinary(
  config: IndexerConfig,
  projectRoot: string,
): string | null {
  for (const relativePath of config.projectLocalBinaries ?? []) {
    const candidate = join(projectRoot, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

/**
 * Resolve an indexer binary, preferring a project-local executable when present.
 */
export function resolveIndexerBinaryForProject(
  config: IndexerConfig,
  projectRoot: string,
): string | null {
  return resolveProjectLocalIndexerBinary(config, projectRoot) ?? resolveIndexerBinary(config);
}

/**
 * Build the environment needed to execute a language indexer.
 * Currently only .NET indexers need special handling because `scip-dotnet`
 * still targets the .NET 9 runtime.
 */
export function getIndexerExecutionEnv(
  config: IndexerConfig,
  baseEnv: NodeJS.ProcessEnv = process.env,
  binary = config.indexerBinary,
): NodeJS.ProcessEnv {
  if (config.indexerBinary !== 'scip-dotnet') {
    return baseEnv;
  }

  if (canRunDotnetIndexer(binary, baseEnv)) {
    return baseEnv;
  }

  const dotnetRoot = resolveWorkingDotnetRoot(binary, baseEnv);
  if (!dotnetRoot) {
    return baseEnv;
  }

  return {
    ...baseEnv,
    DOTNET_ROOT: dotnetRoot,
  };
}

/**
 * Check whether an indexer is installed and runnable in the current environment.
 */
export function getIndexerDependencyStatus(
  config: IndexerConfig,
  projectRoot?: string,
): IndexerDependencyStatus {
  const binaryLabel = describeIndexerBinary(config);
  const resolvedBinary = projectRoot
    ? resolveIndexerBinaryForProject(config, projectRoot)
    : resolveIndexerBinary(config);

  if (!resolvedBinary) {
    return {
      language: config.language,
      binaryLabel,
      installed: false,
      runnable: false,
      resolvedBinary: null,
      installUrl: config.installUrl,
    };
  }

  if (config.indexerBinary !== 'scip-dotnet') {
    return {
      language: config.language,
      binaryLabel,
      installed: true,
      runnable: true,
      resolvedBinary,
    };
  }

  const runtimeProbe = probeDotnetRuntime(resolvedBinary);
  return {
    language: config.language,
    binaryLabel,
    installed: true,
    runnable: runtimeProbe.runnable,
    resolvedBinary,
    installUrl: config.installUrl,
    note: runtimeProbe.note,
  };
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

function probeDotnetRuntime(binary: string): { runnable: boolean; note?: string } {
  if (canRunDotnetIndexer(binary, process.env)) {
    return { runnable: true };
  }

  const dotnetRoot = resolveWorkingDotnetRoot(binary, process.env);
  if (dotnetRoot) {
    return {
      runnable: true,
      note: `using .NET 9 runtime from ${dotnetRoot}`,
    };
  }

  const attemptedRoots = getDotnetRootCandidates(process.env);
  const attemptedNote = attemptedRoots.length > 0
    ? `.NET 9 runtime still unavailable after checking ${attemptedRoots.join(', ')}`
    : 'binary is present, but scip-dotnet still needs a .NET 9 runtime';
  return {
    runnable: false,
    note: attemptedNote,
  };
}

function resolveWorkingDotnetRoot(
  binary: string,
  env: NodeJS.ProcessEnv,
): string | null {
  for (const dotnetRoot of getDotnetRootCandidates(env)) {
    if (canRunDotnetIndexer(binary, { ...env, DOTNET_ROOT: dotnetRoot })) {
      return dotnetRoot;
    }
  }

  return null;
}

function getDotnetRootCandidates(
  env: NodeJS.ProcessEnv,
): string[] {
  const candidates: string[] = [];
  const configured = env['DOTNET_ROOT'];
  if (configured && existsSync(configured)) {
    candidates.push(configured);
  }

  if (platform() === 'darwin' && isBinaryAvailable('brew')) {
    try {
      const prefix = execFileSync('brew', ['--prefix', 'dotnet@9'], {
        stdio: 'pipe',
        env,
      }).toString().trim();
      const candidate = join(prefix, 'libexec');
      if (existsSync(candidate) && !candidates.includes(candidate)) {
        candidates.push(candidate);
      }
    } catch {
      // Fall through to any other candidates we already found.
    }
  }

  return candidates;
}

function canRunDotnetIndexer(
  binary: string,
  env: NodeJS.ProcessEnv,
): boolean {
  try {
    execFileSync(binary, ['--version'], {
      stdio: 'pipe',
      env,
    });
    return true;
  } catch {
    return false;
  }
}
