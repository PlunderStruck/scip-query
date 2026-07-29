import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveIndexStoragePaths } from '../../src/platform/cache-layout.js';
import { loadProjectConfig } from '../../src/runtime/config.js';
import { getIndexFreshness } from '../../src/runtime/index-freshness.js';
import { inspectSharedCacheStatus } from '../../src/runtime/repository-cache-lifecycle.js';
import { resolveGitWorktreeContext } from '../../src/platform/git-worktree.js';
import { reindex } from '../../src/reindex/index.js';
import {
  buildSharedGenerationSnapshot,
  prepareSharedGenerationForProject,
  readSharedGeneration,
} from '../../src/reindex/shared-generation-store.js';
import { buildProjectInputFingerprint } from '../../src/platform/project-files.js';

const tempDirs: string[] = [];
const originalEnvironment = {
  XDG_CACHE_HOME: process.env['XDG_CACHE_HOME'],
  SCIP_QUERY_SHARED_CACHE: process.env['SCIP_QUERY_SHARED_CACHE'],
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('shared Git worktree cache integration', () => {
  it('coordinates simultaneous cold worktrees through one published generation', async () => {
    const root = temporaryDirectory('scip-query-shared-concurrent-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    const primary = join(root, 'primary');
    const firstWorktree = join(root, 'first-worktree');
    const secondWorktree = join(root, 'second-worktree');
    createTypeScriptRepository(primary);
    git(primary, ['worktree', 'add', '--detach', firstWorktree, 'HEAD']);
    git(primary, ['worktree', 'add', '--detach', secondWorktree, 'HEAD']);
    const firstPaths = resolveIndexStoragePaths(firstWorktree, {});
    const secondPaths = resolveIndexStoragePaths(secondWorktree, {});
    const firstStatuses: string[] = [];
    const secondStatuses: string[] = [];

    const [first, second] = await Promise.all([
      reindex({
        projectRoot: firstWorktree,
        languages: ['typescript'],
        outputScip: firstPaths.indexPath,
        outputDb: firstPaths.dbPath,
        skipIfUnchanged: true,
        onStatus: (message) => firstStatuses.push(message),
      }),
      reindex({
        projectRoot: secondWorktree,
        languages: ['typescript'],
        outputScip: secondPaths.indexPath,
        outputDb: secondPaths.dbPath,
        skipIfUnchanged: true,
        onStatus: (message) => secondStatuses.push(message),
      }),
    ]);

    expect([first.reused, second.reused].sort()).toEqual([false, true]);
    expect(
      [...firstStatuses, ...secondStatuses].filter((message) => message.includes('Published shared generation')),
    ).toHaveLength(1);
    expect([...firstStatuses, ...secondStatuses].some((message) => message.includes('after waiting'))).toBe(true);
    expect(documentPaths(firstPaths.dbPath)).toEqual(documentPaths(secondPaths.dbPath));
  }, 60_000);

  it('publishes once, attaches a linked worktree, and keeps dirty updates private', async () => {
    const root = temporaryDirectory('scip-query-shared-worktree-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    delete process.env['SCIP_QUERY_SHARED_CACHE'];
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    createTypeScriptRepository(primary);
    const primaryPaths = resolveIndexStoragePaths(primary, {});
    const primaryStatuses: string[] = [];

    const first = await reindex({
      projectRoot: primary,
      languages: ['typescript'],
      outputScip: primaryPaths.indexPath,
      outputDb: primaryPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: (message) => primaryStatuses.push(message),
    });
    expect(first.reused).toBe(false);
    const context = resolveGitWorktreeContext(primary)!;
    const snapshot = buildSharedGenerationSnapshot(context, buildProjectInputFingerprint(primary, ['typescript'], {}))!;
    expect(readSharedGeneration(snapshot)).not.toBeNull();
    expect(primaryStatuses.some((message) => message.includes('Published shared generation'))).toBe(true);

    const repeatStatuses: string[] = [];
    const repeated = await reindex({
      projectRoot: primary,
      languages: ['typescript'],
      outputScip: primaryPaths.indexPath,
      outputDb: primaryPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: (message) => repeatStatuses.push(message),
    });
    expect(repeated.reused).toBe(true);
    expect(repeatStatuses.some((message) => message.includes('Attached shared generation'))).toBe(false);

    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedPaths = resolveIndexStoragePaths(linked, {});
    const linkedStatuses: string[] = [];
    const attached = await reindex({
      projectRoot: linked,
      languages: ['typescript'],
      outputScip: linkedPaths.indexPath,
      outputDb: linkedPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: (message) => linkedStatuses.push(message),
    });
    expect(attached.reused).toBe(true);
    expect(linkedStatuses.some((message) => message.includes('Attached shared generation'))).toBe(true);
    expect(documentPaths(linkedPaths.dbPath)).toEqual(documentPaths(primaryPaths.dbPath));
    expect(getIndexFreshness(linked, {}, linkedPaths).state).toBe('fresh');

    const sharedDb = join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId, 'index.db');
    const sharedHash = fileHash(sharedDb);
    writeFileSync(join(linked, 'src/value.ts'), 'export const value = 2;\n');
    const dirtyStatuses: string[] = [];
    const dirty = await reindex({
      projectRoot: linked,
      languages: ['typescript'],
      outputScip: linkedPaths.indexPath,
      outputDb: linkedPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: (message) => dirtyStatuses.push(message),
    });
    expect(dirty.reused).toBe(false);
    expect(dirtyStatuses.some((message) => message.includes('Forked shared baseline'))).toBe(false);
    expect(fileHash(sharedDb)).toBe(sharedHash);
    expect(getIndexFreshness(linked, {}, linkedPaths).state).toBe('fresh');
    expect(getIndexFreshness(primary, {}, primaryPaths).state).toBe('fresh');
  }, 60_000);

  it('forks the committed baseline when a linked worktree is dirty before its first reindex', async () => {
    const root = temporaryDirectory('scip-query-shared-dirty-first-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    createTypeScriptRepository(primary);
    writeFileSync(join(primary, 'pyproject.toml'), '[project]\nname = "fixture"\nversion = "1.0.0"\n');
    writeFileSync(join(primary, 'src/value.py'), 'value = 1\n');
    git(primary, ['add', '.']);
    git(primary, ['commit', '-qm', 'add python']);
    const primaryPaths = resolveIndexStoragePaths(primary, {});
    await reindex({
      projectRoot: primary,
      languages: ['typescript', 'python'],
      outputScip: primaryPaths.indexPath,
      outputDb: primaryPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: () => undefined,
    });
    const context = resolveGitWorktreeContext(primary)!;
    const fingerprint = buildProjectInputFingerprint(primary, ['typescript', 'python'], {});
    const snapshot = buildSharedGenerationSnapshot(context, fingerprint)!;
    const sharedDb = join(snapshot.repositoryCacheDir, 'generations', snapshot.generationId, 'index.db');
    const sharedHash = fileHash(sharedDb);

    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedPaths = resolveIndexStoragePaths(linked, {});
    writeFileSync(join(linked, 'src/value.ts'), 'export const value = 2;\n');
    expect(existsSync(linkedPaths.dbPath)).toBe(false);
    const statuses: string[] = [];

    const dirty = await reindex({
      projectRoot: linked,
      languages: ['typescript', 'python'],
      outputScip: linkedPaths.indexPath,
      outputDb: linkedPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: (message) => statuses.push(message),
    });

    expect(statuses.some((message) => message.includes('Forked shared baseline'))).toBe(true);
    expect(statuses.some((message) => message.includes('Reusing cached python SCIP shard'))).toBe(true);
    expect(dirty.shards?.find((shard) => shard.language === 'python')).toEqual(
      expect.objectContaining({ reused: true }),
    );
    expect(dirty.shards?.find((shard) => shard.language === 'typescript')).toEqual(
      expect.objectContaining({ reused: false }),
    );
    expect(fileHash(sharedDb)).toBe(sharedHash);
    expect(getIndexFreshness(linked, {}, linkedPaths).state).toBe('fresh');
    expect(getIndexFreshness(primary, {}, primaryPaths).state).toBe('fresh');
    const sharedStatus = inspectSharedCacheStatus(linked, loadProjectConfig(linked), linkedPaths);
    expect(sharedStatus).toEqual(
      expect.objectContaining({
        state: 'managed',
        baseGenerationId: snapshot.generationId,
        activeGenerationId: undefined,
        lastAction: 'overlay',
        protectedGenerations: 1,
      }),
    );
  }, 90_000);

  it('imports a stable primary cache even after the primary files become dirty', async () => {
    const root = temporaryDirectory('scip-query-shared-peer-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    createTypeScriptRepository(primary);
    const primaryPaths = resolveIndexStoragePaths(primary, {});
    await reindex({
      projectRoot: primary,
      languages: ['typescript'],
      outputScip: primaryPaths.indexPath,
      outputDb: primaryPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: () => undefined,
    });
    const context = resolveGitWorktreeContext(primary)!;
    const snapshot = buildSharedGenerationSnapshot(context, buildProjectInputFingerprint(primary, ['typescript'], {}))!;
    rmSync(join(snapshot.repositoryCacheDir, 'generations'), { recursive: true, force: true });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    writeFileSync(join(primary, 'src/value.ts'), 'export const primaryOnly = 3;\n');

    const linkedConfig = loadProjectConfig(linked);
    const linkedPaths = resolveIndexStoragePaths(linked, linkedConfig);
    const action = prepareSharedGenerationForProject(linked, linkedConfig, linkedPaths);

    expect(action).toEqual(expect.objectContaining({ kind: 'peer-imported' }));
    expect(existsSync(linkedPaths.dbPath)).toBe(true);
    expect(getIndexFreshness(linked, linkedConfig, linkedPaths).state).toBe('fresh');
  }, 60_000);

  it('rejects a primary cache that contains changes absent from the new worktree HEAD', async () => {
    const root = temporaryDirectory('scip-query-shared-dirty-peer-');
    process.env['XDG_CACHE_HOME'] = join(root, 'xdg-cache');
    const primary = join(root, 'primary');
    const linked = join(root, 'linked');
    createTypeScriptRepository(primary);
    const primaryPaths = resolveIndexStoragePaths(primary, {});
    await reindex({
      projectRoot: primary,
      languages: ['typescript'],
      outputScip: primaryPaths.indexPath,
      outputDb: primaryPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: () => undefined,
    });
    const cleanContext = resolveGitWorktreeContext(primary)!;
    const cleanSnapshot = buildSharedGenerationSnapshot(
      cleanContext,
      buildProjectInputFingerprint(primary, ['typescript'], {}),
    )!;
    rmSync(join(cleanSnapshot.repositoryCacheDir, 'generations'), { recursive: true, force: true });

    writeFileSync(join(primary, 'src/value.ts'), 'export const dirtyOnly = 2;\n');
    await reindex({
      projectRoot: primary,
      languages: ['typescript'],
      outputScip: primaryPaths.indexPath,
      outputDb: primaryPaths.dbPath,
      skipIfUnchanged: true,
      onStatus: () => undefined,
    });
    git(primary, ['worktree', 'add', '--detach', linked, 'HEAD']);
    const linkedConfig = loadProjectConfig(linked);
    const linkedPaths = resolveIndexStoragePaths(linked, linkedConfig);

    expect(prepareSharedGenerationForProject(linked, linkedConfig, linkedPaths)).toEqual(
      expect.objectContaining({ kind: 'missed' }),
    );
    expect(existsSync(linkedPaths.dbPath)).toBe(false);
  }, 60_000);
});

function createTypeScriptRepository(root: string): void {
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module' })}\n`,
  );
  writeFileSync(
    join(root, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['src'] })}\n`,
  );
  writeFileSync(join(root, 'src/value.ts'), 'export const value = 1;\n');
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['add', '.']);
  git(root, ['commit', '-qm', 'initial']);
}

function documentPaths(path: string): string[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (
      db.prepare('SELECT relative_path FROM documents ORDER BY relative_path').all() as Array<{ relative_path: string }>
    ).map((row) => row.relative_path);
  } finally {
    db.close();
  }
}

function fileHash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}
