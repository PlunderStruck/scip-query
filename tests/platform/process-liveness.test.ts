import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProcessAlive } from '../../src/platform/process-liveness.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isProcessAlive', () => {
  it('reports a process when signal zero succeeds', () => {
    vi.spyOn(process, 'kill').mockReturnValue(true);

    expect(isProcessAlive(123)).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(123, 0);
  });

  it('treats permission denial as evidence that the process exists', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
    });

    expect(isProcessAlive(123)).toBe(true);
  });

  it('reports other signal errors as a missing process', () => {
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('missing'), { code: 'ESRCH' });
    });

    expect(isProcessAlive(123)).toBe(false);
  });
});
