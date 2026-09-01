import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import type * as ScipCli from '../../src/platform/scip-cli.js';

type ScipCliModule = typeof ScipCli;
type ExecFileSyncMock = (...args: unknown[]) => unknown;

async function loadScipCli(opts: {
  platform: NodeJS.Platform;
  arch: string;
  isBinaryAvailable?: (name: string) => boolean;
  execFileSync?: ExecFileSyncMock;
  existsSync?: (path: string) => boolean;
}) {
  const userIsBinary = opts.isBinaryAvailable;
  const userExec = opts.execFileSync;
  const actualFs = await vi.importActual<typeof NodeFs>('node:fs');
  const isBinaryAvailable = vi.fn(userIsBinary ?? (() => false));
  // scip-cli.ts inlines an `isBinaryAvailable` helper that calls
  // `execFileSync('which'|'where', [name])`. When a test customizes
  // isBinaryAvailable, route which/where probes through the mock so the
  // helper's return value is driven by the test. Otherwise defer to the
  // test's execFileSync (or the no-op default) so unrelated tests keep
  // their existing behavior.
  const execFileSync = vi.fn((cmd: string, args: readonly string[], ...rest: unknown[]) => {
    if (userIsBinary && (cmd === 'which' || cmd === 'where') && Array.isArray(args)) {
      if (isBinaryAvailable(args[0]!)) {
        return opts.platform === 'win32' ? `C:\\tools\\${args[0]}.exe\n` : `/usr/local/bin/${args[0]}\n`;
      }
      throw new Error(`${args[0]} not found`);
    }
    if (userExec) return userExec(cmd, args, ...rest);
    return Buffer.from('');
  });

  vi.resetModules();
  vi.doMock('node:os', () => ({
    platform: () => opts.platform,
    arch: () => opts.arch,
    homedir: () => '/tmp/scip-cli-test-home',
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync,
  }));
  vi.doMock('node:fs', () => ({
    ...actualFs,
    existsSync: vi.fn(opts.existsSync ?? (() => false)),
    readFileSync: actualFs.readFileSync,
  }));

  const mod = (await import('../../src/platform/scip-cli.js')) as ScipCliModule;
  return { ...mod, execFileSync, isBinaryAvailable };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('scip CLI helpers', () => {
  it('detects when scip is installed and trims the reported version', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'which' && args[0] === 'scip') {
        return '/usr/local/bin/scip\n';
      }
      if (cmd === '/usr/local/bin/scip' && args[0] === '--version') {
        return Buffer.from('v0.7.0\n');
      }
      return Buffer.from('');
    });

    const { isScipInstalled, getScipVersion } = await loadScipCli({
      platform: 'linux',
      arch: 'x64',
      execFileSync,
    });

    expect(isScipInstalled()).toBe(true);
    expect(getScipVersion()).toBe('v0.7.0');
    expect(execFileSync).toHaveBeenCalledWith('which', ['scip'], expect.objectContaining({ stdio: 'pipe' }));
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/local/bin/scip',
      ['--version'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('returns null when the scip version probe fails', async () => {
    const execFileSync = vi.fn(() => {
      throw new Error('missing');
    });

    const { getScipVersion } = await loadScipCli({
      platform: 'linux',
      arch: 'x64',
      execFileSync,
    });

    expect(getScipVersion()).toBeNull();
  });

  it('prints platform-specific install instructions for scip', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await loadScipCli({
      platform: 'darwin',
      arch: 'arm64',
    });

    const { printScipInstallInstructions } = await import('../../src/platform/scip-cli.js');
    printScipInstallInstructions();

    expect(log.mock.calls.flat().join('\n')).toContain('go install github.com/sourcegraph/scip/cmd/scip@v0.8.1');
    expect(log.mock.calls.flat().join('\n')).toContain('scip-darwin-arm64.tar.gz');
    expect(log.mock.calls.flat().join('\n')).toContain('https://github.com/sourcegraph/scip/releases/download/v0.8.1/');
  });

  it('uses SCIP_QUERY_SCIP_BIN when scip is not on PATH', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'where') {
        throw new Error('missing');
      }
      if (cmd === 'C:\\tools\\scip.exe' && args[0] === '--version') {
        return Buffer.from('v0.8.1\n');
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { getScipVersion, isScipInstalled, resolveScipBinary } = await loadScipCli({
      platform: 'win32',
      arch: 'x64',
      execFileSync,
      existsSync: (path) => path === 'C:\\tools\\scip.exe',
    });

    const env = { SCIP_QUERY_SCIP_BIN: 'C:\\tools\\scip.exe' };
    expect(resolveScipBinary(env)).toBe('C:\\tools\\scip.exe');
    // isScipInstalled/getScipVersion read process.env directly (matching the
    // real CLI entry point); prove the env var also works through that path.
    const originalEnvVar = process.env['SCIP_QUERY_SCIP_BIN'];
    process.env['SCIP_QUERY_SCIP_BIN'] = 'C:\\tools\\scip.exe';
    try {
      expect(isScipInstalled()).toBe(true);
      expect(getScipVersion()).toBe('v0.8.1');
    } finally {
      if (originalEnvVar === undefined) delete process.env['SCIP_QUERY_SCIP_BIN'];
      else process.env['SCIP_QUERY_SCIP_BIN'] = originalEnvVar;
    }
  });

  it('falls back to nothing when scip is nowhere to be found', async () => {
    const { resolveScipBinary } = await loadScipCli({
      platform: 'win32',
      arch: 'x64',
      isBinaryAvailable: () => false,
      existsSync: () => false,
    });

    expect(resolveScipBinary({ SCIP_QUERY_SCIP_BIN: 'C:\\missing\\scip.exe' })).toBeNull();
  });

  it('tries go install when brew is unavailable and confirms scip afterward', async () => {
    let installed = false;
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'go') {
        installed = true;
      }
      if (cmd === '/usr/local/bin/scip' && args[0] === '--version') {
        return Buffer.from('scip version v0.8.1\n');
      }
      return Buffer.from('');
    });

    const { tryInstallScipCli } = await loadScipCli({
      platform: 'linux',
      arch: 'x64',
      execFileSync,
      isBinaryAvailable: (name) => {
        if (name === 'go') {
          return true;
        }
        if (name === 'scip') {
          return installed;
        }
        return false;
      },
    });

    const status: string[] = [];
    const offline = { fetch: async () => Promise.reject(new Error('offline')) };
    await expect(tryInstallScipCli((message) => status.push(message), offline)).resolves.toBe(true);
    expect(status).toContain('Could not install scip v0.8.1: offline');
    expect(execFileSync).toHaveBeenCalledWith(
      'go',
      ['install', 'github.com/sourcegraph/scip/cmd/scip@v0.8.1'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(status).toContain(
      'Installing immutable github.com/sourcegraph/scip/cmd/scip@v0.8.1 via go install into ' +
        'the Go bin directory (GOBIN or GOPATH/bin); expected executable: scip.',
    );
    expect(status).toContain(
      'Successfully installed github.com/sourcegraph/scip/cmd/scip@v0.8.1; ' +
        'resolved executable: /usr/local/bin/scip; reported version: scip version v0.8.1.',
    );
  });

  it('falls back to manual instructions when auto-install is unavailable', async () => {
    const { tryInstallScipCli } = await loadScipCli({
      platform: 'linux',
      arch: 'x64',
      isBinaryAvailable: () => false,
    });

    const status: string[] = [];
    const offline = { fetch: async () => Promise.reject(new Error('offline')) };
    await expect(tryInstallScipCli((message) => status.push(message), offline)).resolves.toBe(false);
    expect(status).toContain('Could not auto-install scip CLI.');
    expect(status).toContain('Install manually from: https://github.com/sourcegraph/scip/releases/tag/v0.8.1');
  });

  it('installs the reviewed release archive without Go and prefers it over PATH afterwards', async () => {
    const { installScipCliFromRelease, resolveScipDownload, SCIP_RELEASE_DIGESTS, cachedScipBinaryPath } =
      await loadScipCli({ platform: 'linux', arch: 'x64', isBinaryAvailable: () => false });
    const env = { XDG_CACHE_HOME: '/tmp/scip-cli-test-cache' };
    const expectedBinary = cachedScipBinaryPath(env);
    const download = resolveScipDownload('linux', 'x64');
    expect(download).toEqual({
      url: 'https://github.com/sourcegraph/scip/releases/download/v0.8.1/scip-linux-amd64.tar.gz',
      filename: 'scip-linux-amd64.tar.gz',
      sha256: SCIP_RELEASE_DIGESTS['scip-linux-amd64.tar.gz'],
    });
    expect(Object.keys(SCIP_RELEASE_DIGESTS).sort()).toEqual([
      'scip-darwin-amd64.tar.gz',
      'scip-darwin-arm64.tar.gz',
      'scip-linux-amd64.tar.gz',
      'scip-linux-arm64.tar.gz',
    ]);
    expect(resolveScipDownload('freebsd', 'x64')).toBeNull();

    const fetch = vi.fn(async (opts: { cachePath: string; url: string; expectedSha256: string }) => ({
      status: 'downloaded' as const,
      path: opts.cachePath,
      sha256: opts.expectedSha256,
    }));
    const extract = vi.fn();
    const markExecutable = vi.fn();
    const status: string[] = [];
    await expect(
      installScipCliFromRelease((message) => status.push(message), {
        env,
        fetch,
        extract,
        markExecutable,
        probeVersion: () => 'scip version v0.8.1',
      }),
    ).resolves.toBe(expectedBinary);
    expect(fetch).toHaveBeenCalledWith({
      cachePath: expectedBinary.replace(/scip$/, 'scip-linux-amd64.tar.gz'),
      url: download!.url,
      expectedSha256: download!.sha256,
    });
    expect(extract).toHaveBeenCalledWith(
      expectedBinary.replace(/scip$/, 'scip-linux-amd64.tar.gz'),
      expect.any(String),
    );
    expect(markExecutable).toHaveBeenCalledWith(expectedBinary);
    expect(status.at(-1)).toBe(`Installed reviewed scip v0.8.1 at ${expectedBinary}.`);

    // A binary that does not report the pinned version is rejected.
    await expect(
      installScipCliFromRelease(() => undefined, {
        env,
        fetch,
        extract,
        markExecutable,
        probeVersion: () => 'scip version v0.9.0',
      }),
    ).resolves.toBeNull();
  });

  it('keeps postinstall side-effect free', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const scipHelpers = {
      isScipInstalled: vi.fn(() => false),
      getScipVersion: vi.fn(() => null),
      printScipInstallInstructions: vi.fn(),
      tryInstallScipCli: vi.fn(() => false),
    };

    vi.resetModules();
    vi.doMock('node:fs', () => ({
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      symlinkSync: vi.fn(),
      readlinkSync: vi.fn(),
      unlinkSync: vi.fn(),
    }));
    vi.doMock('node:os', () => ({
      homedir: () => '/tmp/scip-query-test-home',
      platform: () => 'linux',
      arch: () => 'x64',
    }));
    vi.doMock('../../src/platform/scip-cli.js', () => scipHelpers);

    const { postinstall } = await import('../../src/runtime/setup.js');
    postinstall();

    expect(scipHelpers.isScipInstalled).not.toHaveBeenCalled();
    expect(scipHelpers.tryInstallScipCli).not.toHaveBeenCalled();
    expect(scipHelpers.printScipInstallInstructions).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain(
      "scip-query installed (Node.js 24 LTS recommended; minimum Node.js 22) -- run 'scip-query setup' in a repo to install skills and build the index.",
    );
  });
});

