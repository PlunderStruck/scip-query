#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWindowsSidecarProvenance,
  DEFAULT_SCIP_REPOSITORY,
  DEFAULT_SCIP_TAG,
  PINNED_GO_VERSION,
  verifyWindowsSidecarProvenance,
  WINDOWS_SIDECAR_BUILD,
  WINDOWS_SIDECAR_PROVENANCE_FILE,
  WINDOWS_SIDECAR_TARGETS,
} from './scip-windows-provenance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function buildScipWindowsSidecar(
  {
    root = ROOT,
    sourceRepository = process.env.SCIP_REPO_URL ?? DEFAULT_SCIP_REPOSITORY,
    sourceTag = process.env.SCIP_VERSION ?? DEFAULT_SCIP_TAG,
    expectedGoVersion = process.env.SCIP_GO_VERSION ?? PINNED_GO_VERSION,
  } = {},
  runtime = createBuildRuntime(),
) {
  const sidecarDir = join(root, 'packages', 'scip-windows');
  const sidecarPackage = JSON.parse(runtime.readFile(join(sidecarDir, 'package.json'), 'utf8'));
  runtime.assertAvailable('git');
  runtime.assertAvailable('go');

  const workDir = runtime.makeTempDirectory(join(runtime.tempDirectory(), 'scip-query-scip-'));
  try {
    const checkoutDir = join(workDir, 'scip');
    const artifactDir = join(workDir, 'artifacts');
    runtime.mkdir(artifactDir);

    const goVersion = parseGoVersion(
      runtime.run('go', ['version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    if (goVersion !== expectedGoVersion) {
      throw new Error(
        `Go toolchain mismatch: expected ${expectedGoVersion}, received ${goVersion}. ` +
          `Install the pinned toolchain or intentionally update the provenance contract.`,
      );
    }

    runtime.run('git', ['clone', '--depth', '1', '--branch', sourceTag, sourceRepository, checkoutDir], {
      stdio: 'inherit',
    });
    const sourceCommit = runtime
      .run('git', ['rev-parse', 'HEAD'], {
        cwd: checkoutDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      .trim();

    runtime.copyFile(join(checkoutDir, 'LICENSE'), join(artifactDir, 'LICENSE.scip'));
    runtime.writeFile(
      join(artifactDir, 'README.md'),
      renderSidecarReadme({ sourceRepository, sourceTag, sourceCommit, goVersion }),
    );

    for (const target of WINDOWS_SIDECAR_TARGETS) {
      const outputPath = join(artifactDir, target.filename);
      runtime.run('go', ['build', ...WINDOWS_SIDECAR_BUILD.flags, '-o', outputPath, WINDOWS_SIDECAR_BUILD.package], {
        cwd: checkoutDir,
        env: {
          ...process.env,
          ...WINDOWS_SIDECAR_BUILD.environment,
          GOARCH: target.goarch,
        },
        stdio: 'inherit',
      });
    }

    const manifest = createWindowsSidecarProvenance({
      sidecarDir: artifactDir,
      packageName: sidecarPackage.name,
      packageVersion: sidecarPackage.version,
      sourceRepository,
      sourceTag,
      sourceCommit,
      goVersion,
      readFile: runtime.readFile,
    });
    runtime.writeFile(join(artifactDir, WINDOWS_SIDECAR_PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`);

    for (const file of [
      'LICENSE.scip',
      'README.md',
      ...WINDOWS_SIDECAR_TARGETS.map((target) => target.filename),
      WINDOWS_SIDECAR_PROVENANCE_FILE,
    ]) {
      runtime.promoteFile(join(artifactDir, file), join(sidecarDir, file));
    }

    const verified = verifyWindowsSidecarProvenance({
      sidecarDir,
      expectedSourceRepository: sourceRepository,
      expectedSourceTag: sourceTag,
      expectedGoVersion,
      readFile: runtime.readFile,
    });
    runtime.log(
      `Built and verified ${verified.package.name}@${verified.package.version} from ${sourceTag} (${sourceCommit.slice(0, 12)}).`,
    );
    return verified;
  } finally {
    runtime.removeTree(workDir);
  }
}

export function createBuildRuntime() {
  return {
    assertAvailable(binary) {
      const probe = process.platform === 'win32' ? 'where' : 'which';
      try {
        execFileSync(probe, [binary], { stdio: 'ignore' });
      } catch {
        throw new Error(`Required command not found on PATH: ${binary}`);
      }
    },
    copyFile: copyFileSync,
    log: console.log,
    makeTempDirectory: mkdtempSync,
    mkdir(path) {
      mkdirSync(path, { recursive: true });
    },
    promoteFile(source, destination) {
      mkdirSync(dirname(destination), { recursive: true });
      const staging = join(dirname(destination), `.${basename(destination)}.${process.pid}.tmp`);
      try {
        copyFileSync(source, staging);
        renameSync(staging, destination);
      } finally {
        rmSync(staging, { force: true });
      }
    },
    readFile: readFileSync,
    removeTree(path) {
      rmSync(path, { recursive: true, force: true });
    },
    run(binary, args, options = {}) {
      console.log(`$ ${binary} ${args.join(' ')}`);
      return execFileSync(binary, args, options);
    },
    tempDirectory: tmpdir,
    writeFile: writeFileSync,
  };
}

export function parseGoVersion(output) {
  const match = /\b(go\d+(?:\.\d+){1,2}(?:[a-z0-9.-]*)?)\b/.exec(String(output));
  if (!match) {
    throw new Error(`Could not parse Go toolchain version from: ${String(output).trim()}`);
  }
  return match[1];
}

export function renderSidecarReadme({ sourceRepository, sourceTag, sourceCommit, goVersion }) {
  return [
    '# Windows scip.exe npm sidecar',
    '',
    `These binaries are built from ${sourceRepository} at ${sourceTag}`,
    `(${sourceCommit}) with ${goVersion}.`,
    'They are bundled in the OS-gated `scip-query-scip-windows` npm package. The main',
    '`scip-query` package declares that sidecar as an optional dependency, so npm',
    'installs it automatically on Windows and `reindex` works without Go or WSL.',
    '',
    `\`${WINDOWS_SIDECAR_PROVENANCE_FILE}\` binds the package version and exact source,`,
    'toolchain, build flags, target machine, file size, and SHA-256 for both binaries.',
    'Build, pack, and publish checks reject missing or mismatched evidence.',
    '',
    'Run `npm run build:scip-windows` to rebuild the binaries and provenance manifest.',
    'Review and commit the manifest change before release. Publishing the main package',
    'verifies the version pin and the complete sidecar provenance before any registry',
    'decision.',
    '',
  ].join('\n');
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    buildScipWindowsSidecar();
  } catch (error) {
    console.error(`Windows sidecar build FAILED:\n  - ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
