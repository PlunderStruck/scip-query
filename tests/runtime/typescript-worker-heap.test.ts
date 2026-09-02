import { describe, expect, it } from 'vitest';
import { availableMemoryBytes, recommendedTypeScriptWorkerHeapMb } from '../../src/runtime/typescript-mailbox-lanes.js';

const GIB = 1024 * 1024 * 1024;

describe('TypeScript worker heap sizing', () => {
  it('lowers the machine memory to the cgroup limit when one applies', () => {
    const files: Record<string, string> = { '/sys/fs/cgroup/memory.max': `${8 * GIB}\n` };
    expect(availableMemoryBytes((path) => files[path] ?? null, 64 * GIB)).toBe(8 * GIB);
    // "max" means unlimited under cgroup v2; the v1 sentinel is above physical memory.
    expect(availableMemoryBytes(() => 'max\n', 64 * GIB)).toBe(64 * GIB);
    expect(
      availableMemoryBytes((path) => (path.endsWith('limit_in_bytes') ? '9223372036854771712\n' : null), 64 * GIB),
    ).toBe(64 * GIB);
    expect(availableMemoryBytes(() => null, 64 * GIB)).toBe(64 * GIB);
  });

  it('sizes the worker heap by document count within the memory ceiling', () => {
    const previous = process.env['SCIP_TS_WORKER_HEAP_MB'];
    delete process.env['SCIP_TS_WORKER_HEAP_MB'];
    try {
      // Small project: the default floor.
      expect(recommendedTypeScriptWorkerHeapMb(500, 64 * GIB)).toBe(6144);
      // Launchpoint-sized project on a large machine: the estimate.
      expect(recommendedTypeScriptWorkerHeapMb(7_782, 64 * GIB)).toBe(2_560 + Math.ceil(7_782 * 1.25));
      // The same project inside an 8 GiB container: capped at 60% of it, never below the floor.
      expect(recommendedTypeScriptWorkerHeapMb(7_782, 8 * GIB)).toBe(6144);
      expect(recommendedTypeScriptWorkerHeapMb(7_782, 16 * GIB)).toBe(Math.floor(16 * 1024 * 0.6));
    } finally {
      if (previous === undefined) delete process.env['SCIP_TS_WORKER_HEAP_MB'];
      else process.env['SCIP_TS_WORKER_HEAP_MB'] = previous;
    }
  });
});
