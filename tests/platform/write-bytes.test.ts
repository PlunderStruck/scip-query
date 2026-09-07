import { writeSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { writeAllBytes } from '../../src/platform/write-bytes.js';

vi.mock('node:fs', () => ({ writeSync: vi.fn() }));

describe('complete descriptor writes', () => {
  beforeEach(() => vi.resetAllMocks());

  it('preserves a byte view when the operating system accepts only part of each write', () => {
    const written: number[] = [];
    vi.mocked(writeSync).mockImplementation((_fd, buffer, offset, length) => {
      const bytes = buffer as Uint8Array;
      const count = Math.min(2, length as number);
      written.push(...bytes.subarray(offset as number, (offset as number) + count));
      return count;
    });
    const bytes = new Uint8Array([0, 10, 20, 30, 40, 50, 255]);
    writeAllBytes(17, bytes.subarray(1, 6));
    expect(written).toEqual([10, 20, 30, 40, 50]);
  });

  it('fails on zero progress with the caller operation in the error', () => {
    vi.mocked(writeSync).mockReturnValue(0);
    expect(() => writeAllBytes(17, Buffer.from('data'), 'JSON export')).toThrow(
      'JSON export write made no forward progress.',
    );
  });

  it('propagates the original filesystem failure for caller cleanup', () => {
    const failure = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    vi.mocked(writeSync).mockImplementation(() => {
      throw failure;
    });
    expect(() => writeAllBytes(17, Buffer.from('data'))).toThrow(failure);
  });

  it('does not write an empty range', () => {
    writeAllBytes(17, new Uint8Array());
    expect(writeSync).not.toHaveBeenCalled();
  });
});
