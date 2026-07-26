import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_SCIP_REPOSITORY,
  DEFAULT_SCIP_TAG,
  PINNED_GO_VERSION,
  verifyWindowsSidecarProvenance,
} from './scip-windows-provenance.mjs';

interface PackageRecord {
  name: string;
  version: string;
  optionalDependencies?: Record<string, string>;
}

export interface WindowsSidecarReleaseRuntime {
  cwd(): string;
  env: NodeJS.ProcessEnv;
  log(message: string): void;
  readFile(path: string): Buffer;
  run(
    binary: string,
    args: string[],
    options?: {
      cwd?: string;
      encoding?: BufferEncoding;
      stdio?: 'inherit' | ['ignore', 'pipe', 'pipe'];
    },
  ): string;
}

export function runWindowsSidecarRelease(runtime: WindowsSidecarReleaseRuntime): void {
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

  const underNpmPublish = runtime.env.npm_lifecycle_event === 'prepublishOnly';
  if (!underNpmPublish) {
    runtime.log(
      `Checks OK. Not publishing ${sidecar.name} (direct invocation) — main-package npm publish runs the ordered sidecar workflow.`,
    );
  } else if (runtime.env.npm_config_dry_run === 'true') {
    runtime.log(`[dry-run] would publish ${sidecar.name}@${sidecar.version}, skipping.`);
  } else if (alreadyPublished(sidecar.name, sidecar.version, runtime)) {
    runtime.log(`${sidecar.name}@${sidecar.version} already on the registry — skipping sidecar publish.`);
  } else {
    runtime.log(`Publishing ${sidecar.name}@${sidecar.version}...`);
    runtime.run('npm', ['publish'], { stdio: 'inherit', cwd: sidecarDir });
  }
  runtime.log('Windows sidecar ready; continuing with the main package publish.');
}

export function createWindowsSidecarReleaseRuntime(): WindowsSidecarReleaseRuntime {
  return {
    cwd: process.cwd,
    env: process.env,
    log: console.log,
    readFile: readFileSync,
    run(binary, args, options = {}) {
      const result = execFileSync(binary, args, options);
      return typeof result === 'string' ? result : (result?.toString('utf8') ?? '');
    },
  };
}

function alreadyPublished(name: string, version: string, runtime: WindowsSidecarReleaseRuntime): boolean {
  try {
    const out = runtime
      .run('npm', ['view', `${name}@${version}`, 'version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();
    return out === version;
  } catch {
    return false;
  }
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
