import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  activateCliProjectContext,
  prepareWorktreeIndex,
  resolveCliProjectContext,
  rootIndexFallbackWarning,
  sharedCachePreparationEligible,
} from '../../src/runtime/cli-context.js';
import type { GitWorktreeContext } from '../../src/platform/git-worktree.js';
import { resolveIndexStoragePaths } from '../../src/platform/cache-layout.js';
import { fingerprintProjectFiles } from '../../src/platform/project-files.js';
import { publishedGenerationIdentity } from '../../src/semantic/typescript/session-protocol.js';
import type { ProjectConfig } from '../../src/domain/types.js';

const tempDirs: string[] = [];

afterEach(() => {
  activateCliProjectContext(undefined);
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('cli context', () => {
  it('renders a dated warning for legacy root index fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-'));
    tempDirs.push(root);
    const dbPath = join(root, 'index.db');
    const configuredPath = join(root, '.cache', 'scip-query', 'index.db');
    mkdirSync(join(root, '.cache', 'scip-query'), { recursive: true });
    writeFileSync(dbPath, '');

    const warning = rootIndexFallbackWarning(dbPath, configuredPath);

    expect(warning).toContain('using legacy project-root index.db');
    expect(warning).toContain(dbPath);
    expect(warning).toContain(configuredPath);
    expect(warning).toContain('modified ');
    expect(warning).toContain("run 'scip-query reindex'");
  });

  it('prepares graph commands but leaves passive, explicit-index, and setup commands alone', () => {
    expect(sharedCachePreparationEligible('refs')).toBe(true);
    expect(sharedCachePreparationEligible('status')).toBe(false);
    expect(sharedCachePreparationEligible('watch')).toBe(false);
    expect(sharedCachePreparationEligible('reindex')).toBe(false);
    expect(sharedCachePreparationEligible('doctor')).toBe(false);
    expect(sharedCachePreparationEligible('effectiveness')).toBe(false);
    expect(sharedCachePreparationEligible('hook-stop-prepare')).toBe(false);
    expect(sharedCachePreparationEligible('install-skills')).toBe(false);
    expect(sharedCachePreparationEligible('init')).toBe(false);
    expect(sharedCachePreparationEligible('setup')).toBe(false);
  });

  it('reuses an activated project and Git context only for the matching root', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-active-'));
    const otherRoot = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-other-'));
    tempDirs.push(root, otherRoot);
    const gitContext: GitWorktreeContext = {
      projectRoot: root,
      gitDir: join(root, '.git'),
      commonDir: join(root, '.git'),
      repositoryId: 'a'.repeat(24),
      worktreeId: 'b'.repeat(24),
      clean: false,
    };
    const active = resolveCliProjectContext(root, gitContext);
    activateCliProjectContext(active);

    expect(resolveCliProjectContext(root)).toBe(active);
    expect(resolveCliProjectContext(otherRoot)).not.toBe(active);
  });

  it('accepts an idle watcher generation for a dirty worktree without rebuilding the project fingerprint', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-watcher-'));
    const cacheHome = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-cache-'));
    tempDirs.push(root, cacheHome);
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      const paths = resolveIndexStoragePaths(root);
      mkdirSync(paths.cacheDir, { recursive: true });
      writeFileSync(paths.dbPath, '');
      writeFileSync(
        paths.metaPath,
        `${JSON.stringify({
          version: 3,
          status: 'complete',
          updatedAt: '2026-07-15T00:00:00.000Z',
          fingerprint: { version: 2, files: [] },
          indexedLanguages: [],
        })}\n`,
      );
      const watcherGeneration = publishedGenerationIdentity(paths.dbPath)!;
      const gitContext: GitWorktreeContext = {
        projectRoot: root,
        gitDir: join(root, '.git'),
        commonDir: join(root, '.git'),
        repositoryId: 'a'.repeat(24),
        worktreeId: 'b'.repeat(24),
        clean: false,
      };
      const config = Object.defineProperty({}, 'languages', {
        get(): never {
          throw new Error('watcher fast path rebuilt the project fingerprint');
        },
      }) as ProjectConfig;

      expect(prepareWorktreeIndex(root, config, paths, { gitContext, watcherGeneration })).toEqual({
        kind: 'missed',
        reason: 'worktree is not a clean committed snapshot',
      });
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });

  it('uses a fresh local index without publishing it during graph-command preflight', () => {
    const root = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-local-fresh-'));
    const cacheHome = mkdtempSync(join(tmpdir(), 'scip-query-cli-context-local-fresh-cache-'));
    tempDirs.push(root, cacheHome);
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'tsconfig.json'), '{}\n');
      writeFileSync(join(root, 'src', 'value.ts'), 'export const value = 1;\n');
      const paths = resolveIndexStoragePaths(root);
      mkdirSync(paths.cacheDir, { recursive: true });
      writeFileSync(paths.dbPath, '');
      writeFileSync(
        paths.metaPath,
        `${JSON.stringify({
          version: 3,
          status: 'complete',
          updatedAt: '2026-07-29T00:00:00.000Z',
          fingerprint: {
            version: 2,
            languages: ['typescript'],
            pnpmWorkspaces: false,
            typescriptProjectMode: 'single',
            typescriptProjects: [],
            files: fingerprintProjectFiles(root),
          },
          requestedLanguages: ['typescript'],
          indexedLanguages: ['typescript'],
          skipped: [],
        })}\n`,
      );

      expect(prepareWorktreeIndex(root, { languages: ['typescript'] }, paths)).toEqual({
        kind: 'local-fresh',
      });
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });
});
