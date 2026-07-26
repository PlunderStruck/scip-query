import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  decodeNpmPackIdentity,
  decodeRegistryDistIdentity,
  hashTarball,
  readTarEntry,
  verifyRegistryTarballIdentity,
} from '../../scripts/scip-windows-package-identity.js';
import {
  createWindowsSidecarProvenance,
  WINDOWS_SIDECAR_PROVENANCE_FILE,
} from '../../scripts/scip-windows-provenance.mjs';
import {
  createWindowsSidecarReleaseRuntime,
  runWindowsSidecarRelease,
  WindowsSidecarCommandError,
  type WindowsSidecarCommandOptions,
  type WindowsSidecarReleaseRuntime,
} from '../../scripts/scip-windows-release.js';
import { createTarGzip, writeNpmPackFixture } from './scip-windows-package-fixture.js';

const SOURCE_COMMIT = 'bf70486060b71bed40f3d6dd19c96da4b3239ead';

describe('Windows sidecar npm package identity', () => {
  it('recomputes local pack hashes and decodes the packed provenance entry', async () => {
    await withTempDir(async (root) => {
      const provenanceBytes = syntheticProvenanceBytes(root);
      const fixture = writeNpmPackFixture({ directory: root, provenanceBytes });

      const identity = decodeNpmPackIdentity(fixture.output, root);
      const noisyIdentity = decodeNpmPackIdentity(`prepack verifier output\n${fixture.output}`, root);

      expect(identity.pack).toMatchObject({
        name: 'scip-query-scip-windows',
        version: '0.13.1',
        entryCount: 2,
      });
      expect(identity.provenance.source.commit).toBe(SOURCE_COMMIT);
      expect(identity.provenanceBytes).toEqual(provenanceBytes);
      expect(noisyIdentity.pack).toEqual(identity.pack);
    });
  });

  it('rejects dishonest npm pack hashes, unsafe filenames, and invalid reports', async () => {
    await withTempDir(async (root) => {
      const provenanceBytes = syntheticProvenanceBytes(root);
      const fixture = writeNpmPackFixture({ directory: root, provenanceBytes });
      const report = JSON.parse(fixture.output);
      report[0].integrity = 'sha512-AAAAAAAA';
      expect(() => decodeNpmPackIdentity(JSON.stringify(report), root)).toThrow('npm pack integrity mismatch');

      report[0].integrity = hashTarball(fixture.tarball).integrity;
      report[0].filename = '../escape.tgz';
      expect(() => decodeNpmPackIdentity(JSON.stringify(report), root)).toThrow('must be a safe basename');

      expect(() => decodeNpmPackIdentity('{}', root)).toThrow('exactly one package report');
      expect(() => decodeNpmPackIdentity('{', root)).toThrow('not valid JSON');
    });
  });

  it('strictly decodes registry dist metadata', () => {
    const expected = {
      shasum: 'a'.repeat(40),
      integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
      tarball: 'https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz',
    };
    expect(decodeRegistryDistIdentity(JSON.stringify(expected))).toEqual(expected);

    for (const malformed of [
      '{',
      '{}',
      JSON.stringify({ ...expected, shasum: 'short' }),
      JSON.stringify({ ...expected, integrity: 'sha1-abc' }),
      JSON.stringify({ ...expected, tarball: 'http://registry.invalid/pkg.tgz' }),
    ]) {
      expect(() => decodeRegistryDistIdentity(malformed)).toThrow();
    }
  });

  it('accepts only registry metadata, downloaded bytes, and provenance that all equal local', async () => {
    await withTempDir(async (root) => {
      const provenanceBytes = syntheticProvenanceBytes(root);
      const localDirectory = join(root, 'local');
      const registryDirectory = join(root, 'registry');
      const localFixture = writeNpmPackFixture({ directory: localDirectory, provenanceBytes });
      const registryFixture = writeNpmPackFixture({
        directory: registryDirectory,
        provenanceBytes,
      });
      const local = decodeNpmPackIdentity(localFixture.output, localDirectory);
      const registryHash = hashTarball(registryFixture.tarball);

      expect(
        verifyRegistryTarballIdentity({
          local,
          registryDist: {
            shasum: registryHash.shasum,
            integrity: registryHash.integrity,
            tarball: 'https://registry.npmjs.org/scip-query-scip-windows/-/same.tgz',
          },
          registryPackOutput: registryFixture.output,
          registryPackDirectory: registryDirectory,
        }).pack.integrity,
      ).toBe(local.pack.integrity);
    });
  });

  it('distinguishes changed local content from a corrupt registry download', async () => {
    await withTempDir(async (root) => {
      const provenanceBytes = syntheticProvenanceBytes(root);
      const localDirectory = join(root, 'local');
      const registryDirectory = join(root, 'registry');
      const localFixture = writeNpmPackFixture({ directory: localDirectory, provenanceBytes });
      const registryFixture = writeNpmPackFixture({
        directory: registryDirectory,
        provenanceBytes,
        payload: 'different-registry-content',
      });
      const local = decodeNpmPackIdentity(localFixture.output, localDirectory);
      const registryHash = hashTarball(registryFixture.tarball);

      expect(() =>
        verifyRegistryTarballIdentity({
          local,
          registryDist: {
            shasum: registryHash.shasum,
            integrity: registryHash.integrity,
            tarball: 'https://registry.npmjs.org/scip-query-scip-windows/-/different.tgz',
          },
          registryPackOutput: registryFixture.output,
          registryPackDirectory: registryDirectory,
        }),
      ).toThrow('sidecar content changed, so bump its version');

      expect(() =>
        verifyRegistryTarballIdentity({
          local,
          registryDist: {
            shasum: 'f'.repeat(40),
            integrity: registryHash.integrity,
            tarball: 'https://registry.npmjs.org/scip-query-scip-windows/-/corrupt.tgz',
          },
          registryPackOutput: registryFixture.output,
          registryPackDirectory: registryDirectory,
        }),
      ).toThrow('downloaded registry shasum mismatch');
    });
  });

  it('requires a version bump when a published predecessor tarball has no provenance', async () => {
    await withTempDir(async (root) => {
      const provenanceBytes = syntheticProvenanceBytes(root);
      const localDirectory = join(root, 'local');
      const registryDirectory = join(root, 'registry');
      const localFixture = writeNpmPackFixture({ directory: localDirectory, provenanceBytes });
      const local = decodeNpmPackIdentity(localFixture.output, localDirectory);
      const registryTarball = createTarGzip([
        { path: 'package/payload.txt', bytes: Buffer.from('same-package-content') },
      ]);
      const registryHash = hashTarball(registryTarball);
      const filename = 'scip-query-scip-windows-0.13.1.tgz';
      mkdirSync(registryDirectory, { recursive: true });
      writeFileSync(join(registryDirectory, filename), registryTarball);
      const registryPackOutput = JSON.stringify([
        {
          name: 'scip-query-scip-windows',
          version: '0.13.1',
          filename,
          size: registryHash.size,
          unpackedSize: Buffer.byteLength('same-package-content'),
          shasum: registryHash.shasum,
          integrity: registryHash.integrity,
          entryCount: 1,
        },
      ]);

      expect(() =>
        verifyRegistryTarballIdentity({
          local,
          registryDist: {
            shasum: registryHash.shasum,
            integrity: registryHash.integrity,
            tarball: 'https://registry.npmjs.org/scip-query-scip-windows/-/missing-provenance.tgz',
          },
          registryPackOutput,
          registryPackDirectory: registryDirectory,
        }),
      ).toThrow('exists without the intended provenance; the sidecar content changed, so bump its version');
    });
  });

  it('bounds decompression and rejects missing, duplicate, truncated, and corrupt tar evidence', () => {
    const manifest = Buffer.from('{}');
    const valid = createTarGzip([{ path: 'package/provenance.json', bytes: manifest }]);
    expect(readTarEntry(valid, 'package/provenance.json')).toEqual(manifest);
    expect(() => readTarEntry(valid, 'package/missing.json')).toThrow('is missing');

    const duplicate = createTarGzip([
      { path: 'package/provenance.json', bytes: manifest },
      { path: 'package/provenance.json', bytes: manifest },
    ]);
    expect(() => readTarEntry(duplicate, 'package/provenance.json')).toThrow('duplicate');
    expect(() => readTarEntry(Buffer.from('not-gzip'), 'package/provenance.json')).toThrow('invalid gzip data');
    expect(() => readTarEntry(valid, 'package/provenance.json', 10)).toThrow('exceeds the 10-byte unpacked limit');

    const corrupt = Buffer.from(valid);
    corrupt[corrupt.length - 9] ^= 0xff;
    expect(() => readTarEntry(corrupt, 'package/provenance.json')).toThrow();
  });
});

