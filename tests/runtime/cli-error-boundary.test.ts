import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCliWithErrorBoundary } from '../../src/runtime/cli-error-boundary.js';

const originalExitCode = process.exitCode;

afterEach(() => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
});

describe('CLI error boundary', () => {
  it('renders routine failures without a JavaScript stack trace', async () => {
    const error = new Error('candidate index is incomplete');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCliWithErrorBoundary(async () => {
      throw error;
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith('error: candidate index is incomplete');
  });

  it('retains the stack only in explicit debug mode', async () => {
    const error = new Error('candidate index is incomplete');
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await runCliWithErrorBoundary(
      async () => {
        throw error;
      },
      { debug: true },
    );

    expect(stderr).toHaveBeenNthCalledWith(1, 'error: candidate index is incomplete');
    expect(stderr).toHaveBeenNthCalledWith(2, error.stack);
  });
});
