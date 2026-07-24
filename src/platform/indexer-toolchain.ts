import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { IndexerConfig } from '../domain/types.js';
import { isBinaryAvailable, resolveSpawnableExecutable } from './binary.js';

const requireFromHere = createRequire(import.meta.url);

export type IndexerToolchain = Pick<
  IndexerConfig,
  'language' | 'indexerBinary' | 'binaryAliases' | 'projectLocalBinaries' | 'bundledNpmPackage' | 'installUrl'
>;

export const RUST_ANALYZER_TOOLCHAIN = {
  language: 'rust',
  indexerBinary: 'rust-analyzer',
  installUrl: 'https://github.com/rust-lang/rust-analyzer',
} as const satisfies IndexerToolchain;

export interface IndexerDependencyStatus {
  language: IndexerConfig['language'];
  binaryLabel: string;
  installed: boolean;
  runnable: boolean;
  resolvedBinary: string | null;
  installUrl?: string;
  note?: string;
}

function getBinaryCandidates(toolchain: IndexerToolchain): string[] {
  return [toolchain.indexerBinary, ...(toolchain.binaryAliases ?? [])];
}

/**
 * Describe the accepted executable names for an indexer.
 */
export function describeIndexerBinary(toolchain: IndexerToolchain): string {
  const candidates = getBinaryCandidates(toolchain);
  return candidates.length === 1 ? candidates[0]! : candidates.join(' or ');
}

/**
 * Resolve the first available executable name for an indexer.
 *
 * Falls back to the indexer's bundled npm package bin when it is installed
 * alongside scip-query. Returning the concrete bin path keeps indexing stable
 * even when the target project is not itself an npm project.
 */
export function resolveIndexerBinary(toolchain: IndexerToolchain): string | null {
  for (const candidate of getBinaryCandidates(toolchain)) {
    if (platform() === 'win32') {
      // `where` also reports npm's .cmd/extensionless shim scripts, which a
      // shell-less spawn rejects with EFTYPE; only a real executable counts.
      const spawnable = resolveSpawnableExecutable(candidate);
      if (spawnable) return spawnable;
    } else if (isBinaryAvailable(candidate)) {
      return candidate;
    }
  }
  return resolveBundledNpmBinary(toolchain);
}

/**
 * Check if an indexer's binary is available on PATH.
 */
export function isIndexerInstalled(toolchain: IndexerToolchain): boolean {
  return resolveIndexerBinary(toolchain) !== null || isBundledNpmPackageInstalled(toolchain);
}

/**
 * Check whether the indexer's bundled npm package (an optionalDependency of
 * scip-query) was successfully installed alongside scip-query.
 */
function isBundledNpmPackageInstalled(toolchain: IndexerToolchain): boolean {
  return resolveBundledNpmPackageJson(toolchain) !== null;
}

function resolveBundledNpmBinary(toolchain: IndexerToolchain): string | null {
  const packageJsonPath = resolveBundledNpmPackageJson(toolchain);
  if (!packageJsonPath) return null;

  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
    bin?: string | Record<string, string>;
  };
  const bin = pkg.bin;
  if (!bin) return null;

  if (typeof bin === 'string') {
    return join(dirname(packageJsonPath), bin);
  }

  for (const candidate of getBinaryCandidates(toolchain)) {
    const relativeBinPath = bin[candidate];
    if (relativeBinPath) return join(dirname(packageJsonPath), relativeBinPath);
  }

  return null;
}

function resolveBundledNpmPackageJson(toolchain: IndexerToolchain): string | null {
  if (!toolchain.bundledNpmPackage) return null;
  try {
    return requireFromHere.resolve(`${toolchain.bundledNpmPackage}/package.json`);
  } catch {
    return null;
  }
}

/**
 * Resolve a project-local indexer binary when the project vendors its own executable.
 */
export function resolveProjectLocalIndexerBinary(toolchain: IndexerToolchain, projectRoot: string): string | null {
  for (const relativePath of toolchain.projectLocalBinaries ?? []) {
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
export function resolveIndexerBinaryForProject(toolchain: IndexerToolchain, projectRoot: string): string | null {
  return resolveProjectLocalIndexerBinary(toolchain, projectRoot) ?? resolveIndexerBinary(toolchain);
}

/**
 * Build the environment needed to execute a language indexer.
 * Currently only .NET indexers need special handling because `scip-dotnet`
 * still targets the .NET 9 runtime.
 */
export function getIndexerExecutionEnv(
  toolchain: IndexerToolchain,
  baseEnv: NodeJS.ProcessEnv = process.env,
  binary = toolchain.indexerBinary,
): NodeJS.ProcessEnv {
  if (toolchain.indexerBinary !== 'scip-dotnet') {
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
export function getIndexerDependencyStatus(toolchain: IndexerToolchain, projectRoot?: string): IndexerDependencyStatus {
  const binaryLabel = describeIndexerBinary(toolchain);
  const resolvedBinary = projectRoot
    ? resolveIndexerBinaryForProject(toolchain, projectRoot)
    : resolveIndexerBinary(toolchain);

  if (!resolvedBinary) {
    return {
      language: toolchain.language,
      binaryLabel,
      installed: false,
      runnable: false,
      resolvedBinary: null,
      installUrl: toolchain.installUrl,
    };
  }

  if (toolchain.indexerBinary !== 'scip-dotnet') {
    return {
      language: toolchain.language,
      binaryLabel,
      installed: true,
      runnable: true,
      resolvedBinary,
    };
  }

  const runtimeProbe = probeDotnetRuntime(resolvedBinary);
  return {
    language: toolchain.language,
    binaryLabel,
    installed: true,
    runnable: runtimeProbe.runnable,
    resolvedBinary,
    installUrl: toolchain.installUrl,
    note: runtimeProbe.note,
  };
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
  const attemptedNote =
    attemptedRoots.length > 0
      ? `.NET 9 runtime still unavailable after checking ${attemptedRoots.join(', ')}`
      : 'binary is present, but scip-dotnet still needs a .NET 9 runtime';
  return {
    runnable: false,
    note: attemptedNote,
  };
}

function resolveWorkingDotnetRoot(binary: string, env: NodeJS.ProcessEnv): string | null {
  for (const dotnetRoot of getDotnetRootCandidates(env)) {
    if (canRunDotnetIndexer(binary, { ...env, DOTNET_ROOT: dotnetRoot })) {
      return dotnetRoot;
    }
  }

  return null;
}

function getDotnetRootCandidates(env: NodeJS.ProcessEnv): string[] {
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
      })
        .toString()
        .trim();
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

function canRunDotnetIndexer(binary: string, env: NodeJS.ProcessEnv): boolean {
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
