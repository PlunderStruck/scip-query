import { afterEach, describe, expect, it, vi } from 'vitest';

type InstallModule = typeof import('../src/reindex/install.js');

async function loadInstall(execFileSyncImpl: (...args: any[]) => any): Promise<InstallModule> {
  vi.resetModules();
  vi.doMock('node:os', () => ({
    platform: () => 'linux',
  }));
  vi.doMock('node:child_process', () => ({
    execFileSync: execFileSyncImpl,
  }));
  return await import('../src/reindex/install.js');
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
});