describe('resolveScipBinaryPure (resolution matrix)', () => {
  // Unmock any node builtins a previous test in this file registered via
  // vi.doMock, so this suite exercises the real, unmocked module — the
  // function under test takes every dependency as a parameter anyway.
  async function loadReal(): Promise<ScipCliModule> {
    vi.doUnmock('node:os');
    vi.doUnmock('node:fs');
    vi.doUnmock('node:child_process');
    vi.doUnmock('../../src/platform/scip-cli.js');
    vi.resetModules();
    return (await import('../../src/platform/scip-cli.js')) as ScipCliModule;
  }

  it('outcome 1: found on PATH', async () => {
    const { resolveScipBinaryPure } = await loadReal();
    const resolution = resolveScipBinaryPure({
      platform: 'win32',
      arch: 'x64',
      env: {},
      isOnPath: () => true,
      fileExists: () => true,
      resolveSidecar: () => null,
    });
    expect(resolution).toEqual({ source: 'path', path: 'scip' });
  });

  it('outcome 2: found via SCIP_QUERY_SCIP_BIN', async () => {
    const { resolveScipBinaryPure } = await loadReal();
    const resolution = resolveScipBinaryPure({
      platform: 'linux',
      arch: 'x64',
      env: { SCIP_QUERY_SCIP_BIN: '/opt/scip' },
      isOnPath: () => false,
      fileExists: (path) => path === '/opt/scip',
      resolveSidecar: () => null,
    });
    expect(resolution).toEqual({ source: 'env', path: '/opt/scip' });
  });

  it('outcome 3: resolved from the Windows npm sidecar', async () => {
    const { resolveScipBinaryPure } = await loadReal();
    const resolution = resolveScipBinaryPure({
      platform: 'win32',
      arch: 'arm64',
      env: {},
      isOnPath: () => false,
      fileExists: (path) => path === '/sidecar/scip-win32-arm64.exe',
      resolveSidecar: (archName) => `/sidecar/scip-win32-${archName}.exe`,
    });
    expect(resolution).toEqual({ source: 'sidecar', path: '/sidecar/scip-win32-arm64.exe' });
  });

  it('outcome 5: the reviewed cached release outranks an arbitrary PATH binary', async () => {
    const { resolveScipBinaryPure } = await loadReal();
    const resolution = resolveScipBinaryPure({
      platform: 'linux',
      arch: 'x64',
      env: {},
      isOnPath: () => true,
      fileExists: () => true,
      resolveSidecar: () => null,
      resolveCached: () => '/home/me/.cache/scip-query/scip/v0.8.1/scip',
    });
    expect(resolution).toEqual({ source: 'cache', path: '/home/me/.cache/scip-query/scip/v0.8.1/scip' });
  });

  it('outcome 4: not found anywhere', async () => {
    const { resolveScipBinaryPure } = await loadReal();
    const resolution = resolveScipBinaryPure({
      platform: 'win32',
      arch: 'x64',
      env: {},
      isOnPath: () => false,
      fileExists: () => false,
      resolveSidecar: () => null,
    });
    expect(resolution).toBeNull();
  });

  it('does not consult the download cache on non-Windows platforms', async () => {
    const { resolveScipBinaryPure } = await loadReal();
    const cachePath = vi.fn(() => '/cache/scip-win32-x64.exe');
    const resolution = resolveScipBinaryPure({
      platform: 'darwin',
      arch: 'x64',
      env: {},
      isOnPath: () => false,
      fileExists: () => true,
      cachePath,
    });
    expect(resolution).toBeNull();
    expect(cachePath).not.toHaveBeenCalled();
  });
});
