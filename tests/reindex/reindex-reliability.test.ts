import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as NodeFs from 'node:fs';
import { dirname, join } from 'node:path';
import { cpus, tmpdir } from 'node:os';
import type * as NodeOs from 'node:os';
import type { SupportedLanguage } from '../../src/domain/types.js';
import type * as AffectedShadow from '../../src/reindex/affected-shadow.js';
import { resolveIndexerConcurrency } from '../../src/reindex/indexer-runner.js';
import { projectShardSlug } from '../../src/reindex/project-shards.js';

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

describe('reindex cache cleanup', () => {
  it('removes only abandoned real reindex workspaces while holding the reindex lock', async () => {
    const projectRoot = createProject('scip-query-reindex-stale-workspaces-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const staleDir = join(cacheDir, 'reindex-stale');
    const unrelatedDir = join(cacheDir, 'language-indexes');
    const prefixedFile = join(cacheDir, 'reindex-not-a-directory');
    const symlinkTarget = mkdtempSync(join(tmpdir(), 'scip-query-reindex-symlink-target-'));
    tempDirs.push(symlinkTarget);
    const prefixedSymlink = join(cacheDir, 'reindex-symlink');
    mkdirSync(staleDir);
    mkdirSync(unrelatedDir);
    writeFileSync(join(staleDir, 'partial-index.db'), 'partial');
    writeFileSync(prefixedFile, 'keep');
    symlinkSync(symlinkTarget, prefixedSymlink);
    const statuses: string[] = [];
    const { reindex } = await loadReindexFixture({ languages: ['typescript'] });

    await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 1,
    });

    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(unrelatedDir)).toBe(true);
    expect(existsSync(prefixedFile)).toBe(true);
    expect(existsSync(prefixedSymlink)).toBe(true);
    expect(statuses).toContain('Removed 1 abandoned reindex workspace(s)');
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

  it('reports shard diagnostics distinguishing reused and rerun languages (plan6 6.5.2)', async () => {
    const projectRoot = createProject('scip-query-reindex-shard-diagnostics-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);

    const { reindex } = await loadReindexFixture({
      languages: ['typescript', 'python'],
    });

    await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: () => undefined,
      indexerConcurrency: 1,
    });
    writeFileSync(join(projectRoot, 'src', 'main.ts'), 'export const answer = 43;\n');
    const second = await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: () => undefined,
      indexerConcurrency: 1,
    });

    expect(second.shards).toBeDefined();
    const shards = second.shards ?? [];
    const python = shards.find((shard) => shard.language === 'python');
    const typescript = shards.find((shard) => shard.language === 'typescript');

    expect(python).toEqual(
      expect.objectContaining({
        id: 'python',
        reused: true,
        durationMs: 0,
      }),
    );
    expect(python?.missReason).toBeUndefined();
    expect(python?.command).toBeUndefined();
    expect(python?.fingerprint).toEqual(expect.any(String));
    expect(python?.outputBytes).toEqual(expect.any(Number));

    expect(typescript).toEqual(
      expect.objectContaining({
        id: 'typescript',
        reused: false,
        missReason: expect.stringMatching(/inputs changed/i),
      }),
    );
    expect(typescript?.command).toContain('typescript-indexer');
    expect(typescript?.durationMs).toBeGreaterThanOrEqual(0);
    expect(typescript?.outputBytes).toEqual(expect.any(Number));
  });

  it('publishes affected TypeScript documents through the incremental SQLite patcher', async () => {
    const projectRoot = createProject('scip-query-reindex-incremental-sqlite-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const statuses: string[] = [];
    const { reindex, attempts } = await loadReindexFixture({
      languages: ['typescript'],
      incrementalTypeScript: true,
    });

    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const answer = 43;\n');
    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: (message) => statuses.push(message),
    });

    expect(attempts.get('typescript')).toBe(1);
    expect(readFileSync(outputDb, 'utf8')).toBe('incrementally-patched-db');
    expect(JSON.parse(readFileSync(join(cacheDir, '.scipquery-generations/state.json'), 'utf8')).publication).toEqual(
      expect.objectContaining({
        mode: 'incremental',
        validation: 'passed',
        affectedDocumentCount: 1,
        changedDocumentCount: 1,
        patchDurationMs: 3,
      }),
    );
    expect(statuses.join('\n')).toContain('Converting 1 affected TypeScript document(s) to SQLite');
    expect(statuses.join('\n')).toContain('Patched 1 SQLite document(s)');
  });

  it('publishes repeated changed-document SQLite generations while preserving a deferred whole SCIP companion', async () => {
    const projectRoot = createProject('scip-query-reindex-deferred-scip-');
    const cacheDir = join(projectRoot, '.scipquery-cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');
    const { reindex, attempts } = await loadReindexFixture({
      languages: ['typescript'],
      deferredIncrementalTypeScript: true,
    });

    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });
    const baseScip = readFileSync(outputScip, 'utf8');
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const answer = 43;\n');
    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const answer = 44;\n');
    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });

    expect(attempts.get('typescript')).toBe(1);
    expect(readFileSync(outputScip, 'utf8')).toBe(baseScip);
    expect(JSON.parse(readFileSync(metaPath, 'utf8'))).toEqual(
      expect.objectContaining({ scipCompanion: 'deferred', languageFingerprints: {} }),
    );
    expect(JSON.parse(readFileSync(join(cacheDir, '.scipquery-generations/state.json'), 'utf8')).publication).toEqual(
      expect.objectContaining({
        mode: 'incremental',
        scipCompanion: 'deferred',
        typescriptOverlayGeneration: 'next-generation',
      }),
    );
  });

  it('falls back to complete conversion when incremental SQLite publication rejects', async () => {
    const projectRoot = createProject('scip-query-reindex-incremental-fallback-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const statuses: string[] = [];
    const { reindex, attempts } = await loadReindexFixture({
      languages: ['typescript'],
      incrementalTypeScript: true,
      failIncrementalPatch: true,
    });

    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const answer = 43;\n');
    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: (message) => statuses.push(message),
    });

    expect(attempts.get('typescript')).toBe(1);
    expect(readFileSync(outputDb, 'utf8')).toBe('new-db');
    expect(JSON.parse(readFileSync(join(cacheDir, '.scipquery-generations/state.json'), 'utf8')).publication).toEqual(
      expect.objectContaining({
        mode: 'full',
        fallbackReason: 'candidate SQLite generation schema changed for table documents',
      }),
    );
    expect(statuses.join('\n')).toContain(
      'Incremental SQLite publication unavailable: candidate SQLite generation schema changed for table documents',
    );
    expect(statuses.join('\n')).toContain('Falling back to complete conversion');
  });

  it('reconstructs a deferred whole SCIP companion before full-conversion fallback', async () => {
    const projectRoot = createProject('scip-query-reindex-deferred-fallback-');
    const cacheDir = join(projectRoot, '.scipquery-cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const statuses: string[] = [];
    const { reindex } = await loadReindexFixture({
      languages: ['typescript'],
      deferredIncrementalTypeScript: true,
      failIncrementalPatch: true,
    });

    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });
    writeFileSync(join(projectRoot, 'src/main.ts'), 'export const answer = 43;\n');
    await reindex({ projectRoot, outputScip, outputDb, onStatus: (message) => statuses.push(message) });

    expect(readFileSync(outputScip, 'utf8')).toBe('materialized-deferred-scip');
    expect(JSON.parse(readFileSync(join(cacheDir, 'meta.json'), 'utf8')).scipCompanion).toBe('current');
    expect(JSON.parse(readFileSync(join(cacheDir, '.scipquery-generations/state.json'), 'utf8')).publication).toEqual(
      expect.objectContaining({ mode: 'full', scipCompanion: 'current' }),
    );
    expect(statuses.join('\n')).toContain('Materializing the deferred whole TypeScript SCIP companion');
  });

  it('reports every shard as reused when the whole project index is unchanged (plan6 6.5.2)', async () => {
    const projectRoot = createProject('scip-query-reindex-shard-full-reuse-');
    // Use the real project-local cache directory name (matches
    // PROJECT_ARTIFACT_DIRS in src/platform/project-files.ts) so meta.json
    // and the language shard cache are excluded from the project
    // fingerprint, the same as a real `.scipquery-cache`-configured project.
    // A plain `.cache` dir (as most other fixtures in this file use) is not
    // in that exclusion list, so its nested meta.json would count toward the
    // fingerprint and this reuse path would never trigger.
    const cacheDir = join(projectRoot, '.scipquery-cache');
    mkdirSync(cacheDir);

    const { reindex } = await loadReindexFixture({
      languages: ['typescript', 'python'],
    });

    await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: () => undefined,
      indexerConcurrency: 1,
    });
    const second = await reindex({
      projectRoot,
      outputScip: join(cacheDir, 'index.scip'),
      outputDb: join(cacheDir, 'index.db'),
      onStatus: () => undefined,
      indexerConcurrency: 1,
    });

    expect(second.reused).toBe(true);
    expect(second.shards?.length).toBe(2);
    expect(second.shards?.every((shard) => shard.reused)).toBe(true);
    expect(second.shards?.map((shard) => shard.language).sort()).toEqual(['python', 'typescript']);
  });

  it('repairs a malformed generation from cached language shards without rerunning indexers', async () => {
    const projectRoot = createProject('scip-query-reindex-generation-repair-');
    const cacheDir = join(projectRoot, '.scipquery-cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const { reindex, attempts } = await loadReindexFixture({ languages: ['typescript', 'python'] });

    await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });
    const attemptsAfterFirst = new Map(attempts);
    writeFileSync(join(cacheDir, '.scipquery-generations/state.json'), '{');
    const repaired = await reindex({ projectRoot, outputScip, outputDb, onStatus: () => undefined });

    expect(repaired.reused).toBe(false);
    expect(attempts).toEqual(attemptsAfterFirst);
    expect(JSON.parse(readFileSync(join(cacheDir, '.scipquery-generations/state.json'), 'utf8')).publication).toEqual(
      expect.objectContaining({ mode: 'full', validation: 'passed' }),
    );
  });

  it('refreshes metadata only when non-language files change and every language shard is reusable', async () => {
    const projectRoot = createProject('scip-query-reindex-shard-metadata-only-');
    const cacheDir = join(projectRoot, '.scipquery-cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');
    const statuses: string[] = [];

    const { reindex, attempts, mergeCalls } = await loadReindexFixture({
      languages: ['typescript', 'python'],
    });

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 1,
    });
    const firstScip = readFileSync(outputScip, 'utf-8');
    const firstDb = readFileSync(outputDb, 'utf-8');
    const firstMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    const mergeCallsAfterFirst = mergeCalls.length;

    writeFileSync(join(projectRoot, 'README.md'), '# Docs only\n');
    const second = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 1,
    });
    const secondMeta = JSON.parse(readFileSync(metaPath, 'utf-8'));

    expect(second.reused).toBe(true);
    expect(second.lastRefresh).toEqual(expect.objectContaining({ result: 'reused' }));
    expect(second.shards?.every((shard) => shard.reused)).toBe(true);
    expect(attempts.get('typescript')).toBe(1);
    expect(attempts.get('python')).toBe(1);
    expect(mergeCalls).toHaveLength(mergeCallsAfterFirst);
    expect(readFileSync(outputScip, 'utf-8')).toBe(firstScip);
    expect(readFileSync(outputDb, 'utf-8')).toBe(firstDb);
    expect(secondMeta.languageFingerprints).toEqual(firstMeta.languageFingerprints);
    expect(secondMeta.fingerprint).not.toEqual(firstMeta.fingerprint);
    expect(secondMeta.fingerprint.files.some((file: { path: string }) => file.path === 'README.md')).toBe(true);
    expect(statuses.join('\n')).toContain('Reusing cached typescript SCIP shard');
    expect(statuses.join('\n')).toContain('Reusing cached python SCIP shard');
    expect(statuses.join('\n')).toContain('All language shards unchanged; reused existing SQLite index');
    expect(JSON.parse(readFileSync(join(cacheDir, 'affected-shadow-latest.json'), 'utf-8'))).toMatchObject({
      version: 1,
      status: 'unavailable',
      refreshResult: 'reused',
      reason: 'oracle-error',
    });
    const history = readFileSync(join(cacheDir, 'affected-shadow.jsonl'), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(history).toHaveLength(2);
    expect(history).toEqual([
      expect.objectContaining({ historyVersion: 1, sourceVersion: 1 }),
      expect.objectContaining({ historyVersion: 1, sourceVersion: 1 }),
    ]);
    expect(history.every((record) => !('manifest' in record))).toBe(true);
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

  // Per-project TypeScript shard caching (2026-07-05 plan): an edit inside one
  // tsconfig project re-runs only that project's shard (plus dependents);
  // unchanged project shards come from the `language-indexes/typescript-projects/`
  // cache instead of re-running the indexer.
  function createTwoProjectWorkspace(prefix: string, opts: { bDependsOnA?: boolean } = {}) {
    const projectRoot = createProject(prefix);
    mkdirSync(join(projectRoot, 'packages/a/src'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages/b/src'), { recursive: true });
    writeFileSync(join(projectRoot, 'packages/a/tsconfig.json'), '{"include":["src"]}\n');
    writeFileSync(join(projectRoot, 'packages/b/tsconfig.json'), '{"include":["src"]}\n');
    writeFileSync(join(projectRoot, 'packages/a/package.json'), JSON.stringify({ name: 'pkg-a' }));
    writeFileSync(
      join(projectRoot, 'packages/b/package.json'),
      JSON.stringify(opts.bDependsOnA ? { name: 'pkg-b', dependencies: { 'pkg-a': '1.0.0' } } : { name: 'pkg-b' }),
    );
    writeFileSync(join(projectRoot, 'packages/a/src/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(projectRoot, 'packages/b/src/b.ts'), 'export const b = 1;\n');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    return { projectRoot, cacheDir };
  }

  it('serves an unchanged TypeScript workspace project shard from cache while re-running only the edited project', async () => {
    const { projectRoot, cacheDir } = createTwoProjectWorkspace('scip-query-reindex-ts-project-cache-');
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');

    const { reindex, commands, mergeCalls } = await loadReindexFixture({ languages: ['typescript'] });

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });
    const commandsAfterFirst = commands.length;
    const cachedAPath = join(
      cacheDir,
      'language-indexes',
      'typescript-projects',
      `${projectShardSlug('packages/a')}.scip`,
    );
    expect(existsSync(cachedAPath)).toBe(true);
    const cachedAContent = readFileSync(cachedAPath, 'utf-8');

    writeFileSync(join(projectRoot, 'packages/b/src/b.ts'), 'export const b = 2;\n');
    const second = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });

    const rerunProjects = commands
      .slice(commandsAfterFirst)
      .filter((command) => command.binary === 'typescript-indexer')
      .map((command) => command.args.at(-1));
    expect(rerunProjects).toEqual(['packages/b']);

    const shards = second.shards ?? [];
    expect(shards).toContainEqual(
      expect.objectContaining({ id: 'typescript:packages/a', language: 'typescript', reused: true }),
    );
    expect(shards).toContainEqual(
      expect.objectContaining({
        id: 'typescript:packages/b',
        language: 'typescript',
        reused: false,
        missReason: 'project inputs changed since last index',
      }),
    );
    expect(second.languages).toEqual(['typescript']);

    // Merged output still contains a's documents: the merge that produced
    // the final typescript shard combined both projects' outputs, and one
    // of those inputs is byte-identical to a's cached shard.
    const lastMerge = mergeCalls.at(-1);
    expect(lastMerge?.inputPaths.length).toBe(2);
    expect(lastMerge?.inputContents).toContain(cachedAContent);
  });

  it('reruns a dependent project when its cross-project dependency changes', async () => {
    const { projectRoot, cacheDir } = createTwoProjectWorkspace('scip-query-reindex-ts-project-dep-', {
      bDependsOnA: true,
    });
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');

    const { reindex, commands } = await loadReindexFixture({ languages: ['typescript'] });

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });
    const commandsAfterFirst = commands.length;

    writeFileSync(join(projectRoot, 'packages/a/src/a.ts'), 'export const a = 2;\n');
    const second = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });

    const rerunProjects = commands
      .slice(commandsAfterFirst)
      .filter((command) => command.binary === 'typescript-indexer')
      .map((command) => command.args.at(-1))
      .sort();
    expect(rerunProjects).toEqual(['packages/a', 'packages/b']);
    expect(second.languages).toEqual(['typescript']);
  });

  it('reruns a project when its cached shard file is missing despite matching metadata', async () => {
    const { projectRoot, cacheDir } = createTwoProjectWorkspace('scip-query-reindex-ts-project-missing-shard-');
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');

    const { reindex, commands } = await loadReindexFixture({ languages: ['typescript'] });

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });

    const cachedAPath = join(
      cacheDir,
      'language-indexes',
      'typescript-projects',
      `${projectShardSlug('packages/a')}.scip`,
    );
    expect(existsSync(cachedAPath)).toBe(true);
    rmSync(cachedAPath);

    // Force a language-level miss (untouched, a whole-language hit would
    // skip project classification entirely) without changing a's own files.
    writeFileSync(join(projectRoot, 'packages/b/src/b.ts'), 'export const b = 2;\n');
    const commandsAfterFirst = commands.length;
    const second = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });

    const rerunProjects = commands
      .slice(commandsAfterFirst)
      .filter((command) => command.binary === 'typescript-indexer')
      .map((command) => command.args.at(-1))
      .sort();
    expect(rerunProjects).toEqual(['packages/a', 'packages/b']);

    const shardA = (second.shards ?? []).find((shard) => shard.id === 'typescript:packages/a');
    expect(shardA).toEqual(expect.objectContaining({ reused: false, missReason: 'cached shard file missing on disk' }));
  });

  it('re-runs every project when metadata predates per-project shard caching, without crashing', async () => {
    const { projectRoot, cacheDir } = createTwoProjectWorkspace('scip-query-reindex-ts-project-old-meta-');
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const metaPath = join(cacheDir, 'meta.json');

    const { reindex, commands } = await loadReindexFixture({ languages: ['typescript'] });

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });

    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
    delete meta.typescriptProjectShards;
    writeFileSync(metaPath, JSON.stringify(meta));

    // Force a language-level miss so project classification actually runs.
    writeFileSync(join(projectRoot, 'packages/a/src/a.ts'), 'export const a = 2;\n');
    const commandsAfterFirst = commands.length;
    const second = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
      indexerConcurrency: 2,
    });

    const rerunProjects = commands
      .slice(commandsAfterFirst)
      .filter((command) => command.binary === 'typescript-indexer')
      .map((command) => command.args.at(-1))
      .sort();
    expect(rerunProjects).toEqual(['packages/a', 'packages/b']);
    expect(second.languages).toEqual(['typescript']);
  });

  it('removes the TypeScript project shard cache directory when switching from workspace to single mode', async () => {
    const projectRoot = createProject('scip-query-reindex-ts-project-mode-switch-');
    mkdirSync(join(projectRoot, 'packages/a/src'), { recursive: true });
    writeFileSync(join(projectRoot, 'packages/a/tsconfig.json'), '{"include":["src"]}\n');
    writeFileSync(join(projectRoot, 'packages/a/src/a.ts'), 'export const a = 1;\n');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');

    const { reindex } = await loadReindexFixture({ languages: ['typescript'] });

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'workspace',
      onStatus: () => undefined,
    });

    const shardDir = join(cacheDir, 'language-indexes', 'typescript-projects');
    expect(existsSync(shardDir)).toBe(true);

    await reindex({
      projectRoot,
      outputScip,
      outputDb,
      typescriptProjectMode: 'single',
      onStatus: () => undefined,
    });

    expect(existsSync(shardDir)).toBe(false);
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

  it('keeps the rebuilt generation authoritative when shadow telemetry cannot be written', async () => {
    const projectRoot = createProject('scip-query-reindex-shadow-write-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    const statuses: string[] = [];
    const { reindex } = await loadReindexFixture({ languages: ['typescript'], failShadowWrite: true });

    const result = await reindex({
      projectRoot,
      outputScip,
      outputDb,
      onStatus: (message) => statuses.push(message),
      indexerConcurrency: 1,
    });

    expect(result.reused).toBe(false);
    expect(readFileSync(outputDb, 'utf-8')).toBe('new-db');
    expect(statuses.join('\n')).toContain('Affected-set shadow telemetry unavailable: forced telemetry failure');
  });

  it('does not publish shadow telemetry when artifact promotion fails', async () => {
    const projectRoot = createProject('scip-query-reindex-shadow-promotion-');
    const cacheDir = join(projectRoot, '.cache');
    mkdirSync(cacheDir);
    const outputScip = join(cacheDir, 'index.scip');
    const outputDb = join(cacheDir, 'index.db');
    writeFileSync(outputScip, 'old-scip');
    writeFileSync(outputDb, 'old-db');
    const { reindex } = await loadReindexFixture({ languages: ['typescript'], failPromotion: true });

    await expect(
      reindex({
        projectRoot,
        outputScip,
        outputDb,
        onStatus: () => undefined,
        indexerConcurrency: 1,
      }),
    ).rejects.toThrow('forced promotion failure');

    expect(readFileSync(outputDb, 'utf-8')).toBe('old-db');
    expect(existsSync(join(cacheDir, 'affected-shadow-latest.json'))).toBe(false);
    expect(existsSync(join(cacheDir, 'affected-shadow.jsonl'))).toBe(false);
  });
});

