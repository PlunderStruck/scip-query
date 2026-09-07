import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GitReader } from '../../src/platform/git-worktree.js';
import {
  isCheapIgnoredWatchPath,
  readWatchGitHeadOid,
  resolveWatchGitLayout,
  shouldUseRecursiveSourceWatch,
  type ReindexDiagnostics,
  type ReindexOperation,
  type ReindexRunner,
  type ReindexRunRequest,
  type WatchClock,
  type WatchSubscription,
  type WatchSubscriptionFactory,
} from '../../src/runtime/watch.js';

const tempDirs: string[] = [];

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-'));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  return projectRoot;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' }).trim();
}

function controlledReindexRunner(): {
  runner: ReindexRunner;
  run: ReturnType<typeof vi.fn<(request: ReindexRunRequest) => void>>;
  requests: ReindexRunRequest[];
  completions: Array<(durationMs: number) => void>;
} {
  const requests: ReindexRunRequest[] = [];
  const completions: Array<(durationMs: number) => void> = [];
  const run = vi.fn<(request: ReindexRunRequest) => void>();
  const start = vi.fn<(request: ReindexRunRequest) => ReindexOperation>((request) => {
    requests.push(request);
    let resolveCompletion!: (durationMs: number) => void;
    const completion = new Promise<number>((resolvePromise) => {
      resolveCompletion = resolvePromise;
      completions.push(resolvePromise);
    });
    run(request);
    return {
      completion,
      async cancel() {
        resolveCompletion(0);
        await completion;
        return { state: 'exited', diagnostics: emptyDiagnostics() };
      },
      diagnostics: emptyDiagnostics,
    };
  });
  return { runner: { start }, run, requests, completions };
}

