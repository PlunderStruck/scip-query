import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cpus, tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import type { SupportedLanguage } from '../../src/domain/types.js';
import { resolveIndexerConcurrency } from '../../src/reindex/indexer-runner.js';

const tempDirs: string[] = [];
const originalIndexerConcurrencyEnv = process.env['SCIP_QUERY_INDEXER_CONCURRENCY'];

function createProject(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'main.ts'), 'export const answer = 42;\n');
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\nname = "fixture"\n');
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (originalIndexerConcurrencyEnv === undefined) {
    delete process.env['SCIP_QUERY_INDEXER_CONCURRENCY'];
  } else {
    process.env['SCIP_QUERY_INDEXER_CONCURRENCY'] = originalIndexerConcurrencyEnv;
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveIndexerConcurrency', () => {
  it('uses a higher adaptive default while clamping to the run count', () => {
    expect(resolveIndexerConcurrency(20)).toBe(Math.min(20, 8, cpus().length));
    expect(resolveIndexerConcurrency(3)).toBe(Math.min(3, 8, cpus().length));
    expect(resolveIndexerConcurrency(1)).toBe(1);
  });

  it('prefers explicit config over env and clamps oversized values', () => {
    process.env['SCIP_QUERY_INDEXER_CONCURRENCY'] = '7';

    expect(resolveIndexerConcurrency(10, 3)).toBe(3);
    expect(resolveIndexerConcurrency(2, 10)).toBe(2);
  });

  it('uses env when config is absent', () => {
    process.env['SCIP_QUERY_INDEXER_CONCURRENCY'] = '5';

    expect(resolveIndexerConcurrency(10)).toBe(5);
  });
});

