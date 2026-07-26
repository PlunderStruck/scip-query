import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScipWindowsSidecar, createBuildRuntime, parseGoVersion } from '../../scripts/build-scip-windows.mjs';
import {
  createWindowsSidecarProvenance,
  decodeWindowsSidecarProvenance,
  DEFAULT_SCIP_REPOSITORY,
  DEFAULT_SCIP_TAG,
  inspectPortableExecutable,
  PINNED_GO_VERSION,
  verifyWindowsSidecarProvenance,
  WINDOWS_SIDECAR_PROVENANCE_KIND,
  WINDOWS_SIDECAR_PROVENANCE_FILE,
  WINDOWS_SIDECAR_PROVENANCE_VERSION,
} from '../../scripts/scip-windows-provenance.mjs';
import { runWindowsSidecarRelease, type WindowsSidecarReleaseRuntime } from '../../scripts/scip-windows-release.js';
import { writeNpmPackFixture } from './scip-windows-package-fixture.js';

const SOURCE_COMMIT = 'bf70486060b71bed40f3d6dd19c96da4b3239ead';

describe('Windows sidecar provenance', () => {
  it('verifies the checked-in manifest against both real PE binaries', () => {
    const sidecarDir = 'packages/scip-windows';
    const manifest = verifyWindowsSidecarProvenance({
      sidecarDir,
    });
    const regenerated = createWindowsSidecarProvenance({
      sidecarDir,
      packageName: 'scip-query-scip-windows',
      packageVersion: '0.13.1',
      sourceCommit: SOURCE_COMMIT,
    });

    expect(manifest.source).toEqual({
      repository: DEFAULT_SCIP_REPOSITORY,
      tag: DEFAULT_SCIP_TAG,
      commit: SOURCE_COMMIT,
    });
    expect(manifest).toEqual(regenerated);
    expect(manifest.binaries.map((binary: { peMachine: string }) => binary.peMachine)).toEqual(['AMD64', 'ARM64']);
  });

  it('accepts an exact synthetic x64/arm64 manifest and returns stable evidence', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root);

      const first = verifyWindowsSidecarProvenance({ sidecarDir });
      const second = verifyWindowsSidecarProvenance({ sidecarDir });

      expect(second).toEqual(first);
      expect(first.binaries).toHaveLength(2);
      expect(first.binaries.every((binary: { size: number }) => binary.size === 512)).toBe(true);
    });
  });

  it('keeps the packaged JSON Schema discriminator aligned with the runtime decoder', () => {
    const schema = JSON.parse(readFileSync('docs/schemas/windows-sidecar-provenance.schema.json', 'utf8'));

    expect(schema.properties.kind.const).toBe(WINDOWS_SIDECAR_PROVENANCE_KIND);
    expect(schema.properties.schemaVersion.const).toBe(WINDOWS_SIDECAR_PROVENANCE_VERSION);
    expect(schema.properties.binaries.minItems).toBe(2);
    expect(schema.properties.binaries.maxItems).toBe(2);
  });

  it('rejects stale bytes even when every expected filename exists', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root);
      const binary = join(sidecarDir, 'scip-win32-x64.exe');
      const bytes = readFileSync(binary);
      bytes[bytes.length - 1] ^= 0xff;
      writeFileSync(binary, bytes);

      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'SHA-256 mismatch');
    });
  });

  it('rejects a valid PE for the wrong target architecture', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root);
      writeFileSync(join(sidecarDir, 'scip-win32-x64.exe'), syntheticPe(0xaa64));

      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'actual PE machine mismatch');
    });
  });

  it('rejects missing, malformed, future, and structurally incomplete manifests', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root);
      const manifestFile = join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE);

      writeFileSync(manifestFile, '{');
      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'not valid JSON');

      writeFileSync(manifestFile, JSON.stringify({ kind: 'wrong', schemaVersion: 2 }));
      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'manifest kind mismatch');

      expectProvenanceFailure(
        () =>
          decodeWindowsSidecarProvenance({
            kind: 'scip-query-windows-sidecar-provenance',
            schemaVersion: 2,
          }),
        'Unsupported Windows sidecar provenance schema 2',
      );
    });

    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root, { writeManifest: false });
      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'is missing');
    });
  });

  it('binds repository, tag, toolchain, build flags, package version, and source commit', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root);
      expectProvenanceFailure(
        () =>
          verifyWindowsSidecarProvenance({
            sidecarDir,
            expectedSourceRepository: 'https://example.invalid/fork.git',
          }),
        'SCIP source repository mismatch',
      );
      expectProvenanceFailure(
        () => verifyWindowsSidecarProvenance({ sidecarDir, expectedSourceTag: 'v9.9.9' }),
        'SCIP source tag mismatch',
      );
      expectProvenanceFailure(
        () => verifyWindowsSidecarProvenance({ sidecarDir, expectedGoVersion: 'go9.9.9' }),
        'pinned Go version mismatch',
      );

      mutateManifest(sidecarDir, (manifest) => {
        manifest.build.flags = ['-trimpath'];
      });
      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'Build flags do not match');
    });

    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(root);
      const packageRecord = JSON.parse(readFileSync(join(sidecarDir, 'package.json'), 'utf8'));
      packageRecord.version = '0.13.2';
      writeFileSync(join(sidecarDir, 'package.json'), JSON.stringify(packageRecord));
      expectProvenanceFailure(() => verifyWindowsSidecarProvenance({ sidecarDir }), 'package version mismatch');
    });

    expectProvenanceFailure(
      () =>
        createWindowsSidecarProvenance({
          sidecarDir: '/unused',
          packageName: 'scip-query-scip-windows',
          packageVersion: '0.13.1',
          sourceCommit: 'short',
        }),
      'full 40-character Git commit',
    );
  });

  it('rejects truncated, unsigned, non-PE32+, and unknown-machine executables', () => {
    expectProvenanceFailure(() => inspectPortableExecutable(Buffer.alloc(10), 'short.exe'), 'too short');

    const unsigned = syntheticPe(0x8664);
    unsigned.write('NOPE', 0x80, 'ascii');
    expectProvenanceFailure(() => inspectPortableExecutable(unsigned, 'unsigned.exe'), 'PE signature');

    const pe32 = syntheticPe(0x8664);
    pe32.writeUInt16LE(0x10b, 0x80 + 24);
    expectProvenanceFailure(() => inspectPortableExecutable(pe32, 'pe32.exe'), 'not a PE32+');

    expectProvenanceFailure(() => inspectPortableExecutable(syntheticPe(0x014c), 'x86.exe'), 'unsupported PE machine');
  });

  it('builds into private staging, records exact inputs, promotes, and verifies through injected ports', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = join(root, 'packages', 'scip-windows');
      mkdirSync(sidecarDir, { recursive: true });
      writeFileSync(
        join(sidecarDir, 'package.json'),
        JSON.stringify({ name: 'scip-query-scip-windows', version: '0.13.1' }),
      );
      const commands: string[] = [];
      const runtime = fakeBuildRuntime(root, commands);

      const manifest = buildScipWindowsSidecar({ root }, runtime);

      expect(manifest.source.commit).toBe(SOURCE_COMMIT);
      expect(manifest.toolchain.goVersion).toBe(PINNED_GO_VERSION);
      expect(commands).toContain(`git clone --depth 1 --branch ${DEFAULT_SCIP_TAG} ${DEFAULT_SCIP_REPOSITORY}`);
      expect(commands.filter((command) => command.startsWith('go build'))).toHaveLength(2);
      expect(verifyWindowsSidecarProvenance({ sidecarDir })).toEqual(manifest);
      expect(readFileSync(join(sidecarDir, 'README.md'), 'utf8')).toContain(SOURCE_COMMIT);
    });
  });

  it('does not replace any artifact when a later staged target build fails', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = join(root, 'packages', 'scip-windows');
      mkdirSync(sidecarDir, { recursive: true });
      writeFileSync(
        join(sidecarDir, 'package.json'),
        JSON.stringify({ name: 'scip-query-scip-windows', version: '0.13.1' }),
      );
      writeFileSync(join(sidecarDir, 'README.md'), 'retained\n');
      const runtime = fakeBuildRuntime(root, []);
      const originalRun = runtime.run;
      runtime.run = (binary: string, args: string[], options: { env?: NodeJS.ProcessEnv } = {}) => {
        if (binary === 'go' && args[0] === 'build' && options.env?.GOARCH === 'arm64') {
          throw new Error('injected arm64 build failure');
        }
        return originalRun(binary, args, options);
      };

      expect(() => buildScipWindowsSidecar({ root }, runtime)).toThrow('injected arm64 build failure');
      expect(readFileSync(join(sidecarDir, 'README.md'), 'utf8')).toBe('retained\n');
      expect(existsSync(join(sidecarDir, 'scip-win32-x64.exe'))).toBe(false);
      expect(existsSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE))).toBe(false);
    });
  });

  it('rejects an unpinned Go toolchain before cloning or changing artifacts', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = join(root, 'packages', 'scip-windows');
      mkdirSync(sidecarDir, { recursive: true });
      writeFileSync(
        join(sidecarDir, 'package.json'),
        JSON.stringify({ name: 'scip-query-scip-windows', version: '0.13.1' }),
      );
      const commands: string[] = [];
      const runtime = fakeBuildRuntime(root, commands);

      expect(() => buildScipWindowsSidecar({ root, expectedGoVersion: 'go1.26.5' }, runtime)).toThrow(
        'Go toolchain mismatch',
      );
      expect(commands).toEqual(['go version']);
      expect(existsSync(join(sidecarDir, 'scip-win32-x64.exe'))).toBe(false);
    });
  });

  it('checks provenance before direct or prepublish registry decisions', async () => {
    await withTempDir(async (root) => {
      const sidecarDir = writeSyntheticSidecar(join(root, 'packages'));
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({
          name: 'scip-query',
          version: '0.19.5',
          optionalDependencies: { 'scip-query-scip-windows': '0.13.1' },
        }),
      );
      const logs: string[] = [];
      const commands: string[] = [];
      const provenanceBytes = readFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE));
      const runtime: WindowsSidecarReleaseRuntime = {
        cwd: () => root,
        env: {},
        log: (message) => logs.push(message),
        makeTempDirectory: mkdtempSync,
        mkdir: (path) => mkdirSync(path, { recursive: true }),
        readFile: readFileSync,
        removeTree: (path) => rmSync(path, { recursive: true, force: true }),
        run: (binary, args, options) => {
          commands.push(`${binary} ${args.join(' ')}`);
          if (binary === 'npm' && args[0] === 'pack' && options.cwd === sidecarDir) {
            const destination = args[args.indexOf('--pack-destination') + 1];
            return writeNpmPackFixture({ directory: destination, provenanceBytes }).output;
          }
          throw new Error(`unexpected command: ${binary} ${args.join(' ')}`);
        },
        tempDirectory: () => root,
      };

      runWindowsSidecarRelease(runtime);
      expect(commands).toHaveLength(1);
      expect(commands[0]).toContain('npm pack --json --pack-destination');
      expect(logs.join('\n')).toContain('Verified scip-query-scip-windows@0.13.1 provenance');

      const binary = join(sidecarDir, 'scip-win32-x64.exe');
      const bytes = readFileSync(binary);
      bytes[bytes.length - 1] ^= 0xff;
      writeFileSync(binary, bytes);
      runtime.env = { npm_lifecycle_event: 'prepublishOnly' };

      expect(() => runWindowsSidecarRelease(runtime)).toThrow('SHA-256 mismatch');
      expect(commands).toHaveLength(1);
    });
  });

  it('parses the pinned Go version and rejects unstructured tool output', () => {
    expect(parseGoVersion('go version go1.26.4 darwin/arm64')).toBe('go1.26.4');
    expect(parseGoVersion('go version go1.26rc1 linux/amd64')).toBe('go1.26rc1');
    expect(() => parseGoVersion('not go output')).toThrow('Could not parse Go toolchain version');
  });
});

