import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveIndexStoragePaths } from '../src/platform/cache-layout.js';
import { cliVersion } from '../src/platform/cli-version.js';
import { resolveGitWorktreeContext } from '../src/platform/git-worktree.js';
import { buildProjectInputFingerprint } from '../src/platform/project-files.js';
import { reindex } from '../src/reindex/index.js';
import {
  buildSharedGenerationSnapshot,
  type SharedGenerationSnapshot,
} from '../src/reindex/shared-generation-store.js';
import { inspectLocalSqliteGenerationRetention } from '../src/reindex/sqlite-generation-store.js';
import { typeScriptFragmentStorePaths } from '../src/reindex/typescript-fragment-store.js';
import {
  DEFAULT_SHARED_GENERATION_TTL_MS,
  maybeSweepRepositoryCache,
} from '../src/runtime/repository-cache-lifecycle.js';

const cycles = cycleCount(process.argv.slice(2));
const root = mkdtempSync(join(tmpdir(), 'scip-query-cache-lifecycle-soak-'));
const previousXdgCacheHome = process.env['XDG_CACHE_HOME'];
const previousSharedCache = process.env['SCIP_QUERY_SHARED_CACHE'];
const cacheHome = join(root, 'xdg-cache');
const primary = join(root, 'primary');
const cliPath = resolve('dist/cli.js');
let activeServiceRoot: string | undefined;

try {
  assert(existsSync(cliPath), `CLI build artifact is missing: ${cliPath}`);
  process.env['XDG_CACHE_HOME'] = cacheHome;
  delete process.env['SCIP_QUERY_SHARED_CACHE'];
  createTypeScriptRepository(primary);
  const primaryPaths = resolveIndexStoragePaths(primary, {});
  await reindexProject(primary, primaryPaths, []);
  const baseline = sharedSnapshot(primary);
  const generationsDir = join(baseline.repositoryCacheDir, 'generations');
  const projectsDir = join(cacheHome, 'scip-query', 'projects');
  const baselineProjectCaches = directoryNames(projectsDir);
  const baselineManagedBytes = directorySize(primaryPaths.cacheDir) + directorySize(generationsDir);
  const startedAt = Date.now();
  const observations: Array<Record<string, unknown>> = [];

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const disposable = join(root, `disposable-${cycle}`);
    git(primary, ['worktree', 'add', '--detach', disposable, 'HEAD']);
    const paths = resolveIndexStoragePaths(disposable, {});
    const attachStatuses: string[] = [];
    const attached = await reindexProject(disposable, paths, attachStatuses);
    assert.equal(attached.reused, true, `cycle ${cycle}: committed baseline did not attach`);
    assert(
      attachStatuses.some((message) => message.includes('Attached shared generation')),
      `cycle ${cycle}: no shared-generation attach evidence`,
    );

    watchCli(disposable, [
      '--daemon',
      '--json',
      '--debounce',
      '300000',
      '--cooldown',
      '0',
      '--git-poll',
      '300000',
      '--idle-timeout',
      '0',
    ]);
    activeServiceRoot = disposable;

    writeFileSync(join(disposable, 'src/value.ts'), `export const value = ${cycle + 2};\n`);
    git(disposable, ['add', 'src/value.ts']);
    git(disposable, ['commit', '-qm', `cycle ${cycle}`]);
    const generation = sharedSnapshot(disposable);
    const updateStatuses: string[] = [];
    const updated = await reindexProject(disposable, paths, updateStatuses);
    assert.equal(updated.reused, false, `cycle ${cycle}: changed committed tree was incorrectly reused`);
    const patched = updateStatuses.find((message) => /^Patched \d+ SQLite document\(s\)/.test(message));
    assert(
      patched,
      `cycle ${cycle}: eligible edit did not use incremental SQLite publication\n${updateStatuses.join('\n')}`,
    );
    assert(
      !updateStatuses.some((message) => message.includes('Incremental SQLite publication unavailable')),
      `cycle ${cycle}: incremental publication fell back to a complete conversion`,
    );
    assert(
      updateStatuses.some((message) => message.includes('Published shared generation')),
      `cycle ${cycle}: clean generation was not published`,
    );
    const localRetention = inspectLocalSqliteGenerationRetention(paths.dbPath);
    assert.equal(localRetention.state, 'managed');
    assert.equal(localRetention.generationCount, 2, `cycle ${cycle}: local generations were not bounded`);
    const fragmentGenerations = directoryNames(typeScriptFragmentStorePaths(paths.cacheDir).generationDir);
    assert.equal(fragmentGenerations.length, 1, `cycle ${cycle}: obsolete TypeScript fragments were retained`);
    assert(existsSync(join(generationsDir, generation.generationId)));

    watchCli(disposable, ['--stop', '--json']);
    activeServiceRoot = undefined;
    git(primary, ['worktree', 'remove', '--force', disposable]);

    const removedAt = startedAt + cycle * (DEFAULT_SHARED_GENERATION_TTL_MS + 1);
    const removed = maybeSweepRepositoryCache(primary, cliVersion, { force: true, now: () => removedAt });
    assert.equal(removed.kind, 'swept');
    assert.equal(removed.deletedWorktrees, 1, `cycle ${cycle}: removed worktree cache survived`);
    assert.equal(removed.deletedGenerations, 0, `cycle ${cycle}: generation bypassed its grace period`);
    assert(!existsSync(paths.cacheDir));
    assert(existsSync(join(generationsDir, generation.generationId)));

    const aged = maybeSweepRepositoryCache(primary, cliVersion, {
      force: true,
      now: () => removedAt + DEFAULT_SHARED_GENERATION_TTL_MS,
    });
    assert.equal(aged.kind, 'swept');
    assert.equal(aged.deletedGenerations, 1, `cycle ${cycle}: unreferenced generation did not age out`);
    assert(!existsSync(join(generationsDir, generation.generationId)));
    assert(existsSync(primaryPaths.cacheDir), `cycle ${cycle}: active cache was deleted`);
    assert(existsSync(join(generationsDir, baseline.generationId)), `cycle ${cycle}: active baseline was deleted`);
    assert.deepEqual(directoryNames(projectsDir), baselineProjectCaches, `cycle ${cycle}: checkout cache leaked`);
    const managedBytes = directorySize(primaryPaths.cacheDir) + directorySize(generationsDir);
    assert.equal(managedBytes, baselineManagedBytes, `cycle ${cycle}: managed bytes did not return to the plateau`);

    observations.push({
      cycle,
      attachDurationMs: attached.durationMs,
      updateDurationMs: updated.durationMs,
      incrementalPublication: patched,
      localGenerationCount: localRetention.generationCount,
      fragmentGenerationCount: fragmentGenerations.length,
      removedWorktreeCaches: removed.deletedWorktrees,
      agedSharedGenerations: aged.deletedGenerations,
      managedBytes,
    });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        kind: 'cache-lifecycle-soak',
        version: 1,
        cycles,
        baselineManagedBytes,
        finalManagedBytes: directorySize(primaryPaths.cacheDir) + directorySize(generationsDir),
        plateau: true,
        activeCacheSurvived: true,
        incrementalCycles: observations.length,
        observations,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (activeServiceRoot) {
    try {
      watchCli(activeServiceRoot, ['--stop', '--json']);
    } catch {
      // Preserve the primary soak failure; the private temp root is removed next.
    }
  }
  rmSync(root, { recursive: true, force: true });
  if (previousXdgCacheHome === undefined) delete process.env['XDG_CACHE_HOME'];
  else process.env['XDG_CACHE_HOME'] = previousXdgCacheHome;
  if (previousSharedCache === undefined) delete process.env['SCIP_QUERY_SHARED_CACHE'];
  else process.env['SCIP_QUERY_SHARED_CACHE'] = previousSharedCache;
}

