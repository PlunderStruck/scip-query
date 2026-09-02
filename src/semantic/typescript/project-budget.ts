import { getHeapStatistics } from 'node:v8';

/** Retaining one compiler graph costs about this much per indexed document on top of a fixed base. */
export const TYPESCRIPT_WORKER_HEAP_BASE_MB = 2_560;
export const TYPESCRIPT_WORKER_HEAP_PER_DOCUMENT_MB = 1.25;

/**
 * Files one whole-project compiler program can hold in a heap of the given
 * size, by the same estimate that sizes the worker heap from the document
 * count. A tsconfig listing more files than this cannot be loaded whole
 * without the worker dying mid-request; it is served from file closures
 * instead.
 */
export function projectFileBudgetForHeap(heapLimitBytes: number): number {
  const heapMb = heapLimitBytes / (1024 * 1024);
  return Math.max(0, Math.floor((heapMb - TYPESCRIPT_WORKER_HEAP_BASE_MB) / TYPESCRIPT_WORKER_HEAP_PER_DOCUMENT_MB));
}

export function currentProjectFileBudget(): number {
  return projectFileBudgetForHeap(getHeapStatistics().heap_size_limit);
}
