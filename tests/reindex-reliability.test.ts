import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SupportedLanguage } from '../src/domain/types.js';

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

    await expect(reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: () => undefined,
      indexerConcurrency: 1,
    })).rejects.toThrow(/failed to index all required languages/i);

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

    await expect(reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: () => undefined,
    })).rejects.toThrow(/failed to convert scip index/i);

    expect(readFileSync(outputScip, 'utf-8')).toBe('old-scip');
    expect(readFileSync(outputDb, 'utf-8')).toBe('old-db');
  });
});

async function loadReindexFixture(opts: {
  languages: SupportedLanguage[];
  failIndexers?: ReadonlySet<SupportedLanguage>;
  failConvert?: boolean;
}) {
  vi.resetModules();

  vi.doMock('node:child_process', async () => {
    const fs = await import('node:fs');
    const execFile = vi.fn((
      binary: string,
      args: readonly string[],
      _options: unknown,
      callback: (error: Error | null) => void,
    ) => {
      const language = binaryToLanguage(binary);
      if (language && opts.failIndexers?.has(language)) {
        callback(new Error(`${language} failed`));
        return;
      }
      const outputPath = outputArg(args);
      if (outputPath) {
        fs.mkdirSync(dirname(outputPath), { recursive: true });
        fs.writeFileSync(outputPath, `${binary} scip`);
      }
      callback(null);
    });
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

  vi.doMock('../src/reindex/detect.js', () => ({
    detectLanguages: () => opts.languages,
  }));
  vi.doMock('../src/reindex/indexers.js', () => ({
    INDEXER_CONFIGS: Object.fromEntries(opts.languages.map((language) => [language, configFor(language)])),
    getIndexerConfig: (language: SupportedLanguage) => configFor(language),
  }));
  vi.doMock('../src/reindex/install.js', () => ({
    describeIndexerBinary: (config: { indexerBinary: string }) => config.indexerBinary,
    getIndexerExecutionEnv: (_config: unknown, env: NodeJS.ProcessEnv) => env,
    isBinaryAvailable: () => true,
    isIndexerInstalled: () => true,
    resolveIndexerBinary: (config: { indexerBinary: string }) => config.indexerBinary,
    resolveProjectLocalIndexerBinary: () => null,
    tryInstallIndexer: () => true,
  }));
  vi.doMock('../src/runtime/scip-cli.js', () => ({
    tryInstallScipCli: () => true,
  }));
  vi.doMock('../src/reindex/augment.js', () => ({
    augmentAuxiliaryDocuments: () => ({ scanned: 0, inserted: 0, existing: 0 }),
  }));

  return await import('../src/reindex/index.js');
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
  return match ? match[1] as SupportedLanguage : null;
}

function outputArg(args: readonly string[]): string | null {
  const index = args.indexOf('--output');
  return index === -1 ? null : args[index + 1] ?? null;
}
