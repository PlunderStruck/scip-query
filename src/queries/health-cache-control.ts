import { getHeapStatistics } from 'node:v8';

const GC_HEADROOM_BYTES = 64 * 1024 * 1024;

export function requestGarbageCollection(): void {
  const maybeGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (!maybeGc) return;

  const heap = getHeapStatistics();
  if (heap.heap_size_limit - heap.used_heap_size < GC_HEADROOM_BYTES) return;

  maybeGc();
}
