import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ProjectConfig, SupportedLanguage } from '../../src/domain/types.js';
import { fingerprintProjectFiles } from '../../src/reindex/project-files.js';
import { getIndexFreshness } from '../../src/runtime/index-freshness.js';

function writeMeta(root: string, metaPath: string, languages: SupportedLanguage[], version: 2 | 3 = 2): void {
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        version,
        status: 'complete',
        updatedAt: new Date().toISOString(),
        fingerprint: {
          version: 1,
          languages: [...languages].sort(),
          pnpmWorkspaces: false,
          files: fingerprintProjectFiles(root),
        },
        requestedLanguages: languages,
        indexedLanguages: languages,
        skipped: [],
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
});
