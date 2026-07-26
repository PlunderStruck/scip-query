import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, type PathLike } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeNpmPackIdentity,
  decodeRegistryDistIdentity,
  type RegistryDistIdentity,
  type VerifiedSidecarPackageIdentity,
  verifyRegistryTarballIdentity,
} from './scip-windows-package-identity.js';
import {
  DEFAULT_SCIP_REPOSITORY,
  DEFAULT_SCIP_TAG,
  PINNED_GO_VERSION,
  verifyWindowsSidecarProvenance,
  WINDOWS_SIDECAR_PROVENANCE_FILE,
} from './scip-windows-provenance.mjs';

const PACK_TIMEOUT_MS = 120_000;
const REGISTRY_TIMEOUT_MS = 30_000;
const PUBLISH_TIMEOUT_MS = 180_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

interface PackageRecord {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
}

export interface WindowsSidecarCommandOptions {
  cwd?: string;
  stdio?: 'inherit' | ['ignore', 'pipe', 'pipe'];
  timeoutMs: number;
  maxOutputBytes: number;
}

export class WindowsSidecarCommandError extends Error {
  constructor(
    readonly kind: 'timeout' | 'output-limit' | 'spawn' | 'exit',
    readonly binary: string,
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
    message: string,
  ) {
    super(message);
    this.name = 'WindowsSidecarCommandError';
  }
}

export interface WindowsSidecarReleaseRuntime {
  cwd(): string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  makeTempDirectory(prefix: string): string;
  mkdir(path: string): void;
  readFile(path: PathLike): Buffer;
  removeTree(path: string): void;
  run(binary: string, args: string[], options: WindowsSidecarCommandOptions): string;
  tempDirectory(): string;
}

export interface WindowsSidecarReleaseOptions {
  registryMode?: 'publish' | 'verify-only';
}

export function runWindowsSidecarRelease(
  runtime: WindowsSidecarReleaseRuntime,
  options: WindowsSidecarReleaseOptions = {},
): void {
  const root = runtime.cwd();
  const sidecarDir = join(root, 'packages', 'scip-windows');
  const main = parsePackage(runtime.readFile(join(root, 'package.json')), 'main package');
  const sidecar = parsePackage(runtime.readFile(join(sidecarDir, 'package.json')), 'Windows sidecar');

  const pin = main.optionalDependencies?.[sidecar.name];
  if (!pin) {
    throw new Error(`package.json has no optionalDependencies entry for ${sidecar.name}.`);
  }
  if (pin !== sidecar.version) {
    throw new Error(`optionalDependencies pin (${pin}) != packages/scip-windows version (${sidecar.version}).`);
  }

  const manifest = verifyWindowsSidecarProvenance({
    sidecarDir,
    expectedSourceRepository: runtime.env.SCIP_REPO_URL ?? DEFAULT_SCIP_REPOSITORY,
    expectedSourceTag: runtime.env.SCIP_VERSION ?? DEFAULT_SCIP_TAG,
    expectedGoVersion: runtime.env.SCIP_GO_VERSION ?? PINNED_GO_VERSION,
    readFile: runtime.readFile,
  });
  runtime.log(
    `Verified ${manifest.package.name}@${manifest.package.version} provenance: ${manifest.source.tag} (${manifest.source.commit.slice(0, 12)}), ${manifest.toolchain.goVersion}.`,
  );

  const releaseDirectory = runtime.makeTempDirectory(join(runtime.tempDirectory(), 'scip-query-sidecar-release-'));
  try {
    const local = packLocalSidecar(sidecarDir, releaseDirectory, runtime);
    const localManifestBytes = runtime.readFile(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE));
    if (!local.provenanceBytes.equals(localManifestBytes)) {
      throw new Error(`Packed provenance does not equal the reviewed local provenance.json bytes.`);
    }
    runtime.log(
      `Packed ${local.pack.name}@${local.pack.version}: ${local.pack.integrity}, ${local.pack.entryCount} entries.`,
    );

    const underNpmPublish = runtime.env.npm_lifecycle_event === 'prepublishOnly';
    if (!underNpmPublish) {
      runtime.log(
        `Checks and local pack OK. Not publishing ${sidecar.name} (direct invocation) — main-package npm publish runs the ordered sidecar workflow.`,
      );
      return;
    }
    if (runtime.env.npm_config_dry_run === 'true') {
      runtime.log(`[dry-run] would publish ${sidecar.name}@${sidecar.version}, skipping.`);
      return;
    }

    const registry = lookupRegistryDist(sidecar.name, sidecar.version, runtime);
    if (registry) {
      verifyExistingRegistryPackage(local, registry, releaseDirectory, runtime);
      runtime.log(
        `${sidecar.name}@${sidecar.version} already has identical registry bytes — skipping sidecar publish.`,
      );
      return;
    }
    if (options.registryMode === 'verify-only') {
      runtime.log(
        `${sidecar.name}@${sidecar.version} is absent from the registry; local identity is ready for a first publish.`,
      );
      return;
    }

    runtime.log(`Publishing ${sidecar.name}@${sidecar.version} from the verified local tarball...`);
    try {
      runtime.run('npm', ['publish', local.pack.tarballPath], {
        stdio: 'inherit',
        timeoutMs: PUBLISH_TIMEOUT_MS,
        maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
      });
    } catch (publishError) {
      const raced = lookupRegistryDist(sidecar.name, sidecar.version, runtime);
      if (!raced) throw publishError;
      try {
        verifyExistingRegistryPackage(local, raced, releaseDirectory, runtime);
      } catch (identityError) {
        throw new Error(
          `Sidecar publish failed and the concurrently published version has different content. ` +
            `${errorMessage(publishError)} ${errorMessage(identityError)}`,
          { cause: identityError },
        );
      }
      runtime.log(
        `Sidecar publish raced with an identical publisher; registry identity matches, so the release may continue.`,
      );
    }
  } finally {
    runtime.removeTree(releaseDirectory);
  }
  runtime.log('Windows sidecar ready; continuing with the main package publish.');
}