function emptyDiagnostics(): ReindexDiagnostics {
  return {
    stdoutTail: '',
    stderrTail: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function completedOperation(durationMs = 1): ReindexOperation {
  return {
    completion: Promise.resolve(durationMs),
    cancel: async () => ({ state: 'exited', diagnostics: emptyDiagnostics() }),
    diagnostics: emptyDiagnostics,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sourceSubscriptionHarness(): {
  factory: WatchSubscriptionFactory;
  emitAll(eventName: string, path: string): void;
  emitError(error: Error): void;
} {
  const emitter = new EventEmitter();
  const subscription = {
    on(event: 'all' | 'error', listener: (...args: never[]) => void) {
      emitter.on(event, listener);
      return subscription;
    },
    close: vi.fn(async () => undefined),
  } as WatchSubscription;
  return {
    factory: () => subscription,
    emitAll: (eventName, path) => emitter.emit('all', eventName, path),
    emitError: (error) => emitter.emit('error', error),
  };
}

function rawGitEntry(before: string, after: string, status: string, path: string): string {
  return `:100644 100644 ${before.padStart(40, '0')} ${after.padStart(40, '0')} ${status}\0${path}\0`;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('watch CPU filters', () => {
  it('ignores Git, dependency, and in-repo cache paths without gitignore', () => {
    expect(isCheapIgnoredWatchPath('.git/index')).toBe(true);
    expect(isCheapIgnoredWatchPath('node_modules/left-pad/index.js')).toBe(true);
    expect(isCheapIgnoredWatchPath('packages/app/node_modules/pkg/index.js')).toBe(true);
    expect(isCheapIgnoredWatchPath('src/a.ts')).toBe(false);
    expect(isCheapIgnoredWatchPath('.cache/scip-query/index.db', '.cache/scip-query')).toBe(true);
    expect(isCheapIgnoredWatchPath('src/a.ts', '.cache/scip-query')).toBe(false);
  });

  it('reads HEAD and the index path from Git files', () => {
    const projectRoot = createProject();
    git(projectRoot, ['init', '-q', '-b', 'main']);
    git(projectRoot, ['config', 'user.email', 'test@example.com']);
    git(projectRoot, ['config', 'user.name', 'Test User']);
    git(projectRoot, ['add', '.']);
    git(projectRoot, ['commit', '-qm', 'initial']);
    const layout = resolveWatchGitLayout(projectRoot);
    expect(layout).toEqual(
      expect.objectContaining({
        gitDir: expect.stringContaining('.git'),
        indexPath: expect.stringContaining(`${join('.git', 'index')}`),
      }),
    );
    expect(readWatchGitHeadOid(layout!.gitDir)).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(layout!.indexPath)).toBe(true);
  });
});

describe('Watcher', () => {
  it('waits for two quiet seconds after the last event by default', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).not.toHaveBeenCalled();

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/b.ts' });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(run).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it('cancels a pending quiet-period refresh when stopped', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' });
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(run).not.toHaveBeenCalled();
  });

  it.each([
    [250, 0],
    [250, 1_000],
    [250, 5_000],
    [750, 0],
    [750, 1_000],
    [750, 5_000],
    [1_500, 0],
    [1_500, 1_000],
    [1_500, 5_000],
  ])('coalesces the calibration burst at %ims debounce / %ims cooldown', async (debounceMs, cooldownMs) => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const controlled = controlledReindexRunner();
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs, cooldownMs, gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: controlled.runner,
    });

    for (let write = 0; write < 20; write += 1) {
      watcher.requestRefresh({ kind: 'watch-source', detail: `write-${write}` });
      await vi.advanceTimersByTimeAsync(25);
    }
    await vi.advanceTimersByTimeAsync(debounceMs);
    expect(controlled.run).toHaveBeenCalledTimes(1);

    watcher.requestRefresh({ kind: 'watch-source', detail: 'during-index' });
    controlled.completions[0]?.(100);
    await vi.advanceTimersByTimeAsync(Math.max(5_000, cooldownMs));
    expect(controlled.run).toHaveBeenCalledTimes(2);

    controlled.completions[1]?.(100);
    await vi.runAllTimersAsync();
    await watcher.stop();
  });

  it('does not accept a superseded completion even when freshness validation would accept it', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const suppressed: unknown[] = [];
    const { Watcher } = await import('../../src/runtime/watch.js');
    const controlled = controlledReindexRunner();
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 1_000, gitPollMs: 60_000 } },
      languages: ['typescript'],
      onReindexComplete: () => true,
      onRefreshSuppressed: (trigger) => suppressed.push(trigger),
      reindexRunner: controlled.runner,
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' });
    await vi.advanceTimersByTimeAsync(250);
    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' });
    controlled.completions[0]?.(100);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(controlled.run).toHaveBeenCalledTimes(2);
    expect(suppressed).toEqual([]);
    controlled.completions[1]?.(100);
    await Promise.resolve();
    await watcher.stop();
  });

  it('persists one pending refresh while the resource budget is paused and retries when it reopens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    let paused = true;
    const statuses: Array<{ state: string; dirty?: boolean }> = [];
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 0, gitPollMs: 60_000 } },
      reindexRunner: { start: run },
      budgetInspector: (_outputDb, _config, now) =>
        paused
          ? {
              state: 'paused',
              reason: 'estimated-write-bytes',
              until: now.getTime() + 1_000,
              rebuilt: 1,
              estimatedWriteBytes: 512,
              detail: 'write budget consumed',
            }
          : { state: 'allowed', rebuilt: 0, estimatedWriteBytes: 0 },
      onStatus: (status) => statuses.push(status),
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' }, { immediate: true });
    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/b.ts' }, { immediate: true });

    expect(run).not.toHaveBeenCalled();
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ state: 'budget-paused', dirty: true }));

    paused = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    expect(run).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it('still starts a cheap refresh after expensive full-rebuild slots are exhausted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-29T12:00:00.000Z'));
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 0, gitPollMs: 60_000 } },
      reindexRunner: { start: run },
      budgetInspector: () => ({
        state: 'paused',
        reason: 'rebuild-count',
        until: Date.parse('2026-07-29T12:15:00.000Z'),
        rebuilt: 2,
        estimatedWriteBytes: 512,
        detail: '2/2 expensive full rebuild slots consumed',
      }),
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' }, { immediate: true });

    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ allowExpensiveRebuild: false }));
    await watcher.stop();
  });

  it('drops a budget-paused pending refresh once a manual reindex publishes a fresh generation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T18:00:00.000Z'));
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const statuses: Array<{ state: string; dirty?: boolean }> = [];
    const suppressed: unknown[] = [];
    let generation = 'generation-setup';
    let freshness: 'fresh' | 'stale' = 'stale';
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 0, gitPollMs: 1_000 } },
      reindexRunner: { start: run },
      budgetInspector: (_outputDb, _config, now) => ({
        state: 'paused',
        reason: 'estimated-write-bytes',
        until: now.getTime() + 15 * 60_000,
        rebuilt: 1,
        estimatedWriteBytes: 1_449_816_966,
        detail: 'write budget consumed',
      }),
      publishedGeneration: () => generation,
      indexFreshness: () => freshness,
      onStatus: (status) => statuses.push(status),
      onRefreshSuppressed: (trigger) => suppressed.push(trigger),
    });
    watcher.start();

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' }, { immediate: true });
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ state: 'budget-paused', dirty: true }));

    // A generation appears that the watcher did not produce, but the tree moved on: keep waiting.
    generation = 'generation-manual-1';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ state: 'budget-paused', dirty: true }));
    expect(suppressed).toEqual([]);

    // The next manual publication matches the working tree: the pending refresh is satisfied.
    generation = 'generation-manual-2';
    freshness = 'fresh';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    expect(suppressed).toEqual([
      expect.objectContaining({
        kind: 'watch-source',
        detail: expect.stringContaining('published outside the watcher'),
      }),
    ]);
    expect(run).not.toHaveBeenCalled();

    // Once idle, nothing pends, so later publications are ignored.
    generation = 'generation-manual-3';
    await vi.advanceTimersByTimeAsync(1_000);
    expect(statuses.at(-1)).toEqual({ state: 'idle' });
    expect(suppressed).toHaveLength(1);
    await watcher.stop();
  });

  it('cancels a resource-budget retry when the watcher stops', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      reindexRunner: { start: run },
      budgetInspector: (_outputDb, _config, now) => ({
        state: 'paused',
        reason: 'estimated-write-bytes',
        until: now.getTime() + 1_000,
        rebuilt: 1,
        estimatedWriteBytes: 512,
        detail: 'write budget consumed',
      }),
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' }, { immediate: true });
    await watcher.stop();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(run).not.toHaveBeenCalled();
  });

  it('preserves a dirty rerun when completion freshness cannot be observed', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const errors: string[] = [];
    const { Watcher } = await import('../../src/runtime/watch.js');
    const controlled = controlledReindexRunner();
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 1_000, gitPollMs: 60_000 } },
      languages: ['typescript'],
      onReindexComplete: () => {
        throw new Error('freshness unavailable');
      },
      onError: (error) => errors.push(error.message),
      reindexRunner: controlled.runner,
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' });
    await vi.advanceTimersByTimeAsync(250);
    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/b.ts' });
    controlled.completions[0]?.(100);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(controlled.run).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([]);
    await watcher.stop();
  });

  it('can request an immediate startup refresh without waiting for debounce', async () => {
    const projectRoot = createProject();
    const statuses: string[] = [];
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 60_000, gitPollMs: 60_000 } },
      languages: ['typescript'],
      onStatus: (status) => statuses.push(status.state),
      reindexRunner: { start: run },
    });

    watcher.requestRefresh({ kind: 'watch-startup' }, { immediate: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    expect(statuses[0]).toBe('indexing');
    await watcher.stop();
  });

  it('attributes a failed reindex to the exact trigger consumed by that attempt', async () => {
    const projectRoot = createProject();
    const completion = deferred<number>();
    const onReindexError = vi.fn();
    const onError = vi.fn();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 60_000, gitPollMs: 60_000 } },
      languages: ['typescript'],
      onReindexError,
      onError,
      reindexRunner: {
        start: () => ({
          completion: completion.promise,
          cancel: async () => ({ state: 'exited', diagnostics: emptyDiagnostics() }),
          diagnostics: emptyDiagnostics,
        }),
      },
    });
    const trigger = { kind: 'watch-demand' as const, detail: 'claimed request A' };

    watcher.requestRefresh(trigger, { immediate: true });
    completion.reject(new Error('worker failed'));
    await vi.waitFor(() => expect(onReindexError).toHaveBeenCalledOnce());

    expect(onReindexError).toHaveBeenCalledWith(expect.objectContaining({ message: 'worker failed' }), trigger);
    expect(onError).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it('retains exact source changes and retries a temporary cache ownership conflict', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const subscription = sourceSubscriptionHarness();
    const firstCompletion = deferred<number>();
    const requests: ReindexRunRequest[] = [];
    const onReindexError = vi.fn();
    const onError = vi.fn();
    let starts = 0;
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>((request) => {
      requests.push(request);
      starts += 1;
      if (starts === 1) {
        return {
          completion: firstCompletion.promise,
          cancel: async () => ({ state: 'exited', diagnostics: emptyDiagnostics() }),
          diagnostics: emptyDiagnostics,
        };
      }
      return completedOperation();
    });
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 5_000, gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
      onReindexError,
      onError,
    });

    watcher.start();
    for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts']) {
      subscription.emitAll('change', path);
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledOnce();

    firstCompletion.reject(Object.assign(new Error('manual refresh owns cache lock'), { retryable: true as const }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onReindexError).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(requests[1]?.changeJournal?.entries).toEqual(
      ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'].map((path) => ({
        path,
        kind: 'change',
      })),
    );
    expect(requests[1]?.trigger).toEqual({ kind: 'watch-source', detail: 'multiple changes' });
    await watcher.stop();
  });

  it('cancels and retries after a source change supersedes an in-flight reindex', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const firstCompletion = deferred<number>();
    const onReindexError = vi.fn();
    const cancel = vi.fn(async () => {
      try {
        await firstCompletion.promise;
      } catch {
        // A superseded operation is expected to reject when its process exits.
      }
      return { state: 'exited' as const, diagnostics: emptyDiagnostics() };
    });
    let starts = 0;
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => {
      starts += 1;
      return starts === 1
        ? {
            completion: firstCompletion.promise,
            cancel,
            diagnostics: emptyDiagnostics,
          }
        : completedOperation();
    });
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 1_000, gitPollMs: 60_000 } },
      languages: ['typescript'],
      onReindexError,
      onError: vi.fn(),
      reindexRunner: { start: run },
    });

    watcher.requestRefresh({ kind: 'watch-startup' }, { immediate: true });
    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' });
    expect(cancel).toHaveBeenCalledOnce();
    firstCompletion.reject(new Error('filesystem snapshot changed'));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0].trigger).toEqual({ kind: 'watch-source', detail: 'src/a.ts' });
    expect(onReindexError).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('decodes the worker module URL into a filesystem path for encoded installation names', async () => {
    const projectRoot = createProject();
    const installRoot = join(projectRoot, 'installation with spaces # and %');
    const moduleUrl = pathToFileURL(join(installRoot, 'watch.js'));
    const { resolveReindexWorkerLaunch } = await import('../../src/runtime/watch.js');
    const NativeURL = globalThis.URL;
    vi.stubGlobal(
      'URL',
      class extends NativeURL {
        constructor(input: string | URL, base?: string | URL) {
          super(input, input === './reindex-worker.js' ? moduleUrl : base);
        }
      },
    );
    try {
      const launch = resolveReindexWorkerLaunch(
        {
          projectRoot,
          config: {},
          pnpmWorkspaces: false,
          trigger: { kind: 'watch-source' },
        },
        (pid) => ({ version: 1, pid, platform: process.platform, startToken: 'test-parent' }),
      );
      expect(launch.workerPath).toBe(join(installRoot, 'reindex-worker.js'));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('passes canonical index paths and trigger metadata to the reindex worker', async () => {
    const projectRoot = createProject();
    const captured: ReindexRunRequest[] = [];
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>((request) => {
      captured.push(request);
      return completedOperation();
    });

    const { Watcher, resolveReindexWorkerLaunch } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: {
        dbPath: '.cache/scip-query',
        indexerConcurrency: 6,
        watch: { gitPollMs: 60_000 },
        indexer: { typescript: { projectMode: 'workspace', projects: ['packages/web'] } },
      },
      languages: ['typescript'],
      reindexRunner: { start: run },
    });

    watcher.requestRefresh({ kind: 'watch-source', detail: 'src/a.ts' }, { immediate: true });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());

    const launch = resolveReindexWorkerLaunch(captured[0]!, (pid) => ({
      version: 1,
      pid,
      platform: process.platform,
      startToken: 'test-watcher-start',
    }));
    const canonicalProjectRoot = realpathSync(projectRoot);
    expect(launch.workerPath).toMatch(/reindex-worker\.js$/);
    expect(launch.env).toEqual(
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: projectRoot,
        SCIP_REINDEX_OUTPUT_SCIP: join(canonicalProjectRoot, '.cache/scip-query/index.scip'),
        SCIP_REINDEX_OUTPUT_DB: join(canonicalProjectRoot, '.cache/scip-query/index.db'),
        SCIP_REINDEX_INDEXER_CONCURRENCY: '6',
        SCIP_REINDEX_TYPESCRIPT_CONFIG: JSON.stringify({
          projectMode: 'workspace',
          projects: ['packages/web'],
        }),
        SCIP_REINDEX_TRIGGER_KIND: 'watch-source',
        SCIP_REINDEX_TRIGGER_DETAIL: 'src/a.ts',
        SCIP_REINDEX_ALLOW_EXPENSIVE: '0',
        SCIP_REINDEX_PARENT_IDENTITY: expect.any(String),
      }),
    );
    expect(JSON.parse(launch.env['SCIP_REINDEX_CHANGE_JOURNAL']!)).toEqual({
      version: 1,
      baseGeneration: null,
      complete: false,
      incompleteReason: 'unstructured-trigger:watch-source',
      entries: [],
    });
    await watcher.stop();
  });

  it('ignores Git bookkeeping events in the source watcher path', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', '.git/index');
    await vi.runAllTimersAsync();

    expect(run).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('ignores dependency and cache directories before consulting gitignore', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', 'node_modules/left-pad/index.js');
    subscription.emitAll('change', 'packages/app/node_modules/pkg/index.js');
    subscription.emitAll('change', '.cache/scip-query/index.db');
    await vi.runAllTimersAsync();

    expect(run).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('ignores reindex activity files in the source watcher path', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', 'reindex-activity.jsonl');
    subscription.emitAll('change', 'reindex-activity.jsonl.previous');
    subscription.emitAll('change', 'reindex-activity.jsonl.rotation.lock');
    subscription.emitAll('change', 'reindex-activity.jsonl.rotation.lock.token.candidate');
    await vi.runAllTimersAsync();

    expect(run).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it('reindexes source, ambient, and configuration files but ignores non-input and directory events', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, gitPollMs: 60_000 } },
      languages: ['typescript', 'javascript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', 'README.md');
    subscription.emitAll('change', 'HEY.md');
    subscription.emitAll('change', '.agents/skills/review/SKILL.md');
    subscription.emitAll('change', '.claude/settings.local.json');
    subscription.emitAll('change', '.scipquery/events/audit.json');
    subscription.emitAll('addDir', 'src/generated');
    subscription.emitAll('unlinkDir', 'src/removed');
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();

    subscription.emitAll('change', 'src/a.ts');
    subscription.emitAll('add', 'src/globals.d.ts');
    subscription.emitAll('change', 'src/View.vue');
    subscription.emitAll('change', '.scipquery.json');
    await vi.advanceTimersByTimeAsync(249);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'watch-source', detail: 'multiple changes' },
      }),
    );
    await watcher.stop();
  });

  it('only schedules ordinary TypeScript edits selected by the configured compiler project', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.gitignore'), '');
    mkdirSync(join(projectRoot, 'packages/app/src'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages/app/scripts'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages/other/src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'packages/app/tsconfig.json'),
      JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }),
    );
    writeFileSync(join(projectRoot, 'packages/app/src/in-scope.ts'), 'export const inScope = true;\n');
    writeFileSync(join(projectRoot, 'packages/app/scripts/out-of-scope.ts'), 'export const script = true;\n');
    writeFileSync(join(projectRoot, 'packages/other/src/out-of-scope.ts'), 'export const other = true;\n');
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: {
        watch: { debounceMs: 250, gitPollMs: 60_000 },
        indexer: { typescript: { projectMode: 'workspace', projects: ['packages/app'] } },
      },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', 'src/a.ts');
    subscription.emitAll('change', 'packages/app/scripts/out-of-scope.ts');
    subscription.emitAll('change', 'packages/other/src/out-of-scope.ts');
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();

    subscription.emitAll('change', 'packages/app/src/in-scope.ts');
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].changeJournal?.entries).toEqual([
      { path: 'packages/app/src/in-scope.ts', kind: 'change' },
    ]);
    await watcher.stop();
  });

  it('recomputes compiler membership for additions without admitting out-of-scope TypeScript files', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.gitignore'), '');
    mkdirSync(join(projectRoot, 'packages/app/src'), { recursive: true });
    mkdirSync(join(projectRoot, 'packages/other/src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'packages/app/tsconfig.json'),
      JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }),
    );
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: {
        watch: { debounceMs: 250, gitPollMs: 60_000 },
        indexer: { typescript: { projectMode: 'workspace', projects: ['packages/app'] } },
      },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    writeFileSync(join(projectRoot, 'packages/other/src/new.ts'), 'export const other = true;\n');
    subscription.emitAll('add', 'packages/other/src/new.ts');
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();

    writeFileSync(join(projectRoot, 'packages/app/src/new.ts'), 'export const added = true;\n');
    subscription.emitAll('add', 'packages/app/src/new.ts');
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].changeJournal?.entries).toEqual([{ path: 'packages/app/src/new.ts', kind: 'add' }]);
    await watcher.stop();
  });

  it('keeps deletions and compiler configuration changes inside the correctness boundary', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    writeFileSync(join(projectRoot, '.gitignore'), '');
    mkdirSync(join(projectRoot, 'packages/app/src'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'packages/app/tsconfig.json'),
      JSON.stringify({ compilerOptions: {}, include: ['src/**/*.ts'] }),
    );
    const sourcePath = join(projectRoot, 'packages/app/src/deleted.ts');
    writeFileSync(sourcePath, 'export const deleted = true;\n');
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: {
        watch: { debounceMs: 250, gitPollMs: 60_000 },
        indexer: { typescript: { projectMode: 'workspace', projects: ['packages/app'] } },
      },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    rmSync(sourcePath);
    subscription.emitAll('unlink', 'packages/app/src/deleted.ts');
    subscription.emitAll('change', 'packages/app/tsconfig.json');
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0].changeJournal?.entries).toEqual([
      { path: 'packages/app/src/deleted.ts', kind: 'delete' },
      { path: 'packages/app/tsconfig.json', kind: 'change' },
    ]);
    await watcher.stop();
  });

  it('preserves coalesced source changes in a complete generation-based journal', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const outputDb = join(projectRoot, 'index.db');
    writeFileSync(outputDb, 'fixture generation');
    writeFileSync(join(projectRoot, 'meta.json'), '{}');
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      outputDb,
      config: { watch: { debounceMs: 250, gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', 'src/a.ts');
    subscription.emitAll('add', 'src/new.ts');
    subscription.emitAll('change', 'src/new.ts');
    subscription.emitAll('add', 'src/transient.ts');
    subscription.emitAll('unlink', 'src/transient.ts');
    subscription.emitAll('unlink', 'src/deleted.ts');
    await vi.advanceTimersByTimeAsync(250);

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        changeJournal: {
          version: 1,
          baseGeneration: expect.any(String),
          complete: true,
          entries: [
            { path: 'src/a.ts', kind: 'change' },
            { path: 'src/deleted.ts', kind: 'delete' },
            { path: 'src/new.ts', kind: 'add' },
          ],
        },
      }),
    );
    await watcher.stop();
  });

  it('marks the next change journal incomplete after a source watcher error', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const outputDb = join(projectRoot, 'index.db');
    writeFileSync(outputDb, 'fixture generation');
    writeFileSync(join(projectRoot, 'meta.json'), '{}');
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      outputDb,
      config: { watch: { debounceMs: 250, gitPollMs: 60_000 } },
      languages: ['typescript'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
      onError: () => undefined,
    });

    watcher.start();
    subscription.emitError(new Error('watch stream failed'));
    subscription.emitAll('change', 'src/a.ts');
    await vi.advanceTimersByTimeAsync(250);

    expect(run.mock.calls[0]?.[0].changeJournal).toEqual(
      expect.objectContaining({
        complete: false,
        incompleteReason: 'source-watcher-error',
        entries: [{ path: 'src/a.ts', kind: 'change' }],
      }),
    );
    await watcher.stop();
  });

  it('ignores dependency locks owned by an unconfigured language', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const { Watcher } = await import('../../src/runtime/watch.js');
    const subscription = sourceSubscriptionHarness();
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, gitPollMs: 60_000 } },
      languages: ['rust'],
      reindexRunner: { start: run },
      subscriptionFactory: subscription.factory,
    });

    watcher.start();
    subscription.emitAll('change', 'package-lock.json');
    await vi.advanceTimersByTimeAsync(500);
    expect(run).not.toHaveBeenCalled();

    subscription.emitAll('change', 'Cargo.lock');
    await vi.advanceTimersByTimeAsync(250);
    expect(run).toHaveBeenCalledOnce();
    await watcher.stop();
  });

  it('skips proven docs-only Git transitions and reindexes compiler-input transitions', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const indexPath = join(projectRoot, '.git-index');
    writeFileSync(indexPath, 'index');
    let head = 'a'.repeat(40);
    let changedPaths = 'README.md\0docs/architecture.md\0';
    const gitReader: GitReader = {
      run: (_root, args) => {
        if (args.includes('--git-path')) return indexPath;
        if (args.includes('HEAD')) return head;
        return undefined;
      },
      runResult: (_root, args) =>
        args[0] === 'diff' ? { kind: 'success', output: changedPaths } : { kind: 'error', message: 'unexpected' },
    };
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, gitPollMs: 1_000 } },
      languages: ['typescript'],
      gitReader,
      reindexRunner: { start: run },
      subscriptionFactory: sourceSubscriptionHarness().factory,
    });

    watcher.start();
    head = 'b'.repeat(40);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(run).not.toHaveBeenCalled();

    changedPaths = 'src/a.ts\0README.md\0';
    head = 'c'.repeat(40);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'watch-git-head', detail: 'src/a.ts' },
      }),
    );
    await watcher.stop();
  });

  it('compares successive staged identities instead of repeatedly charging an unchanged staged source', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const indexPath = join(projectRoot, '.git-index');
    writeFileSync(indexPath, 'initial');
    const head = 'a'.repeat(40);
    let stagedEntries = `${rawGitEntry('1', '2', 'M', 'src/a.ts')}`;
    const gitReader: GitReader = {
      run: (_root, args) => {
        if (args.includes('--git-path')) return indexPath;
        if (args.includes('HEAD')) return head;
        return undefined;
      },
      runResult: (_root, args) =>
        args.includes('--raw')
          ? { kind: 'success', output: stagedEntries }
          : { kind: 'error', message: 'unexpected Git command' },
    };
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, gitPollMs: 1_000 } },
      languages: ['typescript'],
      gitReader,
      reindexRunner: { start: run },
      subscriptionFactory: sourceSubscriptionHarness().factory,
    });

    watcher.start();
    stagedEntries += rawGitEntry('0', '3', 'A', 'README.md');
    writeFileSync(indexPath, 'docs added to index');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(run).not.toHaveBeenCalled();

    stagedEntries = `${rawGitEntry('1', '4', 'M', 'src/a.ts')}${rawGitEntry('0', '3', 'A', 'README.md')}`;
    writeFileSync(indexPath, 'source restaged with changed blob identity');
    await vi.advanceTimersByTimeAsync(1_250);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'watch-git-index', detail: 'src/a.ts' },
      }),
    );
    await watcher.stop();
  });

  it('reindexes conservatively when a changed Git path set cannot be established', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const indexPath = join(projectRoot, '.git-index');
    writeFileSync(indexPath, 'index');
    let head = 'a'.repeat(40);
    const gitReader: GitReader = {
      run: (_root, args) => {
        if (args.includes('--git-path')) return indexPath;
        if (args.includes('HEAD')) return head;
        return undefined;
      },
      runResult: () => ({ kind: 'error', message: 'git diff failed' }),
    };
    const { Watcher } = await import('../../src/runtime/watch.js');
    const run = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => completedOperation());
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, gitPollMs: 1_000 } },
      languages: ['typescript'],
      gitReader,
      reindexRunner: { start: run },
      subscriptionFactory: sourceSubscriptionHarness().factory,
    });

    watcher.start();
    head = 'b'.repeat(40);
    await vi.advanceTimersByTimeAsync(1_250);

    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: { kind: 'watch-git-head', detail: 'HEAD changed; changed paths unavailable' },
      }),
    );
    await watcher.stop();
  });

  it('does not spawn Git while a rebuild is already running', async () => {
    vi.useFakeTimers();
    const projectRoot = createProject();
    const indexPath = join(projectRoot, '.git-index');
    writeFileSync(indexPath, 'index');
    let head = 'a'.repeat(40);
    let gitRuns = 0;
    const gitReader: GitReader = {
      run: (_root, args) => {
        gitRuns += 1;
        if (args.includes('--git-path')) return indexPath;
        if (args.includes('HEAD')) return head;
        return undefined;
      },
      runResult: () => ({ kind: 'error', message: 'git diff failed' }),
    };
    const { Watcher } = await import('../../src/runtime/watch.js');
    const { runner, run } = controlledReindexRunner();
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { debounceMs: 250, cooldownMs: 0, gitPollMs: 1_000 } },
      languages: ['typescript'],
      gitReader,
      reindexRunner: runner,
      subscriptionFactory: sourceSubscriptionHarness().factory,
    });

    watcher.start();
    const gitRunsAfterStart = gitRuns;
    watcher.requestRefresh({ kind: 'watch-startup', detail: 'test' }, { immediate: true });
    expect(run).toHaveBeenCalledOnce();

    head = 'b'.repeat(40);
    await vi.advanceTimersByTimeAsync(1_250);
    expect(run).toHaveBeenCalledOnce();
    expect(gitRuns).toBe(gitRunsAfterStart);
    await watcher.stop();
  });

  it('reports draining and waits for both subscription close and active-worker cancellation', async () => {
    const projectRoot = createProject();
    const completion = deferred<number>();
    const cancellation = deferred<Awaited<ReturnType<ReindexOperation['cancel']>>>();
    const subscriptionClose = deferred<void>();
    const statuses: string[] = [];
    const cancel = vi.fn(async () => {
      completion.resolve(0);
      return cancellation.promise;
    });
    const operation: ReindexOperation = {
      completion: completion.promise,
      cancel,
      diagnostics: emptyDiagnostics,
    };
    const subscription = {
      on: () => subscription,
      close: () => subscriptionClose.promise,
    } as WatchSubscription;
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      reindexRunner: { start: () => operation },
      subscriptionFactory: () => subscription,
      onStatus: (status) => statuses.push(status.state),
    });

    watcher.start();
    watcher.requestRefresh({ kind: 'watch-startup' }, { immediate: true });
    const stopPromise = watcher.stop();
    let settled = false;
    void stopPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(cancel).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe('draining');
    expect(settled).toBe(false);
    expect(() => watcher.start()).toThrow(/still draining/);

    subscriptionClose.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);

    cancellation.resolve({ state: 'exited', diagnostics: emptyDiagnostics() });
    await expect(stopPromise).resolves.toEqual({ state: 'stopped' });
    expect(statuses.at(-1)).toBe('idle');
  });

  it('returns a degraded result by the injected shutdown deadline when close never settles', async () => {
    const projectRoot = createProject();
    const never = new Promise<void>(() => undefined);
    const subscription = {
      on: () => subscription,
      close: () => never,
    } as WatchSubscription;
    let shutdownDeadline: (() => void) | undefined;
    const inertTimer = setTimeout(() => undefined, 0);
    clearTimeout(inertTimer);
    const clock: WatchClock = {
      now: () => 0,
      wallNow: () => 0,
      setTimeout(callback, delayMs) {
        if (delayMs === 25) shutdownDeadline = callback;
        return inertTimer;
      },
      clearTimeout: () => {},
      setInterval: () => inertTimer,
      clearInterval: () => {},
    };
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      subscriptionFactory: () => subscription,
      clock,
      stopTimeoutMs: 25,
    });

    watcher.start();
    const stopping = watcher.stop();
    shutdownDeadline!();

    await expect(stopping).resolves.toEqual({
      state: 'degraded',
      reasons: ['watch shutdown exceeded the 25ms deadline with 1 operation(s) still pending'],
    });
    expect(() => watcher.start()).toThrow(/still draining/);
  });

  it('tracks and reports native watcher retirement when EMFILE starts polling fallback', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const projectRoot = createProject();
    const nativeEvents = new EventEmitter();
    const pollingEvents = new EventEmitter();
    const nativeClose = deferred<void>();
    const errors: string[] = [];
    const subscriptions: WatchSubscription[] = [];
    const factory = vi.fn<WatchSubscriptionFactory>((_root, options) => {
      const emitter = options.usePolling ? pollingEvents : nativeEvents;
      const subscription = {
        on(event: 'all' | 'error', listener: (...args: never[]) => void) {
          emitter.on(event, listener);
          return subscription;
        },
        close: options.usePolling ? vi.fn(async () => undefined) : vi.fn(() => nativeClose.promise),
      } as WatchSubscription;
      subscriptions.push(subscription);
      return subscription;
    });
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      subscriptionFactory: factory,
      onError: (error) => errors.push(error.message),
    });

    watcher.start();
    nativeEvents.emit('error', Object.assign(new Error('too many files'), { code: 'EMFILE' }));
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ usePolling: true, interval: 5_000, binaryInterval: 10_000 }),
    );

    const stopPromise = watcher.stop();
    let stopped = false;
    void stopPromise.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    nativeClose.reject(new Error('native close failed'));
    await expect(stopPromise).resolves.toEqual({
      state: 'degraded',
      reasons: [expect.stringContaining('polling fallback: Error: native close failed')],
    });
    expect(errors).toEqual([expect.stringContaining('polling fallback: Error: native close failed')]);
    expect(subscriptions).toHaveLength(2);
  });

  it('uses one recursive source watch on macOS unless polling fallback was requested', () => {
    expect(shouldUseRecursiveSourceWatch('darwin', false)).toBe(true);
    expect(shouldUseRecursiveSourceWatch('darwin', true)).toBe(false);
    expect(shouldUseRecursiveSourceWatch('linux', false)).toBe(false);
  });

  it('retains a degraded draining state when worker exit cannot be proven', async () => {
    const projectRoot = createProject();
    const never = new Promise<number>(() => undefined);
    const diagnostics = emptyDiagnostics();
    const start = vi.fn<(request: ReindexRunRequest) => ReindexOperation>(() => ({
      completion: never,
      cancel: async () => ({
        state: 'degraded',
        reason: 'worker identity could not be verified',
        diagnostics,
      }),
      diagnostics: () => diagnostics,
    }));
    const statuses: string[] = [];
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      reindexRunner: { start },
      onStatus: (status) => statuses.push(status.state),
    });

    watcher.requestRefresh({ kind: 'watch-startup' }, { immediate: true });
    await expect(watcher.stop()).resolves.toEqual({
      state: 'degraded',
      reasons: ['worker identity could not be verified'],
    });
    watcher.requestRefresh({ kind: 'watch-demand' }, { immediate: true });

    expect(start).toHaveBeenCalledOnce();
    expect(statuses.at(-1)).toBe('draining');
  });

  it.each([
    [
      'synchronous',
      () => () => {
        throw new Error('sync close failure');
      },
    ],
    [
      'asynchronous',
      () => async () => {
        throw new Error('async close failure');
      },
    ],
  ])('retains degraded ownership when a subscription has a %s close failure', async (_kind, createClose) => {
    const projectRoot = createProject();
    const statuses: string[] = [];
    const subscription = {
      on: () => subscription,
      close: createClose(),
    } as WatchSubscription;
    const { Watcher } = await import('../../src/runtime/watch.js');
    const watcher = new Watcher({
      projectRoot,
      config: { watch: { gitPollMs: 60_000 } },
      subscriptionFactory: () => subscription,
      onStatus: (status) => statuses.push(status.state),
    });

    watcher.start();
    await expect(watcher.stop()).resolves.toEqual({
      state: 'degraded',
      reasons: [expect.stringMatching(/watch subscription close failed: Error: .* close failure/)],
    });

    expect(statuses.at(-1)).toBe('draining');
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

    const { acquireWatchProcessLock } = await import('../../src/runtime/watch-service.js');
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

    const { acquireWatchProcessLock } = await import('../../src/runtime/watch-service.js');
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
