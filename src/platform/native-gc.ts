import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

/**
 * Native allocations made by finalizer-owned addon objects (tree-sitter trees
 * and node cache entries) are invisible to V8: the JS wrappers are tiny, so
 * the heap never feels pressure, garbage collection stays rare, and dead
 * native memory accumulates to many gigabytes of RSS while `heapUsed` stays
 * flat. This module gives such producers a way to report their estimated
 * native churn and trigger a collection once enough has accumulated.
 */

let cachedGc: (() => void) | null | undefined;

function resolveGc(): (() => void) | null {
  if (cachedGc !== undefined) return cachedGc;
  const exposed = (globalThis as { gc?: unknown }).gc;
  if (typeof exposed === 'function') {
    cachedGc = exposed as () => void;
    return cachedGc;
  }
  try {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as unknown;
    setFlagsFromString('--no-expose_gc');
    cachedGc = typeof gc === 'function' ? (gc as () => void) : null;
  } catch {
    cachedGc = null;
  }
  return cachedGc;
}

/** Runs a full garbage collection when a collector is obtainable; reports whether one ran. */
export function collectNativeGarbage(): boolean {
  const gc = resolveGc();
  if (!gc) return false;
  gc();
  return true;
}

/**
 * Collect once at least this much estimated finalizer-owned native memory has
 * been produced. The value trades dead-native RSS between collections against
 * collection pauses; at ~10x source bytes per parsed tree it collects roughly
 * once per 50 MB of parsed source.
 */
const NATIVE_PRESSURE_COLLECT_BYTES = 512 * 1024 * 1024;

let pendingNativeBytes = 0;

/**
 * Record an estimated native allocation owned by a GC finalizer. Estimates
 * only steer collection frequency, so a coarse multiple of the source size is
 * sufficient; precision is not required for the bound to hold.
 */
export function noteFinalizerOwnedNativeAllocation(
  estimatedBytes: number,
  collect: () => boolean = collectNativeGarbage,
): void {
  if (!Number.isFinite(estimatedBytes) || estimatedBytes <= 0) return;
  pendingNativeBytes += estimatedBytes;
  if (pendingNativeBytes < NATIVE_PRESSURE_COLLECT_BYTES) return;
  pendingNativeBytes = 0;
  collect();
}

/** Test seam: reset accumulated pressure so unit tests are order-independent. */
export function resetNativeAllocationPressureForTests(): void {
  pendingNativeBytes = 0;
}
