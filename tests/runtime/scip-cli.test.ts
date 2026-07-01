import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import type * as ScipCli from '../../src/runtime/scip-cli.js';

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
      if (isBinaryAvailable(args[0]!)) return Buffer.from('');
      throw new Error(`${args[0]} not found`);
    }
    if (userExec) return userExec(cmd, args, ...rest);
    return Buffer.from('');
  });

  vi.resetModules();
  vi.doMock('node:os', () => ({
    platform: () => opts.platform,
    arch: () => opts.arch,
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync,
  }));
  vi.doMock('node:fs', () => ({
    existsSync: vi.fn(opts.existsSync ?? (() => false)),
    readFileSync: actualFs.readFileSync,
  }));

  const mod = (await import('../../src/runtime/scip-cli.js')) as ScipCliModule;
  return { ...mod, execFileSync, isBinaryAvailable };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('scip CLI helpers', () => {
  it('detects when scip is installed and trims the reported version', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'scip' && args[0] === '--version') {
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
    expect(execFileSync).toHaveBeenCalledWith('scip', ['--version'], expect.objectContaining({ stdio: 'pipe' }));
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

    const { printScipInstallInstructions } = await import('../../src/runtime/scip-cli.js');
    printScipInstallInstructions();

    expect(log.mock.calls.flat().join('\n')).toContain('brew install sourcegraph/scip/scip');
    expect(log.mock.calls.flat().join('\n')).toContain('scip-darwin-arm64.tar.gz');
    expect(log.mock.calls.flat().join('\n')).toContain('https://github.com/sourcegraph/scip/releases/download/v0.8.1/');
  });

  it('uses the managed Windows scip binary when scip is not on PATH', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'where') {
        throw new Error('missing');
      }
      if (cmd.endsWith('/vendor/scip/win32-x64/scip.exe') && args[0] === '--version') {
        return Buffer.from('v0.8.1\n');
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { getScipVersion, isScipInstalled, resolveScipBinary } = await loadScipCli({
      platform: 'win32',
      arch: 'x64',
      execFileSync,
      existsSync: (path) => path.endsWith('/package.json') || path.endsWith('/vendor/scip/win32-x64/scip.exe'),
    });

    const resolved = resolveScipBinary();
    expect(resolved).toMatch(/vendor\/scip\/win32-x64\/scip\.exe$/);
    expect(isScipInstalled()).toBe(true);
    expect(getScipVersion()).toBe('v0.8.1');
    expect(execFileSync).toHaveBeenCalledWith(
      expect.stringMatching(/vendor\/scip\/win32-x64\/scip\.exe$/),
      ['--version'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('does not print nonexistent upstream Windows download assets', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await loadScipCli({
      platform: 'win32',
      arch: 'x64',
    });

    const { printScipInstallInstructions } = await import('../../src/runtime/scip-cli.js');
    printScipInstallInstructions();

    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Windows installs should include a managed scip.exe');
    expect(output).toContain('npm run build:scip-windows');
    expect(output).toContain('https://github.com/sourcegraph/scip/releases/tag/v0.8.1');
    expect(output).not.toContain('scip-windows-amd64.zip');
  });

  it('tries go install when brew is unavailable and confirms scip afterward', async () => {
    let installed = false;
    const execFileSync = vi.fn((cmd: string) => {
      if (cmd === 'go') {
        installed = true;
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
    expect(tryInstallScipCli((message) => status.push(message))).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'go',
      ['install', 'github.com/sourcegraph/scip/cmd/scip@latest'],
      expect.objectContaining({ stdio: 'inherit' }),
    );
    expect(status).toContain('Installing scip CLI via go install...');
    expect(status).toContain('Successfully installed scip CLI via go install');
  });

  it('falls back to manual instructions when auto-install is unavailable', async () => {
    const { tryInstallScipCli } = await loadScipCli({
      platform: 'linux',
      arch: 'x64',
      isBinaryAvailable: () => false,
    });

    const status: string[] = [];
    expect(tryInstallScipCli((message) => status.push(message))).toBe(false);
    expect(status).toContain('Could not auto-install scip CLI.');
    expect(status).toContain('Install manually from: https://github.com/sourcegraph/scip/releases');
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
    vi.doMock('../../src/runtime/scip-cli.js', () => scipHelpers);

    const { postinstall } = await import('../../src/runtime/setup.js');
    postinstall();

    expect(scipHelpers.isScipInstalled).not.toHaveBeenCalled();
    expect(scipHelpers.tryInstallScipCli).not.toHaveBeenCalled();
    expect(scipHelpers.printScipInstallInstructions).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join('\n')).toContain(
      "scip-query installed -- run 'scip-query setup' in a repo to enable skills, hooks, and the index.",
    );
  });
});
