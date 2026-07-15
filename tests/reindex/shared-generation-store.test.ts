import { create } from '@bufbuild/protobuf';
import { deserializeSCIP, IndexSchema, MetadataSchema, serializeSCIP } from '@c4312/scip';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProjectInputFingerprint } from '../../src/reindex/project-files.js';
import {
  acquireSharedGenerationBuildLock,
  buildSharedGenerationSnapshot,
  hydrateSharedGeneration,
  parseSharedGenerationManifest,
  publishFreshLocalGenerationForProject,
  publishSharedGeneration,
  readSharedGeneration,
  sharedCacheBypassReason,
  SHARED_GENERATION_PRODUCER_IDENTITY,
  touchExistingWorktreeLease,
  writeWorktreeLease,
  type SharedGenerationSnapshot,
} from '../../src/reindex/shared-generation-store.js';
import { refreshSqliteGenerationMetadata } from '../../src/reindex/sqlite-generation-store.js';
import { TYPESCRIPT_FRAGMENT_STORE_DIRECTORY } from '../../src/reindex/typescript-fragment-store.js';
import { resolveGitWorktreeContext } from '../../src/runtime/git-worktree.js';
import { resolveIndexStoragePaths, resolveRepositoryCacheDir } from '../../src/runtime/config.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('shared generation store', () => {
  it('publishes an immutable generation and hydrates a private rebased cache', () => {
    const root = temporaryDirectory('scip-query-shared-generation-');
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const sourceCache = join(root, 'source-cache');
    const targetCache = join(root, 'target-cache');
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    createCache(sourceCache, sourceRoot, 'source');
    mkdirSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY), { recursive: true });
    writeFileSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY, 'stale.json'), 'stale');
    const snapshot = createSnapshot(root, targetRoot);

    const manifest = publishSharedGeneration({ snapshot, sourceCacheDir: sourceCache, sourceProjectRoot: sourceRoot });
    hydrateSharedGeneration({ snapshot, manifest, targetCacheDir: targetCache, targetProjectRoot: targetRoot });

    expect(readValue(join(targetCache, 'index.db'))).toBe('source');
    expect(deserializeSCIP(readFileSync(join(targetCache, 'index.scip'))).metadata?.projectRoot).toBe(
      pathToFileURL(realpathSync(targetRoot)).href,
    );
    expect(readSharedGeneration(snapshot)).toEqual(expect.objectContaining({ generationId: snapshot.generationId }));
    expect(existsSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY))).toBe(false);

    writeValue(join(targetCache, 'index.db'), 'target-only');
    expect(readValue(join(targetCache, 'index.db'))).toBe('target-only');
    expect(readValue(join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId, 'index.db'))).toBe(
      'source',
    );
  });

  it('rejects corrupt, incomplete, and source-changing generations', () => {
    const root = temporaryDirectory('scip-query-shared-corrupt-');
    const sourceRoot = join(root, 'source');
    const sourceCache = join(root, 'source-cache');
    mkdirSync(sourceRoot);
    createCache(sourceCache, sourceRoot, 'source');
    const snapshot = createSnapshot(root, sourceRoot);

    expect(() =>
      publishSharedGeneration({
        snapshot,
        sourceCacheDir: sourceCache,
        sourceProjectRoot: sourceRoot,
        sourceStillValid: () => false,
      }),
    ).toThrow('source index changed');
    expect(readSharedGeneration(snapshot)).toBeNull();

    const manifest = publishSharedGeneration({ snapshot, sourceCacheDir: sourceCache, sourceProjectRoot: sourceRoot });
    writeFileSync(join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId, 'index.scip'), 'corrupt');
    expect(readSharedGeneration(snapshot)).toBeNull();
    expect(() => parseSharedGenerationManifest(JSON.stringify({ ...manifest, artifacts: [] }))).toThrow(
      'missing index.db',
    );
    expect(() =>
      parseSharedGenerationManifest(JSON.stringify({ ...manifest, producerIdentity: 'older-producer' })),
    ).toThrow('invalid shared generation manifest');
  });

  it('restores the complete previous cache when hydration fails after handoff starts', () => {
    const root = temporaryDirectory('scip-query-shared-rollback-');
    const sourceRoot = join(root, 'source');
    const targetRoot = join(root, 'target');
    const sourceCache = join(root, 'source-cache');
    const targetCache = join(root, 'target-cache');
    mkdirSync(sourceRoot);
    mkdirSync(targetRoot);
    createCache(sourceCache, sourceRoot, 'new');
    createCache(targetCache, targetRoot, 'old');
    mkdirSync(join(sourceCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY), { recursive: true });
    writeFileSync(join(sourceCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY, 'new.json'), 'new');
    mkdirSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY), { recursive: true });
    writeFileSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY, 'old.json'), 'old');
    const snapshot = createSnapshot(root, targetRoot);
    const manifest = publishSharedGeneration({ snapshot, sourceCacheDir: sourceCache, sourceProjectRoot: sourceRoot });

    expect(() =>
      hydrateSharedGeneration({
        snapshot,
        manifest,
        targetCacheDir: targetCache,
        targetProjectRoot: targetRoot,
        now: () => {
          throw new Error('injected hydration failure');
        },
      }),
    ).toThrow('injected hydration failure');

    expect(readValue(join(targetCache, 'index.db'))).toBe('old');
    expect(readFileSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY, 'old.json'), 'utf8')).toBe('old');
    expect(existsSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY, 'new.json'))).toBe(false);
  });

  it('gives one process generation ownership and times out a live follower', async () => {
    const root = temporaryDirectory('scip-query-shared-lock-');
    const snapshot = createSnapshot(root, root);
    const owner = await acquireSharedGenerationBuildLock(snapshot, { timeoutMs: 10, pollMs: 1 });
    expect(owner.kind).toBe('owner');

    const follower = await acquireSharedGenerationBuildLock(snapshot, { timeoutMs: 2, pollMs: 1 });
    expect(follower.kind).toBe('timeout');
    if (owner.kind === 'owner') owner.release();

    const next = await acquireSharedGenerationBuildLock(snapshot, { timeoutMs: 10, pollMs: 1 });
    expect(next.kind).toBe('owner');
    if (next.kind === 'owner') next.release();
  });

  it('reclaims a dead generation owner without unlinking a replacement lock', async () => {
    const root = temporaryDirectory('scip-query-shared-stale-lock-');
    const snapshot = createSnapshot(root, root);
    const lockPath = join(snapshot.repositoryCacheDir, 'locks', `${snapshot.generationId}.lock`);
    mkdirSync(join(snapshot.repositoryCacheDir, 'locks'), { recursive: true });
    writeFileSync(
      lockPath,
      `${JSON.stringify({ version: 1, pid: 2_147_483_647, token: 'dead-owner', generationId: snapshot.generationId })}\n`,
    );

    const owner = await acquireSharedGenerationBuildLock(snapshot, { timeoutMs: 20, pollMs: 1 });

    expect(owner.kind).toBe('owner');
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toEqual(expect.objectContaining({ pid: process.pid }));
    if (owner.kind === 'owner') owner.release();
    expect(existsSync(lockPath)).toBe(false);
  });

  it('bypasses automatic sharing for opt-out, configured, and custom database paths', () => {
    const previous = process.env['SCIP_QUERY_SHARED_CACHE'];
    try {
      process.env['SCIP_QUERY_SHARED_CACHE'] = '0';
      expect(sharedCacheBypassReason('/repo', '/cache/index.db')).toContain('SCIP_QUERY_SHARED_CACHE=0');
      delete process.env['SCIP_QUERY_SHARED_CACHE'];
      expect(sharedCacheBypassReason('/repo', '/cache/index.db', { dbPath: '.private' })).toContain('explicit');
      expect(sharedCacheBypassReason('/repo', '/cache/index.db')).toContain('outside the managed worktree cache');
    } finally {
      if (previous === undefined) delete process.env['SCIP_QUERY_SHARED_CACHE'];
      else process.env['SCIP_QUERY_SHARED_CACHE'] = previous;
    }
  });

  it('does not trust a warm-cache lease after the worktree changes committed trees', () => {
    const root = temporaryDirectory('scip-query-shared-lease-');
    const cacheHome = temporaryDirectory('scip-query-shared-lease-cache-');
    const localCache = join(cacheHome, 'scip-query', 'projects', 'managed');
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test User']);
      writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'first']);
      const context = resolveGitWorktreeContext(root)!;
      const snapshot = buildSharedGenerationSnapshot(context, fingerprint())!;
      createCache(localCache, root, 'lease');
      mkdirSync(join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId), { recursive: true });
      writeWorktreeLease(snapshot, localCache, 'attached');

      expect(touchExistingWorktreeLease(root, localCache)).not.toBeNull();

      const scip = readFileSync(join(localCache, 'index.scip'));
      rmSync(join(localCache, 'index.scip'));
      expect(touchExistingWorktreeLease(root, localCache)).toBeNull();
      writeFileSync(join(localCache, 'index.scip'), scip);

      const metadata = JSON.parse(readFileSync(join(localCache, 'meta.json'), 'utf8')) as {
        fingerprint: ProjectInputFingerprint;
        [key: string]: unknown;
      };
      writeFileSync(
        join(localCache, 'meta.json'),
        `${JSON.stringify({
          ...metadata,
          fingerprint: { ...metadata.fingerprint, files: [{ path: 'value.ts', size: 2, hash: 'dirty-overlay' }] },
        })}\n`,
      );
      refreshSqliteGenerationMetadata(join(localCache, 'index.db'), join(localCache, 'meta.json'));
      expect(touchExistingWorktreeLease(root, localCache)).toBeNull();
      writeFileSync(join(localCache, 'meta.json'), `${JSON.stringify(metadata)}\n`);
      refreshSqliteGenerationMetadata(join(localCache, 'index.db'), join(localCache, 'meta.json'));
      expect(touchExistingWorktreeLease(root, localCache)).not.toBeNull();

      writeFileSync(join(root, 'value.ts'), 'export const value = 2;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'second']);
      expect(touchExistingWorktreeLease(root, localCache)).toBeNull();
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });

  it('rejects dirty publication before inspecting project fingerprint inputs', () => {
    const root = temporaryDirectory('scip-query-shared-dirty-');
    const cacheHome = temporaryDirectory('scip-query-shared-dirty-cache-');
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test User']);
      writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'initial']);
      writeFileSync(join(root, 'value.ts'), 'export const value = 2;\n');
      const config = Object.defineProperty({}, 'languages', {
        get(): never {
          throw new Error('dirty publication inspected fingerprint inputs');
        },
      });
      const paths = resolveIndexStoragePaths(root);

      const context = resolveGitWorktreeContext(root)!;
      rmSync(join(root, '.git'), { recursive: true, force: true });

      expect(publishFreshLocalGenerationForProject(root, config, paths, context)).toEqual({
        kind: 'missed',
        reason: 'worktree is not a clean committed snapshot',
      });

      const leasePath = join(
        resolveRepositoryCacheDir(context.repositoryId),
        'worktrees',
        `${context.worktreeId}.json`,
      );
      expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(
        expect.objectContaining({
          lastAction: 'missed',
          lastReason: 'worktree is not a clean committed snapshot',
        }),
      );
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });
});

