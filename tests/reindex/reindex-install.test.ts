import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as NodeFs from 'node:fs';
import type * as Install from '../../src/reindex/install.js';

type InstallModule = typeof Install;
type ExecFileSyncMock = (...args: unknown[]) => unknown;

async function loadInstall(
  execFileSyncImpl: ExecFileSyncMock,
  options?: {
    platform?: 'linux' | 'darwin' | 'win32';
    existsSyncImpl?: (path: string) => boolean;
  },
): Promise<InstallModule> {
  vi.resetModules();
  const actualFs = await vi.importActual<typeof NodeFs>('node:fs');
  vi.doMock('node:os', () => ({
    platform: () => options?.platform ?? 'linux',
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync: execFileSyncImpl,
  }));
  vi.doMock('node:fs', () => ({
    existsSync: options?.existsSyncImpl ?? (() => false),
    readFileSync: actualFs.readFileSync,
  }));
  return await import('../../src/reindex/install.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('reindex install helpers', () => {
  it('accepts python indexer aliases when only scip-python-plus is present', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd !== 'which') {
        return Buffer.from('');
      }
      const target = args[0];
      if (target === 'scip-python') {
        throw new Error('missing');
      }
      if (target === 'scip-python-plus') {
        return Buffer.from('/tmp/scip-python-plus\n');
      }
      throw new Error(`unexpected binary check: ${String(target)}`);
    });

    const { describeIndexerBinary, isIndexerInstalled, resolveIndexerBinary } = await loadInstall(execFileSync);
    const config = {
      language: 'python' as const,
      indexerBinary: 'scip-python',
      binaryAliases: ['scip-python-plus'],
      checkCommand: 'scip-python --version',
      indexArgs: ({ outputPath, indexerBinary }: { outputPath: string; indexerBinary: string }) => ({
        binary: indexerBinary,
        args: ['index', '--output', outputPath],
      }),
      markerFiles: ['pyproject.toml'],
    };

    expect(describeIndexerBinary(config)).toBe('scip-python or scip-python-plus');
    expect(resolveIndexerBinary(config)).toBe('scip-python-plus');
    expect(isIndexerInstalled(config)).toBe(true);
  });

  it('resolves the bundled scip-python-plus bin when no python indexer is on PATH', async () => {
    const execFileSync = vi.fn((cmd: string) => {
      if (cmd === 'which') {
        throw new Error('missing');
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const { isIndexerInstalled, resolveIndexerBinary } = await loadInstall(execFileSync);
    const config = {
      language: 'python' as const,
      indexerBinary: 'scip-python-plus',
      binaryAliases: ['scip-python'],
      checkCommand: 'scip-python-plus --version',
      indexArgs: ({ outputPath, indexerBinary }: { outputPath: string; indexerBinary: string }) => ({
        binary: indexerBinary,
        args: ['index', '--output', outputPath],
      }),
      markerFiles: ['pyproject.toml'],
      bundledNpmPackage: 'scip-python-plus',
    };

    expect(resolveIndexerBinary(config)).toMatch(/node_modules\/scip-python-plus\/index\.js$/);
    expect(isIndexerInstalled(config)).toBe(true);
  });

  it('resolves Homebrew dotnet@9 into the indexer environment for scip-dotnet', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[], opts?: { env?: Record<string, string> }) => {
      if (cmd === 'which' && args[0] === 'brew') {
        return Buffer.from('/opt/homebrew/bin/brew\n');
      }
      if (cmd === 'brew' && args[0] === '--prefix' && args[1] === 'dotnet@9') {
        return Buffer.from('/opt/homebrew/opt/dotnet@9\n');
      }
      if (cmd === 'scip-dotnet' && args[0] === '--version') {
        if (opts?.env?.['DOTNET_ROOT'] === '/opt/homebrew/opt/dotnet@9/libexec') {
          return Buffer.from('scip-dotnet 0.8.0\n');
        }
        throw new Error('missing Microsoft.NETCore.App 9.0.0');
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { getIndexerExecutionEnv } = await loadInstall(execFileSync, {
      platform: 'darwin',
      existsSyncImpl: (path) => path === '/opt/homebrew/opt/dotnet@9/libexec' || path === '/opt/homebrew/opt/dotnet/libexec',
    });

    const config = {
      language: 'csharp' as const,
      indexerBinary: 'scip-dotnet',
      checkCommand: 'scip-dotnet --version',
      indexArgs: ({ outputPath }: { outputPath: string }) => ({
        binary: 'scip-dotnet',
        args: ['index', '--output', outputPath],
      }),
      markerFiles: ['*.csproj'],
    };

    const env = getIndexerExecutionEnv(config, {
      PATH: '/usr/bin',
      DOTNET_ROOT: '/opt/homebrew/opt/dotnet/libexec',
    });
    expect(env['DOTNET_ROOT']).toBe('/opt/homebrew/opt/dotnet@9/libexec');
  });

  it('reports scip-dotnet as runnable when dotnet@9 is available via DOTNET_ROOT', async () => {
    const execFileSync = vi.fn((cmd: string, args: readonly string[], opts?: { env?: Record<string, string> }) => {
      if (cmd === 'which' && args[0] === 'scip-dotnet') {
        return Buffer.from('/usr/local/bin/scip-dotnet\n');
      }
      if (cmd === 'which' && args[0] === 'brew') {
        return Buffer.from('/opt/homebrew/bin/brew\n');
      }
      if (cmd === 'brew' && args[0] === '--prefix' && args[1] === 'dotnet@9') {
        return Buffer.from('/opt/homebrew/opt/dotnet@9\n');
      }
      if (cmd === 'scip-dotnet' && args[0] === '--version') {
        if (opts?.env?.['DOTNET_ROOT'] === '/opt/homebrew/opt/dotnet@9/libexec') {
          return Buffer.from('scip-dotnet 0.8.0\n');
        }
        throw new Error('missing Microsoft.NETCore.App 9.0.0');
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(' ')}`);
    });

    const { getIndexerDependencyStatus } = await loadInstall(execFileSync, {
      platform: 'darwin',
      existsSyncImpl: (path) => path === '/opt/homebrew/opt/dotnet@9/libexec',
    });

    const config = {
      language: 'vb' as const,
      indexerBinary: 'scip-dotnet',
      checkCommand: 'scip-dotnet --version',
      indexArgs: ({ outputPath }: { outputPath: string }) => ({
        binary: 'scip-dotnet',
        args: ['index', '--output', outputPath],
      }),
      markerFiles: ['*.vbproj'],
      installUrl: 'https://github.com/sourcegraph/scip-dotnet/releases',
    };

    const status = getIndexerDependencyStatus(config);
    expect(status.installed).toBe(true);
    expect(status.runnable).toBe(true);
    expect(status.note).toContain('.NET 9 runtime');
  });
});
