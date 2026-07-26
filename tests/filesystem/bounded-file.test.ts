import { closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashFileWithinLimit,
  readFileWithinLimit,
  readTextFileDescriptorWithinLimit,
  readTextFileWithinLimit,
  type BoundedFileReadError,
} from '../../src/filesystem/bounded-file.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'scip-query-bounded-file-'));
  tempDirs.push(dir);
  const path = join(dir, 'artifact');
  writeFileSync(path, content);
  return path;
}

describe('bounded file reads', () => {
  it('reads and hashes a file without changing its bytes', () => {
    const path = fixture('hello π');
    const chunks: Buffer[] = [];

    expect(readTextFileWithinLimit(path, { inputKind: 'fixture', maxBytes: 64 })).toBe('hello π');
    expect(readFileWithinLimit(path, { inputKind: 'fixture', maxBytes: 64 })).toEqual(Buffer.from('hello π'));
    expect(
      hashFileWithinLimit(path, { inputKind: 'fixture', maxBytes: 64 }, (chunk) => chunks.push(Buffer.from(chunk))),
    ).toBe(Buffer.byteLength('hello π'));
    expect(Buffer.concat(chunks)).toEqual(Buffer.from('hello π'));
  });

  it('rejects an oversized artifact before materializing it', () => {
    const path = fixture('12345');

    expect(() => readFileWithinLimit(path, { inputKind: 'test artifact', maxBytes: 4 })).toThrow(
      expect.objectContaining<Partial<BoundedFileReadError>>({
        code: 'SCIP_QUERY_BOUNDED_FILE_READ',
        reason: 'too-large',
        observedBytes: 5,
        limitBytes: 4,
      }),
    );
  });

  it('rejects non-regular inputs and invalid limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'scip-query-bounded-file-dir-'));
    tempDirs.push(dir);
    expect(() => readFileWithinLimit(dir, { inputKind: 'directory', maxBytes: 64 })).toThrow(/not a regular file/u);
    expect(() => readFileWithinLimit(dir, { inputKind: 'directory', maxBytes: -1 })).toThrow(/non-negative/u);
  });

  it('does not take ownership of a caller descriptor', () => {
    const path = fixture('owned elsewhere');
    const descriptor = openSync(path, 'r');
    try {
      expect(
        readTextFileDescriptorWithinLimit(descriptor, {
          inputKind: 'caller-owned descriptor',
          maxBytes: 64,
        }),
      ).toBe('owned elsewhere');
      expect(fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      closeSync(descriptor);
    }
  });

  it('bounds streaming descriptors whose size cannot be known in advance', () => {
    const path = fixture('12345');
    const descriptor = openSync(path, 'r');
    try {
      expect(() =>
        readTextFileDescriptorWithinLimit(descriptor, {
          inputKind: 'stream input',
          maxBytes: 4,
        }),
      ).toThrow(
        expect.objectContaining<Partial<BoundedFileReadError>>({
          reason: 'too-large',
          observedBytes: 5,
          limitBytes: 4,
        }),
      );
      expect(fstatSync(descriptor).isFile()).toBe(true);
    } finally {
      closeSync(descriptor);
    }
  });
});