function writeSyntheticSidecar(root: string, options: { writeManifest?: boolean } = {}): string {
  const sidecarDir = join(root, 'scip-windows');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, 'package.json'),
    JSON.stringify({ name: 'scip-query-scip-windows', version: '0.13.1' }),
  );
  writeFileSync(join(sidecarDir, 'scip-win32-x64.exe'), syntheticPe(0x8664));
  writeFileSync(join(sidecarDir, 'scip-win32-arm64.exe'), syntheticPe(0xaa64));
  if (options.writeManifest !== false) {
    const manifest = createWindowsSidecarProvenance({
      sidecarDir,
      packageName: 'scip-query-scip-windows',
      packageVersion: '0.13.1',
      sourceCommit: SOURCE_COMMIT,
    });
    writeFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return sidecarDir;
}

function syntheticPe(machine: number): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'binary');
  bytes.writeUInt16LE(machine, 0x80 + 4);
  bytes.writeUInt16LE(0x20b, 0x80 + 24);
  return bytes;
}

interface ManifestFixture {
  build: {
    flags: string[];
  };
}

function mutateManifest(sidecarDir: string, mutate: (manifest: ManifestFixture) => void): void {
  const file = join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE);
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as ManifestFixture;
  mutate(manifest);
  writeFileSync(file, JSON.stringify(manifest));
}

