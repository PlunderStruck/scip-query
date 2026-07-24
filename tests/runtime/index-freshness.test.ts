import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectConfig, SupportedLanguage } from '../../src/domain/types.js';
import { fingerprintProjectFiles } from '../../src/platform/project-files.js';
import { getIndexFreshness } from '../../src/runtime/index-freshness.js';

function writeMeta(
  root: string,
  metaPath: string,
  languages: SupportedLanguage[],
  version: 2 | 3 = 2,
  fingerprintOverrides: Record<string, unknown> = {},
): void {
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        version,
        status: 'complete',
        updatedAt: new Date().toISOString(),
        fingerprint: {
          version: 2,
          languages: [...languages].sort(),
          pnpmWorkspaces: false,
          typescriptProjectMode: 'single',
          typescriptProjects: [],
          files: fingerprintProjectFiles(root),
          ...fingerprintOverrides,
        },
        requestedLanguages: languages,
        indexedLanguages: languages,
        skipped: [],
        lastRefresh: {
          trigger: { kind: 'manual-cli', detail: 'scip-query reindex' },
          result: 'rebuilt',
          startedAt: '2026-06-27T00:00:00.000Z',
          completedAt: '2026-06-27T00:00:01.000Z',
          durationMs: 1000,
          indexedLanguages: languages,
          skipped: [],
        },
      },
      null,
      2,
    )}\n`,
  );
}

describe('index freshness', () => {
  it('reports missing when no SQLite index exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-missing-'));
    try {
      const config: ProjectConfig = {
        dbPath: join(root, 'index.db'),
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
      };
      expect(getIndexFreshness(root, config, { dbPath: config.dbPath, metaPath: join(root, 'meta.json') }).state).toBe(
        'missing',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports fresh for metadata with per-language shard fingerprints', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-v3-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const dbPath = join(root, 'index.db');
      mkdirSync(join(root, '.scipquery-cache'));
      const metaPath = join(root, '.scipquery-cache', 'meta.json');
      writeFileSync(dbPath, '');
      writeMeta(root, metaPath, ['typescript'], 3);
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
        languages: ['typescript'],
      };

      expect(getIndexFreshness(root, config, { dbPath, metaPath }).state).toBe('fresh');
      expect(getIndexFreshness(root, config, { dbPath, metaPath }).lastRefresh).toEqual(
        expect.objectContaining({
          trigger: { kind: 'manual-cli', detail: 'scip-query reindex' },
          result: 'rebuilt',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports fresh when metadata fingerprint matches current source files', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-fresh-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const dbPath = join(root, 'index.db');
      mkdirSync(join(root, '.scipquery-cache'));
      const metaPath = join(root, '.scipquery-cache', 'meta.json');
      writeFileSync(dbPath, '');
      writeMeta(root, metaPath, ['typescript']);
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
        languages: ['typescript'],
      };

      expect(getIndexFreshness(root, config, { dbPath, metaPath }).state).toBe('fresh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires repair when a present SQLite generation record is malformed', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-generation-drift-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const cacheDir = join(root, '.scipquery-cache');
      const dbPath = join(cacheDir, 'index.db');
      const metaPath = join(cacheDir, 'meta.json');
      mkdirSync(join(cacheDir, '.scipquery-generations'), { recursive: true });
      writeFileSync(dbPath, 'database');
      writeMeta(root, metaPath, ['typescript']);
      writeFileSync(join(cacheDir, '.scipquery-generations', 'state.json'), '{');
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(cacheDir, 'index.scip'),
        projectRoot: root,
        languages: ['typescript'],
      };

      const freshness = getIndexFreshness(root, config, { dbPath, metaPath });
      expect(freshness).toEqual(
        expect.objectContaining({
          state: 'stale',
          reason: 'SQLite generation requires repair: generation state is malformed',
          remedy: 'Run: scip-query reindex',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('ignores root metadata when projects store scip-query outputs in the project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-root-meta-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'deps.edn'), '{}');
      writeFileSync(join(root, 'src', 'core.clj'), '(ns example.core)\n');
      const dbPath = join(root, 'index.db');
      const metaPath = join(root, 'meta.json');
      writeFileSync(dbPath, '');
      writeMeta(root, metaPath, ['clojure']);
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
        languages: ['clojure'],
      };

      expect(getIndexFreshness(root, config, { dbPath, metaPath }).state).toBe('fresh');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports stale when current source files differ from metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-stale-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const dbPath = join(root, 'index.db');
      mkdirSync(join(root, '.scipquery-cache'));
      const metaPath = join(root, '.scipquery-cache', 'meta.json');
      writeFileSync(dbPath, '');
      writeMeta(root, metaPath, ['typescript']);
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 2;\n');
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
        languages: ['typescript'],
      };

      const freshness = getIndexFreshness(root, config, { dbPath, metaPath });
      expect(freshness.state).toBe('stale');
      expect(freshness.remedy).toContain('reindex');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports stale when TypeScript project indexing mode differs from metadata', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-ts-mode-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{}');
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const dbPath = join(root, 'index.db');
      mkdirSync(join(root, '.scipquery-cache'));
      const metaPath = join(root, '.scipquery-cache', 'meta.json');
      writeFileSync(dbPath, '');
      writeMeta(root, metaPath, ['typescript']);
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
        languages: ['typescript'],
        indexer: { typescript: { projectMode: 'workspace', projects: ['src'] } },
      };

      expect(getIndexFreshness(root, config, { dbPath, metaPath }).state).toBe('stale');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports stale when the Clojure indexer config path changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-freshness-clojure-config-'));
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'deps.edn'), '{}');
      writeFileSync(join(root, 'src', 'core.clj'), '(ns example.core)\n');
      writeFileSync(join(root, '.scip-clojure-old.json'), '{}\n');
      writeFileSync(join(root, '.scip-clojure-new.json'), '{}\n');
      const dbPath = join(root, 'index.db');
      mkdirSync(join(root, '.scipquery-cache'));
      const metaPath = join(root, '.scipquery-cache', 'meta.json');
      writeFileSync(dbPath, '');
      writeMeta(root, metaPath, ['clojure'], 2, { clojureConfigPath: '.scip-clojure-old.json' });
      const config: ProjectConfig = {
        dbPath,
        indexPath: join(root, 'index.scip'),
        projectRoot: root,
        languages: ['clojure'],
        indexer: { clojure: { configPath: '.scip-clojure-new.json' } },
      };

      expect(getIndexFreshness(root, config, { dbPath, metaPath }).state).toBe('stale');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
