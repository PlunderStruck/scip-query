import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SupportedLanguage } from '../../src/domain/types.js';

const tempDirs: string[] = [];

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
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
});

async function loadReindexFixture(opts: {
  languages: SupportedLanguage[];
  failIndexers?: ReadonlySet<SupportedLanguage>;
  failFirstIndexers?: ReadonlySet<SupportedLanguage>;
  failConvert?: boolean;
}) {
  vi.resetModules();
  const attempts = new Map<SupportedLanguage, number>();

  vi.doMock('node:child_process', async () => {
    const fs = await import('node:fs');
    const execFile = vi.fn(
      (binary: string, args: readonly string[], _options: unknown, callback: (error: Error | null) => void) => {
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
    tryInstallScipCli: () => true,
  }));
  vi.doMock('../../src/reindex/augment.js', () => ({
    augmentAuxiliaryDocuments: () => ({ scanned: 0, inserted: 0, existing: 0 }),
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

  return { ...(await import('../../src/reindex/index.js')), attempts };
}

function configFor(language: SupportedLanguage) {
  return {
    language,
    indexerBinary: `${language}-indexer`,
    checkCommand: `${language}-indexer --version`,
    indexArgs: ({ outputPath }: { outputPath: string }) => ({
      binary: `${language}-indexer`,
      args: ['--output', outputPath],
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
