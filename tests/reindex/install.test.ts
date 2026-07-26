import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IndexerConfig } from '../../src/domain/types.js';

function fixtureConfig(): IndexerConfig {
  return {
    language: 'typescript',
    indexerBinary: 'scip-typescript',
    checkCommand: 'scip-typescript --version',
    indexArgs: ({ outputPath, indexerBinary }) => ({
      binary: indexerBinary,
      args: ['index', '--output', outputPath],
    }),
    markerFiles: ['tsconfig.json'],
    installMethods: [
      {
        label: 'npm',
        identity: '@sourcegraph/scip-typescript@0.4.0',
        destination: 'npm global prefix',
        prerequisite: 'npm',
        binary: 'npm',
        args: ['install', '-g', '@sourcegraph/scip-typescript@0.4.0'],
      },
    ],
  };
}

async function loadInstaller(opts: { resolveAfterInstall: boolean; throwDuringInstall?: boolean }) {
  let attempted = false;
  const execFileSync = vi.fn((_binary: string, args: readonly string[]) => {
    if (args[0] === 'root' && args[1] === '-g') return '/usr/local/lib/node_modules\n';
    attempted = true;
    if (opts.throwDuringInstall) throw new Error('registry unavailable');
    return Buffer.from('');
  });

  vi.resetModules();
  vi.doMock('node:child_process', () => ({ execFileSync }));
  vi.doMock('node:os', () => ({ platform: () => 'linux' }));
  vi.doMock('../../src/platform/binary.js', () => ({
    isBinaryAvailable: (name: string) => name === 'npm',
  }));
  vi.doMock('../../src/platform/indexer-toolchain.js', () => ({
    describeIndexerBinary: () => 'scip-typescript',
    resolveIndexerBinary: () => (attempted && opts.resolveAfterInstall ? '/usr/local/bin/scip-typescript' : null),
  }));

  return { ...(await import('../../src/reindex/install.js')), execFileSync };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('immutable indexer installation', () => {
  it('reports exact identity, destination, and resolved executable around the fixed installer request', async () => {
    const { tryInstallIndexer, execFileSync } = await loadInstaller({ resolveAfterInstall: true });
    const status: string[] = [];

    expect(tryInstallIndexer(fixtureConfig(), (message) => status.push(message))).toBe(true);
    expect(execFileSync).toHaveBeenCalledWith(
      'npm',
      ['install', '-g', '@sourcegraph/scip-typescript@0.4.0'],
      expect.objectContaining({ shell: false, stdio: 'inherit' }),
    );
    expect(status[0]).toBe(
      'Installing immutable @sourcegraph/scip-typescript@0.4.0 via npm into /usr/local/lib/node_modules; ' +
        'expected executable: scip-typescript.',
    );
    expect(status).toContain(
      'Successfully installed @sourcegraph/scip-typescript@0.4.0 via npm ' +
        '(using /usr/local/bin/scip-typescript); resolved executable: /usr/local/bin/scip-typescript.',
    );
  });

  it('does not report a completed package-manager request as ready when no executable resolves', async () => {
    const { tryInstallIndexer } = await loadInstaller({ resolveAfterInstall: false });
    const status: string[] = [];

    expect(tryInstallIndexer(fixtureConfig(), (message) => status.push(message))).toBe(false);
    expect(status).toContain('npm command completed but scip-typescript was not found on PATH');
    expect(status.some((message) => message.startsWith('Successfully installed'))).toBe(false);
  });

  it('preserves installer failure diagnostics and never reports the tool as ready', async () => {
    const { tryInstallIndexer } = await loadInstaller({
      resolveAfterInstall: false,
      throwDuringInstall: true,
    });
    const status: string[] = [];

    expect(tryInstallIndexer(fixtureConfig(), (message) => status.push(message))).toBe(false);
    expect(status).toContain('npm install failed: registry unavailable');
    expect(status.some((message) => message.startsWith('Successfully installed'))).toBe(false);
  });

  it('refuses compatibility descriptors that do not prove immutable identity and destination', async () => {
    const { tryInstallIndexer, execFileSync } = await loadInstaller({ resolveAfterInstall: true });
    const config = fixtureConfig();
    config.installMethods = [
      {
        label: 'legacy npm',
        prerequisite: 'npm',
        binary: 'npm',
        args: ['install', '-g', '@sourcegraph/scip-typescript'],
      },
    ];
    const status: string[] = [];

    expect(tryInstallIndexer(config, (message) => status.push(message))).toBe(false);
    expect(execFileSync).not.toHaveBeenCalled();
    expect(status).toContain(
      'Refusing legacy npm installation for scip-typescript: ' +
        'the installer descriptor lacks an immutable identity or destination.',
    );
  });
});