describe('Windows sidecar registry release decisions', () => {
  it('packs before an absent-version publish and publishes the verified tarball under finite bounds', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, { registry: 'absent', publish: 'succeed' });

      runWindowsSidecarRelease(fixture.runtime);

      expect(fixture.commandNames()).toEqual(['pack-local', 'view', 'publish']);
      const publish = fixture.calls.find((call) => call.name === 'publish');
      expect(publish?.args[1]).toMatch(/\.tgz$/);
      expect(fixture.calls.every((call) => call.options.timeoutMs > 0)).toBe(true);
      expect(fixture.calls.every((call) => call.options.maxOutputBytes > 0)).toBe(true);
    });
  });

  it('skips an existing version only after metadata, downloaded bytes, and manifest all match', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, { registry: 'same', publish: 'succeed' });

      runWindowsSidecarRelease(fixture.runtime);

      expect(fixture.commandNames()).toEqual(['pack-local', 'view', 'pack-registry']);
      expect(fixture.logs.join('\n')).toContain('identical registry bytes');
    });
  });

  it('requires a version bump when the existing version has different content', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, { registry: 'different', publish: 'succeed' });

      expect(() => runWindowsSidecarRelease(fixture.runtime)).toThrow('sidecar content changed, so bump its version');
      expect(fixture.commandNames()).not.toContain('publish');
    });
  });

  it.each([
    ['auth', 'refusing to treat ambiguity as absence'],
    ['timeout', 'refusing to treat ambiguity as absence'],
    ['ambiguous-not-found', 'refusing to treat ambiguity as absence'],
    ['corrupt', 'not valid JSON'],
    ['metadata-mismatch', 'downloaded registry shasum mismatch'],
  ] as const)('fails closed on %s registry lookup evidence', async (registry, expected) => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, { registry, publish: 'succeed' });

      expect(() => runWindowsSidecarRelease(fixture.runtime)).toThrow(expected);
      expect(fixture.commandNames()).not.toContain('publish');
    });
  });

  it('reconciles a publish conflict only when the winning registry bytes match', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, {
        registry: 'absent',
        publish: 'conflict-same',
      });

      runWindowsSidecarRelease(fixture.runtime);

      expect(fixture.commandNames()).toEqual(['pack-local', 'view', 'publish', 'view', 'pack-registry']);
      expect(fixture.logs.join('\n')).toContain('raced with an identical publisher');
    });
  });

  it('rejects a publish conflict whose winning registry bytes differ', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, {
        registry: 'absent',
        publish: 'conflict-different',
      });

      expect(() => runWindowsSidecarRelease(fixture.runtime)).toThrow(
        'concurrently published version has different content',
      );
    });
  });

  it('packs but never reads or mutates the registry for direct and dry-run invocations', async () => {
    await withTempDir(async (root) => {
      const direct = createReleaseRuntime(root, { registry: 'auth', publish: 'succeed' });
      direct.runtime.env = {};
      runWindowsSidecarRelease(direct.runtime);
      expect(direct.commandNames()).toEqual(['pack-local']);
    });

    await withTempDir(async (root) => {
      const dryRun = createReleaseRuntime(root, { registry: 'auth', publish: 'succeed' });
      dryRun.runtime.env = {
        npm_lifecycle_event: 'prepublishOnly',
        npm_config_dry_run: 'true',
      };
      runWindowsSidecarRelease(dryRun.runtime);
      expect(dryRun.commandNames()).toEqual(['pack-local']);
    });
  });

  it('reports an absent version without publishing in registry-verification mode', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, { registry: 'absent', publish: 'succeed' });

      runWindowsSidecarRelease(fixture.runtime, { registryMode: 'verify-only' });

      expect(fixture.commandNames()).toEqual(['pack-local', 'view']);
      expect(fixture.logs.join('\n')).toContain('ready for a first publish');
    });
  });

  it('does not let inherited environment suppress an authorized sidecar publish', async () => {
    await withTempDir(async (root) => {
      const fixture = createReleaseRuntime(root, { registry: 'absent', publish: 'succeed' });
      fixture.runtime.env.SCIP_WINDOWS_RELEASE_VERIFY_ONLY = 'true';

      runWindowsSidecarRelease(fixture.runtime);

      expect(fixture.commandNames()).toEqual(['pack-local', 'view', 'publish']);
    });
  });

  it('classifies real bounded runner exit, timeout, and output-limit failures', () => {
    const runtime = createWindowsSidecarReleaseRuntime();
    const options: WindowsSidecarCommandOptions = {
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      stdio: ['ignore', 'pipe', 'pipe'],
    };

    expectCommandKind(() => runtime.run(process.execPath, ['-e', 'process.exit(7)'], options), 'exit');
    expectCommandKind(
      () =>
        runtime.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
          ...options,
          timeoutMs: 50,
        }),
      'timeout',
    );
    expectCommandKind(
      () =>
        runtime.run(
          process.execPath,
          ['-e', `process.stdout.write('x'.repeat(${options.maxOutputBytes * 4}))`],
          options,
        ),
      'output-limit',
    );
  });
});