function cycleCount(args: readonly string[]): number {
  const option = args.find((argument) => argument.startsWith('--cycles='));
  const value = option ? Number(option.slice('--cycles='.length)) : 8;
  assert(Number.isSafeInteger(value) && value > 0 && value <= 100, '--cycles must be an integer between 1 and 100');
  return value;
}

function createTypeScriptRepository(projectRoot: string): void {
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    `${JSON.stringify({ name: 'cache-lifecycle-soak', version: '1.0.0', type: 'module' })}\n`,
  );
  writeFileSync(
    join(projectRoot, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext' }, include: ['src'] })}\n`,
  );
  writeFileSync(
    join(projectRoot, '.scipquery.json'),
    `${JSON.stringify({ schemaVersion: 2, languages: ['typescript'], watch: { enabled: true } })}\n`,
  );
  writeFileSync(join(projectRoot, 'src/value.ts'), 'export const value = 1;\n');
  git(projectRoot, ['init', '-q', '-b', 'main']);
  git(projectRoot, ['config', 'user.email', 'test@example.com']);
  git(projectRoot, ['config', 'user.name', 'Test User']);
  git(projectRoot, ['add', '.']);
  git(projectRoot, ['commit', '-qm', 'initial']);
}

function sharedSnapshot(projectRoot: string): SharedGenerationSnapshot {
  const context = resolveGitWorktreeContext(projectRoot);
  assert(context, `missing Git worktree context for ${projectRoot}`);
  const snapshot = buildSharedGenerationSnapshot(
    context,
    buildProjectInputFingerprint(projectRoot, ['typescript'], {}),
  );
  assert(snapshot, `missing shared-generation snapshot for ${projectRoot}`);
  return snapshot;
}

async function reindexProject(
  projectRoot: string,
  paths: ReturnType<typeof resolveIndexStoragePaths>,
  statuses: string[],
) {
  return await reindex({
    projectRoot,
    languages: ['typescript'],
    outputScip: paths.indexPath,
    outputDb: paths.dbPath,
    skipIfUnchanged: true,
    onStatus: (message) => statuses.push(message),
  });
}

function directoryNames(path: string): string[] {
  return existsSync(path) ? readdirSync(path).sort() : [];
}

function directorySize(path: string): number {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const entryPath = join(path, entry.name);
    return total + (entry.isDirectory() ? directorySize(entryPath) : statSync(entryPath).size);
  }, 0);
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function watchCli(cwd: string, args: readonly string[]): void {
  execFileSync(process.execPath, [cliPath, 'watch', ...args], {
    cwd,
    env: process.env,
    stdio: 'pipe',
  });
}
