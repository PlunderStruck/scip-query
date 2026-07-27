import { describe, expect, it } from 'vitest';
import { joinConcurrentOperations, runWithConcurrency } from '../../src/platform/structured-concurrency.js';

describe('structured concurrency', () => {
  it('closes admission on failure and joins every operation already started', async () => {
    const firstFailure = deferred<void>();
    const sibling = deferred<void>();
    const started: number[] = [];
    let settled = false;

    const outcome = runWithConcurrency([0, 1, 2, 3], 2, async (item) => {
      started.push(item);
      if (item === 0) {
        await firstFailure.promise;
        throw new Error('first observed failure');
      }
      await sibling.promise;
      return item;
    }).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(started).toEqual([0, 1]);
    firstFailure.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(started).toEqual([0, 1]);
    sibling.resolve();

    await expect(outcome).rejects.toThrow('first observed failure');
    expect(started).toEqual([0, 1]);
  });

  it('reports the first error observed after every failing lane settles', async () => {
    const laneZero = deferred<void>();
    const laneOne = deferred<void>();
    const outcome = runWithConcurrency([0, 1], 2, async (item) => {
      await (item === 0 ? laneZero.promise : laneOne.promise);
      throw new Error(item === 0 ? 'later error' : 'first error');
    });

    laneOne.resolve();
    await Promise.resolve();
    laneZero.resolve();

    await expect(outcome).rejects.toThrow('first error');
  });

  it('preserves input order and normalizes a non-finite concurrency limit', async () => {
    await expect(runWithConcurrency([3, 1, 2], Number.NaN, async (item) => item * 2)).resolves.toEqual([6, 2, 4]);
  });

  it('joins an already-started sibling before rejecting a concurrent operation group', async () => {
    const sibling = deferred<string>();
    let settled = false;
    const outcome = joinConcurrentOperations([
      Promise.reject(new Error('group failure')),
      sibling.promise,
    ] as const).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    sibling.resolve('joined');

    await expect(outcome).rejects.toThrow('group failure');
    expect(settled).toBe(true);
  });
});

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
