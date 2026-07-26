import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ReindexDiagnostics,
  ReindexOperation,
  ReindexRunner,
  ReindexRunRequest,
  WatchSubscription,
  WatchSubscriptionFactory,
} from '../../src/runtime/watch.js';

const tempDirs: string[] = [];

function createProject(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'scip-query-watch-'));
  tempDirs.push(projectRoot);
  mkdirSync(join(projectRoot, 'src'), { recursive: true });
  writeFileSync(join(projectRoot, 'src', 'a.ts'), 'export const a = 1;\n');
  return projectRoot;
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
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Watcher', () => {
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
    await vi.advanceTimersByTimeAsync(cooldownMs);
    expect(controlled.run).toHaveBeenCalledTimes(2);

    controlled.completions[1]?.(100);
    await vi.runAllTimersAsync();
    await watcher.stop();
  });

  it('suppresses a dirty rerun when the completed index is proven fresh', async () => {
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
    await vi.advanceTimersByTimeAsync(1_000);

    expect(controlled.run).toHaveBeenCalledTimes(1);
    expect(suppressed).toEqual([{ kind: 'watch-source', detail: 'src/a.ts' }]);
    watcher.requestRefresh({ kind: 'watch-startup', detail: 'new request' }, { immediate: true });
    expect(controlled.requests[1]?.trigger).toEqual({
      kind: 'watch-startup',
      detail: 'new request',
    });
    await watcher.stop();
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
    await vi.advanceTimersByTimeAsync(1_000);

    expect(controlled.run).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['freshness unavailable']);
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

    const launch = resolveReindexWorkerLaunch(captured[0]!);
    expect(launch.workerPath).toMatch(/reindex-worker\.js$/);
    expect(launch.env).toEqual(
      expect.objectContaining({
        SCIP_REINDEX_PROJECT_ROOT: projectRoot,
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
    await vi.runAllTimersAsync();

    expect(run).not.toHaveBeenCalled();
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
