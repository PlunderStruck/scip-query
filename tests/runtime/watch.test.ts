import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tempDirs: string[] = [];

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-'));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  return projectRoot;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Watcher', () => {
  it('passes canonical index paths and trigger metadata to the reindex worker', async () => {
    const projectRoot = createProject();
    const captured: { detached?: boolean; env?: NodeJS.ProcessEnv } = {};

    vi.doMock('node:child_process', () => ({
      execFileSync: vi.fn(() => ''),
      fork: vi.fn((_path: string, _args: string[], options: { detached?: boolean; env?: NodeJS.ProcessEnv }) => {
        captured.detached = options.detached;
        captured.env = options.env;
        const child = new EventEmitter();
        process.nextTick(() => child.emit('exit', 0));
        return child;
      }),
    }));

    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: {
        dbPath: '.cache/scip-query',
        indexerConcurrency: 6,
        watch: { gitPollMs: 60_000 },
        indexer: { typescript: { projectMode: 'workspace', projects: ['packages/web'] } },
      },
      languages: ['typescript'],
    });

    await (watcher as unknown as { runReindex(trigger: unknown): Promise<number> }).runReindex({
      kind: 'watch-source',
      detail: 'src/a.ts',
    });

    expect(captured.detached).toBe(true);
    expect(captured.env).toEqual(
      expect.objectContaining({
        SCIP_REINDEX_OUTPUT_SCIP: join(projectRoot, '.cache/scip-query/index.scip'),
        SCIP_REINDEX_OUTPUT_DB: join(projectRoot, '.cache/scip-query/index.db'),
        SCIP_REINDEX_INDEXER_CONCURRENCY: '6',
        SCIP_REINDEX_TYPESCRIPT_CONFIG: JSON.stringify({
          projectMode: 'workspace',
          projects: ['packages/web'],
        }),
        SCIP_REINDEX_TRIGGER_KIND: 'watch-source',
        SCIP_REINDEX_TRIGGER_DETAIL: 'src/a.ts',
      }),
    );
  });

  it('ignores Git bookkeeping events in the source watcher path', async () => {
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      languages: ['typescript'],
    });

    (watcher as unknown as { handleFileChange(filename: string): void }).handleFileChange('.git/index');

    expect((watcher as unknown as { changedFiles: number }).changedFiles).toBe(0);
    expect((watcher as unknown as { pendingTrigger: unknown }).pendingTrigger).toBeNull();
  });

  it('refuses a second foreground watcher when the watch lock is live', async () => {
    const projectRoot = createProject();
    const lockPath = join(projectRoot, '.cache', 'watch.lock');
    mkdirSync(join(projectRoot, '.cache'));
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: process.pid,
        projectRoot,
        startedAt: '2026-07-01T00:00:00.000Z',
      })}\n`,
    );

    const { acquireWatchProcessLock } = await import('../../src/runtime/commands/command-handlers.js');
    const result = acquireWatchProcessLock(lockPath, projectRoot);

    expect(result.acquired).toBe(false);
    expect(result.message).toContain('watch is already running');
    expect(result.message).toContain(lockPath);
  });

  it('replaces a stale watch lock', async () => {
    const projectRoot = createProject();
    const lockPath = join(projectRoot, '.cache', 'watch.lock');
    mkdirSync(join(projectRoot, '.cache'));
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        version: 1,
        pid: 99_999_999,
        projectRoot,
        startedAt: '2026-07-01T00:00:00.000Z',
      })}\n`,
    );

    const { acquireWatchProcessLock } = await import('../../src/runtime/commands/command-handlers.js');
    const result = acquireWatchProcessLock(lockPath, projectRoot);

    try {
      expect(result.acquired).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      result.release();
    }
    expect(existsSync(lockPath)).toBe(false);
  });
});