describe('reindex reliability', () => {
  it('fails closed when a detected language fails and does not cache a partial index as complete', async () => {
    const projectRoot = createProject('scip-query-reindex-partial-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');
    writeFileSync(outputScip, 'old-scip');
    writeFileSync(outputDb, 'old-db');

    const { reindex } = await loadReindexFixture({
      languages: ['typescript', 'python'],
      failIndexers: new Set(['python']),
    });

    await expect(
      reindex({
        projectRoot,
        outputScip,
        outputDb,
        onStatus: () => undefined,
        indexerConcurrency: 1,
      }),
    ).rejects.toThrow(/failed to index all required languages/i);

    expect(readFileSync(outputScip, 'utf-8')).toBe('old-scip');
    expect(readFileSync(outputDb, 'utf-8')).toBe('old-db');
    expect(existsSync(metaPath)).toBe(false);
  });

  it('converts into a temporary database so failed conversion preserves the previous usable DB', async () => {
    const projectRoot = createProject('scip-query-reindex-convert-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    writeFileSync(outputScip, 'old-scip');
    writeFileSync(outputDb, 'old-db');

    const { reindex } = await loadReindexFixture({
      languages: ['typescript'],
      failConvert: true,
    });

    await expect(
      reindex({
        projectRoot,
        outputScip,
        outputDb,
        onStatus: () => undefined,
      }),
    ).rejects.toThrow(/failed to convert scip index/i);

    expect(readFileSync(outputScip, 'utf-8')).toBe('old-scip');
    expect(readFileSync(outputDb, 'utf-8')).toBe('old-db');
  });

  it('writes partial metadata only when partial indexing is explicitly allowed', async () => {
    const projectRoot = createProject('scip-query-reindex-allow-partial-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');

    const { reindex } = await loadReindexFixture({
      languages: ['typescript', 'python'],
      failIndexers: new Set(['python']),
    });

    const result = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      allowPartial: true,
      onStatus: () => undefined,
      indexerConcurrency: 1,
    });

    expect(result.languages).toEqual(['typescript']);
    expect(result.skipped).toEqual([expect.objectContaining({ language: 'python' })]);
    expect(readFileSync(outputDb, 'utf-8')).toBe('new-db');
    expect(JSON.parse(readFileSync(metaPath, 'utf-8'))).toEqual(
      expect.objectContaining({
        status: 'partial',
        requestedLanguages: ['typescript', 'python'],
        indexedLanguages: ['typescript'],
        skipped: [expect.objectContaining({ language: 'python' })],
      }),
    );
  });

  it('retries parallel indexer failures serially before skipping a language', async () => {
    const projectRoot = createProject('scip-query-reindex-retry-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const statuses: string[] = [];

    const { reindex } = await loadReindexFixture({
      languages: ['typescript', 'python'],
      failFirstIndexers: new Set(['python']),
    });

    const result = await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 2,
    });

    expect(result.languages).toEqual(['typescript', 'python']);
    expect(result.skipped).toEqual([]);
    expect(statuses.join('\n')).toContain('Retrying python indexer serially after parallel failure');
  });

  it('reuses unchanged per-language SCIP shards across mixed-language reindexes', async () => {
    const projectRoot = createProject('scip-query-reindex-shards-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const statuses: string[] = [];

    const { reindex, attempts } = await loadReindexFixture({
      languages: ['typescript', 'python'],
    });

    await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 1,
    });
    writeFileSync(join(projectRoot, 'src', 'main.ts'), 'export const answer = 43;\n');
    const second = await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 1,
    });

    expect(second.languages.sort()).toEqual(['python', 'typescript']);
    expect(attempts.get('typescript')).toBe(2);
    expect(attempts.get('python')).toBe(1);
    expect(statuses.join('\n')).toContain('Reusing cached python SCIP shard');
  });

  it('indexes TypeScript workspace project shards and publishes one language output', async () => {
    const projectRoot = createProject('scip-query-reindex-ts-workspace-');
    mkdirSync(join(projectRoot, 'packages/a/src'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages/b/src'), { recursive: true });
    writeFileSync(join(projectRoot, 'packages/a/tsconfig.json'), '{"include":["src"]}\n');
    writeFileSync(join(projectRoot, 'packages/b/tsconfig.json'), '{"include":["src"]}\n');
    writeFileSync(join(projectRoot, 'packages/a/src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectRoot, 'packages/b/src/b.ts'), 'export const b = 1;\n');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const statuses: string[] = [];

    const { reindex, attempts, commands } = await loadReindexFixture({
      languages: ['typescript'],
    });

    const result = await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      typescriptProjectMode: 'workspace',
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 2,
    });

    expect(result.languages).toEqual(['typescript']);
    expect(result.skipped).toEqual([]);
    expect(attempts.get('typescript')).toBe(2);
    expect(
      commands.filter((command) => command.binary === 'typescript-indexer').map((command) => command.args.at(-1)),
    ).toEqual(['packages/a', 'packages/b']);
    expect(statuses.join('\n')).toContain('Indexing TypeScript workspace as 2 project shard(s).');
    expect(JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf-8'))).toEqual(
      expect.objectContaining({
        indexedLanguages: ['typescript'],
        fingerprint: expect.objectContaining({ typescriptProjectMode: 'workspace' }),
      }),
    );
  });

  it('uses an explicit TypeScript project argument even when workspace mode has one project', async () => {
    const projectRoot = createProject('scip-query-reindex-ts-one-project-');
    mkdirSync(join(projectRoot, 'packages/a/src'), { recursive: true });
    writeFileSync(join(projectRoot, 'packages/a/tsconfig.json'), '{"include":["src"]}\n');
    writeFileSync(join(projectRoot, 'packages/a/src/a.ts'), 'export const a = 1;\n');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);

    const { reindex, commands } = await loadReindexFixture({
      languages: ['typescript'],
    });

    await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      typescriptProjectMode: 'workspace',
      typescriptProjects: ['packages/a'],
      onStatus: () => undefined,
    });

    expect(commands.find((command) => command.binary === 'typescript-indexer')?.args.at(-1)).toBe('packages/a');
  });

  it('records rebuilt and reused refresh provenance without changing artifact updatedAt on reuse', async () => {
    const projectRoot = createProject('scip-query-reindex-refresh-meta-');
    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-reindex-refresh-cache-'));
    tempDirs.push(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');

    const { reindex } = await loadReindexFixture({
      languages: ['typescript'],
    });

    const first = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: () => undefined,
      trigger: { kind: 'manual-cli', detail: 'first' },
    });
    const firstMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));

    expect(first.lastRefresh).toEqual(expect.objectContaining({ result: 'rebuilt' }));
    expect(firstMeta.lastRefresh).toEqual(
      expect.objectContaining({
        result: 'rebuilt',
        trigger: { kind: 'manual-cli', detail: 'first' },
      }),
    );

    const second = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: () => undefined,
      trigger: { kind: 'watch-source', detail: 'src/main.ts' },
    });
    const secondMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));

    expect(second.reused).toBe(true);
    expect(second.lastRefresh).toEqual(expect.objectContaining({ result: 'reused' }));
    expect(secondMeta.updatedAt).toBe(firstMeta.updatedAt);
    expect(secondMeta.lastRefresh).toEqual(
      expect.objectContaining({
        result: 'reused',
        trigger: { kind: 'watch-source', detail: 'src/main.ts' },
      }),
    );
  });

  it('records failed refresh provenance without replacing the previous artifacts', async () => {
    const projectRoot = createProject('scip-query-reindex-refresh-failed-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');

    const firstFixture = await loadReindexFixture({ languages: ['typescript'] });
    await firstFixture.reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: () => undefined,
      trigger: { kind: 'manual-cli', detail: 'first' },
    });
    const firstMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));

    const failingFixture = await loadReindexFixture({
      languages: ['typescript'],
      failConvert: true,
    });

    await expect(
      failingFixture.reindex({
        projectRoot,
        outputScip,
        outputDb,
        skipIfUnchanged: false,
        onStatus: () => undefined,
        trigger: { kind: 'watch-git-head', detail: 'HEAD changed' },
      }),
    ).rejects.toThrow(/failed to convert scip index/i);

    const failedMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    expect(readFileSync(outputDb, 'utf-8')).toBe('new-db');
    expect(failedMeta.updatedAt).toBe(firstMeta.updatedAt);
    expect(failedMeta.lastRefresh).toEqual(
      expect.objectContaining({
        result: 'failed',
        trigger: { kind: 'watch-git-head', detail: 'HEAD changed' },
      }),
    );
  });

  it('lets manual refresh replace a stale watcher-owned lock', async () => {
    const projectRoot = createProject('scip-query-reindex-preempt-watch-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    writeFileSync(
      join(cacheDir, 'index.lock'),
      JSON.stringify({
        version: 1,
        pid: 99_999_999,
        projectRoot,
        startedAt: '2026-06-27T00:00:00.000Z',
        trigger: { kind: 'watch-source', detail: 'src/main.ts' },
      }) + '\n',
    );

    const statuses: string[] = [];
    const { reindex } = await loadReindexFixture({ languages: ['typescript'] });

    const result = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: (message) => statuses.push(message),
      trigger: { kind: 'manual-cli', detail: 'manual test' },
    });

    expect(result.languages).toEqual(['typescript']);
    expect(statuses.join('\n')).toContain('Manual reindex preempting watcher refresh');
  });

  it('does not preempt another manual refresh lock', async () => {
    const projectRoot = createProject('scip-query-reindex-manual-lock-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    writeFileSync(
      join(cacheDir, 'index.lock'),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        projectRoot,
        startedAt: '2026-06-27T00:00:00.000Z',
        trigger: { kind: 'manual-cli', detail: 'first manual' },
      }) + '\n',
    );

    const { reindex } = await loadReindexFixture({ languages: ['typescript'] });

    await expect(
      reindex({
        projectRoot,
        outputScip: join(cacheDir, 'index.scip'),
        outputDb: join(cacheDir, 'index.db'),
        onStatus: () => undefined,
        trigger: { kind: 'manual-cli', detail: 'second manual' },
      }),
    ).rejects.toThrow(/another scip-query reindex is already running/i);
  });

  it('refuses to steal a watcher lock when termination cannot be confirmed', async () => {
    // Regression for TLA modeling of specs/reindex-lock/ReindexLock.tla: the
    // preemption path used to discard terminateReindexLockOwner's outcome
    // and force-remove the lock unconditionally (src/reindex/index.ts),
    // which could let a still-alive owner keep running (or a reused PID
    // masquerade as it) while a second reindex publishes concurrently.
    const projectRoot = createProject('scip-query-reindex-preempt-stuck-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    writeFileSync(
      join(cacheDir, 'index.lock'),
      JSON.stringify({
        version: 1,
        pid: 4_242_424,
        projectRoot,
        startedAt: '2026-06-27T00:00:00.000Z',
        trigger: { kind: 'watch-source', detail: 'src/main.ts' },
      }) + '\n',
    );

    const { reindex } = await loadReindexFixture({ languages: ['typescript'] });
    // Simulate a PID that never confirms death: process.kill(pid, 0) never
    // throws, so isProcessAlive keeps reporting it alive through both the
    // SIGTERM and SIGKILL waits.
    const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.useFakeTimers();
    try {
      const pending = reindex({
        projectRoot,
        outputScip: join(cacheDir, 'index.scip'),
        outputDb: join(cacheDir, 'index.db'),
        onStatus: () => undefined,
        trigger: { kind: 'manual-cli', detail: 'manual test' },
      });
      const assertion = expect(pending).rejects.toThrow(/refusing to steal an active lock/i);
      await vi.advanceTimersByTimeAsync(3_100);
      await assertion;
    } finally {
      vi.useRealTimers();
      killSpy.mockRestore();
    }
    // The stale-looking lock must survive an unconfirmed termination — a
    // second reindex must still see it as held.
    expect(existsSync(join(cacheDir, 'index.lock'))).toBe(true);
  });

  it('fails with the sidecar-package guidance when scip is missing on Windows', async () => {
    const projectRoot = createProject('scip-query-reindex-sidecar-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const { reindex } = await loadReindexFixture({
      languages: ['typescript'],
      platform: 'win32',
      scipCli: { resolveScipBinary: () => null },
    });

    await expect(
      reindex({
        projectRoot,
        outputScip,
        outputDb,
        onStatus: () => undefined,
        indexerConcurrency: 1,
      }),
    ).rejects.toThrow(/scip-query-scip-windows[\s\S]*SCIP_QUERY_SCIP_BIN/);
  });
});

