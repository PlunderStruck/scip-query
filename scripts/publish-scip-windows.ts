/**
 * prepublishOnly hook for the main package: makes `npm publish` ship BOTH
 * packages in one command. Steps:
 *   1. Verify the optionalDependencies pin matches packages/scip-windows.
 *   2. Build the Windows binaries if absent (requires the go toolchain).
 *   3. Publish the sidecar to npm unless this exact version is already
 *      published (idempotent re-runs).
 * On `npm publish --dry-run`, performs the checks and build but skips the
 * sidecar publish.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const sidecarDir = join(root, 'packages', 'scip-windows');
const main = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  version: string;
  optionalDependencies?: Record<string, string>;
};
const sidecar = JSON.parse(readFileSync(join(sidecarDir, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};

const pin = main.optionalDependencies?.[sidecar.name];
if (!pin) fail(`package.json has no optionalDependencies entry for ${sidecar.name}.`);
if (pin !== sidecar.version) {
  fail(`optionalDependencies pin (${pin}) != packages/scip-windows version (${sidecar.version}).`);
}

const binaries = ['scip-win32-x64.exe', 'scip-win32-arm64.exe'];
if (!binaries.every((exe) => existsSync(join(sidecarDir, exe)))) {
  console.log('Windows scip binaries missing — building via build:scip-windows (requires go)...');
  execFileSync('npm', ['run', 'build:scip-windows'], { stdio: 'inherit', cwd: root });
  const still = binaries.filter((exe) => !existsSync(join(sidecarDir, exe)));
  if (still.length > 0) fail(`build:scip-windows did not produce: ${still.join(', ')}`);
}

const underNpmPublish = process.env['npm_lifecycle_event'] === 'prepublishOnly';
if (!underNpmPublish) {
  console.log(
    `Checks and build OK. Not publishing ${sidecar.name} (direct invocation) — 'npm publish' on the main package publishes both.`,
  );
} else if (process.env['npm_config_dry_run'] === 'true') {
  console.log(`[dry-run] would publish ${sidecar.name}@${sidecar.version}, skipping.`);
} else if (alreadyPublished(sidecar.name, sidecar.version)) {
  console.log(`${sidecar.name}@${sidecar.version} already on the registry — skipping sidecar publish.`);
} else {
  console.log(`Publishing ${sidecar.name}@${sidecar.version}...`);
  execFileSync('npm', ['publish'], { stdio: 'inherit', cwd: sidecarDir });
}
console.log('Windows sidecar ready; continuing with the main package publish.');

function alreadyPublished(name: string, version: string): boolean {
  try {
    const out = execFileSync('npm', ['view', `${name}@${version}`, 'version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return out === version;
  } catch {
    return false; // never published (E404) — or offline, in which case publish will surface the truth
  }
}

function fail(message: string): never {
  console.error(`Windows sidecar release check FAILED:\n  - ${message}`);
  process.exit(1);
}
