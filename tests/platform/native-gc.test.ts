import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectNativeGarbage,
  noteFinalizerOwnedNativeAllocation,
  resetNativeAllocationPressureForTests,
} from '../../src/platform/native-gc.js';

describe('finalizer-owned native allocation pressure', () => {
  afterEach(() => {
    resetNativeAllocationPressureForTests();
    vi.restoreAllMocks();
  });

  it('collects once accumulated estimates cross the pressure bound, then resets', () => {
    const collect = vi.fn(() => true);
    const mb = 1024 * 1024;

    noteFinalizerOwnedNativeAllocation(300 * mb, collect);
    expect(collect).not.toHaveBeenCalled();
    noteFinalizerOwnedNativeAllocation(300 * mb, collect);
    expect(collect).toHaveBeenCalledTimes(1);
    noteFinalizerOwnedNativeAllocation(300 * mb, collect);
    expect(collect).toHaveBeenCalledTimes(1);
    noteFinalizerOwnedNativeAllocation(300 * mb, collect);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('ignores invalid estimates', () => {
    const collect = vi.fn(() => true);
    noteFinalizerOwnedNativeAllocation(Number.NaN, collect);
    noteFinalizerOwnedNativeAllocation(-1, collect);
    noteFinalizerOwnedNativeAllocation(Number.POSITIVE_INFINITY, collect);
    expect(collect).not.toHaveBeenCalled();
  });

  it('obtains a working collector even without --expose-gc', () => {
    // The suite does not run with --expose-gc, so a successful collection
    // proves the runtime flag route works; a false return would mean large
    // native sweeps silently lose their only release mechanism.
    expect(collectNativeGarbage()).toBe(true);
  });
});