function expectProvenanceFailure(action: () => unknown, message: string): void {
  expect(action).toThrow(message);
}

function fakeBuildRuntime(root: string, commands: string[]) {
  const runtime = createBuildRuntime();
  runtime.assertAvailable = () => {};
  runtime.log = () => {};
  runtime.tempDirectory = () => root;
  runtime.promoteFile = copyFileSync;
  runtime.run = (
    binary: string,
    args: string[],
    options: {
      env?: NodeJS.ProcessEnv;
    } = {},
  ) => {
    if (binary === 'git' && args[0] === 'clone') {
      commands.push(`git ${args.slice(0, -1).join(' ')}`);
      const checkoutDir = args.at(-1)!;
      mkdirSync(checkoutDir, { recursive: true });
      writeFileSync(join(checkoutDir, 'LICENSE'), 'license\n');
      return '';
    }
    if (binary === 'git' && args[0] === 'rev-parse') {
      commands.push('git rev-parse HEAD');
      return `${SOURCE_COMMIT}\n`;
    }
    if (binary === 'go' && args[0] === 'version') {
      commands.push('go version');
      return `go version ${PINNED_GO_VERSION} darwin/arm64\n`;
    }
    if (binary === 'go' && args[0] === 'build') {
      commands.push(`go ${args.join(' ')}`);
      const outputPath = args[args.indexOf('-o') + 1];
      const machine = options.env?.GOARCH === 'amd64' ? 0x8664 : 0xaa64;
      writeFileSync(outputPath, syntheticPe(machine));
      return '';
    }
    throw new Error(`unexpected command: ${binary} ${args.join(' ')}`);
  };
  return runtime;
}

async function withTempDir(action: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-windows-provenance-'));
  try {
    await action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
