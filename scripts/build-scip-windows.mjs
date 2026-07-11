#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCIP_VERSION = process.env.SCIP_VERSION ?? 'v0.8.1';
const SCIP_REPO_URL = process.env.SCIP_REPO_URL ?? 'https://github.com/scip-code/scip.git';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR = join(ROOT, 'packages', 'scip-windows');

const TARGETS = [
  { goarch: 'amd64', packageArch: 'x64' },
  { goarch: 'arm64', packageArch: 'arm64' },
];

function run(binary, args, options = {}) {
  console.log(`$ ${binary} ${args.join(' ')}`);
  execFileSync(binary, args, {
    stdio: 'inherit',
    ...options,
  });
}

function assertAvailable(binary) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  try {
    execFileSync(probe, [binary], { stdio: 'ignore' });
  } catch {
    throw new Error(`Required command not found on PATH: ${binary}`);
  }
}

assertAvailable('git');
assertAvailable('go');

const workDir = mkdtempSync(join(tmpdir(), 'scip-query-scip-'));

try {
  const checkoutDir = join(workDir, 'scip');
  run('git', ['clone', '--depth', '1', '--branch', SCIP_VERSION, SCIP_REPO_URL, checkoutDir]);
  mkdirSync(VENDOR_DIR, { recursive: true });
  copyFileSync(join(checkoutDir, 'LICENSE'), join(VENDOR_DIR, 'LICENSE.scip'));
  writeFileSync(
    join(VENDOR_DIR, 'README.md'),
    [
      '# Windows scip.exe npm sidecar',
      '',
      `These binaries are built from ${SCIP_REPO_URL} at ${SCIP_VERSION}.`,
      'They are bundled in the OS-gated `scip-query-scip-windows` npm package. The main',
      '`scip-query` package declares that sidecar as an optional dependency, so npm',
      'installs it automatically on Windows and `reindex` works without Go or WSL.',
      '',
      'Run `npm run build:scip-windows` to rebuild the binaries. Publishing the main',
      'package verifies the version pin, builds missing binaries, and publishes the',
      'matching sidecar first.',
      '',
    ].join('\n'),
  );

  for (const target of TARGETS) {
    const outputPath = join(VENDOR_DIR, `scip-win32-${target.packageArch}.exe`);
    mkdirSync(VENDOR_DIR, { recursive: true });

    run('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', outputPath, './cmd/scip'], {
      cwd: checkoutDir,
      env: {
        ...process.env,
        CGO_ENABLED: '0',
        GOOS: 'windows',
        GOARCH: target.goarch,
      },
    });
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
