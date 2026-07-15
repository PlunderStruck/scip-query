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
import type { GitWorktreeContext } from '../../src/runtime/git-worktree.js';
import { resolveIndexStoragePaths } from '../../src/runtime/config.js';
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

  it('prepares query, reindex, and watch commands but leaves setup lifecycle commands alone', () => {
    expect(sharedCachePreparationEligible('status')).toBe(true);
    expect(sharedCachePreparationEligible('reindex')).toBe(true);
    expect(sharedCachePreparationEligible('watch')).toBe(true);
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
});