async function loadReindexFixture(opts: {
  languages: SupportedLanguage[];
  failIndexers?: ReadonlySet<SupportedLanguage>;
  failFirstIndexers?: ReadonlySet<SupportedLanguage>;
  failConvert?: boolean;
  failPromotion?: boolean;
  failShadowWrite?: boolean;
  incrementalTypeScript?: boolean;
  deferredIncrementalTypeScript?: boolean;
  failIncrementalPatch?: boolean;
  platform?: NodeJS.Platform;
  scipCli?: {
    resolveScipBinary?: () => string | null;
    tryInstallScipCli?: (onStatus: (message: string) => void) => boolean;
  };
}) {
  vi.resetModules();
  vi.doUnmock('node:fs');
  vi.doUnmock('../../src/reindex/typescript-incremental-index.js');
  vi.doUnmock('../../src/reindex/incremental-sqlite-publication.js');
  const attempts = new Map<SupportedLanguage, number>();
  const commands: { binary: string; args: readonly string[] }[] = [];

  if (opts.incrementalTypeScript || opts.deferredIncrementalTypeScript) {
    vi.doMock('../../src/reindex/typescript-incremental-index.js', () => ({
      tryMaterializeTypeScriptIncrementalIndex: (input: {
        previousDbPath: string;
        previousShardPath: string;
        candidateShardPath: string;
        candidateAffectedScipPath: string;
      }) => {
        if (!existsSync(input.previousDbPath) || !existsSync(input.previousShardPath)) return null;
        if (!opts.deferredIncrementalTypeScript) {
          writeFileSync(input.candidateShardPath, 'incremental-complete-scip');
        }
        writeFileSync(input.candidateAffectedScipPath, 'incremental-affected-scip');
        return {
          scipPath: opts.deferredIncrementalTypeScript ? input.previousShardPath : input.candidateShardPath,
          candidateScipPath: input.candidateShardPath,
          affectedScipPath: input.candidateAffectedScipPath,
          completeScipUpdated: !opts.deferredIncrementalTypeScript,
          durationMs: 4,
          cold: false,
          changedFiles: ['src/main.ts'],
          affectedFiles: ['src/main.ts'],
          producerIdentity: 'test-producer',
          previousFragmentGeneration: 'previous-generation',
          nextFragmentGeneration: 'next-generation',
          manifest: {
            version: 1,
            changes: [],
            projectIdentityChanged: false,
            uncertainty: [],
          },
          plan: {
            mode: 'closure',
            changedFiles: ['src/main.ts'],
            affectedFiles: ['src/main.ts'],
            reasons: [],
          },
          projectFileCount: 1,
          timings: {
            runtimeMs: 1,
            graphMs: 1,
            requestMs: 1,
            serviceMs: 1,
            assemblyMs: 1,
            fragmentStoreMs: 1,
            writeMs: 1,
          },
        };
      },
      materializeDeferredTypeScriptIndex: (input: { candidateShardPath: string }) => {
        writeFileSync(input.candidateShardPath, 'materialized-deferred-scip');
      },
    }));
    vi.doMock('../../src/reindex/incremental-sqlite-publication.js', () => ({
      patchIncrementalSqliteGeneration: (input: { candidateDbPath: string }) => {
        if (opts.failIncrementalPatch) {
          throw new Error('candidate SQLite generation schema changed for table documents');
        }
        writeFileSync(input.candidateDbPath, 'incrementally-patched-db');
        return {
          candidateDbPath: input.candidateDbPath,
          affectedDocumentCount: 1,
          changedDocumentPaths: ['src/main.ts'],
          durationMs: 3,
        };
      },
    }));
  }

  if (opts.failPromotion) {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof NodeFs>('node:fs');
      return {
        ...actual,
        renameSync: (oldPath: string, newPath: string) => {
          if (newPath.endsWith('index.db.tmp-replace')) throw new Error('forced promotion failure');
          return actual.renameSync(oldPath, newPath);
        },
      };
    });
  }

  if (opts.failShadowWrite) {
    vi.doMock('../../src/reindex/affected-shadow.js', async () => {
      const actual = await vi.importActual<typeof AffectedShadow>('../../src/reindex/affected-shadow.js');
      return {
        ...actual,
        writeAffectedSetShadowRecord: () => {
          throw new Error('forced telemetry failure');
        },
      };
    });
  }

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
  vi.doMock('../../src/platform/indexer-toolchain.js', () => ({
    describeIndexerBinary: (config: { indexerBinary: string }) => config.indexerBinary,
    getIndexerExecutionEnv: (_config: unknown, env: NodeJS.ProcessEnv) => env,
    isIndexerInstalled: () => true,
    resolveIndexerBinary: (config: { indexerBinary: string }) => config.indexerBinary,
    resolveProjectLocalIndexerBinary: () => null,
  }));
  vi.doMock('../../src/reindex/install.js', () => ({
    tryInstallIndexer: () => true,
  }));
  vi.doMock('../../src/platform/scip-cli.js', () => ({
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
  // `inputContents` is snapshotted synchronously at call time (not just
  // `inputPaths`) because the temp run dir those paths live in is deleted
  // once `reindex()` resolves — a test asserting on merge inputs after the
  // fact can't re-read them from disk.
  const mergeCalls: { inputPaths: string[]; inputContents: (string | null)[]; outputPath: string }[] = [];
  vi.doMock('../../src/reindex/merge.js', async () => {
    const fs = await import('node:fs');
    const mergeScipFiles = (_inputPaths: readonly string[], outputPath: string) => {
      const inputContents = _inputPaths.map((path) => {
        try {
          return fs.readFileSync(path, 'utf-8');
        } catch {
          return null;
        }
      });
      mergeCalls.push({ inputPaths: [..._inputPaths], inputContents, outputPath });
      fs.writeFileSync(outputPath, 'merged-scip');
      return { documentCount: 0, externalSymbolCount: 0, inputCount: _inputPaths.length };
    };
    return {
      mergeScipFiles,
      mergeAndSanitizeScipFiles: (inputPaths: readonly string[], outputPath: string) => ({
        ...mergeScipFiles(inputPaths, outputPath),
        removedDefinitionOccurrences: 0,
        touchedDocuments: 0,
      }),
    };
  });

  return { ...(await import('../../src/reindex/index.js')), attempts, commands, mergeCalls };
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
