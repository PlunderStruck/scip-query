const NO_ERROR = Symbol('no-error');

/**
 * Run a bounded set of lanes. The first observed failure closes admission,
 * every already-started operation is joined, then that first failure is thrown.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const results = new Array<R>(items.length);
  const normalizedConcurrency = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  const workerCount = Math.min(items.length, normalizedConcurrency);
  let nextIndex = 0;
  let firstError: unknown | typeof NO_ERROR = NO_ERROR;
  let admissionOpen = true;

  const workers = Array.from({ length: workerCount }, async () => {
    while (admissionOpen && nextIndex < items.length) {
      const index = nextIndex++;
      try {
        results[index] = await run(items[index]!);
      } catch (error) {
        if (firstError === NO_ERROR) firstError = error;
        admissionOpen = false;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== NO_ERROR) throw firstError;
  return results;
}

/**
 * Join operations that have already started and preserve the first error
 * observed while waiting for every sibling to settle.
 */
export async function joinConcurrentOperations<T extends readonly unknown[]>(operations: {
  [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  let firstError: unknown | typeof NO_ERROR = NO_ERROR;
  const observed = operations.map((operation) =>
    operation.catch((error: unknown) => {
      if (firstError === NO_ERROR) firstError = error;
      throw error;
    }),
  );
  const settled = await Promise.allSettled(observed);
  if (firstError !== NO_ERROR) throw firstError;
  return settled.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