export function packLocalSidecar(
  sidecarDir: string,
  releaseDirectory: string,
  runtime: WindowsSidecarReleaseRuntime,
): VerifiedSidecarPackageIdentity {
  const packDirectory = join(releaseDirectory, 'local');
  runtime.mkdir(packDirectory);
  const output = runtime.run('npm', ['pack', '--json', '--pack-destination', packDirectory], {
    cwd: sidecarDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeoutMs: PACK_TIMEOUT_MS,
    maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
  });
  return decodeNpmPackIdentity(output, packDirectory, runtime.readFile);
}

export function lookupRegistryDist(
  name: string,
  version: string,
  runtime: WindowsSidecarReleaseRuntime,
): RegistryDistIdentity | null {
  try {
    const output = runtime.run('npm', ['view', `${name}@${version}`, 'dist', '--json'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: REGISTRY_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    });
    return decodeRegistryDistIdentity(output);
  } catch (error) {
    if (error instanceof WindowsSidecarCommandError && isRegistryNotFound(error)) {
      return null;
    }
    throw new Error(
      `Could not determine registry identity for ${name}@${version}; refusing to treat ambiguity as absence. ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

export function verifyExistingRegistryPackage(
  local: VerifiedSidecarPackageIdentity,
  registryDist: RegistryDistIdentity,
  releaseDirectory: string,
  runtime: WindowsSidecarReleaseRuntime,
): VerifiedSidecarPackageIdentity {
  const registryDirectory = join(releaseDirectory, 'registry');
  runtime.mkdir(registryDirectory);
  const output = runtime.run(
    'npm',
    [
      'pack',
      `${local.pack.name}@${local.pack.version}`,
      '--json',
      '--ignore-scripts',
      '--pack-destination',
      registryDirectory,
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeoutMs: PACK_TIMEOUT_MS,
      maxOutputBytes: COMMAND_OUTPUT_LIMIT_BYTES,
    },
  );
  return verifyRegistryTarballIdentity({
    local,
    registryDist,
    registryPackOutput: output,
    registryPackDirectory: registryDirectory,
    readFile: runtime.readFile,
  });
}

export function createWindowsSidecarReleaseRuntime(): WindowsSidecarReleaseRuntime {
  return {
    cwd: process.cwd,
    env: process.env,
    log: console.log,
    makeTempDirectory: mkdtempSync,
    mkdir(path) {
      mkdirSync(path, { recursive: true });
    },
    readFile: readFileSync,
    removeTree(path) {
      rmSync(path, { recursive: true, force: true });
    },
    run(binary, args, options) {
      const result = spawnSync(binary, args, {
        cwd: options.cwd,
        encoding: 'utf8',
        env: process.env,
        killSignal: 'SIGTERM',
        maxBuffer: options.maxOutputBytes,
        stdio: options.stdio,
        timeout: options.timeoutMs,
      });
      const stdout = typeof result.stdout === 'string' ? result.stdout : '';
      const stderr = typeof result.stderr === 'string' ? result.stderr : '';
      if (result.error) {
        const code = (result.error as NodeJS.ErrnoException).code;
        const kind = code === 'ETIMEDOUT' ? 'timeout' : code === 'ENOBUFS' ? 'output-limit' : 'spawn';
        throw new WindowsSidecarCommandError(
          kind,
          binary,
          args,
          result.status,
          stdout,
          stderr,
          `${binary} ${args.join(' ')} failed (${kind}): ${result.error.message}`,
        );
      }
      if (result.status !== 0) {
        throw new WindowsSidecarCommandError(
          'exit',
          binary,
          args,
          result.status,
          stdout,
          stderr,
          `${binary} ${args.join(' ')} exited ${String(result.status)}: ${stderr.trim() || stdout.trim()}`,
        );
      }
      return stdout;
    },
    tempDirectory: tmpdir,
  };
}

function isRegistryNotFound(error: WindowsSidecarCommandError): boolean {
  const evidence = `${error.stderr}\n${error.stdout}`;
  return /\bE404\b/.test(evidence);
}

function parsePackage(bytes: Buffer, label: string): PackageRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`${label} package.json is malformed.`);
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as Partial<PackageRecord>).name !== 'string' ||
    typeof (parsed as Partial<PackageRecord>).version !== 'string'
  ) {
    throw new Error(`${label} package.json is missing its name or version.`);
  }
  return parsed as PackageRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