type RegistryScenario =
  | 'absent'
  | 'same'
  | 'different'
  | 'auth'
  | 'timeout'
  | 'ambiguous-not-found'
  | 'corrupt'
  | 'metadata-mismatch';
type PublishScenario = 'succeed' | 'conflict-same' | 'conflict-different';

interface RecordedCommand {
  name: string;
  binary: string;
  args: string[];
  options: WindowsSidecarCommandOptions;
}

function createReleaseRuntime(
  root: string,
  scenario: { registry: RegistryScenario; publish: PublishScenario },
): {
  runtime: WindowsSidecarReleaseRuntime;
  calls: RecordedCommand[];
  logs: string[];
  commandNames(): string[];
} {
  const sidecarDir = writeSyntheticSidecar(join(root, 'packages'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'scip-query',
      version: '0.19.5',
      optionalDependencies: { 'scip-query-scip-windows': '0.13.1' },
    }),
  );
  const provenanceBytes = readFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE));
  const calls: RecordedCommand[] = [];
  const logs: string[] = [];
  let registry = scenario.registry;

  const runtime: WindowsSidecarReleaseRuntime = {
    cwd: () => root,
    env: { npm_lifecycle_event: 'prepublishOnly' },
    log: (message) => logs.push(message),
    makeTempDirectory: mkdtempSync,
    mkdir: (path) => mkdirSync(path, { recursive: true }),
    readFile: readFileSync,
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    run: (binary, args, options) => {
      const name = commandName(args, options, sidecarDir);
      calls.push({ name, binary, args: [...args], options: { ...options } });
      if (name === 'pack-local') {
        return writeNpmPackFixture({
          directory: packDestination(args),
          provenanceBytes,
        }).output;
      }
      if (name === 'view') {
        if (registry === 'absent') throw commandError('exit', binary, args, 'npm error code E404');
        if (registry === 'auth') throw commandError('exit', binary, args, 'npm error code E401');
        if (registry === 'timeout') throw commandError('timeout', binary, args, 'registry timed out');
        if (registry === 'ambiguous-not-found') {
          throw commandError('exit', binary, args, 'registry proxy returned not found without an npm error code');
        }
        if (registry === 'corrupt') return '{';
        const remote = writeNpmPackFixture({
          directory: join(root, 'registry-seed'),
          provenanceBytes,
          payload: registry === 'different' ? 'different-registry-content' : 'same-package-content',
        });
        const identity = hashTarball(remote.tarball);
        return JSON.stringify({
          shasum: registry === 'metadata-mismatch' ? 'f'.repeat(40) : identity.shasum,
          integrity: identity.integrity,
          tarball: 'https://registry.npmjs.org/scip-query-scip-windows/-/scip-query-scip-windows-0.13.1.tgz',
        });
      }
      if (name === 'pack-registry') {
        return writeNpmPackFixture({
          directory: packDestination(args),
          provenanceBytes,
          payload: registry === 'different' ? 'different-registry-content' : 'same-package-content',
        }).output;
      }
      if (name === 'publish') {
        if (scenario.publish === 'succeed') return '';
        registry = scenario.publish === 'conflict-same' ? 'same' : 'different';
        throw commandError('exit', binary, args, 'npm error code E409 publish conflict');
      }
      throw new Error(`unexpected command ${binary} ${args.join(' ')}`);
    },
    tempDirectory: () => root,
  };

  return {
    runtime,
    calls,
    logs,
    commandNames: () => calls.map((call) => call.name),
  };
}