function createSnapshot(root: string, projectRoot: string): SharedGenerationSnapshot {
  return {
    repositoryId: 'a'.repeat(24),
    worktreeId: 'b'.repeat(24),
    projectRoot,
    treeOid: 'tree-1',
    fingerprint: fingerprint(),
    producerIdentity: SHARED_GENERATION_PRODUCER_IDENTITY,
    generationId: 'c'.repeat(64),
    repositoryCacheDir: join(root, 'repository-cache'),
  };
}

function fingerprint(): ProjectInputFingerprint {
  return {
    version: 2,
    languages: ['typescript'],
    pnpmWorkspaces: false,
    typescriptProjectMode: 'single',
    typescriptProjects: [],
    files: [{ path: 'src/value.ts', size: 1, hash: 'hash' }],
  };
}

function createCache(cacheDir: string, projectRoot: string, value: string): void {
  mkdirSync(cacheDir, { recursive: true });
  const db = new Database(join(cacheDir, 'index.db'));
  db.exec('CREATE TABLE fixture (value TEXT NOT NULL)');
  db.prepare('INSERT INTO fixture (value) VALUES (?)').run(value);
  db.close();
  writeFileSync(
    join(cacheDir, 'index.scip'),
    Buffer.from(
      serializeSCIP(
        create(IndexSchema, {
          metadata: create(MetadataSchema, { projectRoot: pathToFileURL(realpathSync(projectRoot)).href }),
          documents: [],
          externalSymbols: [],
        }),
      ),
    ),
  );
  writeFileSync(
    join(cacheDir, 'meta.json'),
    `${JSON.stringify({
      version: 3,
      status: 'complete',
      updatedAt: '2026-07-14T00:00:00.000Z',
      fingerprint: fingerprint(),
      indexedLanguages: ['typescript'],
    })}\n`,
  );
  refreshSqliteGenerationMetadata(join(cacheDir, 'index.db'), join(cacheDir, 'meta.json'));
}

function readValue(path: string): string {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare('SELECT value FROM fixture').get() as { value: string }).value;
  } finally {
    db.close();
  }
}

function writeValue(path: string, value: string): void {
  const db = new Database(path);
  try {
    db.prepare('UPDATE fixture SET value = ?').run(value);
  } finally {
    db.close();
  }
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}
