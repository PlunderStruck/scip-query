import { create } from '@bufbuild/protobuf';
import { deserializeSCIP, IndexSchema, MetadataSchema, serializeSCIP } from '@c4312/scip';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProjectInputFingerprint,
  normalizeProjectInputFingerprintConfiguration,
  type ProjectInputFingerprint,
} from '../../src/platform/project-files.js';
import {
  acquireSharedGenerationBuildLock,
  buildSharedGenerationSnapshot,
  findSharedBaselineGeneration,
  hydrateSharedGeneration,
  parseSharedGenerationManifest,
  publishFreshLocalGenerationForProject,
  publishSharedGeneration,
  readSharedGeneration,
  sharedCacheBypassReason,
  SHARED_GENERATION_PRODUCER_IDENTITY,
  touchExistingWorktreeLease,
  worktreeLeaseOwnershipChecksum,
  writeWorktreeLease,
  type SharedGenerationSnapshot,
  type SharedGenerationPublicationStage,
  type WorktreeCacheLease,
} from '../../src/reindex/shared-generation-store.js';
import { refreshSqliteGenerationMetadata } from '../../src/reindex/sqlite-generation-store.js';
import { TYPESCRIPT_FRAGMENT_STORE_DIRECTORY } from '../../src/reindex/typescript-fragment-store.js';
import { resolveIndexStoragePaths, resolveRepositoryCacheDir } from '../../src/platform/cache-layout.js';
import { resolveGitWorktreeContext } from '../../src/platform/git-worktree.js';
import { ScipDatabase } from '../../src/storage/db.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('shared generation store', () => {
  it('normalizes the indexer configuration independently from source files', () => {
    expect(
      normalizeProjectInputFingerprintConfiguration(['typescript'], {
        pnpmWorkspaces: true,
        typescriptProjectMode: 'workspace',
        typescriptProjects: [' packages/b ', 'packages/a', 'packages/a'],
        clojureConfigPath: ' ',
      }),
    ).toEqual({
      version: 2,
      languages: ['typescript'],
      pnpmWorkspaces: false,
      typescriptProjectMode: 'workspace',
      typescriptProjects: ['packages/a', 'packages/b'],
      clojureConfigPath: undefined,
    });
  });

  it('selects the newest valid exact-HEAD baseline for a dirty worktree', () => {
    const root = temporaryDirectory('scip-query-shared-baseline-');
    const cacheHome = temporaryDirectory('scip-query-shared-baseline-cache-');
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test User']);
      writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'initial']);
      const cleanContext = resolveGitWorktreeContext(root)!;
      const olderFingerprint = buildProjectInputFingerprint(root, ['typescript'], {});
      const olderSnapshot = buildSharedGenerationSnapshot(cleanContext, olderFingerprint)!;
      const olderCache = join(root, 'older-cache');
      createCache(olderCache, root, 'older', { fingerprint: olderFingerprint });
      publishSharedGeneration({
        snapshot: olderSnapshot,
        sourceCacheDir: olderCache,
        sourceProjectRoot: root,
        now: () => new Date('2026-07-29T01:00:00.000Z'),
      });

      const newerFingerprint = {
        ...olderFingerprint,
        files: olderFingerprint.files.map((file) => ({ ...file, hash: `${file.hash}-newer` })),
      };
      const newerSnapshot = buildSharedGenerationSnapshot(cleanContext, newerFingerprint)!;
      const newerCache = join(root, 'newer-cache');
      createCache(newerCache, root, 'newer', { fingerprint: newerFingerprint });
      publishSharedGeneration({
        snapshot: newerSnapshot,
        sourceCacheDir: newerCache,
        sourceProjectRoot: root,
        now: () => new Date('2026-07-29T02:00:00.000Z'),
      });

      writeFileSync(join(root, 'value.ts'), 'export const value = 2;\n');
      const dirtyContext = resolveGitWorktreeContext(root)!;
      expect(dirtyContext.clean).toBe(false);
      expect(findSharedBaselineGeneration(dirtyContext, ['typescript'], {})).toEqual(
        expect.objectContaining({
          snapshot: expect.objectContaining({ generationId: newerSnapshot.generationId }),
          manifest: expect.objectContaining({ generationId: newerSnapshot.generationId }),
        }),
      );

      const newerDb = join(newerSnapshot.repositoryCacheDir, 'generations', newerSnapshot.generationId, 'index.db');
      chmodSync(newerDb, 0o644);
      writeFileSync(newerDb, 'corrupt');
      expect(findSharedBaselineGeneration(dirtyContext, ['typescript'], {})).toEqual(
        expect.objectContaining({
          snapshot: expect.objectContaining({ generationId: olderSnapshot.generationId }),
        }),
      );
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });

  it('rejects baseline generations with a different tree or indexer configuration', () => {
    const root = temporaryDirectory('scip-query-shared-baseline-mismatch-');
    const cacheHome = temporaryDirectory('scip-query-shared-baseline-mismatch-cache-');
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test User']);
      writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'initial']);
      const cleanContext = resolveGitWorktreeContext(root)!;
      const baselineFingerprint = buildProjectInputFingerprint(root, ['typescript'], {});
      const baselineSnapshot = buildSharedGenerationSnapshot(cleanContext, baselineFingerprint)!;
      const sourceCache = join(root, 'source-cache');
      createCache(sourceCache, root, 'baseline', { fingerprint: baselineFingerprint });
      publishSharedGeneration({
        snapshot: baselineSnapshot,
        sourceCacheDir: sourceCache,
        sourceProjectRoot: root,
      });

      writeFileSync(join(root, 'value.ts'), 'export const value = 2;\n');
      const dirtyContext = resolveGitWorktreeContext(root)!;
      expect(findSharedBaselineGeneration(dirtyContext, ['python'], {})).toBeNull();
      expect(
        findSharedBaselineGeneration(dirtyContext, ['typescript'], {
          typescriptProjectMode: 'workspace',
        }),
      ).toBeNull();
      expect(
        findSharedBaselineGeneration(dirtyContext, ['typescript'], {
          pnpmWorkspaces: true,
        }),
      ).toBeNull();
      expect(
        findSharedBaselineGeneration(dirtyContext, ['typescript'], {
          typescriptProjects: ['packages/a'],
        }),
      ).toBeNull();
      expect(
        findSharedBaselineGeneration(dirtyContext, ['typescript'], {
          clojureConfigPath: 'deps.edn',
        }),
      ).toBeNull();
      expect(findSharedBaselineGeneration({ ...dirtyContext, treeOid: 'f'.repeat(40) }, ['typescript'], {})).toBeNull();
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });

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

    const publication = publishSharedGeneration({
      snapshot,
      sourceCacheDir: sourceCache,
      sourceProjectRoot: sourceRoot,
    });
    const manifest = publication.manifest;
    expect(publication).toEqual(
      expect.objectContaining({
        kind: 'published',
        achievedDurability: 'directory-durable',
        directorySync: 'synced',
      }),
    );
    hydrateSharedGeneration({ snapshot, manifest, targetCacheDir: targetCache, targetProjectRoot: targetRoot });

    expect(readValue(join(targetCache, 'index.db'))).toBe('source');
    expect(deserializeSCIP(readFileSync(join(targetCache, 'index.scip'))).metadata?.projectRoot).toBe(
      pathToFileURL(realpathSync(targetRoot)).href,
    );
    expect(readSharedGeneration(snapshot)).toEqual(expect.objectContaining({ generationId: snapshot.generationId }));
    expect(existsSync(join(targetCache, TYPESCRIPT_FRAGMENT_STORE_DIRECTORY))).toBe(false);

    const retainedReader = new ScipDatabase({
      projectRoot: targetRoot,
      dbPath: join(targetCache, 'index.db'),
      indexPath: join(targetCache, 'index.scip'),
    });
    try {
      expect(retainedReader.generation.source).toBe('immutable');
      writeValue(join(targetCache, 'index.db'), 'target-only');
      expect(readValue(join(targetCache, 'index.db'))).toBe('target-only');
      expect(readValueFromHandle(retainedReader)).toBe('source');
      expect(readValue(join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId, 'index.db'))).toBe(
        'source',
      );
    } finally {
      retainedReader.close();
    }
  });

  it('gives one publication owner exclusive staging rights for a generation', () => {
    const root = temporaryDirectory('scip-query-shared-publication-lock-');
    const sourceRoot = join(root, 'source');
    const sourceCache = join(root, 'source-cache');
    mkdirSync(sourceRoot);
    createCache(sourceCache, sourceRoot, 'source');
    const snapshot = createSnapshot(root, sourceRoot);
    let nestedError: unknown;
    let attempted = false;

    const publication = publishSharedGeneration({
      snapshot,
      sourceCacheDir: sourceCache,
      sourceProjectRoot: sourceRoot,
      onPublicationStage(stage) {
        if (stage !== 'after-artifact-flushed' || attempted) return;
        attempted = true;
        try {
          publishSharedGeneration({
            snapshot,
            sourceCacheDir: sourceCache,
            sourceProjectRoot: sourceRoot,
          });
        } catch (error) {
          nestedError = error;
        }
      },
    });

    expect(publication.kind).toBe('published');
    expect(nestedError).toEqual(
      new Error(`shared generation publication is already in progress for ${snapshot.generationId}`),
    );
    expect(readSharedGeneration(snapshot)).toEqual(expect.objectContaining({ generationId: snapshot.generationId }));
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

    const publication = publishSharedGeneration({
      snapshot,
      sourceCacheDir: sourceCache,
      sourceProjectRoot: sourceRoot,
    });
    const manifest = publication.manifest;
    const corruptPath = join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId, 'index.scip');
    chmodSync(corruptPath, 0o644);
    writeFileSync(corruptPath, 'corrupt');
    expect(readSharedGeneration(snapshot)).toBeNull();
    expect(() => parseSharedGenerationManifest(JSON.stringify({ ...manifest, artifacts: [] }))).toThrow(
      'missing index.db',
    );
    expect(() =>
      parseSharedGenerationManifest(JSON.stringify({ ...manifest, producerIdentity: 'older-producer' })),
    ).toThrow('invalid shared generation manifest');
  });

  it.each<SharedGenerationPublicationStage>([
    'after-artifact-flushed',
    'after-manifest-flushed',
    'after-staging-directory-synced',
    'after-generation-renamed',
    'after-generations-directory-synced',
  ])('never returns publication success after an injected crash at %s', (crashStage) => {
    const root = temporaryDirectory(`scip-query-shared-crash-${crashStage}-`);
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
        onPublicationStage(stage) {
          if (stage === crashStage) throw new Error(`simulated publication crash at ${stage}`);
        },
      }),
    ).toThrow(`simulated publication crash at ${crashStage}`);

    if (
      crashStage === 'after-artifact-flushed' ||
      crashStage === 'after-manifest-flushed' ||
      crashStage === 'after-staging-directory-synced'
    ) {
      expect(readSharedGeneration(snapshot)).toBeNull();
    }
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
    const publication = publishSharedGeneration({
      snapshot,
      sourceCacheDir: sourceCache,
      sourceProjectRoot: sourceRoot,
    });
    const manifest = publication.manifest;

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

  it('does not let a waiting G1 touch overwrite a G2 lease', () => {
    withWarmLeaseFixture('generation-race', ({ context, localCache, leasePath, snapshot }) => {
      const newerSnapshot = { ...snapshot, generationId: 'd'.repeat(64) };
      mkdirSync(join(snapshot.repositoryCacheDir, 'generations', newerSnapshot.generationId), { recursive: true });

      const touched = touchExistingWorktreeLease(context.projectRoot, localCache, () => new Date(120_000), context, {
        onBeforeRepositoryLock: () => {
          writeWorktreeLease(newerSnapshot, localCache, 'attached', () => new Date(180_000));
        },
      });

      expect(touched).toBeNull();
      expect(JSON.parse(readFileSync(leasePath, 'utf8'))).toEqual(
        expect.objectContaining({
          activeGenerationId: newerSnapshot.generationId,
          baseGenerationId: newerSnapshot.generationId,
          lastSeenAt: new Date(180_000).toISOString(),
        }),
      );
    });
  });

  it('does not recreate a lease deleted while a touch is waiting', () => {
    withWarmLeaseFixture('lease-delete', ({ context, localCache, leasePath }) => {
      const touched = touchExistingWorktreeLease(context.projectRoot, localCache, () => new Date(120_000), context, {
        onBeforeRepositoryLock: () => rmSync(leasePath),
      });

      expect(touched).toBeNull();
      expect(existsSync(leasePath)).toBe(false);
    });
  });

  it('preserves a recreated lease whose ownership checksum names a different cache', () => {
    withWarmLeaseFixture('lease-recreate', ({ context, localCache, leasePath }) => {
      const foreignLeaseWithoutChecksum = {
        version: 1,
        repositoryId: context.repositoryId,
        worktreeId: context.worktreeId,
        projectRoot: context.projectRoot,
        treeOid: context.treeOid,
        localCacheDir: `${localCache}-foreign`,
        baseGenerationId: 'e'.repeat(64),
        activeGenerationId: 'e'.repeat(64),
        lastAction: 'attached',
        lastSeenAt: new Date(180_000).toISOString(),
      } as const;
      const foreignLease: WorktreeCacheLease = {
        ...foreignLeaseWithoutChecksum,
        ownershipChecksum: worktreeLeaseOwnershipChecksum(foreignLeaseWithoutChecksum),
      };
      const foreignBytes = `${JSON.stringify(foreignLease, null, 2)}\n`;

      const touched = touchExistingWorktreeLease(context.projectRoot, localCache, () => new Date(120_000), context, {
        onBeforeRepositoryLock: () => writeFileSync(leasePath, foreignBytes),
      });

      expect(touched).toBeNull();
      expect(readFileSync(leasePath, 'utf8')).toBe(foreignBytes);
    });
  });

  it('rejects an ownership-checksum mismatch without rewriting the lease', () => {
    withWarmLeaseFixture('lease-checksum', ({ context, localCache, leasePath }) => {
      const lease = JSON.parse(readFileSync(leasePath, 'utf8')) as WorktreeCacheLease;
      const corruptedBytes = `${JSON.stringify({ ...lease, ownershipChecksum: '0'.repeat(64) }, null, 2)}\n`;
      writeFileSync(leasePath, corruptedBytes);

      expect(touchExistingWorktreeLease(context.projectRoot, localCache, () => new Date(120_000), context)).toBeNull();
      expect(readFileSync(leasePath, 'utf8')).toBe(corruptedBytes);
    });
  });

  it('serializes concurrent touches and never regresses lastSeenAt', () => {
    withWarmLeaseFixture('lease-concurrent-touch', ({ context, localCache, leasePath }) => {
      let inner: WorktreeCacheLease | null = null;
      const outer = touchExistingWorktreeLease(context.projectRoot, localCache, () => new Date(120_000), context, {
        onBeforeRepositoryLock: () => {
          inner = touchExistingWorktreeLease(context.projectRoot, localCache, () => new Date(180_000), context);
        },
      });

      expect(inner?.lastSeenAt).toBe(new Date(180_000).toISOString());
      expect(outer?.lastSeenAt).toBe(new Date(180_000).toISOString());
      expect((JSON.parse(readFileSync(leasePath, 'utf8')) as WorktreeCacheLease).lastSeenAt).toBe(
        new Date(180_000).toISOString(),
      );
    });
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

  it('rejects future reindex metadata before shared-generation publication', () => {
    const root = temporaryDirectory('scip-query-shared-future-metadata-');
    const cacheHome = temporaryDirectory('scip-query-shared-future-metadata-cache-');
    const previousCacheHome = process.env['XDG_CACHE_HOME'];
    process.env['XDG_CACHE_HOME'] = cacheHome;
    try {
      git(root, ['init', '-q', '-b', 'main']);
      git(root, ['config', 'user.email', 'test@example.com']);
      git(root, ['config', 'user.name', 'Test User']);
      writeFileSync(join(root, 'value.ts'), 'export const value = 1;\n');
      git(root, ['add', '.']);
      git(root, ['commit', '-qm', 'initial']);
      const paths = resolveIndexStoragePaths(root);
      const currentFingerprint = buildProjectInputFingerprint(root, ['typescript'], {});
      createCache(paths.cacheDir, root, 'future', { fingerprint: currentFingerprint, metadataVersion: 4 });

      expect(publishFreshLocalGenerationForProject(root, { languages: ['typescript'] }, paths)).toEqual({
        kind: 'missed',
        reason: 'local metadata does not match the clean worktree snapshot',
      });
    } finally {
      if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
      else process.env['XDG_CACHE_HOME'] = previousCacheHome;
    }
  });
});