function commandName(args: string[], options: WindowsSidecarCommandOptions, sidecarDir: string): string {
  if (args[0] === 'pack' && options.cwd === sidecarDir) return 'pack-local';
  if (args[0] === 'view') return 'view';
  if (args[0] === 'pack') return 'pack-registry';
  if (args[0] === 'publish') return 'publish';
  return 'unknown';
}

function packDestination(args: string[]): string {
  return args[args.indexOf('--pack-destination') + 1];
}

function commandError(
  kind: 'timeout' | 'output-limit' | 'spawn' | 'exit',
  binary: string,
  args: string[],
  stderr: string,
): WindowsSidecarCommandError {
  return new WindowsSidecarCommandError(kind, binary, args, 1, '', stderr, stderr);
}

function expectCommandKind(action: () => unknown, kind: WindowsSidecarCommandError['kind']): void {
  try {
    action();
    throw new Error('expected command failure');
  } catch (error) {
    expect(error).toBeInstanceOf(WindowsSidecarCommandError);
    expect((error as WindowsSidecarCommandError).kind).toBe(kind);
  }
}

function syntheticProvenanceBytes(root: string): Buffer {
  const sidecarDir = writeSyntheticSidecar(root);
  return readFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE));
}

function writeSyntheticSidecar(root: string): string {
  const sidecarDir = join(root, 'scip-windows');
  mkdirSync(sidecarDir, { recursive: true });
  writeFileSync(
    join(sidecarDir, 'package.json'),
    JSON.stringify({ name: 'scip-query-scip-windows', version: '0.13.1' }),
  );
  writeFileSync(join(sidecarDir, 'scip-win32-x64.exe'), syntheticPe(0x8664));
  writeFileSync(join(sidecarDir, 'scip-win32-arm64.exe'), syntheticPe(0xaa64));
  const manifest = createWindowsSidecarProvenance({
    sidecarDir,
    packageName: 'scip-query-scip-windows',
    packageVersion: '0.13.1',
    sourceCommit: SOURCE_COMMIT,
  });
  writeFileSync(join(sidecarDir, WINDOWS_SIDECAR_PROVENANCE_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
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

async function withTempDir(action: (root: string) => Promise<void> | void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'scip-query-windows-registry-'));
  try {
    await action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