async function loadReindexFixture(opts: {
  languages: SupportedLanguage[];
  failIndexers?: ReadonlySet<SupportedLanguage>;
  failFirstIndexers?: ReadonlySet<SupportedLanguage>;
  failConvert?: boolean;
  platform?: NodeJS.Platform;
  scipCli?: {
    resolveScipBinary?: () => string | null;
    tryInstallScipCli?: (onStatus: (message: string) => void) => boolean;
  };
}) {
  vi.resetModules();
  const attempts = new Map<SupportedLanguage, number>();
  const commands: { binary: string; args: readonly string[] }[] = [];

  if (opts.platform) {
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof NodeOs>('node:os');
      return { ...actual, platform: () => opts.platform };
    });
  }

  vi.doMock('node:child_process', async () => {
    const fs = await import('node:fs');
    const execFile = vi.fn(
      (binary: string, args: readonly string[], _options: unknown, callback: (error: Error | null) => void) => {
        commands.push({ binary, args });
        const language = binaryToLanguage(binary);
        if (language) {
          attempts.set(language, (attempts.get(language) ?? 0) + 1);
        }
        if (language && opts.failIndexers?.has(language)) {
          callback(new Error(`${language} failed`));
          return;
        }
        if (language && opts.failFirstIndexers?.has(language) && attempts.get(language) === 1) {
          callback(new Error(`${language} failed once`));
          return;
        }
        const outputPath = outputArg(args);
        if (outputPath) {
          fs.mkdirSync(dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, `${binary} scip`);
        }
        callback(null);
      },
    );
    const execFileSync = vi.fn((cmd: string, args: readonly string[]) => {
      if (cmd === 'git') {
        throw new Error('not a git repo');
      }
      if (cmd === 'scip' && args[0] === 'expt-convert') {
        if (opts.failConvert) {
          throw new Error('convert failed');
        }
        const outputPath = outputArg(args);
        if (outputPath) {
          fs.mkdirSync(dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, 'new-db');
        }
        return Buffer.from('');
      }
      return Buffer.from('');
    });
    return { execFile, execFileSync };
  });

  vi.doMock('../../src/reindex/detect.js', () => ({
    detectLanguages: () => opts.languages,
  }));
  vi.doMock('../../src/reindex/indexers.js', () => ({
    INDEXER_CONFIGS: Object.fromEntries(opts.languages.map((language) => [language, configFor(language)])),
    getIndexerConfig: (language: SupportedLanguage) => configFor(language),
  }));
  vi.doMock('../../src/reindex/install.js', () => ({
    describeIndexerBinary: (config: { indexerBinary: string }) => config.indexerBinary,
    getIndexerExecutionEnv: (_config: unknown, env: NodeJS.ProcessEnv) => env,
    isBinaryAvailable: () => true,
    isIndexerInstalled: () => true,
    resolveIndexerBinary: (config: { indexerBinary: string }) => config.indexerBinary,
    resolveProjectLocalIndexerBinary: () => null,
    tryInstallIndexer: () => true,
  }));
  vi.doMock('../../src/runtime/scip-cli.js', () => ({
    resolveScipBinary: opts.scipCli?.resolveScipBinary ?? (() => 'scip'),
    tryInstallScipCli: opts.scipCli?.tryInstallScipCli ?? (() => true),
  }));
  vi.doMock('../../src/reindex/augment.js', () => ({
    augmentAuxiliaryDocuments: () => ({ scanned: 0, inserted: 0, existing: 0 }),
    auxiliaryDocumentsAugmentationStage: () => ({
      id: 'auxiliary-documents',
      facts: ['auxiliary-document'],
      run: () => ({ scanned: 0, inserted: 0, existing: 0 }),
    }),
  }));
  vi.doMock('../../src/reindex/merge.js', async () => {
    const fs = await import('node:fs');
    return {
      mergeScipFiles: (_inputPaths: readonly string[], outputPath: string) => {
        fs.writeFileSync(outputPath, 'merged-scip');
        return { documentCount: 0, externalSymbolCount: 0, inputCount: _inputPaths.length };
      },
    };
  });

  return { ...(await import('../../src/reindex/index.js')), attempts, commands };
}

function configFor(language: SupportedLanguage) {
  return {
    language,
    indexerBinary: `${language}-indexer`,
    checkCommand: `${language}-indexer --version`,
    indexArgs: ({ outputPath, projectPath }: { outputPath: string; projectPath?: string }) => ({
      binary: `${language}-indexer`,
      args: projectPath ? ['--output', outputPath, projectPath] : ['--output', outputPath],
    }),
    markerFiles: [],
  };
}

function binaryToLanguage(binary: string): SupportedLanguage | null {
  const match = /^([a-z]+)-indexer$/.exec(binary);
  return match ? (match[1] as SupportedLanguage) : null;
}

function outputArg(args: readonly string[]): string | null {
  const index = args.indexOf('--output');
  return index === -1 ? null : (args[index + 1] ?? null);
}