function withWarmLeaseFixture(
  name: string,
  run: (fixture: {
    context: NonNullable<ReturnType<typeof resolveGitWorktreeContext>>;
    localCache: string;
    leasePath: string;
    snapshot: SharedGenerationSnapshot;
  }) => void,
): void {
  const root = temporaryDirectory(`scip-query-shared-${name}-`);
  const cacheHome = temporaryDirectory(`scip-query-shared-${name}-cache-`);
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
    createCache(localCache, root, name);
    mkdirSync(join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId), { recursive: true });
    writeWorktreeLease(snapshot, localCache, 'attached', () => new Date(0));
    run({
      context,
      localCache,
      snapshot,
      leasePath: join(snapshot.repositoryCacheDir, 'worktrees', `${snapshot.worktreeId}.json`),
    });
  } finally {
    if (previousCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = previousCacheHome;
  }
}

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

function createCache(
  cacheDir: string,
  projectRoot: string,
  value: string,
  options: { fingerprint?: ProjectInputFingerprint; metadataVersion?: number } = {},
): void {
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
      version: options.metadataVersion ?? 3,
      status: 'complete',
      updatedAt: '2026-07-14T00:00:00.000Z',
      fingerprint: options.fingerprint ?? fingerprint(),
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

function readValueFromHandle(db: ScipDatabase): string {
  return (db.db.prepare('SELECT value FROM fixture').get() as { value: string }).value;
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
